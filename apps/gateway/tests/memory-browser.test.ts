import { describe, expect, it, vi } from "vitest";
import {
  MemoryBrowser,
  memoryBrowseQuerySchema,
} from "../src/memory-browser.js";
import type { UpstreamGatewayClient } from "../src/types.js";
import {
  MemoryStateLedger,
  defaultMigrations,
  migrateDatabase,
} from "@personalmemory/core";
import { DatabaseSync } from "node:sqlite";

function envelope(data: unknown) {
  return { status: 200, body: { code: 0, data } };
}

describe("MemoryBrowser", () => {
  it("uses upstream pagination before returning a stable L1 page", async () => {
    const request = vi.fn(async () =>
      envelope({
        items: [
          {
            id: "m2",
            type: "fact",
            content: "second",
            updated_at: "2026-01-02T00:00:00Z",
            source_message_ids: ["source-2"],
          },
        ],
        total: 3,
      }),
    );
    const result = await new MemoryBrowser({ request }, 1_000).browse(
      memoryBrowseQuerySchema.parse({ level: "L1", page: 2, page_size: 1 }),
      "request-1",
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/v2/atomic/query",
        body: { limit: 1, offset: 1 },
      }),
    );
    expect(result).toMatchObject({
      page: 2,
      total: 3,
      hasPrevious: true,
      hasNext: true,
      items: [
        { id: "m2", source: { status: "original", label: "1 条对话原文" } },
      ],
    });
  });

  it("marks L0 messages as original rather than inferred", async () => {
    const upstream: UpstreamGatewayClient = {
      async request() {
        return envelope({
          messages: [
            {
              id: "source-1",
              role: "user",
              content: "原始消息",
              timestamp: "2026-01-01T00:00:00Z",
            },
          ],
          total: 1,
        });
      },
    };
    const result = await new MemoryBrowser(upstream, 1_000).browse(
      memoryBrowseQuerySchema.parse({ level: "L0" }),
      "request-1",
    );
    expect(result.items[0]).toMatchObject({
      id: "source-1",
      source: { status: "original", label: "对话原文" },
    });
  });

  it("filters and paginates L2 before reading selected details", async () => {
    const request = vi.fn(async ({ path, body }) => {
      if (path === "/v2/scenario/ls") {
        return envelope({
          entries: [
            { path: "work.md", summary: "工作记录" },
            { path: "travel.md", summary: "旅行计划" },
          ],
        });
      }
      return envelope({
        path: (body as { path: string }).path,
        content: "旅行详情",
        updated_at: null,
      });
    });
    const result = await new MemoryBrowser({ request }, 1_000).browse(
      memoryBrowseQuerySchema.parse({ level: "L2", query: "旅行" }),
      "request-1",
    );
    expect(result.items).toMatchObject([
      { id: "travel.md", source: { status: "unavailable" } },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("returns an empty L3 page when the profile does not match", async () => {
    const upstream: UpstreamGatewayClient = {
      async request() {
        return envelope({ content: "偏好简洁回答", updated_at: null });
      },
    };
    const result = await new MemoryBrowser(upstream, 1_000).browse(
      memoryBrowseQuerySchema.parse({ level: "L3", query: "旅行" }),
      "request-1",
    );
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("hides invalidated memories even when upstream indexing returns them", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      migrateDatabase(database, defaultMigrations);
      const states = new MemoryStateLedger(database);
      states.set("L1", "hidden", "invalidated", 0, "incorrect");
      const upstream: UpstreamGatewayClient = {
        async request() {
          return envelope({
            items: [
              {
                id: "hidden",
                type: "fact",
                content: "must stay hidden",
                updated_at: "2026-08-11T00:00:00Z",
              },
            ],
            total: 1,
          });
        },
      };
      const result = await new MemoryBrowser(upstream, 1_000, states).browse(
        memoryBrowseQuerySchema.parse({ level: "L1" }),
        "request-1",
      );
      expect(result.items).toEqual([]);
      expect(result.total).toBeNull();
    } finally {
      database.close();
    }
  });
});
