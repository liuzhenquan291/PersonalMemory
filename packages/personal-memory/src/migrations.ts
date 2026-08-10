import { createHash } from "node:crypto";
import type { Migration } from "./migration-runner.js";

export const PERSONAL_MEMORY_SCHEMA_VERSION = 2;

const INITIAL_SCHEMA_SQL = `
CREATE TABLE personalmemory_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`;

const IMPORT_JOBS_SQL = `
CREATE TABLE personalmemory_import_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  total_items INTEGER NOT NULL,
  completed_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT
`;

const IMPORT_ITEMS_SQL = `
CREATE TABLE personalmemory_import_items (
  job_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  PRIMARY KEY (job_id, item_index),
  FOREIGN KEY (job_id) REFERENCES personalmemory_import_jobs(id) ON DELETE CASCADE
) STRICT
`;

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export const defaultMigrations: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: "initialize_personalmemory_metadata",
    checksum: checksum(INITIAL_SCHEMA_SQL),
    statements: [INITIAL_SCHEMA_SQL],
  },
  {
    version: 2,
    name: "add_conversation_import_ledger",
    checksum: checksum(`${IMPORT_JOBS_SQL}\n${IMPORT_ITEMS_SQL}`),
    statements: [IMPORT_JOBS_SQL, IMPORT_ITEMS_SQL],
  },
]);
