import { createHash } from "node:crypto";
import type { Migration } from "./migration-runner.js";

export const PERSONAL_MEMORY_SCHEMA_VERSION = 11;

const INITIAL_SCHEMA_SQL = `
CREATE TABLE personalmemory_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`;

const IMPORT_JOBS_SQL = `
CREATE TABLE personalmemory_import_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  total_items INTEGER NOT NULL,
  completed_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT
`;

const IMPORT_ITEMS_SQL = `
CREATE TABLE personalmemory_import_items (
  job_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  PRIMARY KEY (job_id, item_index),
  FOREIGN KEY (job_id) REFERENCES personalmemory_import_jobs(id) ON DELETE CASCADE
) STRICT
`;

const MEMORY_STATES_SQL = `
CREATE TABLE personalmemory_memory_states (
  level TEXT NOT NULL CHECK (level IN ('L0', 'L1', 'L2', 'L3')),
  memory_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'invalidated', 'deleted')),
  reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (level, memory_id)
) STRICT
`;

const MEMORY_REVIEWS_SQL = `
CREATE TABLE personalmemory_memory_reviews (
  level TEXT NOT NULL CHECK (level IN ('L1', 'L2', 'L3')),
  memory_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (level, memory_id)
) STRICT
`;

const MEMORY_VALIDITY_SQL = `
CREATE TABLE personalmemory_memory_validity (
  level TEXT NOT NULL CHECK (level IN ('L1', 'L2', 'L3')),
  memory_id TEXT NOT NULL,
  valid_from TEXT,
  expires_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (level, memory_id),
  CHECK (valid_from IS NULL OR expires_at IS NULL OR valid_from < expires_at)
) STRICT
`;

const MEMORY_RELATIONS_SQL = `
CREATE TABLE personalmemory_memory_relations (
  id TEXT PRIMARY KEY NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('L1', 'L2', 'L3')),
  kind TEXT NOT NULL CHECK (kind IN ('conflicts_with', 'supersedes')),
  source_memory_id TEXT NOT NULL,
  target_memory_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  reason TEXT NOT NULL,
  merged_content_hash TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_memory_id <> target_memory_id)
) STRICT
`;

const MEMORY_RELATIONS_INDEX_SQL = `
CREATE UNIQUE INDEX personalmemory_active_memory_relations
ON personalmemory_memory_relations(level, kind, source_memory_id, target_memory_id)
WHERE status = 'active'
`;

const AUDIT_EVENTS_SQL = `
CREATE TABLE personalmemory_audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'memory.generated', 'memory.reviewed', 'memory.recalled',
    'memory.updated', 'memory.invalidated', 'memory.deleted',
    'memory.relation_created', 'memory.relation_revoked',
    'memory.validity_updated', 'data.exported'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  subject_level TEXT CHECK (subject_level IN ('L0', 'L1', 'L2', 'L3')),
  subject_hash TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT UNIQUE,
  occurred_at TEXT NOT NULL,
  CHECK ((subject_level IS NULL) = (subject_hash IS NULL))
) STRICT
`;

const AUDIT_EVENTS_TIME_INDEX_SQL = `
CREATE INDEX personalmemory_audit_events_time
ON personalmemory_audit_events(occurred_at DESC, sequence DESC)
`;

const AUDIT_EVENTS_SUBJECT_INDEX_SQL = `
CREATE INDEX personalmemory_audit_events_subject
ON personalmemory_audit_events(subject_level, subject_hash, sequence DESC)
`;

const AUDIT_EVENTS_ACTION_INDEX_SQL = `
CREATE INDEX personalmemory_audit_events_action
ON personalmemory_audit_events(action, sequence DESC)
`;

const MANAGED_ARTIFACTS_SQL = `
CREATE TABLE personalmemory_managed_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('readable_export', 'portable_backup')),
  path TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT
`;

const ERASURE_RECEIPTS_SQL = `
CREATE TABLE personalmemory_erasure_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  level TEXT NOT NULL CHECK (level = 'L1'),
  memory_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial')),
  verification_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (level, memory_id)
) STRICT
`;

const HOOK_CAPTURES_SQL = `
CREATE TABLE personalmemory_hook_captures (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'captured'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT
`;

const MODEL_AUTHORIZATIONS_SQL = `
CREATE TABLE personalmemory_model_authorizations (
  revision INTEGER PRIMARY KEY NOT NULL CHECK (revision > 0),
  disclosure_version INTEGER NOT NULL CHECK (disclosure_version > 0),
  disclosure_hash TEXT NOT NULL CHECK (length(disclosure_hash) = 64),
  provider TEXT NOT NULL CHECK (provider IN ('local', 'openai-compatible')),
  target_origin TEXT NOT NULL,
  sent_fields_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('authorized', 'revoked')),
  authorized_at TEXT,
  revoked_at TEXT,
  CHECK (
    (status = 'authorized' AND authorized_at IS NOT NULL AND revoked_at IS NULL) OR
    (status = 'revoked' AND authorized_at IS NULL AND revoked_at IS NOT NULL)
  )
) STRICT
`;

