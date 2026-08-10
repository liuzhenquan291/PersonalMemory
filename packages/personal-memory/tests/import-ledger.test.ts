import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ImportIdempotencyConflictError,
  ImportLedger,
  defaultMigrations,
  migrateDatabase,
  type ImportRoundPayload,
} from "../src/index.js";

const round: ImportRoundPayload = {
  sessionKey: "session-1",
  userContent: "private user content",
  assistantContent: "private assistant content",
  messages: [
    { role: "user", content: "private user content" },
    { role: "assistant", content: "private assistant content" },
  ],
};

function withLedger(
  run: (ledger: ImportLedger, database: DatabaseSync) => void,
) {
  const database = new DatabaseSync(":memory:");
  migrateDatabase(database, defaultMigrations);
  try {
    run(new ImportLedger(database, () => "2026-08-10T00:00:00.000Z"), database);
  } finally {
    database.close();
  }
}

describe("ImportLedger", () => {
  it("creates one durable job per idempotency key and rejects changed input", () => {
    withLedger((ledger) => {
      const first = ledger.create({
        id: "job-1",
        idempotencyKey: "key-1",
        payloadHash: "hash-1",
        rounds: [round],
      });
      expect(first.created).toBe(true);
      expect(first.job).toMatchObject({ status: "pending", totalItems: 1 });
      expect(
        ledger.create({
          id: "job-2",
          idempotencyKey: "key-1",
          payloadHash: "hash-1",
          rounds: [round],
        }),
      ).toMatchObject({ created: false, job: { id: "job-1" } });
      expect(() =>
        ledger.create({
          id: "job-3",
          idempotencyKey: "key-1",
          payloadHash: "changed",
          rounds: [round],
        }),
      ).toThrow(ImportIdempotencyConflictError);
    });
  });

  it("retries only failed items and never requeues completed items", () => {
    withLedger((ledger, database) => {
      ledger.create({
        id: "job-1",
        idempotencyKey: "key-1",
        payloadHash: "hash-1",
        rounds: [round, { ...round, sessionKey: "session-2" }],
      });
      const first = ledger.next("job-1")!;
      ledger.complete(first);
      const second = ledger.next("job-1")!;
      ledger.fail(second, "UPSTREAM_UNAVAILABLE");
      expect(ledger.get("job-1")).toMatchObject({
        status: "partial",
        completedItems: 1,
        failedItems: 1,
      });

      ledger.retry("job-1");
      const retry = ledger.next("job-1")!;
      expect(retry.itemIndex).toBe(1);
      expect(retry.attempts).toBe(2);
      expect(
        database
          .prepare(
            "SELECT attempts FROM personalmemory_import_items WHERE job_id = ? AND item_index = 0",
          )
          .get("job-1"),
      ).toEqual({ attempts: 1 });
    });
  });

  it("marks pending work cancelled and recovers interrupted running work", () => {
    withLedger((ledger, database) => {
      ledger.create({
        id: "job-1",
        idempotencyKey: "key-1",
        payloadHash: "hash-1",
        rounds: [round, round],
      });
      ledger.next("job-1");
      const cancelled = ledger.requestCancel("job-1");
      expect(cancelled).toMatchObject({ cancelRequested: true });

      ledger.create({
        id: "job-2",
        idempotencyKey: "key-2",
        payloadHash: "hash-2",
        rounds: [round],
      });

      const recovered = new ImportLedger(
        database,
        () => "2026-08-10T00:01:00.000Z",
      );
      expect(recovered.get("job-1")).toMatchObject({
        status: "cancelled",
        failedItems: 0,
      });
      expect(recovered.get("job-2")).toMatchObject({
        status: "failed",
        failedItems: 1,
      });
    });
  });
});
