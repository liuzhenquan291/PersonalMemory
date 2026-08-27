import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ModelAuthorizationLedger,
  defaultMigrations,
  migrateDatabase,
  type ModelOutboundDisclosure,
} from "../src/index.js";

const disclosure: ModelOutboundDisclosure = {
  version: 1,
  provider: "openai-compatible",
  targetOrigin: "https://models.example.test",
  sentFields: [
    "model input",
    "selected memory context",
    "imported conversation messages",
  ],
};

describe("ModelAuthorizationLedger", () => {
  it("versions authorization and makes changed disclosures stale", () => {
    const database = new DatabaseSync(":memory:");
    migrateDatabase(database, defaultMigrations);
    const ledger = new ModelAuthorizationLedger(
      database,
      () => "2026-08-24T00:00:00.000Z",
    );

    expect(ledger.status(disclosure)).toEqual({
      status: "required",
      revision: 0,
    });
    expect(ledger.authorize(disclosure)).toEqual({
      status: "authorized",
      revision: 1,
      authorizedAt: "2026-08-24T00:00:00.000Z",
    });
    expect(ledger.authorize(disclosure)).toEqual({
      status: "authorized",
      revision: 1,
      authorizedAt: "2026-08-24T00:00:00.000Z",
    });
    expect(
      ledger.status({
        ...disclosure,
        targetOrigin: "https://other.example.test",
      }),
    ).toEqual({ status: "stale", revision: 1 });
    expect(ledger.revoke(disclosure)).toEqual({
      status: "revoked",
      revision: 2,
      revokedAt: "2026-08-24T00:00:00.000Z",
    });
    expect(ledger.revoke(disclosure)).toEqual({
      status: "revoked",
      revision: 2,
      revokedAt: "2026-08-24T00:00:00.000Z",
    });
    expect(
      database
        .prepare(
          "SELECT provider, target_origin, sent_fields_json FROM personalmemory_model_authorizations ORDER BY revision",
        )
        .all(),
    ).toEqual([
      {
        provider: "openai-compatible",
        target_origin: "https://models.example.test",
        sent_fields_json: JSON.stringify(disclosure.sentFields),
      },
      {
        provider: "openai-compatible",
        target_origin: "https://models.example.test",
        sent_fields_json: JSON.stringify(disclosure.sentFields),
      },
    ]);
  });
});
