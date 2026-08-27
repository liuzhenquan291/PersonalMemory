import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PERSONAL_MEMORY_MCP_CONTRACT_VERSION,
  UNTRUSTED_MEMORY_WARNING,
  captureExchangeOutputSchema,
  prepareForgetOutputSchema,
  readMemoryOutputSchema,
  searchMemoriesOutputSchema,
  submitFeedbackOutputSchema,
  type CaptureExchangeInput,
  type CaptureExchangeOutput,
  type McpMemoryLevel,
  type PrepareForgetInput,
  type PrepareForgetOutput,
  type ReadMemoryInput,
  type ReadMemoryOutput,
  type SearchMemoriesInput,
  type SearchMemoriesOutput,
  type SubmitFeedbackInput,
  type SubmitFeedbackOutput,
} from "./contract.js";
import { GatewayClientError } from "./gateway-client.js";
import type { PersonalMemoryGatewayClient } from "./gateway-client.js";

const MAX_SEARCH_SESSIONS = 32;
const SEARCH_SESSION_TTL_MS = 5 * 60_000;

const reviewSchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]),
  revision: z.number().int().nonnegative(),
});
const recallResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      level: z.enum(["L0", "L1", "L2", "L3"]),
      content: z.string(),
      score: z.number().optional(),
      source: z.string().optional(),
      source_reference_count: z.number().int().nonnegative().optional(),
      review: reviewSchema.optional(),
      truncated: z.boolean(),
    }),
  ),
  degraded_levels: z.array(
    z.object({
      level: z.enum(["L0", "L1", "L2", "L3"]),
      code: z.enum([
        "TIMEOUT",
        "UPSTREAM_UNAVAILABLE",
        "INVALID_UPSTREAM_RESPONSE",
      ]),
    }),
  ),
  page: z.object({
    offset: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    has_more: z.boolean(),
  }),
  budget: z.object({
    used_chars: z.number().int().nonnegative(),
    estimated_tokens: z.number().int().nonnegative(),
    exhausted: z.boolean(),
  }),
});
const exactMemoryResponseSchema = z.object({
  id: z.string(),
  level: z.enum(["L0", "L1", "L2", "L3"]),
  content: z.string(),
  score: z.number().optional(),
  source: z.object({
    status: z.enum(["original", "unavailable"]),
    reference_count: z.number().int().nonnegative(),
    message_ids: z.array(z.string()).max(20).optional(),
    references_truncated: z.boolean(),
  }),
  review: reviewSchema.optional(),
});
const captureResponseSchema = z.object({
  id: z.string(),
  status: z.enum([
    "pending",
    "running",
    "completed",
    "partial",
    "failed",
    "cancelled",
  ]),
  progress: z.object({
    total: z.number().int(),
    completed: z.number().int(),
    failed: z.number().int(),
  }),
});
const feedbackResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      review: reviewSchema.optional(),
      code: z.enum(["CONFLICT", "UPSTREAM_REJECTED"]).optional(),
    }),
  ),
});
const handoffResponseSchema = z.object({
  handoff_id: z.string(),
  expires_at: z.string().datetime(),
  scope: z.object({
    source_l0: z.number().int().nonnegative(),
    index_l1: z.number().int().nonnegative(),
    derived_l2: z.number().int().nonnegative(),
    derived_l3: z.number().int().nonnegative(),
    readable_l0: z.number().int().nonnegative(),
    readable_l1: z.number().int().nonnegative(),
    managed_copies: z.number().int().nonnegative(),
  }),
  limitations: z.array(z.string()),
});

interface SearchSession {
  fingerprint: string;
  nextOffset: number;
  expiresAt: number;
}

function sourceFor(level: McpMemoryLevel, referenceCount = 0) {
  if (level === "L0") {
    return {
      status: "original" as const,
      reference_count: 1,
      references_truncated: true,
    };
  }
  return referenceCount > 0
    ? {
        status: "original" as const,
        reference_count: referenceCount,
        references_truncated: true,
      }
    : {
        status: "unavailable" as const,
        reference_count: 0,
        references_truncated: false,
      };
}

