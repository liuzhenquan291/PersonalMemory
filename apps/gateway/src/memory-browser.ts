import { z } from "zod";
import type { MemoryStateLedger } from "@personalmemory/core";
import type { UpstreamGatewayClient } from "./types.js";

export const memoryLayerSchema = z.enum(["L0", "L1", "L2", "L3"]);
export type MemoryLayer = z.infer<typeof memoryLayerSchema>;

export const memoryBrowseQuerySchema = z.object({
  level: memoryLayerSchema.default("L1"),
  query: z.string().max(2_048).default(""),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(12),
});

export interface BrowsedMemory {
  id: string;
  level: MemoryLayer;
  title: string;
  content: string;
  updatedAt?: string;
  score?: number;
  state: {
    status: "active";
    revision: number;
  };
  source: {
    status: "original" | "unavailable";
    label: string;
    explanation: string;
  };
}

export interface MemoryBrowseResult {
  items: BrowsedMemory[];
  page: number;
  pageSize: number;
  total: number | null;
  hasPrevious: boolean;
  hasNext: boolean;
}

const envelopeSchema = z.object({ code: z.number(), data: z.unknown() });
const l0Schema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      role: z.string(),
      content: z.string(),
      timestamp: z.string(),
      score: z.number().optional(),
    }),
  ),
  total: z.number().int().nonnegative().optional(),
});
const l1Schema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      content: z.string(),
      updated_at: z.string(),
      score: z.number().optional(),
      source_message_ids: z.array(z.string()).optional(),
    }),
  ),
  total: z.number().int().nonnegative().optional(),
});
const l2Schema = z.object({
  entries: z.array(
    z.object({
      path: z.string(),
      summary: z.string().optional(),
      updated_at: z.string().optional(),
    }),
  ),
});
const fileSchema = z.object({
  content: z.string().nullable(),
  updated_at: z.string().nullable().optional(),
});

function data<T>(body: unknown, schema: z.ZodType<T>): T {
  const envelope = envelopeSchema.parse(body);
  if (envelope.code !== 0) throw new Error("UPSTREAM_REJECTED");
  return schema.parse(envelope.data);
}

function title(content: string, fallback: string): string {
  const firstLine = content.split(/\r?\n/u, 1)[0]?.trim();
  return firstLine ? firstLine.slice(0, 80) : fallback;
}

export class MemoryBrowser {
  constructor(
    private readonly upstream: UpstreamGatewayClient,
    private readonly timeoutMs: number,
    private readonly states?: MemoryStateLedger,
  ) {}

  async browse(
    input: z.output<typeof memoryBrowseQuerySchema>,
    requestId: string,
  ): Promise<MemoryBrowseResult> {
    const offset = (input.page - 1) * input.page_size;
    if (input.level === "L2") {
      return this.applyStates(
        input.level,
        await this.browseL2(input, requestId, offset),
      );
    }
    if (input.level === "L3") {
      return this.applyStates(
        input.level,
        await this.browseL3(input, requestId),
      );
    }

    const searching = input.query.trim().length > 0;
    const requested = searching
      ? Math.min(offset + input.page_size + 1, 50)
      : input.page_size;
    const path =
      input.level === "L1"
        ? searching
          ? "/v2/atomic/search"
          : "/v2/atomic/query"
        : searching
          ? "/v2/conversation/search"
          : "/v2/conversation/query";
    const body = searching
      ? { query: input.query.trim(), limit: requested }
      : { limit: input.page_size, offset };
    const response = await this.call(path, body, requestId);
    let upstreamTotal: number | undefined;
    let allItems: BrowsedMemory[];
    if (input.level === "L1") {
      const parsed = data(response, l1Schema);
      upstreamTotal = parsed.total;
      allItems = parsed.items.map((item) => ({
        id: item.id,
        level: "L1" as const,
        title: title(item.content, item.type || "结构化记忆"),
        content: item.content,
        updatedAt: item.updated_at,
        ...(item.score === undefined ? {} : { score: item.score }),
        state: { status: "active" as const, revision: 0 },
        source: item.source_message_ids?.length
          ? {
              status: "original" as const,
              label: `${item.source_message_ids.length} 条对话原文`,
              explanation: `来源消息 ID：${item.source_message_ids.join(", ")}`,
            }
          : {
              status: "unavailable" as const,
              label: "来源未记录",
              explanation: "这条结构化记忆没有可验证的原消息引用。",
            },
      }));
    } else {
      const parsed = data(response, l0Schema);
      upstreamTotal = parsed.total;
      allItems = parsed.messages.map((item) => ({
        id: item.id,
        level: "L0" as const,
        title: title(item.content, `${item.role} 消息`),
        content: item.content,
        updatedAt: item.timestamp,
        ...(item.score === undefined ? {} : { score: item.score }),
        state: { status: "active" as const, revision: 0 },
        source: {
          status: "original" as const,
          label: "对话原文",
          explanation: "这是本地保存的原始对话消息，不是模型推断。",
        },
      }));
    }
    const items = searching
      ? allItems.slice(offset, offset + input.page_size)
      : allItems;
    const total = searching ? null : (upstreamTotal ?? allItems.length);
    return this.applyStates(input.level, {
      items,
      page: input.page,
      pageSize: input.page_size,
      total,
      hasPrevious: input.page > 1,
      hasNext: searching
        ? allItems.length > offset + input.page_size
        : offset + items.length < (total ?? 0),
    });
  }

