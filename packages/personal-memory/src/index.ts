export {
  PERSONAL_MEMORY_SCHEMA_VERSION,
  defaultMigrations,
} from "./migrations.js";
export {
  MigrationError,
  getAppliedMigrations,
  migrateDatabase,
  type AppliedMigration,
  type Migration,
  type MigrationResult,
} from "./migration-runner.js";
