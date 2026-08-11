import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeletedMemoryCannotBeRestoredError,
  MemoryStateConflictError,
  MemoryStateLedger,
  defaultMigrations,
  migrateDatabase,
} from "../src/index.js";

function withLedger(run: (ledger: MemoryStateLedger) => void): void {
  const database = new DatabaseSync(":memory:");
  try {
    migrateDatabase(database, defaultMigrations);
    run(new MemoryStateLedger(database, () => "2026-08-11T00:00:00.000Z"));
  } finally {
    database.close();
  }
}

describe("MemoryStateLedger", () => {
  it("creates an invalidation tombstone and suppresses the memory", () => {
    withLedger((ledger) => {
      const state = ledger.set("L1", "memory-1", "invalidated", 0, "错误");
      expect(state).toMatchObject({
        status: "invalidated",
        reason: "错误",
        revision: 1,
      });
      expect(ledger.isSuppressed("L1", "memory-1")).toBe(true);
    });
  });

  it("rejects stale revisions", () => {
    withLedger((ledger) => {
      ledger.set("L1", "memory-1", "active", 0);
      expect(() => ledger.set("L1", "memory-1", "invalidated", 0)).toThrow(
        MemoryStateConflictError,
      );
    });
  });

  it("does not allow a deleted tombstone to be restored", () => {
    withLedger((ledger) => {
      ledger.set("L1", "memory-1", "deleted", 0);
      expect(() => ledger.set("L1", "memory-1", "active", 1)).toThrow(
        DeletedMemoryCannotBeRestoredError,
      );
    });
  });

  it("keeps deletion tombstones when a ledger is recreated", () => {
    const directory = mkdtempSync(join(tmpdir(), "personalmemory-ledger-"));
    const path = join(directory, "memory.sqlite3");
    try {
      const database = new DatabaseSync(path);
      migrateDatabase(database, defaultMigrations);
      new MemoryStateLedger(database).set("L1", "memory-1", "deleted", 0);
      database.close();
      const reopened = new DatabaseSync(path);
      expect(
        new MemoryStateLedger(reopened).get("L1", "memory-1"),
      ).toMatchObject({ status: "deleted", revision: 1 });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns states for a bounded set of keys", () => {
    withLedger((ledger) => {
      ledger.set("L1", "one", "invalidated", 0);
      ledger.set("L2", "two", "active", 0);
      expect([
        ...ledger.getMany([
          { level: "L1", memoryId: "one" },
          { level: "L2", memoryId: "two" },
        ]),
      ]).toHaveLength(2);
    });
  });
});
