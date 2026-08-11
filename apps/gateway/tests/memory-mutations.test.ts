import {
  MemoryStateLedger,
  defaultMigrations,
  migrateDatabase,
} from "@personalmemory/core";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { MemoryMutationService } from "../src/memory-mutations.js";
import type { MemoryMutationError } from "../src/memory-mutations.js";
import type { UpstreamGatewayClient } from "../src/types.js";

async function withService(
  upstream: UpstreamGatewayClient,
  run: (
    service: MemoryMutationService,
    states: MemoryStateLedger,
  ) => Promise<void>,
): Promise<void> {
  const database = new DatabaseSync(":memory:");
  try {
    migrateDatabase(database, defaultMigrations);
    const states = new MemoryStateLedger(
      database,
      () => "2026-08-11T00:00:00.000Z",
    );
    await run(new MemoryMutationService(states, upstream, 1_000), states);
  } finally {
    database.close();
  }
}

describe("MemoryMutationService", () => {
  it("updates L1 before recording a new active revision", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      body: { code: 0, data: { id: "memory-1" } },
    }));
    await withService({ request }, async (service) => {
      const state = await service.update(
        "L1",
        "memory-1",
        "修正内容",
        0,
        "request-1",
      );
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/v2/atomic/update",
          body: { id: "memory-1", content: "修正内容" },
        }),
      );
      expect(state).toMatchObject({ status: "active", revision: 1 });
    });
  });

  it("serializes same-memory writes and rejects the stale revision", async () => {
    const upstream: UpstreamGatewayClient = {
      async request() {
        return { status: 200, body: { code: 0 } };
      },
    };
    await withService(upstream, async (service) => {
      const first = service.update("L2", "scene.md", "first", 0, "one");
      const stale = service.update("L2", "scene.md", "stale", 0, "two");
      await expect(first).resolves.toMatchObject({ revision: 1 });
      await expect(stale).rejects.toMatchObject<MemoryMutationError>({
        code: "CONFLICT",
      });
    });
  });

  it("uses the level-specific L2 and L3 write routes", async () => {
    const request = vi.fn(async () => ({ status: 200, body: { code: 0 } }));
    await withService({ request }, async (service) => {
      await service.update("L2", "work/project.md", "情境", 0, "l2");
      await service.update("L3", "persona.md", "画像", 0, "l3");
      expect(request).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          path: "/v2/scenario/write",
          body: { path: "work/project.md", content: "情境" },
        }),
      );
      expect(request).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          path: "/v2/core/write",
          body: { content: "画像" },
        }),
      );
    });
  });

  it("does not implicitly restore an invalidated memory through update", async () => {
    const request = vi.fn(async () => ({ status: 200, body: { code: 0 } }));
    await withService({ request }, async (service) => {
      await service.invalidate("L1", "memory-1", "错误", 0);
      await expect(
        service.update("L1", "memory-1", "new", 1, "request-1"),
      ).rejects.toMatchObject<MemoryMutationError>({
        code: "INVALIDATED_MEMORY",
      });
      expect(request).not.toHaveBeenCalled();
    });
  });

  it("keeps a deletion tombstone when the upstream delete fails", async () => {
    const upstream: UpstreamGatewayClient = {
      async request() {
        throw new Error("unavailable");
      },
    };
    await withService(upstream, async (service, states) => {
      const result = await service.deleteL1(
        "memory-1",
        "DELETE L1:memory-1",
        "用户确认删除",
        0,
        "request-1",
      );
      expect(result.upstreamDeleted).toBe(false);
      expect(states.get("L1", "memory-1")).toMatchObject({
        status: "deleted",
        revision: 1,
      });
    });
  });

  it("retries upstream cleanup without changing an existing tombstone", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ status: 200, body: { code: 0 } });
    await withService({ request }, async (service) => {
      const first = await service.deleteL1(
        "memory-1",
        "DELETE L1:memory-1",
        "用户确认删除",
        0,
        "request-1",
      );
      const retry = await service.deleteL1(
        "memory-1",
        "DELETE L1:memory-1",
        "用户确认删除",
        1,
        "request-2",
      );
      expect(first.upstreamDeleted).toBe(false);
      expect(retry).toMatchObject({
        upstreamDeleted: true,
        state: { status: "deleted", revision: 1 },
      });
      expect(request).toHaveBeenCalledTimes(2);
    });
  });

  it("rejects deletion without the exact target confirmation", async () => {
    const upstream: UpstreamGatewayClient = {
      async request() {
        throw new Error("must not be called");
      },
    };
    await withService(upstream, async (service) => {
      await expect(
        service.deleteL1("memory-1", "DELETE", "reason", 0, "request-1"),
      ).rejects.toMatchObject<MemoryMutationError>({
        code: "CONFIRMATION_MISMATCH",
      });
    });
  });
});
