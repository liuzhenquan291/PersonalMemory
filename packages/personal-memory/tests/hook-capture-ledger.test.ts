import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  HookCaptureLedger,
  HOOK_CAPTURE_COMMITTED,
  PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
  defaultMigrations,
  migrateDatabase,
  type HookCaptureRequest,
} from "../src/index.js";

const request: HookCaptureRequest = {
  contract_version: PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
  event: {
    client: "codex",
    session_id: "session-1",
    turn_id: "turn-1",
    subagent: false,
  },
  authorization: {
    installation_id: "installation-1",
    authorization_revision: 1,
    policy_revision: 1,
  },
  source: { kind: "agent_lifecycle", working_directory: "/project" },
  idempotency_key: `hook:v1:${"a".repeat(64)}`,
  messages: [
    { role: "user", content: "Remember local-first" },
    { role: "assistant", content: "I will." },
  ],
};

describe("HookCaptureLedger", () => {
  it("distinguishes a retry from a conflicting payload without storing content", () => {
    const database = new DatabaseSync(":memory:");
    migrateDatabase(database, defaultMigrations);
    const ledger = new HookCaptureLedger(
      database,
      () => "2026-08-18T00:00:00Z",
    );

    let writes = 0;
    expect(
      ledger.capture(request, () => {
        writes += 1;
        return HOOK_CAPTURE_COMMITTED;
      }),
    ).toBe("captured");
    expect(
      ledger.capture(request, () => {
        writes += 1;
        return HOOK_CAPTURE_COMMITTED;
      }),
    ).toBe("duplicate");
    expect(
      ledger.capture(
        {
          ...request,
          messages: [
            request.messages[0],
            { role: "assistant", content: "Changed" },
          ],
        },
        () => {
          writes += 1;
          return HOOK_CAPTURE_COMMITTED;
        },
      ),
    ).toBe("conflict");
    expect(writes).toBe(1);

    const stored = JSON.stringify(
      database.prepare("SELECT * FROM personalmemory_hook_captures").all(),
    );
    expect(stored).not.toContain("Remember local-first");
    expect(stored).not.toContain("I will");
    database.close();
  });

  it("rolls back the local write and idempotency row together", () => {
    const database = new DatabaseSync(":memory:");
    migrateDatabase(database, defaultMigrations);
    database.exec("CREATE TABLE local_l0 (content TEXT NOT NULL) STRICT");
    const ledger = new HookCaptureLedger(database);

    expect(() =>
      ledger.capture(request, (transaction) => {
        transaction.prepare("INSERT INTO local_l0 VALUES (?)").run("private");
        throw new Error("fail after write");
      }),
    ).toThrow("fail after write");
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM local_l0").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM personalmemory_hook_captures")
        .get(),
    ).toEqual({ count: 0 });
    database.close();
  });

  it("rejects a sink that does not return the synchronous commit sentinel", () => {
    const database = new DatabaseSync(":memory:");
    migrateDatabase(database, defaultMigrations);
    const ledger = new HookCaptureLedger(database);
    expect(() =>
      ledger.capture(request, (() =>
        Promise.resolve()) as unknown as () => typeof HOOK_CAPTURE_COMMITTED),
    ).toThrow("did not commit synchronously");
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM personalmemory_hook_captures")
        .get(),
    ).toEqual({ count: 0 });
    database.close();
  });
});
