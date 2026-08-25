import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CapturePolicyStatus } from "./capture-policy-ledger.js";

export const RETENTION_DISCLOSURE_VERSION = 1;
export const RETENTION_MANAGED_ARTIFACT_HANDLING =
  "delete-whole-active-artifacts" as const;

export interface RetentionDisclosure {
  version: number;
  effects: readonly string[];
  managedArtifactHandling: typeof RETENTION_MANAGED_ARTIFACT_HANDLING;
}

export interface RetentionAuthorizationBinding {
  policyRevision: number;
  l0RetentionDays: number | null;
  l1RetentionDays: number | null;
}

export type RetentionAuthorizationStatus =
  | { status: "disabled"; revision: 0 }
  | {
      status: "stale";
      revision: number;
      binding: RetentionAuthorizationBinding;
      changedAt: string;
    }
  | {
      status: "authorized";
      revision: number;
      binding: RetentionAuthorizationBinding;
      changedAt: string;
    }
  | {
      status: "revoked";
      revision: number;
      binding: RetentionAuthorizationBinding;
      changedAt: string;
    };

export type RetentionRunStatus = "draining" | "drained" | "partial";

export class RetentionAuthorizationConflictError extends Error {
  constructor() {
    super("Retention authorization changed; reload it before updating");
    this.name = "RetentionAuthorizationConflictError";
  }
}

export interface RetentionRunCounts {
  plannedL0: number;
  plannedL1: number;
  deletedL0: number;
  deletedL1: number;
  remainingL0: number;
  remainingL1: number;
  deletedArtifacts: number;
  anomalyCount: number;
}

export interface RetentionRunView extends RetentionRunCounts {
  runId: string;
  policyRevision: number;
  authorizationRevision: number;
  cutoffL0: string | null;
  cutoffL1: string | null;
  status: RetentionRunStatus;
  errorCode: string | null;
  leaseExpiresAt: string;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
}

interface AuthorizationRow {
  revision: number;
  disclosure_version: number;
  disclosure_hash: string;
  policy_revision: number;
  l0_retention_days: number | null;
  l1_retention_days: number | null;
  managed_artifact_handling: typeof RETENTION_MANAGED_ARTIFACT_HANDLING;
  status: "authorized" | "revoked";
  changed_at: string;
}

interface RunRow {
  run_id: string;
  policy_revision: number;
  authorization_revision: number;
  cutoff_l0: string | null;
  cutoff_l1: string | null;
  status: RetentionRunStatus;
  planned_l0: number;
  planned_l1: number;
  deleted_l0: number;
  deleted_l1: number;
  remaining_l0: number;
  remaining_l1: number;
  deleted_artifacts: number;
  anomaly_count: number;
  error_code: string | null;
  lease_expires_at: string;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
}

const DISCLOSURE_EFFECTS = Object.freeze([
  "Expired L1, exact derivatives, readable L1, metadata and indexes are permanently removed; source L0 is retained until its independent cutoff, while explicit complete erasure still removes every known source L0.",
  "Every active registered readable export and portable backup is deleted as a whole.",
  "Copies moved, renamed, synchronized or created outside PersonalMemory cannot be discovered and are excluded from completion claims.",
  "Cutoffs use local calendar days; retention days or disclosure changes require new authorization.",
  "Disabling execution prevents new runs and does not restore deleted data.",
]);

