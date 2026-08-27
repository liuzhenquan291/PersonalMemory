import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const policySchema = z.object({
  revision: z.number().int().positive(),
  capture_enabled: z.number().int().min(0).max(1),
  excluded_clients_json: z.string(),
  excluded_working_directories_json: z.string(),
  excluded_sources_json: z.string(),
  sensitive_categories_json: z.string(),
  l0_retention_days: z.number().int().min(1).max(3650).nullable(),
  l1_retention_days: z.number().int().min(1).max(3650).nullable(),
  changed_at: z.string(),
});

const authorizationSchema = z
  .object({
    revision: z.number().int().positive(),
    disclosure_version: z.number().int().positive(),
    disclosure_hash: z.string().regex(/^[a-f0-9]{64}$/u),
    policy_revision: z.number().int().positive(),
    l0_retention_days: z.number().int().min(1).max(3650).nullable(),
    l1_retention_days: z.number().int().min(1).max(3650).nullable(),
    managed_artifact_handling: z.literal("delete-whole-active-artifacts"),
    status: z.enum(["authorized", "revoked"]),
    changed_at: z.string(),
  })
  .nullable();

const artifactSchema = z.object({
  id: z.string(),
  kind: z.enum(["readable_export", "portable_backup"]),
  path: z.string(),
  created_at: z.string(),
});

const payloadSchema = z.object({
  version: z.literal(1),
  installation_id: z.string().min(1).max(256).nullable(),
  policy: policySchema,
  authorization: authorizationSchema,
});

const envelopeSchema = z.object({
  payload: payloadSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type RetentionRestoreEnvelope = z.infer<typeof envelopeSchema>;
const snapshotSchema = z.object({
  envelope: envelopeSchema,
  active_artifacts: z.array(artifactSchema).max(10_000),
});
export type RetentionRestoreSnapshot = z.infer<typeof snapshotSchema>;

function digest(payload: z.infer<typeof payloadSchema>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function createRetentionRestoreSnapshot(
  database: DatabaseSync,
): RetentionRestoreSnapshot {
  const policy = policySchema.parse(
    database
      .prepare(
        "SELECT * FROM personalmemory_capture_policies ORDER BY revision DESC LIMIT 1",
      )
      .get(),
  );
  const authorization = authorizationSchema.parse(
    database
      .prepare(
        "SELECT * FROM personalmemory_retention_authorizations ORDER BY revision DESC LIMIT 1",
      )
      .get() ?? null,
  );
  const active_artifacts = z.array(artifactSchema).parse(
    database
      .prepare(
        `SELECT id, kind, path, created_at FROM personalmemory_managed_artifacts
         WHERE status = 'active' ORDER BY created_at, id`,
      )
      .all(),
  );
  const installation = database
    .prepare(
      `SELECT installation_id FROM personalmemory_hook_authorizations
       ORDER BY authorization_revision DESC LIMIT 1`,
    )
    .get() as { installation_id: string } | undefined;
  if (authorization?.status === "authorized" && !installation)
    throw new Error(
      "Authorized retention restore requires an installation identity",
    );
  const payload = {
    version: 1 as const,
    installation_id: installation?.installation_id ?? null,
    policy,
    authorization,
  };
  return {
    envelope: { payload, digest: digest(payload) },
    active_artifacts,
  };
}

export function parseRetentionRestoreEnvelope(
  value: unknown,
): RetentionRestoreEnvelope {
  const envelope = envelopeSchema.parse(value);
  if (digest(envelope.payload) !== envelope.digest)
    throw new Error("Retention restore envelope digest mismatch");
  return envelope;
}

export function parseRetentionRestoreSnapshot(
  value: unknown,
): RetentionRestoreSnapshot {
  const snapshot = snapshotSchema.parse(value);
  parseRetentionRestoreEnvelope(snapshot.envelope);
  return snapshot;
}

export function applyRetentionRestoreEnvelope(
  database: DatabaseSync,
  value: unknown,
  options: { deferredArtifactPath?: string } = {},
): RetentionRestoreEnvelope {
  const snapshot = parseRetentionRestoreSnapshot(value);
  const envelope = parseRetentionRestoreEnvelope(snapshot.envelope);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM personalmemory_capture_policies");
    const policy = envelope.payload.policy;
    database
      .prepare(
        `INSERT INTO personalmemory_capture_policies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        policy.revision,
        policy.capture_enabled,
        policy.excluded_clients_json,
        policy.excluded_working_directories_json,
        policy.excluded_sources_json,
        policy.sensitive_categories_json,
        policy.l0_retention_days,
        policy.l1_retention_days,
        policy.changed_at,
      );
    database.exec("DELETE FROM personalmemory_retention_authorizations");
    const authorization = envelope.payload.authorization;
    if (authorization)
      database
        .prepare(
          `INSERT INTO personalmemory_retention_authorizations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          authorization.revision,
          authorization.disclosure_version,
          authorization.disclosure_hash,
          authorization.policy_revision,
          authorization.l0_retention_days,
          authorization.l1_retention_days,
          authorization.managed_artifact_handling,
          authorization.status,
          authorization.changed_at,
        );
    for (const artifact of snapshot.active_artifacts) {
      if (artifact.path === options.deferredArtifactPath) continue;
      database
        .prepare(
          `INSERT INTO personalmemory_managed_artifacts
           (id, kind, path, status, created_at, deleted_at)
           VALUES (?, ?, ?, 'active', ?, NULL)
           ON CONFLICT(path) DO UPDATE SET status = 'active', deleted_at = NULL`,
        )
        .run(artifact.id, artifact.kind, artifact.path, artifact.created_at);
    }
    database.exec("COMMIT");
    return envelope;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
