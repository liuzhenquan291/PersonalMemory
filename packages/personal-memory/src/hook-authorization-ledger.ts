import type { DatabaseSync } from "node:sqlite";

export interface HookAuthorizationStatus {
  installationId: string;
  authorizationRevision: number;
  policyRevision: number;
  recallEnabled: boolean;
  captureEnabled: boolean;
  changedAt: string;
}

interface HookAuthorizationRow {
  authorization_revision: number;
  installation_id: string;
  policy_revision: number;
  recall_enabled: number;
  capture_enabled: number;
  changed_at: string;
}

export class HookAuthorizationConflictError extends Error {
  constructor() {
    super("Hook authorization changed; reload it before updating");
    this.name = "HookAuthorizationConflictError";
  }
}

function toStatus(row: HookAuthorizationRow): HookAuthorizationStatus {
  return {
    installationId: row.installation_id,
    authorizationRevision: row.authorization_revision,
    policyRevision: row.policy_revision,
    recallEnabled: row.recall_enabled === 1,
    captureEnabled: row.capture_enabled === 1,
    changedAt: row.changed_at,
  };
}

export class HookAuthorizationLedger {
  constructor(
    private readonly database: DatabaseSync,
    private readonly installationId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    const current = this.currentRow();
    if (!current) {
      this.insertDisabled(1, 1);
    } else if (current.installation_id !== this.installationId) {
      this.insertDisabled(
        current.authorization_revision + 1,
        current.policy_revision,
      );
    }
  }

  status(): HookAuthorizationStatus {
    return toStatus(this.currentRow()!);
  }

  update(input: {
    expectedRevision: number;
    recallEnabled: boolean;
    captureEnabled: boolean;
  }): HookAuthorizationStatus {
    const current = this.currentRow()!;
    if (input.expectedRevision !== current.authorization_revision) {
      throw new HookAuthorizationConflictError();
    }
    if (
      input.recallEnabled === (current.recall_enabled === 1) &&
      input.captureEnabled === (current.capture_enabled === 1)
    ) {
      return toStatus(current);
    }
    const next: HookAuthorizationRow = {
      ...current,
      authorization_revision: current.authorization_revision + 1,
      recall_enabled: input.recallEnabled ? 1 : 0,
      capture_enabled: input.captureEnabled ? 1 : 0,
      changed_at: this.now(),
    };
    this.database
      .prepare(
        `INSERT INTO personalmemory_hook_authorizations
         (authorization_revision, installation_id, policy_revision,
          recall_enabled, capture_enabled, changed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        next.authorization_revision,
        next.installation_id,
        next.policy_revision,
        next.recall_enabled,
        next.capture_enabled,
        next.changed_at,
      );
    return toStatus(next);
  }

  private currentRow(): HookAuthorizationRow | undefined {
    return this.database
      .prepare(
        `SELECT authorization_revision, installation_id, policy_revision,
                recall_enabled, capture_enabled, changed_at
         FROM personalmemory_hook_authorizations
         ORDER BY authorization_revision DESC
         LIMIT 1`,
      )
      .get() as HookAuthorizationRow | undefined;
  }

  private insertDisabled(
    authorizationRevision: number,
    policyRevision: number,
  ): void {
    this.database
      .prepare(
        `INSERT INTO personalmemory_hook_authorizations
         (authorization_revision, installation_id, policy_revision,
          recall_enabled, capture_enabled, changed_at)
         VALUES (?, ?, ?, 0, 0, ?)`,
      )
      .run(
        authorizationRevision,
        this.installationId,
        policyRevision,
        this.now(),
      );
  }
}
