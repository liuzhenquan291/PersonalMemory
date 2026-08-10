import { z } from "zod";
import { UpstreamGatewayError } from "./upstream-client.js";
import type { UpstreamGatewayClient } from "./types.js";

export const recallLevelSchema = z.enum(["L0", "L1", "L2", "L3"]);
export type RecallLevel = z.infer<typeof recallLevelSchema>;

export const unifiedRecallRequestSchema = z
  .object({
    query: z.string().min(1).max(2_048),
    levels: z.array(recallLevelSchema).min(1).max(4).default(["L1", "L0"]),
    budget: z
      .object({
        max_items: z.number().int().min(1).max(50).default(10),
        max_chars: z.number().int().min(128).max(32_000).default(6_000),
        max_tokens: z.number().int().min(32).max(8_000).default(1_500),
        timeout_ms: z.number().int().min(50).max(10_000).default(2_000),
      })
      .strict()
      .default({
        max_items: 10,
        max_chars: 6_000,
        max_tokens: 1_500,
        timeout_ms: 2_000,
      }),
  })
  .strict()
  .transform((input) => ({ ...input, levels: [...new Set(input.levels)] }));

export interface RecallItem {
  id: string;
  level: RecallLevel;
  content: string;
  score?: number;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
  truncated: boolean;
}

export interface UnifiedRecallResult {
  items: RecallItem[];
  degradedLevels: Array<{ level: RecallLevel; code: string }>;
  budget: {
    maxItems: number;
    maxChars: number;
    maxTokens: number;
    usedItems: number;
    usedChars: number;
    estimatedTokens: number;
    exhausted: boolean;
  };
}

