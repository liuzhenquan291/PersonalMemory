import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ErasureReceiptLedger,
  ManagedArtifactLedger,
  defaultMigrations,
  migrateDatabase,
} from "../src/index.js";

describe("privacy deletion ledgers", () => {
  it("tracks only active managed exports and backups", () => {
    const database = new DatabaseSync(":memory:");
    try {
      migrateDatabase(database, defaultMigrations);
      let id = 0;
      const ledger = new ManagedArtifactLedger(
        database,
        () => "2026-08-11T00:00:00.000Z",
        () => `artifact-${++id}`,
      );
      const registered = ledger.register("readable_export", "/tmp/export.json");
      ledger.register("portable_backup", "/tmp/backup");
      expect(ledger.listActive()).toHaveLength(2);
      ledger.markDeleted(registered.id);
      expect(ledger.listActive()).toEqual([
        expect.objectContaining({
          kind: "portable_backup",
          path: "/tmp/backup",
        }),
      ]);
      expect(
        ledger.register("readable_export", "/tmp/export.json"),
      ).toMatchObject({ status: "active", path: "/tmp/export.json" });
    } finally {
      database.close();
    }
  });

  it("upserts a content-free erasure receipt for retry", () => {
    const database = new DatabaseSync(":memory:");
    try {
      migrateDatabase(database, defaultMigrations);
      const ledger = new ErasureReceiptLedger(
        database,
        () => "2026-08-11T00:00:00.000Z",
        () => "receipt-1",
      );
      ledger.save({
        memoryId: "memory-1",
        contentHash: "content-hash",
        planHash: "plan-hash",
        status: "partial",
        verification: { l1_remaining: 1 },
      });
      const completed = ledger.save({
        memoryId: "memory-1",
        contentHash: "content-hash",
        planHash: "plan-hash",
        status: "complete",
        verification: { l1_remaining: 0 },
      });
      expect(completed).toMatchObject({
        id: "receipt-1",
        status: "complete",
        verification: { l1_remaining: 0 },
      });
      const row = database
        .prepare(
          "SELECT COUNT(*) AS count FROM personalmemory_erasure_receipts",
        )
        .get() as { count: number };
      expect(row.count).toBe(1);
    } finally {
      database.close();
    }
  });
});
