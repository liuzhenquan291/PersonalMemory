import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MemoryReviewConflictError,
  MemoryReviewLedger,
  defaultMigrations,
  migrateDatabase,
} from "../src/index.js";

function withLedger(run: (ledger: MemoryReviewLedger) => void): void {
  const database = new DatabaseSync(":memory:");
  try {
    migrateDatabase(database, defaultMigrations);
    run(new MemoryReviewLedger(database, () => "2026-08-11T00:00:00.000Z"));
  } finally {
    database.close();
  }
}

describe("MemoryReviewLedger", () => {
  it("treats an unseen memory as pending", () => {
    withLedger((ledger) => {
      expect(ledger.get("L1", "new-memory")).toEqual({
        level: "L1",
        memoryId: "new-memory",
        status: "pending",
        revision: 0,
      });
      expect(ledger.isApproved("L1", "new-memory")).toBe(false);
    });
  });

  it("approves and rejects with optimistic revisions", () => {
    withLedger((ledger) => {
      expect(ledger.set("L1", "one", "approved", 0)).toMatchObject({
        status: "approved",
        revision: 1,
      });
      expect(ledger.set("L1", "one", "rejected", 1, "不准确")).toMatchObject({
        status: "rejected",
        reason: "不准确",
        revision: 2,
      });
      expect(() => ledger.set("L1", "one", "approved", 1)).toThrow(
        MemoryReviewConflictError,
      );
    });
  });

  it("returns the current state for an identical retry", () => {
    withLedger((ledger) => {
      const approved = ledger.set("L1", "one", "approved", 0);
      expect(ledger.set("L1", "one", "approved", 0)).toEqual(approved);
    });
  });
});
