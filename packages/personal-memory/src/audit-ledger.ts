import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type AuditAction =
  | "memory.generated"
  | "memory.reviewed"
  | "memory.recalled"
  | "memory.updated"
  | "memory.invalidated"
  | "memory.deleted"
  | "memory.relation_created"
  | "memory.relation_revoked"
  | "memory.validity_updated"
  | "data.exported";

export type AuditSubjectLevel = "L0" | "L1" | "L2" | "L3";
export type AuditDetailValue = string | number | boolean | string[] | number[];

export interface AuditEvent {
  sequence: number;
  eventId: string;
  action: AuditAction;
  outcome: "success" | "failure";
  subject?: { level: AuditSubjectLevel; reference: string };
  details: Record<string, AuditDetailValue>;
  occurredAt: string;
}

export interface AuditQuery {
  level?: AuditSubjectLevel;
  memoryId?: string;
  action?: AuditAction;
  beforeSequence?: number;
  limit?: number;
}

const AUDIT_KEY = "audit_subject_hmac_key";
const ALLOWED_DETAIL_KEYS = new Set([
  "status",
  "count",
  "levels",
  "scope",
  "kind",
  "format",
  "upstream_deleted",
  "changed_content",
  "result_count",
]);

interface AuditRow {
  sequence: number;
  event_id: string;
  action: AuditAction;
  outcome: "success" | "failure";
  subject_level: AuditSubjectLevel | null;
  subject_hash: string | null;
  details_json: string;
  occurred_at: string;
}

function eventView(row: AuditRow): AuditEvent {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    action: row.action,
    outcome: row.outcome,
    ...(row.subject_level && row.subject_hash
      ? {
          subject: {
            level: row.subject_level,
            reference: row.subject_hash.slice(0, 16),
          },
        }
      : {}),
    details: JSON.parse(row.details_json) as Record<string, AuditDetailValue>,
    occurredAt: row.occurred_at,
  };
}