export function getRetentionDisclosure(): RetentionDisclosure {
  return {
    version: RETENTION_DISCLOSURE_VERSION,
    effects: DISCLOSURE_EFFECTS,
    managedArtifactHandling: RETENTION_MANAGED_ARTIFACT_HANDLING,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function disclosureHash(disclosure: RetentionDisclosure): string {
  return sha256(JSON.stringify(disclosure));
}

function binding(policy: CapturePolicyStatus): RetentionAuthorizationBinding {
  return {
    policyRevision: policy.revision,
    l0RetentionDays: policy.l0RetentionDays,
    l1RetentionDays: policy.l1RetentionDays,
  };
}

function rowBinding(row: AuthorizationRow): RetentionAuthorizationBinding {
  return {
    policyRevision: row.policy_revision,
    l0RetentionDays: row.l0_retention_days,
    l1RetentionDays: row.l1_retention_days,
  };
}

function matches(row: AuthorizationRow, policy: CapturePolicyStatus): boolean {
  const disclosure = getRetentionDisclosure();
  return (
    row.disclosure_version === disclosure.version &&
    row.disclosure_hash === disclosureHash(disclosure) &&
    row.managed_artifact_handling === disclosure.managedArtifactHandling &&
    row.policy_revision === policy.revision &&
    row.l0_retention_days === policy.l0RetentionDays &&
    row.l1_retention_days === policy.l1RetentionDays
  );
}

export class RetentionAuthorizationLedger {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  status(policy: CapturePolicyStatus): RetentionAuthorizationStatus {
    const row = this.current();
    if (!row) return { status: "disabled", revision: 0 };
    if (!matches(row, policy))
      return {
        status: "stale",
        revision: row.revision,
        binding: rowBinding(row),
        changedAt: row.changed_at,
      };
    return {
      status: row.status,
      revision: row.revision,
      binding: binding(policy),
      changedAt: row.changed_at,
    };
  }

  authorize(
    policy: CapturePolicyStatus,
    expectedRevision: number,
  ): RetentionAuthorizationStatus {
    return this.transition(policy, "authorized", expectedRevision);
  }

  revoke(
    policy: CapturePolicyStatus,
    expectedRevision: number,
  ): RetentionAuthorizationStatus {
    return this.transition(policy, "revoked", expectedRevision);
  }

  private transition(
    policy: CapturePolicyStatus,
    target: "authorized" | "revoked",
    expectedRevision: number,
  ): RetentionAuthorizationStatus {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.status(policy);
      if (current.revision !== expectedRevision) {
        throw new RetentionAuthorizationConflictError();
      }
      if (current.status === target) {
        this.database.exec("COMMIT");
        return current;
      }
      const revision = (this.current()?.revision ?? 0) + 1;
      const disclosure = getRetentionDisclosure();
      const changedAt = this.now();
      this.database
        .prepare(
          `INSERT INTO personalmemory_retention_authorizations
           (revision, disclosure_version, disclosure_hash, policy_revision,
            l0_retention_days, l1_retention_days, managed_artifact_handling,
            status, changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revision,
          disclosure.version,
          disclosureHash(disclosure),
          policy.revision,
          policy.l0RetentionDays,
          policy.l1RetentionDays,
          disclosure.managedArtifactHandling,
          target,
          changedAt,
        );
      this.database.exec("COMMIT");
      return {
        status: target,
        revision,
        binding: binding(policy),
        changedAt,
      };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private current(): AuthorizationRow | undefined {
    return this.database
      .prepare(
        `SELECT revision, disclosure_version, disclosure_hash, policy_revision, l0_retention_days,
                l1_retention_days, managed_artifact_handling, status, changed_at
         FROM personalmemory_retention_authorizations
         ORDER BY revision DESC LIMIT 1`,
      )
      .get() as AuthorizationRow | undefined;
  }
}

function toRunView(row: RunRow): RetentionRunView {
  return {
    runId: row.run_id,
    policyRevision: row.policy_revision,
    authorizationRevision: row.authorization_revision,
    cutoffL0: row.cutoff_l0,
    cutoffL1: row.cutoff_l1,
    status: row.status,
    plannedL0: row.planned_l0,
    plannedL1: row.planned_l1,
    deletedL0: row.deleted_l0,
    deletedL1: row.deleted_l1,
    remainingL0: row.remaining_l0,
    remainingL1: row.remaining_l1,
    deletedArtifacts: row.deleted_artifacts,
    anomalyCount: row.anomaly_count,
    errorCode: row.error_code,
    leaseExpiresAt: row.lease_expires_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

export class RetentionRunLedger {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
    private readonly randomId: () => string = randomUUID,
  ) {}

  latest(): RetentionRunView | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM personalmemory_retention_runs
         ORDER BY started_at DESC, run_id DESC LIMIT 1`,
      )
      .get() as RunRow | undefined;
    return row ? toRunView(row) : undefined;
  }

  acquire(input: {
    policyRevision: number;
    authorizationRevision: number;
    cutoffL0: string | null;
    cutoffL1: string | null;
    candidateDigest: string;
    leaseOwner: string;
    leaseMilliseconds: number;
    plannedL0: number;
    plannedL1: number;
    anomalyCount: number;
  }): RetentionRunView | undefined {
    if (!/^[a-f\d]{64}$/u.test(input.candidateDigest)) {
      throw new Error("candidateDigest must be a SHA-256 digest");
    }
    if (input.plannedL0 > 100 || input.plannedL1 > 25) {
      throw new Error("Retention batch exceeds the bounded planning limit");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = this.now();
      const active = this.database
        .prepare(
          `SELECT run_id FROM personalmemory_retention_runs
           WHERE status = 'draining' AND lease_expires_at > ? LIMIT 1`,
        )
        .get(now.toISOString());
      if (active) {
        this.database.exec("COMMIT");
        return undefined;
      }
      const runId = this.randomId();
      const leaseExpiresAt = new Date(
        now.getTime() + input.leaseMilliseconds,
      ).toISOString();
      this.database
        .prepare(
          `INSERT INTO personalmemory_retention_runs
           (run_id, policy_revision, authorization_revision, cutoff_l0, cutoff_l1,
            candidate_digest, status, planned_l0, planned_l1, anomaly_count,
            lease_owner_digest, lease_expires_at, started_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'draining', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          input.policyRevision,
          input.authorizationRevision,
          input.cutoffL0,
          input.cutoffL1,
          input.candidateDigest,
          input.plannedL0,
          input.plannedL1,
          input.anomalyCount,
          sha256(input.leaseOwner),
          leaseExpiresAt,
          now.toISOString(),
          now.toISOString(),
        );
      this.database.exec("COMMIT");
      return this.latest();
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  complete(
    runId: string,
    leaseOwner: string,
    input: RetentionRunCounts & {
      status: "drained" | "partial";
      errorCode?: string;
    },
  ): RetentionRunView {
    const timestamp = this.now().toISOString();
    if (
      input.status === "drained" &&
      (input.remainingL0 !== 0 || input.remainingL1 !== 0)
    )
      throw new Error("A drained retention run cannot have eligible records");
    const result = this.database
      .prepare(
        `UPDATE personalmemory_retention_runs
         SET status = ?, deleted_l0 = ?, deleted_l1 = ?, remaining_l0 = ?,
             remaining_l1 = ?, deleted_artifacts = ?, anomaly_count = ?,
             error_code = ?, completed_at = ?, updated_at = ?
         WHERE run_id = ? AND status = 'draining'
           AND lease_owner_digest = ? AND lease_expires_at > ?`,
      )
      .run(
        input.status,
        input.deletedL0,
        input.deletedL1,
        input.remainingL0,
        input.remainingL1,
        input.deletedArtifacts,
        input.anomalyCount,
        input.errorCode ?? null,
        timestamp,
        timestamp,
        runId,
        sha256(leaseOwner),
        timestamp,
      );
    if (result.changes !== 1) throw new Error("Retention run is not active");
    const row = this.database
      .prepare("SELECT * FROM personalmemory_retention_runs WHERE run_id = ?")
      .get(runId) as unknown as RunRow;
    return toRunView(row);
  }

  checkpoint(
    runId: string,
    leaseOwner: string,
    input: RetentionRunCounts,
  ): RetentionRunView {
    const timestamp = this.now().toISOString();
    const result = this.database
      .prepare(
        `UPDATE personalmemory_retention_runs
         SET deleted_l0 = ?, deleted_l1 = ?, remaining_l0 = ?,
             remaining_l1 = ?, deleted_artifacts = ?, anomaly_count = ?,
             lease_expires_at = ?, updated_at = ?
         WHERE run_id = ? AND status = 'draining'
           AND lease_owner_digest = ? AND lease_expires_at > ?`,
      )
      .run(
        input.deletedL0,
        input.deletedL1,
        input.remainingL0,
        input.remainingL1,
        input.deletedArtifacts,
        input.anomalyCount,
        timestamp,
        timestamp,
        runId,
        sha256(leaseOwner),
        timestamp,
      );
    if (result.changes !== 1) throw new Error("Retention run is not active");
    const row = this.database
      .prepare("SELECT * FROM personalmemory_retention_runs WHERE run_id = ?")
      .get(runId) as unknown as RunRow;
    return toRunView(row);
  }

  renew(
    runId: string,
    leaseOwner: string,
    leaseMilliseconds: number,
  ): RetentionRunView {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + leaseMilliseconds).toISOString();
    const result = this.database
      .prepare(
        `UPDATE personalmemory_retention_runs
         SET lease_expires_at = ?, updated_at = ?
         WHERE run_id = ? AND status = 'draining'
           AND lease_owner_digest = ? AND lease_expires_at > ?`,
      )
      .run(
        expiresAt,
        now.toISOString(),
        runId,
        sha256(leaseOwner),
        now.toISOString(),
      );
    if (result.changes !== 1) throw new Error("Retention run is not active");
    const row = this.database
      .prepare("SELECT * FROM personalmemory_retention_runs WHERE run_id = ?")
      .get(runId) as unknown as RunRow;
    return toRunView(row);
  }
}
