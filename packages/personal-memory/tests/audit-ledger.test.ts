import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AuditLedger,
  defaultMigrations,
  migrateDatabase,
} from "../src/index.js";

function withLedger(
  run: (ledger: AuditLedger, database: DatabaseSync) => void,
  now: () => string = () => "2026-08-11T00:00:00.000Z",
): void {
  const database = new DatabaseSync(":memory:");
  try {
    migrateDatabase(database, defaultMigrations);
    let id = 0;
    run(new AuditLedger(database, now, () => `event-${++id}`), database);
  } finally {
    database.close();
  }
}

describe("AuditLedger", () => {
  it("stores an HMAC subject reference without raw identifiers or content", () => {
    withLedger((ledger, database) => {
      ledger.record({
        action: "memory.reviewed",
        subject: { level: "L1", memoryId: "private/path.md" },
        details: { status: "confirmed" },
      });
      const row = database
        .prepare(
          "SELECT subject_hash, details_json FROM personalmemory_audit_events",
        )
        .get() as { subject_hash: string; details_json: string };
      expect(row.subject_hash).toHaveLength(64);
      expect(JSON.stringify(row)).not.toContain("private/path.md");
      expect(
        ledger.query({ level: "L1", memoryId: "private/path.md" }).events,
      ).toHaveLength(1);
    });
  });

  it("rejects detail fields that could become a sensitive body", () => {
    withLedger((ledger) => {
      expect(() =>
        ledger.record({
          action: "memory.updated",
          details: { content: "secret" } as never,
        }),
      ).toThrow(/not allowed/);
      expect(() =>
        ledger.record({
          action: "memory.updated",
          details: { count: Number.NaN },
        }),
      ).toThrow(/number is invalid/);
    });
  });

  it("deduplicates first-observed generation events", () => {
    withLedger((ledger) => {
      const input = {
        action: "memory.generated" as const,
        subject: { level: "L1" as const, memoryId: "memory-1" },
        details: { scope: "first_observed" },
        dedupe: true,
      };
      ledger.record(input);
      ledger.record(input);
      expect(ledger.query().events).toHaveLength(1);
    });
  });

  it("returns stable newest-first cursor pages with a bounded limit", () => {
    withLedger((ledger) => {
      for (let index = 0; index < 105; index += 1) {
        ledger.record({ action: "memory.recalled", details: { count: index } });
      }
      const first = ledger.query({ limit: 500 });
      expect(first.events).toHaveLength(100);
      expect(first.events[0]!.sequence).toBe(105);
      expect(first.nextBeforeSequence).toBe(6);
      expect(first.nextBeforeSequence).toBeDefined();
      const second = ledger.query({
        beforeSequence: first.nextBeforeSequence!,
      });
      expect(second.events.map(({ sequence }) => sequence)).toEqual([
        5, 4, 3, 2, 1,
      ]);
    });
  });

  it("prunes events beyond the default 365 day retention window", () => {
    let at = "2025-01-01T00:00:00.000Z";
    withLedger(
      (ledger) => {
        ledger.record({ action: "memory.recalled" });
        at = "2026-01-02T00:00:00.000Z";
        ledger.record({ action: "memory.recalled" });
        expect(ledger.query().events).toHaveLength(1);
      },
      () => at,
    );
  });
});
