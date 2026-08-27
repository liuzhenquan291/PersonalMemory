import type { DatabaseSync } from "node:sqlite";

export type GovernedMemoryLevel = "L1" | "L2" | "L3";
export type MemoryRelationKind = "conflicts_with" | "supersedes";

export interface MemoryValidity {
  level: GovernedMemoryLevel;
  memoryId: string;
  validFrom?: string;
  expiresAt?: string;
  revision: number;
  updatedAt?: string;
}

export interface MemoryRelation {
  id: string;
  level: GovernedMemoryLevel;
  kind: MemoryRelationKind;
  sourceMemoryId: string;
  targetMemoryId: string;
  status: "active" | "revoked";
  reason: string;
  mergedContentHash?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export class MemoryGovernanceConflictError extends Error {
  constructor(message = "Memory governance state changed after it was loaded") {
    super(message);
    this.name = "MemoryGovernanceConflictError";
  }
}

export class MemoryGovernanceCycleError extends Error {
  constructor() {
    super("The supersedes relation would create a cycle");
    this.name = "MemoryGovernanceCycleError";
  }
}

interface ValidityRow {
  level: GovernedMemoryLevel;
  memory_id: string;
  valid_from: string | null;
  expires_at: string | null;
  revision: number;
  updated_at: string;
}

interface RelationRow {
  id: string;
  level: GovernedMemoryLevel;
  kind: MemoryRelationKind;
  source_memory_id: string;
  target_memory_id: string;
  status: "active" | "revoked";
  reason: string;
  merged_content_hash: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

function validityView(row: ValidityRow): MemoryValidity {
  return {
    level: row.level,
    memoryId: row.memory_id,
    ...(row.valid_from ? { validFrom: row.valid_from } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function relationView(row: RelationRow): MemoryRelation {
  return {
    id: row.id,
    level: row.level,
    kind: row.kind,
    sourceMemoryId: row.source_memory_id,
    targetMemoryId: row.target_memory_id,
    status: row.status,
    reason: row.reason,
    ...(row.merged_content_hash
      ? { mergedContentHash: row.merged_content_hash }
      : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MemoryGovernanceLedger {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getValidity(level: GovernedMemoryLevel, memoryId: string): MemoryValidity {
    const row = this.database
      .prepare(
        `SELECT level, memory_id, valid_from, expires_at, revision, updated_at
         FROM personalmemory_memory_validity WHERE level = ? AND memory_id = ?`,
      )
      .get(level, memoryId) as ValidityRow | undefined;
    return row ? validityView(row) : { level, memoryId, revision: 0 };
  }

  setValidity(
    level: GovernedMemoryLevel,
    memoryId: string,
    validFrom: string | undefined,
    expiresAt: string | undefined,
    expectedRevision: number,
  ): MemoryValidity {
    const current = this.getValidity(level, memoryId);
    if (current.revision !== expectedRevision) {
      throw new MemoryGovernanceConflictError();
    }
    const revision = expectedRevision + 1;
    const updatedAt = this.now();
    const result = this.database
      .prepare(
        `INSERT INTO personalmemory_memory_validity
         (level, memory_id, valid_from, expires_at, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(level, memory_id) DO UPDATE SET
           valid_from = excluded.valid_from,
           expires_at = excluded.expires_at,
           revision = excluded.revision,
           updated_at = excluded.updated_at
         WHERE personalmemory_memory_validity.revision = ?`,
      )
      .run(
        level,
        memoryId,
        validFrom ?? null,
        expiresAt ?? null,
        revision,
        updatedAt,
        expectedRevision,
      );
    if (result.changes !== 1) throw new MemoryGovernanceConflictError();
    return this.getValidity(level, memoryId);
  }

  addRelation(input: {
    id: string;
    level: GovernedMemoryLevel;
    kind: MemoryRelationKind;
    sourceMemoryId: string;
    targetMemoryId: string;
    reason: string;
    mergedContentHash?: string;
  }): MemoryRelation {
    const existing = this.validateRelation(input);
    if (existing) return existing;
    const normalized = this.normalizeRelation(input);
    const timestamp = this.now();
    try {
      this.database
        .prepare(
          `INSERT INTO personalmemory_memory_relations
           (id, level, kind, source_memory_id, target_memory_id, status,
            reason, merged_content_hash, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 1, ?, ?)`,
        )
        .run(
          normalized.id,
          normalized.level,
          normalized.kind,
          normalized.sourceMemoryId,
          normalized.targetMemoryId,
          normalized.reason,
          normalized.mergedContentHash ?? null,
          timestamp,
          timestamp,
        );
    } catch (error) {
      throw new MemoryGovernanceConflictError(String(error));
    }
    return this.getRelation(normalized.id)!;
  }

  validateRelation(input: {
    id: string;
    level: GovernedMemoryLevel;
    kind: MemoryRelationKind;
    sourceMemoryId: string;
    targetMemoryId: string;
    reason: string;
    mergedContentHash?: string;
  }): MemoryRelation | undefined {
    if (input.sourceMemoryId === input.targetMemoryId) {
      throw new MemoryGovernanceCycleError();
    }
    const normalized = this.normalizeRelation(input);
    if (
      normalized.kind === "supersedes" &&
      this.hasSupersedesPath(
        normalized.level,
        normalized.targetMemoryId,
        normalized.sourceMemoryId,
      )
    ) {
      throw new MemoryGovernanceCycleError();
    }
    const existing = this.findActiveRelation(
      normalized.level,
      normalized.kind,
      normalized.sourceMemoryId,
      normalized.targetMemoryId,
    );
    if (
      existing &&
      (existing.reason !== normalized.reason ||
        existing.mergedContentHash !== normalized.mergedContentHash)
    ) {
      throw new MemoryGovernanceConflictError(
        "The active relation already has a different reason",
      );
    }
    return existing;
  }

  revokeRelation(id: string, expectedRevision: number): MemoryRelation {
    const timestamp = this.now();
    const result = this.database
      .prepare(
        `UPDATE personalmemory_memory_relations
         SET status = 'revoked', revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'active' AND revision = ?`,
      )
      .run(timestamp, id, expectedRevision);
    if (result.changes !== 1) throw new MemoryGovernanceConflictError();
    return this.getRelation(id)!;
  }

  getRelation(id: string): MemoryRelation | undefined {
    const row = this.database
      .prepare(
        `SELECT id, level, kind, source_memory_id, target_memory_id, status,
                reason, merged_content_hash, revision, created_at, updated_at
         FROM personalmemory_memory_relations WHERE id = ?`,
      )
      .get(id) as RelationRow | undefined;
    return row ? relationView(row) : undefined;
  }

  listRelations(
    level: GovernedMemoryLevel,
    memoryId: string,
    includeRevoked = true,
  ): MemoryRelation[] {
    const rows = this.database
      .prepare(
        `SELECT id, level, kind, source_memory_id, target_memory_id, status,
                reason, merged_content_hash, revision, created_at, updated_at
         FROM personalmemory_memory_relations
         WHERE level = ? AND (source_memory_id = ? OR target_memory_id = ?)
           AND (? = 1 OR status = 'active')
         ORDER BY created_at, id`,
      )
      .all(
        level,
        memoryId,
        memoryId,
        includeRevoked ? 1 : 0,
      ) as unknown as RelationRow[];
    return rows.map(relationView);
  }

  isRecallable(
    level: GovernedMemoryLevel,
    memoryId: string,
    at = this.now(),
  ): boolean {
    const validity = this.getValidity(level, memoryId);
    if (validity.validFrom && at < validity.validFrom) return false;
    if (validity.expiresAt && at >= validity.expiresAt) return false;
    const blocked = this.database
      .prepare(
        `SELECT 1 FROM personalmemory_memory_relations
         WHERE level = ? AND status = 'active' AND (
           (kind = 'supersedes' AND target_memory_id = ?) OR
           (kind = 'conflicts_with' AND
             (source_memory_id = ? OR target_memory_id = ?))
         ) LIMIT 1`,
      )
      .get(level, memoryId, memoryId, memoryId);
    return !blocked;
  }

  private findActiveRelation(
    level: GovernedMemoryLevel,
    kind: MemoryRelationKind,
    sourceMemoryId: string,
    targetMemoryId: string,
  ): MemoryRelation | undefined {
    const row = this.database
      .prepare(
        `SELECT id, level, kind, source_memory_id, target_memory_id, status,
                reason, merged_content_hash, revision, created_at, updated_at
         FROM personalmemory_memory_relations
         WHERE level = ? AND kind = ? AND source_memory_id = ?
           AND target_memory_id = ? AND status = 'active'`,
      )
      .get(level, kind, sourceMemoryId, targetMemoryId) as
      RelationRow | undefined;
    return row ? relationView(row) : undefined;
  }

  private normalizeRelation<
    T extends {
      kind: MemoryRelationKind;
      sourceMemoryId: string;
      targetMemoryId: string;
    },
  >(input: T): T {
    return input.kind === "conflicts_with" &&
      input.sourceMemoryId.localeCompare(input.targetMemoryId) > 0
      ? {
          ...input,
          sourceMemoryId: input.targetMemoryId,
          targetMemoryId: input.sourceMemoryId,
        }
      : input;
  }

  private hasSupersedesPath(
    level: GovernedMemoryLevel,
    sourceMemoryId: string,
    targetMemoryId: string,
  ): boolean {
    return Boolean(
      this.database
        .prepare(
          `WITH RECURSIVE path(memory_id) AS (
             SELECT target_memory_id FROM personalmemory_memory_relations
             WHERE level = ? AND kind = 'supersedes'
               AND source_memory_id = ? AND status = 'active'
             UNION
             SELECT relation.target_memory_id
             FROM personalmemory_memory_relations relation
             JOIN path ON relation.source_memory_id = path.memory_id
             WHERE relation.level = ? AND relation.kind = 'supersedes'
               AND relation.status = 'active'
           )
           SELECT 1 FROM path WHERE memory_id = ? LIMIT 1`,
        )
        .get(level, sourceMemoryId, level, targetMemoryId),
    );
  }
}