function fingerprint(input: SearchMemoriesInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        query: input.query,
        levels: input.levels,
        page_size: input.page_size,
        budget: input.budget,
      }),
    )
    .digest("hex");
}

export class PersonalMemoryMcpService {
  readonly #searches = new Map<string, SearchSession>();

  constructor(
    private readonly gateway: PersonalMemoryGatewayClient,
    private readonly now: () => number = Date.now,
    private readonly randomId: () => string = randomUUID,
  ) {}

  async preflight(signal?: AbortSignal): Promise<void> {
    await this.gateway.preflight(signal);
  }

  async search(
    input: SearchMemoriesInput,
    signal?: AbortSignal,
  ): Promise<SearchMemoriesOutput> {
    this.sweepSearches();
    const requestFingerprint = fingerprint(input);
    let offset = 0;
    if (input.cursor) {
      const session = this.#searches.get(input.cursor);
      if (!session || session.expiresAt <= this.now()) {
        throw new GatewayClientError(
          400,
          "INVALID_ARGUMENT",
          "Search cursor expired; start a new search",
        );
      }
      if (session.fingerprint !== requestFingerprint) {
        throw new GatewayClientError(
          400,
          "INVALID_ARGUMENT",
          "Search cursor does not match this request",
        );
      }
      offset = session.nextOffset;
      this.#searches.delete(input.cursor);
    }
    const response = await this.gateway.post(
      "/api/v1/recall/query",
      {
        query: input.query,
        levels: input.levels,
        offset,
        budget: {
          max_items: input.page_size,
          max_chars: input.budget.max_chars,
          max_tokens: input.budget.max_tokens,
          timeout_ms: input.budget.timeout_ms,
        },
      },
      recallResponseSchema,
      {
        timeoutMs: input.budget.timeout_ms + 250,
        ...(signal ? { signal } : {}),
      },
    );
    let nextCursor: string | undefined;
    if (
      response.data.items.length > 0 &&
      response.data.page.has_more &&
      offset + response.data.items.length <= 40
    ) {
      nextCursor = this.randomId();
      this.#searches.set(nextCursor, {
        fingerprint: requestFingerprint,
        nextOffset: offset + response.data.items.length,
        expiresAt: this.now() + SEARCH_SESSION_TTL_MS,
      });
    }
    return searchMemoriesOutputSchema.parse({
      contract_version: PERSONAL_MEMORY_MCP_CONTRACT_VERSION,
      data_classification: "untrusted_memory_data",
      usage_warning: UNTRUSTED_MEMORY_WARNING,
      items: response.data.items.map((item) => ({
        id: item.id,
        level: item.level,
        content: item.content,
        ...(item.score === undefined ? {} : { score: item.score }),
        source: sourceFor(item.level, item.source_reference_count),
        ...(item.review ? { review: item.review } : {}),
        truncated: item.truncated,
      })),
      page: {
        count: response.data.items.length,
        has_more: Boolean(nextCursor),
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      },
      budget: response.data.budget,
      degraded_levels: response.data.degraded_levels,
    });
  }

  async read(
    input: ReadMemoryInput,
    signal?: AbortSignal,
  ): Promise<ReadMemoryOutput> {
    const response = await this.gateway.get(
      `/api/v1/memory?${new URLSearchParams({
        level: input.level,
        id: input.memory_id,
      }).toString()}`,
      exactMemoryResponseSchema,
      { timeoutMs: 10_000, ...(signal ? { signal } : {}) },
    );
    const item = response.data;
    const content = item.content.slice(0, input.max_chars);
    return readMemoryOutputSchema.parse({
      contract_version: PERSONAL_MEMORY_MCP_CONTRACT_VERSION,
      data_classification: "untrusted_memory_data",
      usage_warning: UNTRUSTED_MEMORY_WARNING,
      memory: {
        id: item.id,
        level: item.level,
        content,
        ...(item.score === undefined ? {} : { score: item.score }),
        source: item.source,
        ...(item.review ? { review: item.review } : {}),
        truncated: content.length < item.content.length,
      },
    });
  }

  async capture(
    input: CaptureExchangeInput,
    signal?: AbortSignal,
  ): Promise<CaptureExchangeOutput> {
    const response = await this.gateway.post(
      "/api/v1/conversations/capture",
      {
        idempotency_key: input.idempotency_key,
        session: { session_key: input.session_key, messages: input.messages },
      },
      captureResponseSchema,
      { timeoutMs: input.timeout_ms, ...(signal ? { signal } : {}) },
    );
    return captureExchangeOutputSchema.parse({
      contract_version: PERSONAL_MEMORY_MCP_CONTRACT_VERSION,
      job_id: response.data.id,
      status: ["pending", "running"].includes(response.data.status)
        ? "processing"
        : response.data.status === "cancelled"
          ? "failed"
          : response.data.status,
      duplicate: response.status === 200,
      completed_rounds: response.data.progress.completed,
      failed_rounds: response.data.progress.failed,
      retryable: ["partial", "failed", "cancelled"].includes(
        response.data.status,
      ),
    });
  }

  async feedback(
    input: SubmitFeedbackInput,
    signal?: AbortSignal,
  ): Promise<SubmitFeedbackOutput> {
    const response = await this.gateway.post(
      "/api/v1/memory-reviews",
      {
        items: [
          {
            id: input.memory_id,
            action: input.action === "reject" ? "reject" : "approve",
            expected_revision: input.expected_review_revision,
            ...(input.corrected_content
              ? { content: input.corrected_content }
              : {}),
            ...(input.reason ? { reason: input.reason } : {}),
          },
        ],
      },
      feedbackResponseSchema,
      { timeoutMs: 10_000, ...(signal ? { signal } : {}) },
    );
    const result = response.data.results[0];
    if (!result?.ok || !result.review) {
      throw new GatewayClientError(
        409,
        result?.code === "CONFLICT"
          ? "MEMORY_CONFLICT"
          : "UPSTREAM_UNAVAILABLE",
        result?.code === "CONFLICT"
          ? "Memory changed after it was read"
          : "The local memory kernel rejected feedback",
      );
    }
    return submitFeedbackOutputSchema.parse({
      contract_version: PERSONAL_MEMORY_MCP_CONTRACT_VERSION,
      memory_id: input.memory_id,
      status: result.review.status,
      review_revision: result.review.revision,
      content_changed: input.action === "correct_and_approve",
    });
  }

  async prepareForget(
    input: PrepareForgetInput,
    signal?: AbortSignal,
  ): Promise<PrepareForgetOutput> {
    const response = await this.gateway.post(
      "/api/v1/privacy-deletions/handoffs",
      { level: "L1", memory_id: input.memory_id },
      handoffResponseSchema,
      { timeoutMs: 10_000, ...(signal ? { signal } : {}) },
    );
    return prepareForgetOutputSchema.parse({
      contract_version: PERSONAL_MEMORY_MCP_CONTRACT_VERSION,
      handoff_id: response.data.handoff_id,
      expires_at: response.data.expires_at,
      web_confirmation_required: true,
      destructive_action_performed: false,
      scope: response.data.scope,
      limitations: response.data.limitations,
    });
  }

  private sweepSearches(): void {
    for (const [cursor, session] of this.#searches) {
      if (session.expiresAt <= this.now()) this.#searches.delete(cursor);
    }
    while (this.#searches.size >= MAX_SEARCH_SESSIONS) {
      const oldest = this.#searches.keys().next().value;
      if (!oldest) break;
      this.#searches.delete(oldest);
    }
  }
}
