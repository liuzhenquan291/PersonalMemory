import {
  MemoryReviewConflictError,
  type MemoryReview,
  type MemoryReviewLedger,
} from "@personalmemory/core";
import { z } from "zod";
import type { UpstreamGatewayClient } from "./types.js";

export const memoryReviewBatchSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(2_048),
            action: z.enum(["approve", "reject"]),
            expected_revision: z.number().int().min(0),
            content: z.string().min(1).max(100_000).optional(),
            reason: z.string().min(1).max(500).optional(),
          })
          .strict()
          .superRefine((item, context) => {
            if (item.action === "reject" && !item.reason) {
              context.addIssue({
                code: "custom",
                message: "Rejected memories require a reason",
                path: ["reason"],
              });
            }
            if (item.action === "reject" && item.content) {
              context.addIssue({
                code: "custom",
                message: "Rejected memories cannot update content",
                path: ["content"],
              });
            }
          }),
      )
      .min(1)
      .max(50),
  })
  .strict();

export interface MemoryReviewResult {
  id: string;
  ok: boolean;
  review?: MemoryReview;
  code?: "CONFLICT" | "UPSTREAM_REJECTED";
}

export class MemoryReviewService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly reviews: MemoryReviewLedger,
    private readonly upstream: UpstreamGatewayClient,
    private readonly timeoutMs: number,
  ) {}

  async applyBatch(
    items: z.infer<typeof memoryReviewBatchSchema>["items"],
    requestId: string,
  ): Promise<MemoryReviewResult[]> {
    return await Promise.all(
      items.map((item, index) => this.applyOne(item, `${requestId}:${index}`)),
    );
  }

  private async applyOne(
    item: z.infer<typeof memoryReviewBatchSchema>["items"][number],
    requestId: string,
  ): Promise<MemoryReviewResult> {
    return await this.withLock(item.id, async () => {
      try {
        if (item.action === "approve" && item.content) {
          const result = await this.upstream
            .request({
              path: "/v2/atomic/update",
              body: { id: item.id, content: item.content },
              requestId,
              timeoutMs: this.timeoutMs,
            })
            .catch(() => undefined);
          if (!result) {
            return { id: item.id, ok: false, code: "UPSTREAM_REJECTED" };
          }
          const envelope = z
            .object({ code: z.number() })
            .safeParse(result.body);
          if (
            result.status < 200 ||
            result.status >= 300 ||
            !envelope.success ||
            envelope.data.code !== 0
          ) {
            return { id: item.id, ok: false, code: "UPSTREAM_REJECTED" };
          }
        }
        const review = this.reviews.set(
          "L1",
          item.id,
          item.action === "approve" ? "approved" : "rejected",
          item.expected_revision,
          item.reason,
        );
        return { id: item.id, ok: true, review };
      } catch (error) {
        if (error instanceof MemoryReviewConflictError) {
          return { id: item.id, ok: false, code: "CONFLICT" };
        }
        throw error;
      }
    });
  }

  private async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}
