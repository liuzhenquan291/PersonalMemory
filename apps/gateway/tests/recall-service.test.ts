import { describe, expect, it, vi } from "vitest";
import {
  RecallService,
  unifiedRecallRequestSchema,
} from "../src/recall-service.js";
import { UpstreamGatewayError } from "../src/upstream-client.js";
import type { UpstreamGatewayClient } from "../src/types.js";
import {
  MemoryGovernanceLedger,
  MemoryStateLedger,
  MemoryReviewLedger,
  defaultMigrations,
  migrateDatabase,
} from "@personalmemory/core";
import { DatabaseSync } from "node:sqlite";

function envelope(data: unknown) {
  return { status: 200, body: { code: 0, message: "ok", data } };
}

function parse(input: unknown) {
  return unifiedRecallRequestSchema.parse(input);
}

describe("RecallService", () => {
  it("does not inject pending or rejected L1 memories", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      migrateDatabase(database, defaultMigrations);
      const reviews = new MemoryReviewLedger(database);
      reviews.set("L1", "approved", "approved", 0);
      reviews.set("L1", "rejected", "rejected", 0, "wrong");
      const upstream: UpstreamGatewayClient = {
        async request() {
          return envelope({
            items: [
              { id: "pending", content: "pending", score: 1 },
              { id: "approved", content: "approved", score: 0.9 },
              { id: "rejected", content: "rejected", score: 0.8 },
            ],
          });
        },
      };
      const result = await new RecallService(
        upstream,
        1_000,
        undefined,
        reviews,
      ).recall(parse({ query: "query", levels: ["L1"] }), "request-1");
      expect(result.items.map(({ id }) => id)).toEqual(["approved"]);
    } finally {
      database.close();
    }
  });
  it("filters levels before upstream calls and sorts equal-score IDs deterministically", async () => {
    const upstream: UpstreamGatewayClient = {
      request: vi.fn(async ({ path }) => {
        expect(path).toBe("/v2/atomic/search");
        return envelope({
          items: [
            { id: "b", content: "second", score: 0.5 },
            { id: "a", content: "first", score: 0.5 },
          ],
        });
      }),
    };
    const result = await new RecallService(upstream, 1_000).recall(
      parse({ query: "query", levels: ["L1", "L1"] }),
      "request-1",
    );
    expect(result.items.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(upstream.request).toHaveBeenCalledTimes(1);
  });

  it("enforces item, character, and estimated token budgets after retrieval", async () => {
    const upstream: UpstreamGatewayClient = {
      async request() {
        return envelope({
          items: [
            { id: "a", content: "a".repeat(300), score: 1 },
            { id: "b", content: "b".repeat(300), score: 0.5 },
          ],
        });
      },
    };
    const result = await new RecallService(upstream, 1_000).recall(
      parse({
        query: "query",
        levels: ["L1"],
        budget: {
          max_items: 2,
          max_chars: 500,
          max_tokens: 100,
          timeout_ms: 1_000,
        },
      }),
      "request-1",
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[1]).toMatchObject({ id: "b", truncated: true });
    expect(result.budget).toMatchObject({
      usedChars: 400,
      estimatedTokens: 100,
      exhausted: true,
    });
  });

  it("conservatively enforces token budgets for non-ASCII content", async () => {
    const upstream: UpstreamGatewayClient = {
      async request() {
        return envelope({
          items: [{ id: "cjk", content: "记".repeat(100), score: 1 }],
        });
      },
    };
    const result = await new RecallService(upstream, 1_000).recall(
      parse({
        query: "记忆",
        levels: ["L1"],
        budget: {
          max_items: 1,
          max_chars: 500,
          max_tokens: 32,
          timeout_ms: 1_000,
        },
      }),
      "request-1",
    );
    expect(result.items[0]).toMatchObject({
      content: "记".repeat(16),
      truncated: true,
    });
    expect(result.budget).toMatchObject({
      usedChars: 16,
      estimatedTokens: 32,
      exhausted: true,
    });
  });

  it("returns a valid empty result when no memories match", async () => {
    const upstream: UpstreamGatewayClient = {
      async request() {
        return envelope({ items: [] });
      },
    };
    await expect(
      new RecallService(upstream, 1_000).recall(
        parse({ query: "missing", levels: ["L1"] }),
        "request-1",
      ),
    ).resolves.toMatchObject({
      items: [],
      degradedLevels: [],
      budget: { usedItems: 0, exhausted: false },
    });
  });

  it("returns successful levels while marking a timed-out level degraded", async () => {
    const upstream: UpstreamGatewayClient = {
      async request({ path, signal }) {
        if (path === "/v2/atomic/search") {
          return envelope({
            items: [{ id: "l1", content: "available", score: 1 }],
          });
        }
        await new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          }),
        );
        return envelope({ messages: [] });
      },
    };
    const result = await new RecallService(upstream, 1_000).recall(
      parse({
        query: "query",
        levels: ["L1", "L0"],
        budget: {
          max_items: 10,
          max_chars: 1_000,
          max_tokens: 250,
          timeout_ms: 50,
        },
      }),
      "request-1",
    );
    expect(result.items).toMatchObject([{ id: "l1", level: "L1" }]);
    expect(result.degradedLevels).toEqual([{ level: "L0", code: "TIMEOUT" }]);
  });

  it("classifies the shorter upstream timeout as a timeout degradation", async () => {
    const upstream: UpstreamGatewayClient = {
      async request() {
        throw new UpstreamGatewayError("timed out", "UPSTREAM_TIMEOUT");
      },
    };
    await expect(
      new RecallService(upstream, 10).recall(
        parse({ query: "query", levels: ["L1"] }),
        "request-1",
      ),
    ).resolves.toMatchObject({
      items: [],
      degradedLevels: [{ level: "L1", code: "TIMEOUT" }],
    });
  });

  it("reads L2 and L3 through allowlisted read-only routes with stable L2 ranking", async () => {
    const upstream: UpstreamGatewayClient = {
      async request({ path, body }) {
        if (path === "/v2/scenario/ls") {
          return envelope({
            entries: [
              {
                path: "other.md",
                summary: "unrelated",
                updated_at: "2026-01-02T00:00:00Z",
              },
              {
                path: "project.md",
                summary: "local memory project",
                updated_at: "2026-01-01T00:00:00Z",
              },
              { path: "folder/", updated_at: "2026-01-03T00:00:00Z" },
            ],
          });
        }
        if (path === "/v2/scenario/read") {
          const selected = (body as { path: string }).path;
          return envelope({
            path: selected,
            content: `content:${selected}`,
            created_at: null,
            updated_at: null,
          });
        }
        return envelope({
          content: "persona",
          created_at: null,
          updated_at: null,
        });
      },
    };
    const result = await new RecallService(upstream, 1_000).recall(
      parse({ query: "local memory", levels: ["L2", "L3"] }),
      "request-1",
    );
    expect(result.items.map(({ id }) => id)).toEqual([
      "project.md",
      "other.md",
      "persona.md",
    ]);
    expect(
      result.items.every(({ level }) => ["L2", "L3"].includes(level)),
    ).toBe(true);
  });

  it("treats malformed upstream bodies as a bounded degraded result", async () => {
    const upstream: UpstreamGatewayClient = {
      async request() {
        return { status: 200, body: { private: "malformed" } };
      },
    };
    await expect(
      new RecallService(upstream, 1_000).recall(
        parse({ query: "query", levels: ["L1"] }),
        "request-1",
      ),
    ).resolves.toMatchObject({
      items: [],
      degradedLevels: [{ level: "L1", code: "INVALID_UPSTREAM_RESPONSE" }],
    });
  });

  it("keeps invalidated memories suppressed after upstream reindexing", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      migrateDatabase(database, defaultMigrations);
      const states = new MemoryStateLedger(database);
      states.set("L1", "resurrected", "invalidated", 0, "incorrect");
      const upstream: UpstreamGatewayClient = {
        async request() {
          return envelope({
            items: [
              { id: "resurrected", content: "stale", score: 1 },
              { id: "active", content: "current", score: 0.8 },
            ],
          });
        },
      };
      const result = await new RecallService(upstream, 1_000, states).recall(
        parse({ query: "query", levels: ["L1"] }),
        "request-1",
      );
      expect(result.items.map(({ id }) => id)).toEqual(["active"]);
    } finally {
      database.close();
    }
  });

  it("excludes future, expired, and superseded memories from recall", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      migrateDatabase(database, defaultMigrations);
      const governance = new MemoryGovernanceLedger(
        database,
        () => "2026-08-12T00:00:00.000Z",
      );
      governance.setValidity(
        "L1",
        "expired",
        undefined,
        "2026-08-11T00:00:00.000Z",
        0,
      );
      governance.setValidity(
        "L1",
        "future",
        "2026-08-13T00:00:00.000Z",
        undefined,
        0,
      );
      governance.addRelation({
        id: "supersedes-1",
        level: "L1",
        kind: "supersedes",
        sourceMemoryId: "current",
        targetMemoryId: "old",
        reason: "merged",
      });
      governance.addRelation({
        id: "conflict-1",
        level: "L1",
        kind: "conflicts_with",
        sourceMemoryId: "conflict-a",
        targetMemoryId: "conflict-b",
        reason: "user confirmed conflict",
      });
      const upstream: UpstreamGatewayClient = {
        async request() {
          return envelope({
            items: [
              { id: "expired", content: "expired", score: 1 },
              { id: "future", content: "future", score: 0.9 },
              { id: "old", content: "old", score: 0.8 },
              { id: "current", content: "current", score: 0.7 },
              { id: "conflict-a", content: "a", score: 0.6 },
              { id: "conflict-b", content: "b", score: 0.5 },
            ],
          });
        },
      };
      const result = await new RecallService(
        upstream,
        1_000,
        undefined,
        undefined,
        governance,
      ).recall(parse({ query: "query", levels: ["L1"] }), "request-1");
      expect(result.items.map(({ id }) => id)).toEqual(["current"]);
    } finally {
      database.close();
    }
  });
});
