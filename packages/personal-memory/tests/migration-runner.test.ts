import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MigrationError,
  defaultMigrations,
  getAppliedMigrations,
  migrateDatabase,
  type Migration,
} from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/schema-v0.sql", import.meta.url),
);

function withDatabase(run: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(":memory:");
  try {
    run(database);
  } finally {
    database.close();
  }
}

describe("migrateDatabase", () => {
  it("initializes an empty database", () => {
    withDatabase((database) => {
      const result = migrateDatabase(database, defaultMigrations);

      expect(result).toEqual({
        initialVersion: 0,
        currentVersion: 1,
        appliedVersions: [1],
      });
      expect(getAppliedMigrations(database)).toHaveLength(1);
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM personalmemory_metadata")
          .get(),
      ).toEqual({ count: 0 });
    });
  });

  it("is idempotent and preserves a version zero fixture", () => {
    withDatabase((database) => {
      database.exec(readFileSync(fixturePath, "utf8"));

      migrateDatabase(database, defaultMigrations);
      const second = migrateDatabase(database, defaultMigrations);

      expect(second).toEqual({
        initialVersion: 1,
        currentVersion: 1,
        appliedVersions: [],
      });
      expect(
        database.prepare("SELECT value FROM legacy_fixture WHERE id = 1").get(),
      ).toEqual({ value: "preserve-me" });
      expect(getAppliedMigrations(database)).toHaveLength(1);
    });
  });

  it("rolls back a failed migration and leaves the prior version usable", () => {
    withDatabase((database) => {
      migrateDatabase(database, defaultMigrations);
      const failingMigration: Migration = {
        version: 2,
        name: "failing_fixture",
        checksum: "test-only-failing-fixture-v1",
        statements: [
          "CREATE TABLE must_rollback (id INTEGER PRIMARY KEY)",
          "INSERT INTO table_that_does_not_exist VALUES (1)",
        ],
      };

      expect(() =>
        migrateDatabase(database, [...defaultMigrations, failingMigration]),
      ).toThrow(MigrationError);
      expect(
        getAppliedMigrations(database).map(({ version }) => version),
      ).toEqual([1]);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'must_rollback'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM personalmemory_metadata")
          .get(),
      ).toEqual({ count: 0 });
    });
  });

  it("rejects mutation of an already applied migration", () => {
    withDatabase((database) => {
      migrateDatabase(database, defaultMigrations);
      const changed = [{ ...defaultMigrations[0]!, checksum: "changed" }];

      expect(() => migrateDatabase(database, changed)).toThrow(
        /immutable definition/,
      );
    });
  });

  it("refuses a database created by a newer application", () => {
    withDatabase((database) => {
      migrateDatabase(database, defaultMigrations);
      database
        .prepare(
          `
        INSERT INTO personalmemory_schema_migrations (version, name, checksum, applied_at)
        VALUES (2, 'future_migration', 'future-checksum', ?)
      `,
        )
        .run(new Date().toISOString());

      expect(() => migrateDatabase(database, defaultMigrations)).toThrow(
        /newer than this application supports/,
      );
    });
  });

  it("rejects a migration ledger with a version gap", () => {
    withDatabase((database) => {
      const migrations: Migration[] = [
        ...defaultMigrations,
        {
          version: 2,
          name: "second",
          checksum: "second-v1",
          statements: ["SELECT 1"],
        },
        {
          version: 3,
          name: "third",
          checksum: "third-v1",
          statements: ["SELECT 1"],
        },
      ];
      migrateDatabase(database, migrations);
      database
        .prepare(
          "DELETE FROM personalmemory_schema_migrations WHERE version = 2",
        )
        .run();

      expect(() => migrateDatabase(database, migrations)).toThrow(
        /contiguous prefix/,
      );
    });
  });

  it("rejects configured migrations with a version gap", () => {
    const migrationWithGap: Migration = {
      version: 3,
      name: "third",
      checksum: "third-v1",
      statements: ["SELECT 1"],
    };

    withDatabase((database) => {
      expect(() =>
        migrateDatabase(database, [...defaultMigrations, migrationWithGap]),
      ).toThrow(/contiguous from 1/);
    });
  });

  it("fails predictably on a locked database and succeeds idempotently after retry", () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "personalmemory-migration-"),
    );
    const databasePath = path.join(directory, "personal-memory.db");
    const lockOwner = new DatabaseSync(databasePath);
    const contender = new DatabaseSync(databasePath);
    try {
      getAppliedMigrations(contender);
      lockOwner.exec("BEGIN IMMEDIATE");
      expect(() => migrateDatabase(contender, defaultMigrations)).toThrow(
        MigrationError,
      );
      lockOwner.exec("ROLLBACK");

      expect(
        migrateDatabase(contender, defaultMigrations).appliedVersions,
      ).toEqual([1]);
      expect(
        migrateDatabase(contender, defaultMigrations).appliedVersions,
      ).toEqual([]);
    } finally {
      if (lockOwner.isTransaction) lockOwner.exec("ROLLBACK");
      contender.close();
      lockOwner.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "COMMIT",
    "END TRANSACTION",
    "-- comment\nEND TRANSACTION",
    "/* comment */ COMMIT",
  ])("rejects %s before schema or data can leak", (transactionControl) => {
    withDatabase((database) => {
      const transactionBreakingMigration: Migration = {
        version: 1,
        name: "transaction_breaker",
        checksum: "transaction-breaker-v1",
        statements: [
          "CREATE TABLE must_not_leak (id INTEGER PRIMARY KEY)",
          transactionControl,
        ],
      };

      expect(() =>
        migrateDatabase(database, [transactionBreakingMigration]),
      ).toThrow(/transaction control SQL|start with SQL comments/);
      expect(getAppliedMigrations(database)).toHaveLength(0);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'must_not_leak'",
          )
          .get(),
      ).toBeUndefined();
    });
  });
});