const envelopeSchema = z.object({
  code: z.number(),
  data: z.unknown().optional(),
});
const l0DataSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      score: z.number(),
      timestamp: z.string().optional(),
    }),
  ),
});
const l1DataSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      score: z.number(),
      created_at: z.string().optional(),
      updated_at: z.string().optional(),
    }),
  ),
});
const l2ListSchema = z.object({
  entries: z.array(
    z.object({
      path: z.string(),
      summary: z.string().optional(),
      created_at: z.string().optional(),
      updated_at: z.string().optional(),
    }),
  ),
});
const l2FileSchema = z.object({
  path: z.string(),
  content: z.string().nullable(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});
const l3FileSchema = z.object({
  content: z.string().nullable(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});

function parseData<T>(body: unknown, schema: z.ZodType<T>): T {
  const envelope = envelopeSchema.parse(body);
  if (envelope.code !== 0) throw new Error("UPSTREAM_REJECTED");
  return schema.parse(envelope.data);
}

function lexicalScore(query: string, text: string): number {
  const normalized = query.toLocaleLowerCase();
  const haystack = text.toLocaleLowerCase();
  const terms = normalized.split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return 0;
  return terms.filter((term) => haystack.includes(term)).length / terms.length;
}

function tokenUnits(character: string): number {
  return character.codePointAt(0)! <= 0x7f ? 1 : 8;
}

function takeWithinBudget(
  content: string,
  maxChars: number,
  maxTokenUnits: number,
): { content: string; tokenUnits: number } {
  let selected = "";
  let units = 0;
  for (const character of content) {
    if (
      selected.length + character.length > maxChars ||
      units + tokenUnits(character) > maxTokenUnits
    ) {
      break;
    }
    selected += character;
    units += tokenUnits(character);
  }
  return { content: selected, tokenUnits: units };
}

export class RecallService {
  constructor(
    private readonly upstream: UpstreamGatewayClient,
    private readonly upstreamTimeoutMs: number,
  ) {}

  async recall(
    input: z.output<typeof unifiedRecallRequestSchema>,
    requestId: string,
  ): Promise<UnifiedRecallResult> {
    const deadline = AbortSignal.timeout(input.budget.timeout_ms);
    const limit = input.budget.max_items;
    const requested = new Set(input.levels);
    const tasks = (["L1", "L0", "L2", "L3"] as const)
      .filter((level) => requested.has(level))
      .map(async (level) => {
        try {
          return {
            level,
            items: await this.fetchLevel(
              level,
              input.query,
              limit,
              requestId,
              deadline,
            ),
          };
        } catch (error) {
          return {
            level,
            items: [] as RecallItem[],
            error:
              deadline.aborted ||
              (error instanceof UpstreamGatewayError &&
                error.code === "UPSTREAM_TIMEOUT")
                ? "TIMEOUT"
                : error instanceof z.ZodError
                  ? "INVALID_UPSTREAM_RESPONSE"
                  : "UPSTREAM_UNAVAILABLE",
          };
        }
      });
    const results = await Promise.all(tasks);
    const candidates = results.flatMap(({ items }) => items);
    const items: RecallItem[] = [];
    let usedChars = 0;
    let usedTokenUnits = 0;
    const maxTokenUnits = input.budget.max_tokens * 4;
    for (const candidate of candidates) {
      if (
        items.length >= input.budget.max_items ||
        usedChars >= input.budget.max_chars ||
        usedTokenUnits >= maxTokenUnits
      )
        break;
      const selected = takeWithinBudget(
        candidate.content,
        input.budget.max_chars - usedChars,
        maxTokenUnits - usedTokenUnits,
      );
      const content = selected.content;
      if (!content) break;
      items.push({
        ...candidate,
        content,
        truncated: content.length < candidate.content.length,
      });
      usedChars += content.length;
      usedTokenUnits += selected.tokenUnits;
    }
    return {
      items,
      degradedLevels: results.flatMap((result) =>
        result.error ? [{ level: result.level, code: result.error }] : [],
      ),
      budget: {
        maxItems: input.budget.max_items,
        maxChars: input.budget.max_chars,
        maxTokens: input.budget.max_tokens,
        usedItems: items.length,
        usedChars,
        estimatedTokens: Math.ceil(usedTokenUnits / 4),
        exhausted:
          items.length < candidates.length ||
          usedChars >= input.budget.max_chars ||
          usedTokenUnits >= maxTokenUnits ||
          items.some(({ truncated }) => truncated),
      },
    };
  }

  private async fetchLevel(
    level: RecallLevel,
    query: string,
    limit: number,
    requestId: string,
    signal: AbortSignal,
  ): Promise<RecallItem[]> {
    if (level === "L0") {
      const response = await this.call(
        "/v2/conversation/search",
        { query, limit },
        requestId,
        signal,
      );
      return parseData(response, l0DataSchema)
        .messages.map((item) => ({
          id: item.id,
          level,
          content: item.content,
          score: item.score,
          ...(item.timestamp ? { createdAt: item.timestamp } : {}),
          truncated: false,
        }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    }
    if (level === "L1") {
      const response = await this.call(
        "/v2/atomic/search",
        { query, limit },
        requestId,
        signal,
      );
      return parseData(response, l1DataSchema)
        .items.map((item) => ({
          id: item.id,
          level,
          content: item.content,
          score: item.score,
          ...(item.created_at ? { createdAt: item.created_at } : {}),
          ...(item.updated_at ? { updatedAt: item.updated_at } : {}),
          truncated: false,
        }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    }
    if (level === "L3") {
      const response = await this.call("/v2/core/read", {}, requestId, signal);
      const file = parseData(response, l3FileSchema);
      return file.content
        ? [
            {
              id: "persona.md",
              level,
              content: file.content,
              source: "persona.md",
              ...(file.created_at ? { createdAt: file.created_at } : {}),
              ...(file.updated_at ? { updatedAt: file.updated_at } : {}),
              truncated: false,
            },
          ]
        : [];
    }

    const listed = parseData(
      await this.call("/v2/scenario/ls", {}, requestId, signal),
      l2ListSchema,
    );
    const ranked = listed.entries
      .filter(({ path }) => !path.endsWith("/"))
      .map((entry) => ({
        ...entry,
        score: lexicalScore(query, `${entry.path} ${entry.summary ?? ""}`),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.updated_at ?? "").localeCompare(a.updated_at ?? "") ||
          a.path.localeCompare(b.path),
      )
      .slice(0, limit);
    const items: RecallItem[] = [];
    for (const entry of ranked) {
      if (signal.aborted) throw signal.reason;
      const file = parseData(
        await this.call(
          "/v2/scenario/read",
          { path: entry.path },
          requestId,
          signal,
        ),
        l2FileSchema,
      );
      if (file.content) {
        items.push({
          id: entry.path,
          level,
          content: file.content,
          score: entry.score,
          source: entry.path,
          ...(file.created_at ? { createdAt: file.created_at } : {}),
          ...(file.updated_at ? { updatedAt: file.updated_at } : {}),
          truncated: false,
        });
      }
    }
    return items;
  }

  private async call(
    path: string,
    body: unknown,
    requestId: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const result = await this.upstream.request({
      path,
      body,
      requestId,
      timeoutMs: this.upstreamTimeoutMs,
      signal,
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error("UPSTREAM_REJECTED");
    }
    return result.body;
  }
}
