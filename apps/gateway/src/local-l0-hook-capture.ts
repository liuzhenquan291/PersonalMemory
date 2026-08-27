import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  HOOK_CAPTURE_COMMITTED,
  HookCaptureLedger,
  type HookCaptureRequest,
} from "@personalmemory/core";
import type { HookCaptureSink } from "./hook-lifecycle.js";

const HOOK_CAPTURE_SCHEMA_VERSION = 1;
const HOOK_CAPTURE_SCHEMA = `
CREATE TABLE personalmemory_hook_captures (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  status TEXT NOT NULL CHECK (status = 'captured'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT
`;
const REQUIRED_L0_COLUMNS = new Set([
  "record_id",
  "session_key",
  "session_id",
  "role",
  "message_text",
  "recorded_at",
  "timestamp",
]);

function assertUpstreamL0Schema(database: DatabaseSync): void {
  const columns = database
    .prepare("PRAGMA table_info(l0_conversations)")
    .all() as {
    name: string;
  }[];
  if (
    columns.length === 0 ||
    [...REQUIRED_L0_COLUMNS].some(
      (required) => !columns.some(({ name }) => name === required),
    )
  ) {
    throw new Error(
      "Upstream L0 schema is unavailable or incompatible; start the upstream Gateway first",
    );
  }
}

function migrateHookCaptureSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS personalmemory_hook_schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
  const current = database
    .prepare(
      "SELECT MAX(version) AS version FROM personalmemory_hook_schema_migrations",
    )
    .get() as { version: number | null };
  if ((current.version ?? 0) > HOOK_CAPTURE_SCHEMA_VERSION) {
    throw new Error("Hook capture schema is newer than this Gateway");
  }
  if (current.version === HOOK_CAPTURE_SCHEMA_VERSION) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(HOOK_CAPTURE_SCHEMA);
    database
      .prepare(
        "INSERT INTO personalmemory_hook_schema_migrations (version, applied_at) VALUES (?, ?)",
      )
      .run(HOOK_CAPTURE_SCHEMA_VERSION, new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export function initializeLocalL0HookCaptureDatabase(
  databasePath: string,
): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 500");
    database.exec("PRAGMA journal_mode = WAL");
    assertUpstreamL0Schema(database);
    migrateHookCaptureSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function createProductionHookCapture(dataDirectory: string) {
  const database = initializeLocalL0HookCaptureDatabase(
    join(dataDirectory, "vectors.db"),
  );
  return {
    database,
    ledger: new HookCaptureLedger(database),
    sink: createLocalL0HookCaptureSink(database),
  };
}

function recordId(request: HookCaptureRequest, role: "user" | "assistant") {
  return `hook-l0:${createHash("sha256")
    .update(`${request.idempotency_key}\0${role}`)
    .digest("hex")}`;
}

export function createLocalL0HookCaptureSink(
  database: DatabaseSync,
  now: () => Date = () => new Date(),
): HookCaptureSink {
  return {
    capture(request, _requestId, transaction) {
      if (transaction !== database || !transaction.isTransaction) {
        throw new Error(
          "Local L0 capture requires the active Hook transaction",
        );
      }
      const capturedAt = now();
      const recordedAt = capturedAt.toISOString();
      const timestamp = capturedAt.getTime();
      const sessionKey = `hook:${request.event.client}:${request.authorization.installation_id}:${request.event.session_id}`;
      const insert = transaction.prepare(`
        INSERT INTO l0_conversations
          (record_id, session_key, session_id, role, message_text, recorded_at, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const message of request.messages) {
        insert.run(
          recordId(request, message.role),
          sessionKey,
          request.event.session_id,
          message.role,
          message.content,
          recordedAt,
          timestamp,
        );
      }
      return HOOK_CAPTURE_COMMITTED;
    },
  };
}
