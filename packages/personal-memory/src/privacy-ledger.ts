import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ManagedArtifactKind = "readable_export" | "portable_backup";

export interface ManagedArtifact {
  id: string;
  kind: ManagedArtifactKind;
  path: string;
  status: "active" | "deleted";
  createdAt: string;
  deletedAt?: string;
}

interface ArtifactRow {
  id: string;
  kind: ManagedArtifactKind;
  path: string;
  status: "active" | "deleted";
  created_at: string;
  deleted_at: string | null;
}

function artifactView(row: ArtifactRow): ManagedArtifact {
  return {
    id: row.id,
    kind: row.kind,
    path: row.path,
    status: row.status,
    createdAt: row.created_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

export class ManagedArtifactLedger {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly randomId: () => string = randomUUID,
  ) {}

  register(kind: ManagedArtifactKind, artifactPath: string): ManagedArtifact {
    const at = this.now();
    this.database
      .prepare(
        `INSERT INTO personalmemory_managed_artifacts
         (id, kind, path, status, created_at, deleted_at)
         VALUES (?, ?, ?, 'active', ?, NULL)
         ON CONFLICT(path) DO UPDATE SET
           kind = excluded.kind,
           status = 'active',
           created_at = excluded.created_at,
           deleted_at = NULL`,
      )
      .run(this.randomId(), kind, artifactPath, at);
    return this.getByPath(artifactPath)!;
  }

  listActive(): ManagedArtifact[] {
    return (
      this.database
        .prepare(
          `SELECT id, kind, path, status, created_at, deleted_at
           FROM personalmemory_managed_artifacts
           WHERE status = 'active' ORDER BY created_at, id`,
        )
        .all() as unknown as ArtifactRow[]
    ).map(artifactView);
  }

  markDeleted(id: string): void {
    this.database
      .prepare(
        `UPDATE personalmemory_managed_artifacts
         SET status = 'deleted', deleted_at = ? WHERE id = ?`,
      )
      .run(this.now(), id);
  }

  private getByPath(artifactPath: string): ManagedArtifact | undefined {
    const row = this.database
      .prepare(
        `SELECT id, kind, path, status, created_at, deleted_at
         FROM personalmemory_managed_artifacts WHERE path = ?`,
      )
      .get(artifactPath) as unknown as ArtifactRow | undefined;
    return row ? artifactView(row) : undefined;
  }
}

export interface ErasureReceipt {
  id: string;
  memoryId: string;
  contentHash: string;
  planHash: string;
  status: "complete" | "partial";
  verification: Record<string, number | boolean | string>;
  createdAt: string;
  updatedAt: string;
}

export class ErasureReceiptLedger {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly randomId: () => string = randomUUID,
  ) {}

  save(input: {
    memoryId: string;
    contentHash: string;
    planHash: string;
    status: "complete" | "partial";
    verification: Record<string, number | boolean | string>;
  }): ErasureReceipt {
    const at = this.now();
    this.database
      .prepare(
        `INSERT INTO personalmemory_erasure_receipts
         (id, level, memory_id, content_hash, plan_hash, status,
          verification_json, created_at, updated_at)
         VALUES (?, 'L1', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(level, memory_id) DO UPDATE SET
           content_hash = excluded.content_hash,
           plan_hash = excluded.plan_hash,
           status = excluded.status,
           verification_json = excluded.verification_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        this.randomId(),
        input.memoryId,
        input.contentHash,
        input.planHash,
        input.status,
        JSON.stringify(input.verification),
        at,
        at,
      );
    const row = this.database
      .prepare(
        `SELECT id, memory_id, content_hash, plan_hash, status,
                verification_json, created_at, updated_at
         FROM personalmemory_erasure_receipts
         WHERE level = 'L1' AND memory_id = ?`,
      )
      .get(input.memoryId) as unknown as {
      id: string;
      memory_id: string;
      content_hash: string;
      plan_hash: string;
      status: "complete" | "partial";
      verification_json: string;
      created_at: string;
      updated_at: string;
    };
    return {
      id: row.id,
      memoryId: row.memory_id,
      contentHash: row.content_hash,
      planHash: row.plan_hash,
      status: row.status,
      verification: JSON.parse(row.verification_json) as Record<
        string,
        number | boolean | string
      >,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