function validateDetails(
  details: Record<string, AuditDetailValue>,
): Record<string, AuditDetailValue> {
  for (const [key, value] of Object.entries(details)) {
    if (!ALLOWED_DETAIL_KEYS.has(key)) {
      throw new Error(`Audit detail key is not allowed: ${key}`);
    }
    if (typeof value === "string" && value.length > 100) {
      throw new Error(`Audit detail value is too long: ${key}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Audit detail number is invalid: ${key}`);
    }
    if (Array.isArray(value)) {
      if (value.length > 10)
        throw new Error(`Audit detail array is too long: ${key}`);
      if (
        value.some(
          (item) =>
            (typeof item !== "string" && typeof item !== "number") ||
            (typeof item === "string" && item.length > 100) ||
            (typeof item === "number" && !Number.isFinite(item)),
        )
      ) {
        throw new Error(`Audit detail array is invalid: ${key}`);
      }
    } else if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Audit detail value is invalid: ${key}`);
    }
  }
  const encoded = JSON.stringify(details);
  if (Buffer.byteLength(encoded) > 4_096) {
    throw new Error("Audit details exceed 4096 bytes");
  }
  return details;
}

export class AuditLedger {
  private readonly key: Buffer;

  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly randomId: () => string = randomUUID,
    private readonly retentionDays = 365,
  ) {
    const existing = database
      .prepare("SELECT value FROM personalmemory_metadata WHERE key = ?")
      .get(AUDIT_KEY) as { value: string } | undefined;
    if (existing) {
      if (!/^[a-f0-9]{64}$/u.test(existing.value)) {
        throw new Error("Audit subject key is invalid");
      }
      this.key = Buffer.from(existing.value, "hex");
    } else {
      const value = randomBytes(32).toString("hex");
      database
        .prepare(
          `INSERT OR IGNORE INTO personalmemory_metadata
           (key, value, updated_at) VALUES (?, ?, ?)`,
        )
        .run(AUDIT_KEY, value, this.now());
      const stored = database
        .prepare("SELECT value FROM personalmemory_metadata WHERE key = ?")
        .get(AUDIT_KEY) as { value: string };
      this.key = Buffer.from(stored.value, "hex");
    }
  }

  record(input: {
    action: AuditAction;
    outcome?: "success" | "failure";
    subject?: { level: AuditSubjectLevel; memoryId: string };
    details?: Record<string, AuditDetailValue>;
    dedupe?: boolean;
  }): AuditEvent {
    if (
      input.subject &&
      (input.subject.memoryId.length === 0 ||
        input.subject.memoryId.length > 2_048)
    ) {
      throw new Error("Audit subject memory ID is invalid");
    }
    const occurredAt = this.now();
    const subjectHash = input.subject
      ? this.hashSubject(input.subject.level, input.subject.memoryId)
      : undefined;
    const details = validateDetails(input.details ?? {});
    const dedupeKey = input.dedupe
      ? `${input.action}:${input.subject?.level ?? "none"}:${subjectHash ?? "none"}`
      : undefined;
    this.prune(occurredAt);
    const eventId = this.randomId();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO personalmemory_audit_events
         (event_id, action, outcome, subject_level, subject_hash, details_json,
          dedupe_key, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.action,
        input.outcome ?? "success",
        input.subject?.level ?? null,
        subjectHash ?? null,
        JSON.stringify(details),
        dedupeKey ?? null,
        occurredAt,
      );
    const row = dedupeKey
      ? (this.database
          .prepare(
            `SELECT sequence, event_id, action, outcome, subject_level,
                    subject_hash, details_json, occurred_at
             FROM personalmemory_audit_events WHERE dedupe_key = ?`,
          )
          .get(dedupeKey) as unknown as AuditRow)
      : (this.database
          .prepare(
            `SELECT sequence, event_id, action, outcome, subject_level,
                    subject_hash, details_json, occurred_at
             FROM personalmemory_audit_events WHERE event_id = ?`,
          )
          .get(eventId) as unknown as AuditRow);
    return eventView(row);
  }

  query(input: AuditQuery = {}): {
    events: AuditEvent[];
    nextBeforeSequence?: number;
  } {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    if ((input.level && !input.memoryId) || (!input.level && input.memoryId)) {
      throw new Error(
        "Audit subject level and memory ID must be supplied together",
      );
    }
    const subjectHash =
      input.level && input.memoryId
        ? this.hashSubject(input.level, input.memoryId)
        : undefined;
    const rows = this.database
      .prepare(
        `SELECT sequence, event_id, action, outcome, subject_level,
                subject_hash, details_json, occurred_at
         FROM personalmemory_audit_events
         WHERE (? IS NULL OR sequence < ?)
           AND (? IS NULL OR action = ?)
           AND (? IS NULL OR subject_level = ?)
           AND (? IS NULL OR subject_hash = ?)
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(
        input.beforeSequence ?? null,
        input.beforeSequence ?? null,
        input.action ?? null,
        input.action ?? null,
        input.level ?? null,
        input.level ?? null,
        subjectHash ?? null,
        subjectHash ?? null,
        limit + 1,
      ) as unknown as AuditRow[];
    const hasNext = rows.length > limit;
    const selected = rows.slice(0, limit);
    return {
      events: selected.map(eventView),
      ...(hasNext
        ? { nextBeforeSequence: selected[selected.length - 1]!.sequence }
        : {}),
    };
  }

  private hashSubject(level: AuditSubjectLevel, memoryId: string): string {
    return createHmac("sha256", this.key)
      .update(level)
      .update("\0")
      .update(memoryId)
      .digest("hex");
  }

  private prune(at: string): void {
    const threshold = new Date(at);
    threshold.setUTCDate(threshold.getUTCDate() - this.retentionDays);
    this.database
      .prepare("DELETE FROM personalmemory_audit_events WHERE occurred_at < ?")
      .run(threshold.toISOString());
  }
}
