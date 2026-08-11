import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MemoryGovernanceConflictError,
  MemoryGovernanceCycleError,
  MemoryGovernanceLedger,
  defaultMigrations,
  migrateDatabase,
} from "../src/index.js";

function withLedger(run: (ledger: MemoryGovernanceLedger) => void): void {
  const database = new DatabaseSync(":memory:");
  try {
    migrateDatabase(database, defaultMigrations);
    run(new MemoryGovernanceLedger(database, () => "2026-08-12T00:00:00.000Z"));
  } finally {
    database.close();
  }
}

describe("MemoryGovernanceLedger", () => {
  it("applies validity windows with optimistic revisions", () => {
    withLedger((ledger) => {
      expect(
        ledger.setValidity(
          "L1",
          "seasonal",
          "2026-01-01T00:00:00.000Z",
          "2026-06-01T00:00:00.000Z",
          0,
        ),
      ).toMatchObject({ revision: 1 });
      expect(ledger.isRecallable("L1", "seasonal")).toBe(false);
      expect(() =>
        ledger.setValidity("L1", "seasonal", undefined, undefined, 0),
      ).toThrow(MemoryGovernanceConflictError);
    });
  });

  it("keeps conflicts visible while pausing both memories", () => {
    withLedger((ledger) => {
      const relation = ledger.addRelation({
        id: "relation-1",
        level: "L1",
        kind: "conflicts_with",
        sourceMemoryId: "new",
        targetMemoryId: "old",
        reason: "用户确认两条事实矛盾",
      });
      expect(relation).toMatchObject({
        sourceMemoryId: "new",
        targetMemoryId: "old",
        status: "active",
      });
      expect(ledger.isRecallable("L1", "new")).toBe(false);
      expect(ledger.isRecallable("L1", "old")).toBe(false);
      expect(() =>
        ledger.addRelation({
          id: "relation-2",
          level: "L1",
          kind: "conflicts_with",
          sourceMemoryId: "old",
          targetMemoryId: "new",
          reason: "different reason",
        }),
      ).toThrow(MemoryGovernanceConflictError);
    });
  });

  it("suppresses superseded memories and restores them after undo", () => {
    withLedger((ledger) => {
      const relation = ledger.addRelation({
        id: "relation-1",
        level: "L1",
        kind: "supersedes",
        sourceMemoryId: "new",
        targetMemoryId: "old",
        reason: "合并为新事实",
      });
      expect(ledger.isRecallable("L1", "old")).toBe(false);
      expect(ledger.isRecallable("L1", "new")).toBe(true);
      expect(ledger.revokeRelation(relation.id, 1)).toMatchObject({
        status: "revoked",
        revision: 2,
      });
      expect(ledger.isRecallable("L1", "old")).toBe(true);
      expect(ledger.listRelations("L1", "old")).toHaveLength(1);
    });
  });

  it("rejects self and transitive supersedes cycles", () => {
    withLedger((ledger) => {
      expect(() =>
        ledger.addRelation({
          id: "self",
          level: "L1",
          kind: "supersedes",
          sourceMemoryId: "one",
          targetMemoryId: "one",
          reason: "invalid",
        }),
      ).toThrow(MemoryGovernanceCycleError);
      ledger.addRelation({
        id: "one-two",
        level: "L1",
        kind: "supersedes",
        sourceMemoryId: "one",
        targetMemoryId: "two",
        reason: "first",
      });
      ledger.addRelation({
        id: "two-three",
        level: "L1",
        kind: "supersedes",
        sourceMemoryId: "two",
        targetMemoryId: "three",
        reason: "second",
      });
      expect(() =>
        ledger.addRelation({
          id: "three-one",
          level: "L1",
          kind: "supersedes",
          sourceMemoryId: "three",
          targetMemoryId: "one",
          reason: "cycle",
        }),
      ).toThrow(MemoryGovernanceCycleError);
    });
  });
});
