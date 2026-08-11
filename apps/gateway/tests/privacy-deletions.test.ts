import {
  ManagedArtifactLedger,
  MemoryStateLedger,
  defaultMigrations,
  migrateDatabase,
} from "@personalmemory/core";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  PrivacyDeletionService,
  type PrivacyDeletionError,
} from "../src/privacy-deletions.js";
import { MemoryBrowser } from "../src/memory-browser.js";
import type { UpstreamGatewayClient } from "../src/types.js";

const sandboxes: string[] = [];

function sandbox(): string {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "personalmemory-erasure-"),
  );
  sandboxes.push(directory);
  return directory;
}

interface KernelFixture {
  l1: Map<
    string,
    {
      id: string;
      type: string;
      content: string;
      updated_at: string;
      source_message_ids: string[];
    }
  >;
  l0: Set<string>;
  scenarios: Map<string, string>;
  core: string;
  failAtomicDelete: number;
}

function kernel(fixture: KernelFixture): UpstreamGatewayClient {
  return {
    async request({ path, body }) {
      const input = body as Record<string, unknown>;
      if (path === "/v2/atomic/query") {
        const rows = [...fixture.l1.values()];
        const offset = Number(input.offset ?? 0);
        const limit = Number(input.limit ?? 100);
        return {
          status: 200,
          body: {
            code: 0,
            data: {
              items: rows.slice(offset, offset + limit),
              total: rows.length,
            },
          },
        };
      }
      if (path === "/v2/conversation/query") {
        const rows = [...fixture.l0].map((id) => ({ id }));
        const offset = Number(input.offset ?? 0);
        const limit = Number(input.limit ?? 100);
        return {
          status: 200,
          body: {
            code: 0,
            data: {
              messages: rows.slice(offset, offset + limit),
              total: rows.length,
            },
          },
        };
      }
      if (path === "/v2/scenario/ls") {
        return {
          status: 200,
          body: {
            code: 0,
            data: {
              entries: [...fixture.scenarios.keys()].map((value) => ({
                path: value,
              })),
            },
          },
        };
      }
      if (path === "/v2/scenario/read") {
        return {
          status: 200,
          body: {
            code: 0,
            data: {
              content: fixture.scenarios.get(String(input.path)) ?? null,
            },
          },
        };
      }
      if (path === "/v2/core/read") {
        return {
          status: 200,
          body: { code: 0, data: { content: fixture.core } },
        };
      }
      if (path === "/v2/scenario/write") {
        fixture.scenarios.set(String(input.path), String(input.content));
        return { status: 200, body: { code: 0, data: {} } };
      }
      if (path === "/v2/core/write") {
        fixture.core = String(input.content);
        return { status: 200, body: { code: 0, data: {} } };
      }
      if (path === "/v2/conversation/delete") {
        for (const id of input.message_ids as string[]) fixture.l0.delete(id);
        return { status: 200, body: { code: 0, data: {} } };
      }
      if (path === "/v2/atomic/delete") {
        if (fixture.failAtomicDelete > 0) {
          fixture.failAtomicDelete -= 1;
          throw new Error("temporary failure");
        }
        for (const id of input.ids as string[]) fixture.l1.delete(id);
        return { status: 200, body: { code: 0, data: {} } };
      }
      throw new Error(`unexpected path: ${path}`);
    },
  };
}

function testContext(
  options: { failAtomicDelete?: number; managed?: boolean } = {},
) {
  const root = sandbox();
  const data = join(root, "data");
  mkdirSync(join(data, "conversations"), { recursive: true });
  mkdirSync(join(data, "records"));
  writeFileSync(
    join(data, "conversations", "one.jsonl"),
    `${JSON.stringify({ id: "source-1", content: "需要删除" })}\n`,
  );
  writeFileSync(
    join(data, "records", "one.jsonl"),
    `${JSON.stringify({ id: "memory-1", content: "需要删除" })}\n`,
  );
  const database = new DatabaseSync(join(data, "personalmemory.sqlite"));
  migrateDatabase(database, defaultMigrations);
  const fixture: KernelFixture = {
    l1: new Map([
      [
        "memory-1",
        {
          id: "memory-1",
          type: "fact",
          content: "需要删除",
          updated_at: "2026-08-11T00:00:00.000Z",
          source_message_ids: ["source-1"],
        },
      ],
    ]),
    l0: new Set(["source-1"]),
    scenarios: new Map([["work.md", "情境：需要删除。"]]),
    core: "画像：需要删除。",
    failAtomicDelete: options.failAtomicDelete ?? 0,
  };
  const managedPaths: string[] = [];
  if (options.managed) {
    const managedPath = join(root, "export.json");
    writeFileSync(
      managedPath,
      `${JSON.stringify({ format: "personalmemory-export" })}\n`,
    );
    const artifacts = new ManagedArtifactLedger(
      database,
      () => "2026-08-11T00:00:00.000Z",
      (() => {
        let id = 0;
        return () => `artifact-${++id}`;
      })(),
    );
    artifacts.register("readable_export", managedPath);
    managedPaths.push(managedPath);
    const backupPath = join(root, "backup");
    mkdirSync(backupPath);
    writeFileSync(
      join(backupPath, "manifest.json"),
      `${JSON.stringify({ format: "personalmemory-backup" })}\n`,
    );
    artifacts.register("portable_backup", backupPath);
    managedPaths.push(backupPath);
  }
  const service = new PrivacyDeletionService(
    database,
    data,
    kernel(fixture),
    1_000,
    () => Date.parse("2026-08-11T00:00:00.000Z"),
    (() => {
      let id = 0;
      return () => `id-${++id}`;
    })(),
  );
  return { root, data, database, fixture, service, managedPaths };
}

