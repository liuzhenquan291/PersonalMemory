import type { DatabaseSync } from "node:sqlite";

export type ImportJobStatus =
  "pending" | "running" | "completed" | "partial" | "failed" | "cancelled";

export interface ImportRoundPayload {
  sessionKey: string;
  sessionId?: string;
  userContent: string;
  assistantContent: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ImportJobView {
  id: string;
  idempotencyKey: string;
  status: ImportJobStatus;
  cancelRequested: boolean;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImportItem {
  jobId: string;
  itemIndex: number;
  payload: ImportRoundPayload;
  attempts: number;
}

export class ImportIdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key is already associated with different input");
    this.name = "ImportIdempotencyConflictError";
  }
}

interface JobRow {
  id: string;
  idempotency_key: string;
  payload_hash: string;
  status: ImportJobStatus;
  cancel_requested: number;
  total_items: number;
  completed_items: number;
  failed_items: number;
  created_at: string;
  updated_at: string;
}

function toView(row: JobRow): ImportJobView {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    cancelRequested: row.cancel_requested === 1,
    totalItems: row.total_items,
    completedItems: row.completed_items,
    failedItems: row.failed_items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ImportLedger {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.database.exec("PRAGMA foreign_keys = ON");
    const timestamp = this.now();
    this.database
      .prepare(
        `UPDATE personalmemory_import_items
         SET status = CASE WHEN (
           SELECT cancel_requested FROM personalmemory_import_jobs
           WHERE id = personalmemory_import_items.job_id
         ) = 1 THEN 'cancelled' ELSE 'failed' END,
         error_code = CASE WHEN (
           SELECT cancel_requested FROM personalmemory_import_jobs
           WHERE id = personalmemory_import_items.job_id
         ) = 1 THEN NULL ELSE 'INTERRUPTED' END
         WHERE status IN ('pending', 'running')`,
      )
      .run();
    this.database
      .prepare(
        `UPDATE personalmemory_import_jobs
         SET status = CASE
           WHEN cancel_requested = 1 THEN 'cancelled'
           WHEN completed_items > 0 THEN 'partial'
           ELSE 'failed'
         END,
         failed_items = (
           SELECT COUNT(*) FROM personalmemory_import_items
           WHERE job_id = personalmemory_import_jobs.id AND status = 'failed'
         ), updated_at = ?
         WHERE status IN ('pending', 'running')`,
      )
      .run(timestamp);
  }

  create(input: {
    id: string;
    idempotencyKey: string;
    payloadHash: string;
    rounds: readonly ImportRoundPayload[];
  }): { job: ImportJobView; created: boolean } {
    const existing = this.database
      .prepare(
        "SELECT * FROM personalmemory_import_jobs WHERE idempotency_key = ?",
      )
      .get(input.idempotencyKey) as JobRow | undefined;
    if (existing) {
      if (existing.payload_hash !== input.payloadHash) {
        throw new ImportIdempotencyConflictError();
      }
      return { job: toView(existing), created: false };
    }
    const timestamp = this.now();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database
        .prepare(
          `INSERT INTO personalmemory_import_jobs
           (id, idempotency_key, payload_hash, status, total_items, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          input.id,
          input.idempotencyKey,
          input.payloadHash,
          input.rounds.length,
          timestamp,
          timestamp,
        );
      const insertItem = this.database.prepare(
        `INSERT INTO personalmemory_import_items
         (job_id, item_index, session_key, payload_json, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      );
      input.rounds.forEach((round, index) => {
        insertItem.run(
          input.id,
          index,
          round.sessionKey,
          JSON.stringify(round),
        );
      });
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
    return { job: this.get(input.id)!, created: true };
  }

  get(id: string): ImportJobView | undefined {
    const row = this.database
      .prepare("SELECT * FROM personalmemory_import_jobs WHERE id = ?")
      .get(id) as JobRow | undefined;
    return row ? toView(row) : undefined;
  }

  next(jobId: string): ImportItem | undefined {
    const job = this.get(jobId);
    if (!job || job.cancelRequested) return undefined;
    const row = this.database
      .prepare(
        `SELECT job_id, item_index, payload_json, attempts
         FROM personalmemory_import_items
         WHERE job_id = ? AND status = 'pending'
         ORDER BY item_index LIMIT 1`,
      )
      .get(jobId) as
      | {
          job_id: string;
          item_index: number;
          payload_json: string;
          attempts: number;
        }
      | undefined;
    if (!row) return undefined;
    const timestamp = this.now();
    this.database
      .prepare(
        `UPDATE personalmemory_import_items
         SET status = 'running', attempts = attempts + 1, error_code = NULL
         WHERE job_id = ? AND item_index = ? AND status = 'pending'`,
      )
      .run(jobId, row.item_index);
    this.database
      .prepare(
        "UPDATE personalmemory_import_jobs SET status = 'running', updated_at = ? WHERE id = ?",
      )
      .run(timestamp, jobId);
    return {
      jobId,
      itemIndex: row.item_index,
      payload: JSON.parse(row.payload_json) as ImportRoundPayload,
      attempts: row.attempts + 1,
    };
  }

  complete(item: ImportItem): void {
    this.database
      .prepare(
        "UPDATE personalmemory_import_items SET status = 'completed', error_code = NULL WHERE job_id = ? AND item_index = ?",
      )
      .run(item.jobId, item.itemIndex);
    this.refresh(item.jobId);
  }

  fail(item: ImportItem, errorCode: string): void {
    this.database
      .prepare(
        "UPDATE personalmemory_import_items SET status = 'failed', error_code = ? WHERE job_id = ? AND item_index = ?",
      )
      .run(errorCode, item.jobId, item.itemIndex);
    this.refresh(item.jobId);
  }

  cancel(item: ImportItem): void {
    this.database
      .prepare(
        "UPDATE personalmemory_import_items SET status = 'cancelled', error_code = NULL WHERE job_id = ? AND item_index = ?",
      )
      .run(item.jobId, item.itemIndex);
    this.refresh(item.jobId);
  }

  requestCancel(jobId: string): ImportJobView | undefined {
    const job = this.get(jobId);
    if (!job) return undefined;
    if (!["pending", "running"].includes(job.status)) return job;
    this.database
      .prepare(
        "UPDATE personalmemory_import_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?",
      )
      .run(this.now(), jobId);
    this.database
      .prepare(
        "UPDATE personalmemory_import_items SET status = 'cancelled' WHERE job_id = ? AND status = 'pending'",
      )
      .run(jobId);
    this.refresh(jobId);
    return this.get(jobId);
  }

  retry(jobId: string): ImportJobView | undefined {
    const job = this.get(jobId);
    if (!job || !["failed", "partial", "cancelled"].includes(job.status))
      return job;
    this.database
      .prepare(
        `UPDATE personalmemory_import_items
         SET status = 'pending', error_code = NULL
         WHERE job_id = ? AND status IN ('failed', 'cancelled')`,
      )
      .run(jobId);
    this.database
      .prepare(
        "UPDATE personalmemory_import_jobs SET status = 'pending', cancel_requested = 0, failed_items = 0, updated_at = ? WHERE id = ?",
      )
      .run(this.now(), jobId);
    return this.get(jobId);
  }

  private refresh(jobId: string): void {
    const counts = this.database
      .prepare(
        `SELECT
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
         FROM personalmemory_import_items WHERE job_id = ?`,
      )
      .get(jobId) as {
      completed: number;
      failed: number;
      active: number;
      cancelled: number;
    };
    const job = this.get(jobId)!;
    let status: ImportJobStatus = "running";
    if (counts.active === 0) {
      if (job.cancelRequested && counts.cancelled > 0) status = "cancelled";
      else if (counts.failed > 0 && counts.completed > 0) status = "partial";
      else if (counts.failed > 0) status = "failed";
      else status = "completed";
    }
    this.database
      .prepare(
        `UPDATE personalmemory_import_jobs
         SET status = ?, completed_items = ?, failed_items = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, counts.completed, counts.failed, this.now(), jobId);
  }
}
