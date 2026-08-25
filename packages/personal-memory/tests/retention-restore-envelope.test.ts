import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  CapturePolicyLedger,
  ManagedArtifactLedger,
  RetentionAuthorizationLedger,
  applyRetentionRestoreEnvelope,
  createRetentionRestoreSnapshot,
  defaultMigrations,
  migrateDatabase,
  parseRetentionRestoreEnvelope,
} from "../src/index.js";

function database(): DatabaseSync {
  const value = new DatabaseSync(":memory:");
  migrateDatabase(value, defaultMigrations);
  return value;
}

function setInstallation(database: DatabaseSync, id: string): void {
  database
    .prepare(
      `INSERT INTO personalmemory_hook_authorizations
       (authorization_revision, installation_id, policy_revision,
        recall_enabled, capture_enabled, changed_at)
       VALUES (1, ?, 1, 0, 0, '2026-08-25T00:00:00.000Z')`,
    )
    .run(id);
}

describe("retention restore envelope", () => {
  it("rejects an active authorization without an installation identity", () => {
    const current = database();
    const policy = new CapturePolicyLedger(current);
    new RetentionAuthorizationLedger(current).authorize(policy.status(), 0);
    expect(() => createRetentionRestoreSnapshot(current)).toThrow(
      /installation identity/u,
    );
    current.close();
  });

  it("keeps paths outside the persistent envelope and restores current bindings", () => {
    const current = database();
    setInstallation(current, "install-current");
    const policies = new CapturePolicyLedger(
      current,
      () => "2026-08-25T00:00:00.000Z",
    );
    policies.update({
      expectedRevision: 1,
      captureEnabled: true,
      excludedClients: [],
      excludedWorkingDirectories: [],
      excludedSources: [],
      sensitiveCategories: ["credentials"],
      l0RetentionDays: 30,
      l1RetentionDays: 90,
    });
    new RetentionAuthorizationLedger(current).authorize(policies.status(), 0);
    new ManagedArtifactLedger(current).register(
      "portable_backup",
      "/safe/current-backup",
    );
    const snapshot = createRetentionRestoreSnapshot(current);
    expect(JSON.stringify(snapshot.envelope)).not.toContain(
      "/safe/current-backup",
    );
    expect(() =>
      parseRetentionRestoreEnvelope({
        ...snapshot.envelope,
        digest: "0".repeat(64),
      }),
    ).toThrow(/digest mismatch/u);

    const staging = database();
    setInstallation(staging, "install-current");
    applyRetentionRestoreEnvelope(staging, snapshot);
    expect(new CapturePolicyLedger(staging).status()).toMatchObject({
      revision: 2,
      l0RetentionDays: 30,
      l1RetentionDays: 90,
    });
    expect(
      new RetentionAuthorizationLedger(staging).status(
        new CapturePolicyLedger(staging).status(),
      ),
    ).toMatchObject({ status: "authorized", revision: 1 });
    expect(new ManagedArtifactLedger(staging).listActive()).toHaveLength(1);
    current.close();
    staging.close();
  });
});