const HOOK_AUTHORIZATIONS_SQL = `
CREATE TABLE personalmemory_hook_authorizations (
  authorization_revision INTEGER PRIMARY KEY NOT NULL CHECK (authorization_revision > 0),
  installation_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  recall_enabled INTEGER NOT NULL CHECK (recall_enabled IN (0, 1)),
  capture_enabled INTEGER NOT NULL CHECK (capture_enabled IN (0, 1)),
  changed_at TEXT NOT NULL
) STRICT
`;

const CAPTURE_POLICIES_SQL = `
CREATE TABLE personalmemory_capture_policies (
  revision INTEGER PRIMARY KEY NOT NULL CHECK (revision > 0),
  capture_enabled INTEGER NOT NULL CHECK (capture_enabled IN (0, 1)),
  excluded_clients_json TEXT NOT NULL,
  excluded_working_directories_json TEXT NOT NULL,
  excluded_sources_json TEXT NOT NULL,
  sensitive_categories_json TEXT NOT NULL,
  l0_retention_days INTEGER CHECK (l0_retention_days IS NULL OR l0_retention_days BETWEEN 1 AND 3650),
  l1_retention_days INTEGER CHECK (l1_retention_days IS NULL OR l1_retention_days BETWEEN 1 AND 3650),
  changed_at TEXT NOT NULL
) STRICT
`;

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export const defaultMigrations: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: "initialize_personalmemory_metadata",
    checksum: checksum(INITIAL_SCHEMA_SQL),
    statements: [INITIAL_SCHEMA_SQL],
  },
  {
    version: 2,
    name: "add_conversation_import_ledger",
    checksum: checksum(`${IMPORT_JOBS_SQL}\n${IMPORT_ITEMS_SQL}`),
    statements: [IMPORT_JOBS_SQL, IMPORT_ITEMS_SQL],
  },
  {
    version: 3,
    name: "add_memory_state_tombstones",
    checksum: checksum(MEMORY_STATES_SQL),
    statements: [MEMORY_STATES_SQL],
  },
  {
    version: 4,
    name: "add_memory_review_inbox",
    checksum: checksum(MEMORY_REVIEWS_SQL),
    statements: [MEMORY_REVIEWS_SQL],
  },
  {
    version: 5,
    name: "add_memory_conflict_governance",
    checksum: checksum(
      `${MEMORY_VALIDITY_SQL}\n${MEMORY_RELATIONS_SQL}\n${MEMORY_RELATIONS_INDEX_SQL}`,
    ),
    statements: [
      MEMORY_VALIDITY_SQL,
      MEMORY_RELATIONS_SQL,
      MEMORY_RELATIONS_INDEX_SQL,
    ],
  },
  {
    version: 6,
    name: "add_privacy_preserving_audit_events",
    checksum: checksum(
      `${AUDIT_EVENTS_SQL}\n${AUDIT_EVENTS_TIME_INDEX_SQL}\n${AUDIT_EVENTS_SUBJECT_INDEX_SQL}\n${AUDIT_EVENTS_ACTION_INDEX_SQL}`,
    ),
    statements: [
      AUDIT_EVENTS_SQL,
      AUDIT_EVENTS_TIME_INDEX_SQL,
      AUDIT_EVENTS_SUBJECT_INDEX_SQL,
      AUDIT_EVENTS_ACTION_INDEX_SQL,
    ],
  },
  {
    version: 7,
    name: "add_privacy_erasure_control",
    checksum: checksum(`${MANAGED_ARTIFACTS_SQL}\n${ERASURE_RECEIPTS_SQL}`),
    statements: [MANAGED_ARTIFACTS_SQL, ERASURE_RECEIPTS_SQL],
  },
  {
    version: 8,
    name: "add_hook_capture_idempotency",
    checksum: checksum(HOOK_CAPTURES_SQL),
    statements: [HOOK_CAPTURES_SQL],
  },
  {
    version: 9,
    name: "add_model_outbound_authorizations",
    checksum: checksum(MODEL_AUTHORIZATIONS_SQL),
    statements: [MODEL_AUTHORIZATIONS_SQL],
  },
  {
    version: 10,
    name: "add_hook_lifecycle_authorizations",
    checksum: checksum(HOOK_AUTHORIZATIONS_SQL),
    statements: [HOOK_AUTHORIZATIONS_SQL],
  },
  {
    version: 11,
    name: "add_capture_policy_and_retention",
    checksum: checksum(CAPTURE_POLICIES_SQL),
    statements: [CAPTURE_POLICIES_SQL],
  },
]);
