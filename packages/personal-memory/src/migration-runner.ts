import type { DatabaseSync } from "node:sqlite";

const MIGRATION_TABLE = "personalmemory_schema_migrations";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly statements: readonly string[];
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface MigrationResult {
  initialVersion: number;
  currentVersion: number;
  appliedVersions: number[];
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
  }
}

function ensureMigrationTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
}

function validateMigrations(migrations: readonly Migration[]): Migration[] {
  const sorted = [...migrations].sort(
    (left, right) => left.version - right.version,
  );
  for (const [index, migration] of sorted.entries()) {
    const expectedVersion = index + 1;
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version !== expectedVersion
    ) {
      throw new MigrationError(
        `Migration versions must be contiguous from 1; expected ${expectedVersion}, got ${migration.version}`,
      );
    }
    if (!migration.name.trim() || !migration.checksum.trim()) {
      throw new MigrationError(
        `Migration ${migration.version} must have a name and checksum`,
      );
    }
    if (migration.statements.length === 0) {
      throw new MigrationError(
        `Migration ${migration.version} must contain at least one SQL statement`,
      );
    }
    for (const statement of migration.statements) {
      if (!statement.trim()) {
        throw new MigrationError(
          `Migration ${migration.version} contains an empty SQL statement`,
        );
      }
      if (statement.includes(";")) {
        throw new MigrationError(
          `Migration ${migration.version} statements must contain exactly one semicolon-free SQL statement each`,
        );
      }
      if (/^\s*(?:--|\/\*)/.test(statement)) {
        throw new MigrationError(
          `Migration ${migration.version} statements must not start with SQL comments`,
        );
      }
      if (
        /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(statement)
      ) {
        throw new MigrationError(
          `Migration ${migration.version} contains forbidden transaction control SQL`,
        );
      }
    }
  }
  return sorted;
}

export function getAppliedMigrations(
  database: DatabaseSync,
): AppliedMigration[] {
  ensureMigrationTable(database);
  const rows = database
    .prepare(
      `
    SELECT version, name, checksum, applied_at
    FROM ${MIGRATION_TABLE}
    ORDER BY version ASC
  `,
    )
    .all() as Array<{
    version: number;
    name: string;
    checksum: string;
    applied_at: string;
  }>;

  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

export function migrateDatabase(
  database: DatabaseSync,
  migrations: readonly Migration[],
): MigrationResult {
  const ordered = validateMigrations(migrations);
  const applied = getAppliedMigrations(database);
  const byVersion = new Map(
    applied.map((migration) => [migration.version, migration]),
  );
  const initialVersion = applied.at(-1)?.version ?? 0;
  const appliedVersions: number[] = [];

  for (const [index, existing] of applied.entries()) {
    const expectedAppliedVersion = index + 1;
    if (
      !Number.isSafeInteger(existing.version) ||
      existing.version !== expectedAppliedVersion
    ) {
      throw new MigrationError(
        `Applied migration ledger must be a contiguous prefix from 1; expected ${expectedAppliedVersion}, got ${existing.version}`,
      );
    }
    const expected = ordered[existing.version - 1];
    if (!expected) {
      throw new MigrationError(
        `Database schema version ${existing.version} is newer than this application supports`,
      );
    }
    if (
      existing.name !== expected.name ||
      existing.checksum !== expected.checksum
    ) {
      throw new MigrationError(
        `Applied migration ${existing.version} does not match its immutable definition`,
      );
    }
  }

  for (const migration of ordered) {
    const existing = byVersion.get(migration.version);
    if (existing) {
      if (
        existing.name !== migration.name ||
        existing.checksum !== migration.checksum
      ) {
        throw new MigrationError(
          `Applied migration ${migration.version} does not match its immutable definition`,
        );
      }
      continue;
    }

    try {
      database.exec("BEGIN IMMEDIATE");
      const concurrent = database
        .prepare(
          `
        SELECT name, checksum FROM ${MIGRATION_TABLE} WHERE version = ?
      `,
        )
        .get(migration.version) as
        { name: string; checksum: string } | undefined;
      if (concurrent) {
        if (
          concurrent.name !== migration.name ||
          concurrent.checksum !== migration.checksum
        ) {
          throw new MigrationError(
            `Applied migration ${migration.version} does not match its immutable definition`,
          );
        }
        database.exec("COMMIT");
        continue;
      }
      for (const statement of migration.statements) {
        database.prepare(statement).run();
      }
      database
        .prepare(
          `
        INSERT INTO ${MIGRATION_TABLE} (version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `,
        )
        .run(
          migration.version,
          migration.name,
          migration.checksum,
          new Date().toISOString(),
        );
      database.exec("COMMIT");
      appliedVersions.push(migration.version);
    } catch (error) {
      if (database.isTransaction) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the original migration failure.
        }
      }
      const structuralDetail =
        error instanceof MigrationError ? `: ${error.message}` : "";
      throw new MigrationError(
        `Migration ${migration.version} (${migration.name}) failed${structuralDetail}`,
        { cause: error },
      );
    }
  }

  return {
    initialVersion,
    currentVersion: ordered.at(-1)?.version ?? 0,
    appliedVersions,
  };
}
