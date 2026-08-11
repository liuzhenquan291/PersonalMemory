import type { DatabaseSync } from "node:sqlite";

export type MemoryStateLevel = "L0" | "L1" | "L2" | "L3";
export type MemoryStateStatus = "active" | "invalidated" | "deleted";

export interface MemoryState {
  level: MemoryStateLevel;
  memoryId: string;
  status: MemoryStateStatus;
  reason?: string;
  revision: number;
  updatedAt: string;
}

export class MemoryStateConflictError extends Error {
  constructor(options?: ErrorOptions) {
    super("The memory state changed after it was loaded", options);
    this.name = "MemoryStateConflictError";
  }
}

export class DeletedMemoryCannotBeRestoredError extends Error {
  constructor() {
    super("A deleted memory tombstone cannot be restored in M2");
    this.name = "DeletedMemoryCannotBeRestoredError";
  }
}

interface StateRow {
  level: MemoryStateLevel;
  memory_id: string;
  status: MemoryStateStatus;
  reason: string | null;
  revision: number;
  updated_at: string;
}

function view(row: StateRow): MemoryState {
  return {
    level: row.level,
    memoryId: row.memory_id,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export class MemoryStateLedger {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get(level: MemoryStateLevel, memoryId: string): MemoryState | undefined {
    const row = this.database
      .prepare(
        `SELECT level, memory_id, status, reason, revision, updated_at
         FROM personalmemory_memory_states WHERE level = ? AND memory_id = ?`,
      )
      .get(level, memoryId) as StateRow | undefined;
    return row ? view(row) : undefined;
  }

  getMany(
    keys: readonly { level: MemoryStateLevel; memoryId: string }[],
  ): Map<string, MemoryState> {
    const result = new Map<string, MemoryState>();
    const statement = this.database.prepare(
      `SELECT level, memory_id, status, reason, revision, updated_at
       FROM personalmemory_memory_states WHERE level = ? AND memory_id = ?`,
    );
    for (const key of keys) {
      const row = statement.get(key.level, key.memoryId) as
        StateRow | undefined;
      if (row) result.set(`${key.level}:${key.memoryId}`, view(row));
    }
    return result;
  }

  set(
    level: MemoryStateLevel,
    memoryId: string,
    status: MemoryStateStatus,
    expectedRevision: number,
    reason?: string,
  ): MemoryState {
    const current = this.get(level, memoryId);
    if ((current?.revision ?? 0) !== expectedRevision) {
      throw new MemoryStateConflictError();
    }
    if (current?.status === "deleted" && status !== "deleted") {
      throw new DeletedMemoryCannotBeRestoredError();
    }
    const revision = expectedRevision + 1;
    const updatedAt = this.now();
    if (current) {
      const changed = this.database
        .prepare(
          `UPDATE personalmemory_memory_states
           SET status = ?, reason = ?, revision = ?, updated_at = ?
           WHERE level = ? AND memory_id = ? AND revision = ?`,
        )
        .run(
          status,
          reason ?? null,
          revision,
          updatedAt,
          level,
          memoryId,
          expectedRevision,
        );
      if (changed.changes !== 1) throw new MemoryStateConflictError();
    } else {
      try {
        this.database
          .prepare(
            `INSERT INTO personalmemory_memory_states
             (level, memory_id, status, reason, revision, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(level, memoryId, status, reason ?? null, revision, updatedAt);
      } catch (error) {
        if (this.get(level, memoryId)) {
          throw new MemoryStateConflictError({ cause: error });
        }
        throw error;
      }
    }
    return this.get(level, memoryId)!;
  }

  isSuppressed(level: MemoryStateLevel, memoryId: string): boolean {
    const status = this.get(level, memoryId)?.status;
    return status === "invalidated" || status === "deleted";
  }

  countSuppressed(level: MemoryStateLevel): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM personalmemory_memory_states
         WHERE level = ? AND status IN ('invalidated', 'deleted')`,
      )
      .get(level) as { count: number };
    return row.count;
  }
}