afterEach(() => {
  for (const directory of sandboxes.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PrivacyDeletionService", () => {
  it("previews and verifies a complete cascade across controlled copies", async () => {
    const context = testContext({ managed: true });
    try {
      const preview = await context.service.preview("memory-1", "request-1");
      expect(preview.scope).toEqual({
        source_l0: 1,
        index_l1: 1,
        derived_l2: 1,
        derived_l3: 1,
        readable_l0: 1,
        readable_l1: 1,
        managed_copies: 2,
      });
      expect(preview.limitations).toHaveLength(3);

      const result = await context.service.execute(
        preview.token,
        {
          confirmation: "ERASE L1:memory-1",
          delete_managed_copies: true,
          unmanaged_copies_acknowledged: true,
        },
        "request-2",
      );

      expect(result.status).toBe("complete");
      expect(result.verification).toEqual({
        l1_remaining: 0,
        l0_remaining: 0,
        derived_occurrences: 0,
        readable_rows: 0,
        managed_copies_remaining: 0,
        tombstone_present: true,
      });
      expect(context.fixture.scenarios.get("work.md")).not.toContain(
        "需要删除",
      );
      expect(context.fixture.core).not.toContain("需要删除");
      expect(
        readFileSync(join(context.data, "records", "one.jsonl"), "utf8"),
      ).toBe("");
      expect(context.managedPaths.every((item) => !existsSync(item))).toBe(
        true,
      );

      context.fixture.l1.set("memory-1", {
        id: "memory-1",
        type: "fact",
        content: "重建索引后重新出现",
        updated_at: "2026-08-11T00:01:00.000Z",
        source_message_ids: [],
      });
      const restartedBrowser = new MemoryBrowser(
        kernel(context.fixture),
        1_000,
        new MemoryStateLedger(context.database),
      );
      await expect(
        restartedBrowser.browse(
          { level: "L1", query: "", page: 1, page_size: 12 },
          "request-after-restart",
        ),
      ).resolves.toMatchObject({ items: [] });
    } finally {
      const receipt = context.database
        .prepare(
          "SELECT status FROM personalmemory_erasure_receipts WHERE memory_id = ?",
        )
        .get("memory-1") as { status?: string } | undefined;
      expect(receipt?.status).toBe("complete");
      context.database.close();
    }
  });

  it("keeps a partial plan retryable and completes after a transient failure", async () => {
    const context = testContext({ failAtomicDelete: 1 });
    try {
      const preview = await context.service.preview("memory-1", "request-1");
      const confirmation = {
        confirmation: "ERASE L1:memory-1",
        delete_managed_copies: true as const,
        unmanaged_copies_acknowledged: true as const,
      };
      const first = await context.service.execute(
        preview.token,
        confirmation,
        "request-2",
      );
      expect(first).toMatchObject({ status: "partial", retryable: true });
      expect(first.steps.index_l1).toBe("failed");
      const retried = await context.service.execute(
        preview.token,
        confirmation,
        "request-3",
      );
      expect(retried).toMatchObject({ status: "complete", retryable: false });
    } finally {
      context.database.close();
    }
  });

  it("keeps L1 available for recovery when an earlier copy cannot be deleted", async () => {
    const context = testContext({ managed: true });
    try {
      const preview = await context.service.preview("memory-1", "request-1");
      const backupPath = context.managedPaths[1]!;
      writeFileSync(
        join(backupPath, "manifest.json"),
        `${JSON.stringify({ format: "unexpected" })}\n`,
      );
      const confirmation = {
        confirmation: "ERASE L1:memory-1",
        delete_managed_copies: true as const,
        unmanaged_copies_acknowledged: true as const,
      };
      const partial = await context.service.execute(
        preview.token,
        confirmation,
        "request-2",
      );
      expect(partial).toMatchObject({
        status: "partial",
        steps: { managed_copies: "failed", index_l1: "skipped" },
      });
      expect(context.fixture.l1.has("memory-1")).toBe(true);

      writeFileSync(
        join(backupPath, "manifest.json"),
        `${JSON.stringify({ format: "personalmemory-backup" })}\n`,
      );
      await expect(
        context.service.execute(preview.token, confirmation, "request-3"),
      ).resolves.toMatchObject({ status: "complete" });
    } finally {
      context.database.close();
    }
  });

  it("cancels a pending preview without mutating data", async () => {
    const context = testContext();
    try {
      const preview = await context.service.preview("memory-1", "request-1");
      context.service.cancel(preview.token);
      await expect(
        context.service.execute(
          preview.token,
          {
            confirmation: "ERASE L1:memory-1",
            delete_managed_copies: true,
            unmanaged_copies_acknowledged: true,
          },
          "request-2",
        ),
      ).rejects.toMatchObject<PrivacyDeletionError>({ code: "PLAN_NOT_FOUND" });
      expect(context.fixture.l1.has("memory-1")).toBe(true);
    } finally {
      context.database.close();
    }
  });
});
