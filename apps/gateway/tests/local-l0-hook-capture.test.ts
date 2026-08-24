import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ImportLedger,
  MemoryGovernanceLedger,
  MemoryReviewLedger,
  MemoryStateLedger,
  ModelAuthorizationLedger,
  PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
  defaultMigrations,
  getModelOutboundDisclosure,
  loadConfig,
  migrateDatabase,
} from "@personalmemory/core";
import { createGatewayApp } from "../src/app.js";
import { ConversationImportManager } from "../src/import-manager.js";
import { createProductionHookCapture } from "../src/local-l0-hook-capture.js";
import type { HookLifecyclePolicy } from "../src/hook-lifecycle.js";
import type { UpstreamGatewayClient } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("production local L0 Hook capture", () => {
  it("captures through the public API while model authorization is required", async () => {
    let modelRequests = 0;
    const modelTrap = createServer((_request, response) => {
      modelRequests += 1;
      response.writeHead(500).end();
    });
    await new Promise<void>((resolve) =>
      modelTrap.listen(0, "127.0.0.1", resolve),
    );
    const address = modelTrap.address();
    if (!address || typeof address === "string")
      throw new Error("No model trap address");
    const directory = await mkdtemp(join(tmpdir(), "personalmemory-hook-l0-"));
    temporaryDirectories.push(directory);
    let product: DatabaseSync | undefined;
    let capture: ReturnType<typeof createProductionHookCapture> | undefined;
    try {
      const upstreamOwner = new DatabaseSync(join(directory, "vectors.db"));
      upstreamOwner.exec(`
        CREATE TABLE l0_conversations (
          record_id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL,
          session_id TEXT DEFAULT '',
          role TEXT NOT NULL DEFAULT '',
          message_text TEXT NOT NULL,
          recorded_at TEXT DEFAULT '',
          timestamp INTEGER DEFAULT 0
        );
        CREATE TABLE l1_records (record_id TEXT PRIMARY KEY);
        CREATE TABLE scene_blocks (path TEXT PRIMARY KEY)
      `);
      upstreamOwner.close();
      capture = createProductionHookCapture(directory);
      product = new DatabaseSync(join(directory, "personalmemory.sqlite"));
      migrateDatabase(product, defaultMigrations);
      const { config } = loadConfig({
        environment: {
          PERSONALMEMORY_AUTH_ENABLED: "true",
          PERSONALMEMORY_AUTH_TOKEN: "test-auth-secret",
          PERSONALMEMORY_MODEL_ENABLED: "true",
          PERSONALMEMORY_MODEL_PROVIDER: "openai-compatible",
          PERSONALMEMORY_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          PERSONALMEMORY_MODEL_ALLOWED_ORIGINS: `http://127.0.0.1:${address.port}`,
          PERSONALMEMORY_MODEL_API_KEY: "private-model-key",
          PERSONALMEMORY_MODEL_NAME: "trap-model",
        },
      });
      const disclosure = getModelOutboundDisclosure(config)!;
      expect(new ModelAuthorizationLedger(product).status(disclosure)).toEqual({
        status: "required",
        revision: 0,
      });
      const upstream: UpstreamGatewayClient = {
        async request({ path }) {
          if (path !== "/v2/conversation/query") {
            return { status: 200, body: { code: 0, data: {} } };
          }
          const rows = capture!.database
            .prepare(
              "SELECT record_id, role, message_text, recorded_at FROM l0_conversations ORDER BY role DESC",
            )
            .all() as {
            record_id: string;
            role: string;
            message_text: string;
            recorded_at: string;
          }[];
          return {
            status: 200,
            body: {
              code: 0,
              data: {
                messages: rows.map((row) => ({
                  id: row.record_id,
                  role: row.role,
                  content: row.message_text,
                  timestamp: row.recorded_at,
                })),
                total: rows.length,
              },
            },
          };
        },
      };
      const policy: HookLifecyclePolicy = {
        authorization: () => ({
          installationId: "installation-1",
          authorizationRevision: 1,
          policyRevision: 1,
          recallEnabled: false,
          captureEnabled: true,
        }),
        allowsSource: () => true,
      };
      const app = createGatewayApp({
        config,
        upstream,
        importManager: new ConversationImportManager(
          new ImportLedger(product),
          upstream,
          config.server.upstreamTimeoutMs,
        ),
        memoryStates: new MemoryStateLedger(product),
        memoryReviews: new MemoryReviewLedger(product),
        memoryGovernance: new MemoryGovernanceLedger(product),
        hookCaptures: capture.ledger,
        hookCaptureSink: capture.sink,
        hookPolicy: policy,
      });
      const request = {
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
        source: {
          kind: "agent_lifecycle",
          working_directory: "/private/project",
        },
        idempotency_key: `hook:v1:${"a".repeat(64)}`,
        messages: [
          { role: "user", content: "private user text" },
          { role: "assistant", content: "private assistant text" },
        ],
      };
      const captured = await app.request("/api/v1/hooks/capture", {
        method: "POST",
        headers: {
          authorization: "Bearer test-auth-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });
      expect(await captured.json()).toMatchObject({ outcome: "captured" });
      const browsed = await app.request("/api/v1/memories?level=L0", {
        headers: { authorization: "Bearer test-auth-secret" },
      });
      expect(await browsed.json()).toMatchObject({
        items: [
          { level: "L0", content: "private user text" },
          { level: "L0", content: "private assistant text" },
        ],
        total: 2,
      });
      expect(
        capture.database
          .prepare(
            "SELECT (SELECT COUNT(*) FROM l1_records) + (SELECT COUNT(*) FROM scene_blocks) AS count",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(modelRequests).toBe(0);
    } finally {
      capture?.database.close();
      product?.close();
      await new Promise<void>((resolve, reject) =>
        modelTrap.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("versions its owned schema and rejects an incompatible upstream L0", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "personalmemory-hook-schema-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "vectors.db");
    const incompatible = new DatabaseSync(databasePath);
    incompatible.exec(
      "CREATE TABLE l0_conversations (record_id TEXT PRIMARY KEY)",
    );
    incompatible.close();
    expect(() => createProductionHookCapture(directory)).toThrow(
      /Upstream L0 schema is unavailable or incompatible/,
    );
  });

  it("rolls back both L0 and idempotency state when the second row fails", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "personalmemory-hook-rollback-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "vectors.db");
    const upstreamOwner = new DatabaseSync(databasePath);
    upstreamOwner.exec(`
      CREATE TABLE l0_conversations (
        record_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_id TEXT DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        message_text TEXT NOT NULL,
        recorded_at TEXT DEFAULT '',
        timestamp INTEGER DEFAULT 0
      );
      CREATE TRIGGER fail_assistant BEFORE INSERT ON l0_conversations
      WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END
    `);
    upstreamOwner.close();
    const capture = createProductionHookCapture(directory);
    try {
      const request = {
        contract_version: PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
        event: {
          client: "codex" as const,
          session_id: "session-rollback",
          turn_id: "turn-rollback",
          subagent: false as const,
        },
        authorization: {
          installation_id: "installation-1",
          authorization_revision: 1,
          policy_revision: 1,
        },
        source: {
          kind: "agent_lifecycle" as const,
          working_directory: "/private/project",
        },
        idempotency_key: `hook:v1:${"b".repeat(64)}`,
        messages: [
          { role: "user" as const, content: "must roll back" },
          { role: "assistant" as const, content: "fixture failure" },
        ] as const,
      };
      expect(() =>
        capture.ledger.capture(request, (transaction) =>
          capture!.sink.capture(request, "request-rollback", transaction),
        ),
      ).toThrow(/fixture failure/);
      expect(
        capture.database
          .prepare("SELECT COUNT(*) AS count FROM l0_conversations")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        capture.database
          .prepare("SELECT COUNT(*) AS count FROM personalmemory_hook_captures")
          .get(),
      ).toEqual({ count: 0 });
      expect(
        capture.database
          .prepare(
            "SELECT MAX(version) AS version FROM personalmemory_hook_schema_migrations",
          )
          .get(),
      ).toEqual({ version: 1 });
    } finally {
      capture.database.close();
    }
  });

  it("fails within the Hook deadline when the upstream database is write-locked", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "personalmemory-hook-locked-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "vectors.db");
    const upstreamOwner = new DatabaseSync(databasePath);
    upstreamOwner.exec(`
      CREATE TABLE l0_conversations (
        record_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_id TEXT DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        message_text TEXT NOT NULL,
        recorded_at TEXT DEFAULT '',
        timestamp INTEGER DEFAULT 0
      )
    `);
    upstreamOwner.close();
    const capture = createProductionHookCapture(directory);
    const lockOwner = new DatabaseSync(databasePath);
    lockOwner.exec("BEGIN IMMEDIATE");
    const startedAt = Date.now();
    try {
      expect(() => capture.database.exec("BEGIN IMMEDIATE")).toThrow(
        /database is locked/,
      );
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(capture.database.isTransaction).toBe(false);
    } finally {
      lockOwner.exec("ROLLBACK");
      lockOwner.close();
      capture.database.close();
    }
  });
});
