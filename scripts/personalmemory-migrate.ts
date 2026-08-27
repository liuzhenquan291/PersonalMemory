import {
  PERSONAL_MEMORY_SCHEMA_VERSION,
  defaultMigrations,
  migrateDatabase,
} from "@personalmemory/core";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import process from "node:process";

const dataDirectory = process.env.PERSONALMEMORY_DATA_DIR;
if (!dataDirectory) throw new Error("PERSONALMEMORY_DATA_DIR is required");
const database = new DatabaseSync(
  path.join(path.resolve(dataDirectory), "personalmemory.sqlite"),
);
try {
  const result = migrateDatabase(database, defaultMigrations);
  process.stdout.write(
    `${JSON.stringify({ ...result, targetVersion: PERSONAL_MEMORY_SCHEMA_VERSION })}\n`,
  );
} finally {
  database.close();
}
