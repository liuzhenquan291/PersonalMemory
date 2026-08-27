import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CapturePolicyLedger,
  RetentionAuthorizationLedger,
  RetentionRunLedger,
  defaultMigrations,
  migrateDatabase,
} from "../src/index.js";

describe("retention execution ledgers", () => {
  let database: DatabaseSync;
  let policy: CapturePolicyLedger;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    migrateDatabase(database, defaultMigrations);
    policy = new CapturePolicyLedger(
      database,
      () => "2026-08-24T00:00:00.000Z",
    );
  });

  it("is disabled by default and invalidates authorization on any policy binding change", () => {
    const ledger = new RetentionAuthorizationLedger(
      database,
      () => "2026-08-24T01:00:00.000Z",
    );
    expect(ledger.status(policy.status())).toEqual({
      status: "disabled",
      revision: 0,
    });
    expect(ledger.authorize(policy.status(), 0)).toMatchObject({
      status: "authorized",
      revision: 1,
      binding: {
        policyRevision: 1,
        l0RetentionDays: null,
        l1RetentionDays: null,
      },
    });

    policy.update({
      expectedRevision: 1,
      captureEnabled: true,
      excludedClients: [],
      excludedWorkingDirectories: [],
      excludedSources: [],
      sensitiveCategories: ["credentials", "financial", "identity"],
      l0RetentionDays: 30,
      l1RetentionDays: 365,
    });
    expect(ledger.status(policy.status())).toMatchObject({
      status: "stale",
      revision: 1,
      binding: { policyRevision: 1 },
    });
    expect(ledger.authorize(policy.status(), 1)).toMatchObject({
      status: "authorized",
      revision: 2,
      binding: { policyRevision: 2, l0RetentionDays: 30, l1RetentionDays: 365 },
    });
    expect(ledger.revoke(policy.status(), 2)).toMatchObject({
      status: "revoked",
      revision: 3,
    });
  });

  it("persists only digests and bounded redacted run statistics", () => {
    const digest = createHash("sha256").update("candidate-set").digest("hex");
    let runSequence = 0;
    const ledger = new RetentionRunLedger(
      database,
      () => new Date("2026-08-24T02:00:00.000Z"),
      () => `run-${++runSequence}`,
    );
    const run = ledger.acquire({
      policyRevision: 2,
      authorizationRevision: 1,
      cutoffL0: "2026-07-26T00:00:00.000Z",
      cutoffL1: "2025-08-25T00:00:00.000Z",
      candidateDigest: digest,
      leaseOwner: "private-worker-instance",
      leaseMilliseconds: 60_000,
      plannedL0: 100,
      plannedL1: 25,
      anomalyCount: 2,
    });
    expect(run).toMatchObject({
      status: "draining",
      plannedL0: 100,
      plannedL1: 25,
    });
    expect(
      ledger.acquire({
        policyRevision: 2,
        authorizationRevision: 1,
        cutoffL0: null,
        cutoffL1: null,
        candidateDigest: digest,
        leaseOwner: "another-worker",
        leaseMilliseconds: 60_000,
        plannedL0: 0,
        plannedL1: 0,
        anomalyCount: 0,
      }),
    ).toBeUndefined();
    expect(() =>
      ledger.complete("run-1", "wrong-worker", {
        status: "partial",
        plannedL0: 100,
        plannedL1: 25,
        deletedL0: 0,
        deletedL1: 0,
        remainingL0: 100,
        remainingL1: 25,
        deletedArtifacts: 0,
        anomalyCount: 2,
      }),
    ).toThrow(/not active/);
    expect(() =>
      ledger.complete("run-1", "private-worker-instance", {
        status: "drained",
        plannedL0: 100,
        plannedL1: 25,
        deletedL0: 99,
        deletedL1: 25,
        remainingL0: 1,
        remainingL1: 0,
        deletedArtifacts: 2,
        anomalyCount: 2,
      }),
    ).toThrow(/cannot have eligible records/);
    expect(
      ledger.complete("run-1", "private-worker-instance", {
        status: "drained",
        plannedL0: 100,
        plannedL1: 25,
        deletedL0: 100,
        deletedL1: 25,
        remainingL0: 0,
        remainingL1: 0,
        deletedArtifacts: 2,
        anomalyCount: 2,
      }),
    ).toMatchObject({ status: "drained", remainingL0: 0, remainingL1: 0 });
    ledger.acquire({
      policyRevision: 2,
      authorizationRevision: 1,
      cutoffL0: null,
      cutoffL1: null,
      candidateDigest: digest,
      leaseOwner: "private-worker-instance",
      leaseMilliseconds: 60_000,
      plannedL0: 1,
      plannedL1: 1,
      anomalyCount: 0,
    });
    expect(
      ledger.checkpoint("run-2", "private-worker-instance", {
        plannedL0: 1,
        plannedL1: 1,
        deletedL0: 1,
        deletedL1: 1,
        remainingL0: 1,
        remainingL1: 1,
        deletedArtifacts: 0,
        anomalyCount: 0,
      }),
    ).toMatchObject({ status: "draining", remainingL0: 1, remainingL1: 1 });
    const stored = JSON.stringify(
      database.prepare("SELECT * FROM personalmemory_retention_runs").get(),
    );
    expect(stored).not.toContain("candidate-set");
    expect(stored).not.toContain("private-worker-instance");
  });

  it("rejects completion after the lease expires", () => {
    let now = new Date("2026-08-24T02:00:00.000Z");
    const ledger = new RetentionRunLedger(
      database,
      () => now,
      () => "expired-run",
    );
    const digest = createHash("sha256").update("empty").digest("hex");
    ledger.acquire({
      policyRevision: 1,
      authorizationRevision: 1,
      cutoffL0: null,
      cutoffL1: null,
      candidateDigest: digest,
      leaseOwner: "worker",
      leaseMilliseconds: 1_000,
      plannedL0: 0,
      plannedL1: 0,
      anomalyCount: 0,
    });
    now = new Date("2026-08-24T02:00:02.000Z");
    expect(() =>
      ledger.complete("expired-run", "worker", {
        status: "drained",
        plannedL0: 0,
        plannedL1: 0,
        deletedL0: 0,
        deletedL1: 0,
        remainingL0: 0,
        remainingL1: 0,
        deletedArtifacts: 0,
        anomalyCount: 0,
      }),
    ).toThrow(/not active/);
  });

  it("rejects batches above the frozen L0 and L1 bounds", () => {
    const ledger = new RetentionRunLedger(database);
    const digest = createHash("sha256").update("too-many").digest("hex");
    expect(() =>
      ledger.acquire({
        policyRevision: 1,
        authorizationRevision: 1,
        cutoffL0: null,
        cutoffL1: null,
        candidateDigest: digest,
        leaseOwner: "worker",
        leaseMilliseconds: 1_000,
        plannedL0: 101,
        plannedL1: 25,
        anomalyCount: 0,
      }),
    ).toThrow(/bounded planning limit/);
  });
});
