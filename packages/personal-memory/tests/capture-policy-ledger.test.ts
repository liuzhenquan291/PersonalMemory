import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CapturePolicyConflictError,
  CapturePolicyLedger,
  defaultMigrations,
  migrateDatabase,
} from "../src/index.js";

describe("CapturePolicyLedger", () => {
  let database: DatabaseSync;
  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    migrateDatabase(database, defaultMigrations);
  });

  it("starts enabled with conservative sensitive rules and unlimited retention", () => {
    expect(
      new CapturePolicyLedger(
        database,
        () => "2026-08-24T00:00:00.000Z",
      ).status(),
    ).toMatchObject({
      revision: 1,
      captureEnabled: true,
      sensitiveCategories: ["credentials", "financial", "identity"],
      l0RetentionDays: null,
      l1RetentionDays: null,
    });
  });

  it("versions policy and applies client, project, source and sensitive exclusions", () => {
    const ledger = new CapturePolicyLedger(database);
    const status = ledger.update({
      expectedRevision: 1,
      captureEnabled: true,
      excludedClients: ["codex"],
      excludedWorkingDirectories: ["/private/work"],
      excludedSources: [],
      sensitiveCategories: ["credentials", "financial"],
      l0RetentionDays: 30,
      l1RetentionDays: 365,
    });
    expect(status.revision).toBe(2);
    expect(
      ledger.allowsSource({
        client: "codex",
        workingDirectory: "/safe",
        source: "agent_lifecycle",
      }),
    ).toBe(false);
    expect(
      ledger.allowsSource({
        client: "claude-code",
        workingDirectory: "/private/work/../work/child",
        source: "agent_lifecycle",
      }),
    ).toBe(false);
    expect(
      ledger.allowsSource({
        client: "claude-code",
        workingDirectory: "/private/work/child",
        source: "agent_lifecycle",
      }),
    ).toBe(false);
    expect(ledger.sensitiveCategory("password = hunter22")).toBe("credentials");
    expect(
      ledger.sensitiveCategory("ordinary identifier 4111 1111 1111 1112"),
    ).toBeUndefined();
    expect(ledger.sensitiveCategory("payment 4242 4242 4242 4242")).toBe(
      "financial",
    );
    expect(
      ledger.sensitiveCategory("ordinary identifier 1234567890123456"),
    ).toBeUndefined();
    expect(
      ledger.sensitiveCategory("Authorization: Bearer abcdefghijklmnop"),
    ).toBe("credentials");
    expect(
      ledger.sensitiveCategory(["-----BEGIN", "PRIVATE KEY-----"].join(" ")),
    ).toBe("credentials");
    expect(ledger.history({ limit: 1 })).toHaveLength(1);
    expect(ledger.history({ beforeRevision: 2 })).toMatchObject([
      { revision: 1 },
    ]);
  });

  it("normalizes trailing separators and supports excluding the filesystem root", () => {
    const ledger = new CapturePolicyLedger(database);
    ledger.update({
      expectedRevision: 1,
      captureEnabled: true,
      excludedClients: [],
      excludedWorkingDirectories: ["/private/work/"],
      excludedSources: [],
      sensitiveCategories: [],
      l0RetentionDays: null,
      l1RetentionDays: null,
    });
    expect(
      ledger.allowsSource({
        client: "codex",
        workingDirectory: "/private/work/child",
        source: "agent_lifecycle",
      }),
    ).toBe(false);
    ledger.update({
      expectedRevision: 2,
      captureEnabled: true,
      excludedClients: [],
      excludedWorkingDirectories: ["/"],
      excludedSources: [],
      sensitiveCategories: [],
      l0RetentionDays: null,
      l1RetentionDays: null,
    });
    expect(
      ledger.allowsSource({
        client: "codex",
        workingDirectory: "/anywhere",
        source: "agent_lifecycle",
      }),
    ).toBe(false);
  });

  it("rejects stale updates", () => {
    const ledger = new CapturePolicyLedger(database);
    const input = {
      expectedRevision: 2,
      captureEnabled: true,
      excludedClients: [],
      excludedWorkingDirectories: [],
      excludedSources: [],
      sensitiveCategories: [],
      l0RetentionDays: null,
      l1RetentionDays: null,
    } as const;
    expect(() => ledger.update(input)).toThrow(CapturePolicyConflictError);
  });
});