  private async browseL2(
    input: z.output<typeof memoryBrowseQuerySchema>,
    requestId: string,
    offset: number,
  ): Promise<MemoryBrowseResult> {
    const listed = data(
      await this.call("/v2/scenario/ls", {}, requestId),
      l2Schema,
    );
    const query = input.query.trim().toLocaleLowerCase();
    const entries = listed.entries
      .filter(({ path }) => !path.endsWith("/"))
      .filter(({ path, summary }) =>
        query
          ? `${path} ${summary ?? ""}`.toLocaleLowerCase().includes(query)
          : true,
      )
      .sort(
        (left, right) =>
          (right.updated_at ?? "").localeCompare(left.updated_at ?? "") ||
          left.path.localeCompare(right.path),
      );
    const selected = entries.slice(offset, offset + input.page_size);
    const items = await Promise.all(
      selected.map(async (entry) => {
        const file = data(
          await this.call("/v2/scenario/read", { path: entry.path }, requestId),
          fileSchema,
        );
        const content = file.content ?? "";
        const updatedAt = file.updated_at ?? entry.updated_at;
        return {
          id: entry.path,
          level: "L2" as const,
          title: title(content, entry.summary ?? entry.path),
          content,
          ...(updatedAt ? { updatedAt } : {}),
          state: { status: "active" as const, revision: 0 },
          source: {
            status: "unavailable" as const,
            label: "来源未记录",
            explanation: "这是情境摘要；当前情境文件没有可验证的 L1 记忆引用。",
          },
        };
      }),
    );
    return {
      items,
      page: input.page,
      pageSize: input.page_size,
      total: entries.length,
      hasPrevious: input.page > 1,
      hasNext: offset + items.length < entries.length,
    };
  }

  private async browseL3(
    input: z.output<typeof memoryBrowseQuerySchema>,
    requestId: string,
  ): Promise<MemoryBrowseResult> {
    const file = data(
      await this.call("/v2/core/read", {}, requestId),
      fileSchema,
    );
    const content = file.content ?? "";
    const matches =
      input.page === 1 &&
      content.length > 0 &&
      (!input.query.trim() ||
        content.toLocaleLowerCase().includes(input.query.toLocaleLowerCase()));
    const items: BrowsedMemory[] = matches
      ? [
          {
            id: "persona.md",
            level: "L3",
            title: title(content, "核心画像"),
            content,
            ...(file.updated_at ? { updatedAt: file.updated_at } : {}),
            state: { status: "active", revision: 0 },
            source: {
              status: "unavailable",
              label: "来源未记录",
              explanation: "这是核心画像；当前文件没有可验证的 L2 情境引用。",
            },
          },
        ]
      : [];
    return {
      items,
      page: input.page,
      pageSize: input.page_size,
      total: input.query.trim() ? (matches ? 1 : 0) : content ? 1 : 0,
      hasPrevious: input.page > 1,
      hasNext: false,
    };
  }

  private async call(
    path: string,
    body: unknown,
    requestId: string,
  ): Promise<unknown> {
    const result = await this.upstream.request({
      path,
      body,
      requestId,
      timeoutMs: this.timeoutMs,
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error("UPSTREAM_REJECTED");
    }
    return result.body;
  }

  private applyStates(
    level: MemoryLayer,
    result: MemoryBrowseResult,
  ): MemoryBrowseResult {
    if (!this.states) return result;
    const states = this.states.getMany(
      result.items.map((item) => ({
        level: item.level,
        memoryId: item.id,
      })),
    );
    const items = result.items
      .filter((item) => {
        const status = states.get(`${item.level}:${item.id}`)?.status;
        return status !== "invalidated" && status !== "deleted";
      })
      .map((item) => {
        const state = states.get(`${item.level}:${item.id}`);
        return {
          ...item,
          state: { status: "active" as const, revision: state?.revision ?? 0 },
        };
      });
    return {
      ...result,
      items,
      total: this.states.countSuppressed(level) > 0 ? null : result.total,
    };
  }
}
