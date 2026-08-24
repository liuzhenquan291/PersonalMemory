import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  HookAuthorizationConflictError,
  HookAuthorizationLedger,
  defaultMigrations,
  migrateDatabase,
} from "../src/index.js";

describe("HookAuthorizationLedger", () => {
  it("keeps recall and local capture disabled until independently authorized", () => {
    const database = new DatabaseSync(":memory:");
    migrateDatabase(database, defaultMigrations);
    const ledger = new HookAuthorizationLedger(
      database,
      "install_0123456789abcdef",
      () => "2026-08-24T01:00:00.000Z",
    );

    expect(ledger.status()).toEqual({
      installationId: "install_0123456789abcdef",
      authorizationRevision: 1,
      policyRevision: 1,
      recallEnabled: false,
      captureEnabled: false,
      changedAt: "2026-08-24T01:00:00.000Z",
    });

    expect(
      ledger.update({
        expectedRevision: 1,
        recallEnabled: true,
        captureEnabled: false,
      }),
    ).toMatchObject({
      authorizationRevision: 2,
      recallEnabled: true,
      captureEnabled: false,
    });
    expect(() =>
      ledger.update({
        expectedRevision: 1,
        recallEnabled: true,
        captureEnabled: true,
      }),
    ).toThrow(HookAuthorizationConflictError);

    expect(
      ledger.update({
        expectedRevision: 2,
        recallEnabled: false,
        captureEnabled: false,
      }),
    ).toMatchObject({
      authorizationRevision: 3,
      recallEnabled: false,
      captureEnabled: false,
    });
    expect(
      database
        .prepare(
          `SELECT authorization_revision, recall_enabled, capture_enabled
           FROM personalmemory_hook_authorizations
           ORDER BY authorization_revision`,
        )
        .all(),
    ).toEqual([
      {
        authorization_revision: 1,
        recall_enabled: 0,
        capture_enabled: 0,
      },
      {
        authorization_revision: 2,
        recall_enabled: 1,
        capture_enabled: 0,
      },
      {
        authorization_revision: 3,
        recall_enabled: 0,
        capture_enabled: 0,
      },
    ]);

    expect(
      new HookAuthorizationLedger(
        database,
        "install_fedcba9876543210",
        () => "2026-08-24T03:00:00.000Z",
      ).status(),
    ).toEqual({
      installationId: "install_fedcba9876543210",
      authorizationRevision: 4,
      policyRevision: 1,
      recallEnabled: false,
      captureEnabled: false,
      changedAt: "2026-08-24T03:00:00.000Z",
    });
  });
});
