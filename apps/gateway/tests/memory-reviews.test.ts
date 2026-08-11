import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryReviewLedger,
  defaultMigrations,
  migrateDatabase,
} from "@personalmemory/core";
import {
  MemoryReviewService,
  memoryReviewBatchSchema,
} from "../src/memory-reviews.js";

function harness() {
  const database = new DatabaseSync(":memory:");
  migrateDatabase(database, defaultMigrations);
  const reviews = new MemoryReviewLedger(
    database,
    () => "2026-08-11T00:00:00.000Z",
  );
  const upstream = {
    request: vi.fn(async () => ({
      status: 200,
      body: { code: 0, data: { id: "memory-1" } },
    })),
  };
  return {
    database,
    reviews,
    upstream,
    service: new MemoryReviewService(reviews, upstream, 1_000),
  };
}

describe("MemoryReviewService", () => {
  it("approves after an optional correction reaches upstream", async () => {
    const { database, reviews, service, upstream } = harness();
    try {
      const results = await service.applyBatch(
        memoryReviewBatchSchema.parse({
          items: [
            {
              id: "memory-1",
              action: "approve",
              expected_revision: 0,
              content: "修正后的事实",
            },
          ],
        }).items,
        "request-1",
      );
      expect(upstream.request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/v2/atomic/update",
          body: { id: "memory-1", content: "修正后的事实" },
        }),
      );
      expect(results).toMatchObject([
        {
          id: "memory-1",
          ok: true,
          review: { status: "approved", revision: 1 },
        },
      ]);
      expect(reviews.isApproved("L1", "memory-1")).toBe(true);
    } finally {
      database.close();
    }
  });

  it("keeps review pending when correction fails and isolates batch conflicts", async () => {
    const { database, reviews, service, upstream } = harness();
    try {
      upstream.request.mockResolvedValueOnce({ status: 503, body: {} });
      reviews.set("L1", "stale", "approved", 0);
      const results = await service.applyBatch(
        [
          {
            id: "upstream-failure",
            action: "approve",
            expected_revision: 0,
            content: "new content",
          },
          {
            id: "stale",
            action: "reject",
            expected_revision: 0,
            reason: "wrong",
          },
        ],
        "request-1",
      );
      expect(results).toEqual([
        { id: "upstream-failure", ok: false, code: "UPSTREAM_REJECTED" },
        { id: "stale", ok: false, code: "CONFLICT" },
      ]);
      expect(reviews.get("L1", "upstream-failure").status).toBe("pending");
    } finally {
      database.close();
    }
  });

  it("isolates an upstream transport failure within a batch", async () => {
    const { database, reviews, service, upstream } = harness();
    try {
      upstream.request.mockRejectedValueOnce(new Error("connection closed"));
      const results = await service.applyBatch(
        [
          {
            id: "transport-failure",
            action: "approve",
            expected_revision: 0,
            content: "new content",
          },
          { id: "healthy", action: "approve", expected_revision: 0 },
        ],
        "request-1",
      );
      expect(results).toEqual([
        { id: "transport-failure", ok: false, code: "UPSTREAM_REJECTED" },
        expect.objectContaining({ id: "healthy", ok: true }),
      ]);
      expect(reviews.get("L1", "transport-failure").status).toBe("pending");
      expect(reviews.get("L1", "healthy").status).toBe("approved");
    } finally {
      database.close();
    }
  });
});
