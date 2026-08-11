import type { DatabaseSync } from "node:sqlite";

export type MemoryReviewLevel = "L1" | "L2" | "L3";
export type MemoryReviewStatus = "pending" | "approved" | "rejected";

export interface MemoryReview {
  level: MemoryReviewLevel;
  memoryId: string;
  status: MemoryReviewStatus;
  reason?: string;
  revision: number;
  updatedAt?: string;
}

export class MemoryReviewConflictError extends Error {
  constructor(options?: ErrorOptions) {
    super("The memory review changed after it was loaded", options);
    this.name = "MemoryReviewConflictError";
  }
}

interface ReviewRow {
  level: MemoryReviewLevel;
  memory_id: string;
  status: MemoryReviewStatus;
  reason: string | null;
  revision: number;
  updated_at: string;
}

function view(row: ReviewRow): MemoryReview {
  return {
    level: row.level,
    memoryId: row.memory_id,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export class MemoryReviewLedger {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get(level: MemoryReviewLevel, memoryId: string): MemoryReview {
    const row = this.database
      .prepare(
        `SELECT level, memory_id, status, reason, revision, updated_at
         FROM personalmemory_memory_reviews WHERE level = ? AND memory_id = ?`,
      )
      .get(level, memoryId) as ReviewRow | undefined;
    return row
      ? view(row)
      : { level, memoryId, status: "pending", revision: 0 };
  }

  getMany(
    keys: readonly { level: MemoryReviewLevel; memoryId: string }[],
  ): Map<string, MemoryReview> {
    return new Map(
      keys.map((key) => {
        const review = this.get(key.level, key.memoryId);
        return [`${key.level}:${key.memoryId}`, review];
      }),
    );
  }

  set(
    level: MemoryReviewLevel,
    memoryId: string,
    status: MemoryReviewStatus,
    expectedRevision: number,
    reason?: string,
  ): MemoryReview {
    const current = this.get(level, memoryId);
    if (
      current.status === status &&
      current.revision === expectedRevision + 1 &&
      (current.reason ?? "") === (reason ?? "")
    ) {
      return current;
    }
    if (current.revision !== expectedRevision) {
      throw new MemoryReviewConflictError();
    }
    const revision = expectedRevision + 1;
    const updatedAt = this.now();
    try {
      this.database
        .prepare(
          `INSERT INTO personalmemory_memory_reviews
           (level, memory_id, status, reason, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(level, memory_id) DO UPDATE SET
             status = excluded.status,
             reason = excluded.reason,
             revision = excluded.revision,
             updated_at = excluded.updated_at
           WHERE personalmemory_memory_reviews.revision = ?`,
        )
        .run(
          level,
          memoryId,
          status,
          reason ?? null,
          revision,
          updatedAt,
          expectedRevision,
        );
    } catch (error) {
      throw new MemoryReviewConflictError({ cause: error });
    }
    const result = this.get(level, memoryId);
    if (
      result.revision !== revision ||
      result.status !== status ||
      (result.reason ?? "") !== (reason ?? "")
    ) {
      throw new MemoryReviewConflictError();
    }
    return result;
  }

  isApproved(level: MemoryReviewLevel, memoryId: string): boolean {
    return this.get(level, memoryId).status === "approved";
  }
}
