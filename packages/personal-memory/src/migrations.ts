import { createHash } from "node:crypto";
import type { Migration } from "./migration-runner.js";

export const PERSONAL_MEMORY_SCHEMA_VERSION = 1;

const INITIAL_SCHEMA_SQL = `
CREATE TABLE personalmemory_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
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
]);
