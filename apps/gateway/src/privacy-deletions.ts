import {
  ErasureReceiptLedger,
  ManagedArtifactLedger,
  type ManagedArtifact,
} from "@personalmemory/core";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { z } from "zod";
import type { UpstreamGatewayClient } from "./types.js";

const PLAN_TTL_MS = 10 * 60_000;
const PARTIAL_PLAN_TTL_MS = 60 * 60_000;
const MAX_DELETION_PLANS = 32;
const MAX_UPSTREAM_RECORDS = 10_000;
const REDACTION = "【已根据隐私删除请求移除】";

const envelopeSchema = z.object({ code: z.number(), data: z.unknown() });
const l1Schema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      source_message_ids: z.array(z.string()).optional(),
      updated_at: z.string().optional(),
    }),
  ),
  total: z.number().int().nonnegative().optional(),
});
const l0Schema = z.object({
  messages: z.array(
    z.object({ id: z.string(), timestamp: z.string().optional() }),
  ),
  total: z.number().int().nonnegative().optional(),
});
const scenariosSchema = z.object({
  entries: z.array(z.object({ path: z.string() })),
});
const fileSchema = z.object({ content: z.string().nullable() });

export const privacyDeletionPreviewSchema = z
  .object({ level: z.literal("L1"), memory_id: z.string().min(1).max(2_048) })
  .strict();

export const privacyDeletionExecuteSchema = z
  .object({
    confirmation: z.string().max(2_048),
    delete_managed_copies: z.literal(true),
    unmanaged_copies_acknowledged: z.literal(true),
  })
  .strict();

export type PrivacyDeletionStep =
  | "tombstone"
  | "derived_l2"
  | "derived_l3"
  | "readable_l0"
  | "readable_l1"
  | "source_l0"
  | "index_l1"
  | "managed_copies"
  | "product_metadata"
  | "residual_verification";

export interface PrivacyDeletionPreview {
  token: string;
  level: "L1";
  memory_id: string;
  expires_at: string;
  confirmation: string;
  scope: {
    source_l0: number;
    index_l1: number;
    derived_l2: number;
    derived_l3: number;
    readable_l0: number;
    readable_l1: number;
    managed_copies: number;
  };
  managed_copies: Array<{
    id: string;
    kind: ManagedArtifact["kind"];
    path: string;
  }>;
  limitations: string[];
}

export interface PrivacyDeletionResult {
  status: "complete" | "partial";
  memory_id: string;
  retryable: boolean;
  steps: Record<
    PrivacyDeletionStep,
    "complete" | "failed" | "not_found" | "skipped"
  >;
  verification: {
    l1_remaining: number;
    l0_remaining: number;
    derived_occurrences: number;
    readable_rows: number;
    managed_copies_remaining: number;
    tombstone_present: boolean;
  };
  errors: Array<{ step: PrivacyDeletionStep; code: string }>;
}

export interface RetentionDeletionResult {
  candidate_digest: string;
  status: "draining" | "drained" | "partial";
  planned_l0: number;
  planned_l1: number;
  deleted_l0: number;
  deleted_l1: number;
  remaining_l0: number;
  remaining_l1: number;
  deleted_artifacts: number;
  anomaly_count: number;
  error_code?:
    | "RETENTION_DELETE_FAILED"
    | "RETENTION_VERIFY_FAILED"
    | "RETENTION_LEASE_UNAVAILABLE";
}

interface RetentionCandidatePlan {
  l0: string[];
  l1: Array<{ id: string; content: string }>;
  eligibleL0: number;
  eligibleL1: number;
  anomalyCount: number;
}

interface DerivedCopy {
  level: "L2" | "L3";
  path: string;
  content: string;
}

interface DeletionPlan {
  token: string;
  memoryId: string;
  content: string;
  contentHash: string;
  sourceIds: string[];
  derived: DerivedCopy[];
  artifacts: ManagedArtifact[];
  planHash: string;
  expiresAt: number;
  state: "pending" | "running" | "partial";
}

export class PrivacyDeletionError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "PLAN_NOT_FOUND"
      | "PLAN_EXPIRED"
      | "PLAN_LIMIT"
      | "PLAN_RUNNING"
      | "CONFIRMATION_MISMATCH"
      | "PLAN_STALE"
      | "UPSTREAM_REJECTED",
  ) {
    super(code);
    this.name = "PrivacyDeletionError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function recordId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const id = row.id ?? row.record_id;
  return typeof id === "string" ? id : undefined;
}

async function jsonlFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.isSymbolicLink()) throw new Error("UNSAFE_SYMLINK");
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

async function countJsonlRows(
  directory: string,
  ids: ReadonlySet<string>,
): Promise<number> {
  let count = 0;
  for (const file of await jsonlFiles(directory)) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/u);
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed: unknown = JSON.parse(line);
      if (ids.has(recordId(parsed) ?? "")) count += 1;
    }
  }
  return count;
}

async function removeJsonlRows(
  directory: string,
  ids: ReadonlySet<string>,
  randomId: () => string,
): Promise<number> {
  let removed = 0;
  for (const file of await jsonlFiles(directory)) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/u);
    const kept: string[] = [];
    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed: unknown = JSON.parse(line);
      if (ids.has(recordId(parsed) ?? "")) {
        removed += 1;
        changed = true;
      } else {
        kept.push(line);
      }
    }
    if (!changed) continue;
    const temporary = `${file}.erasure-${randomId()}.tmp`;
    try {
      await writeFile(temporary, kept.length ? `${kept.join("\n")}\n` : "", {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return removed;
}

export class PrivacyDeletionService {
  private readonly plans = new Map<string, DeletionPlan>();
  private readonly artifacts: ManagedArtifactLedger;
  private readonly receipts: ErasureReceiptLedger;

  constructor(
    private readonly database: DatabaseSync,
    private readonly dataDirectory: string,
    private readonly upstream: UpstreamGatewayClient,
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
    private readonly randomId: () => string = randomUUID,
  ) {
    const isoNow = () => new Date(this.now()).toISOString();
    this.artifacts = new ManagedArtifactLedger(database, isoNow, randomId);
    this.receipts = new ErasureReceiptLedger(database, isoNow, randomId);
  }

  async preview(
    memoryId: string,
    requestId: string,
  ): Promise<PrivacyDeletionPreview> {
    this.pruneExpired();
    for (const [token, plan] of this.plans) {
      if (plan.memoryId !== memoryId) continue;
      if (plan.state === "running") {
        throw new PrivacyDeletionError("PLAN_RUNNING");
      }
      this.plans.delete(token);
    }
    if (this.plans.size >= MAX_DELETION_PLANS) {
      throw new PrivacyDeletionError("PLAN_LIMIT");
    }
    const memory = await this.findL1(memoryId, requestId);
    if (!memory) throw new PrivacyDeletionError("NOT_FOUND");
    const sourceIds = [...new Set(memory.source_message_ids ?? [])];
    const derived = await this.findDerived(memory.content, requestId);
    const artifacts = this.artifacts.listActive();
    const readableL0 = await countJsonlRows(
      path.join(this.dataDirectory, "conversations"),
      new Set(sourceIds),
    );
    const readableL1 = await countJsonlRows(
      path.join(this.dataDirectory, "records"),
      new Set([memoryId]),
    );
    const token = this.randomId();
    const expiresAt = this.now() + PLAN_TTL_MS;
    const contentHash = sha256(`${token}\u0000${memory.content}`);
    const planHash = sha256(
      JSON.stringify({
        memoryId,
        contentHash,
        sourceIds,
        derived: derived.map(({ level, path: copyPath }) => [level, copyPath]),
        artifacts: artifacts.map(({ id }) => id),
      }),
    );
    this.plans.set(token, {
      token,
      memoryId,
      content: memory.content,
      contentHash,
      sourceIds,
      derived,
      artifacts,
      planHash,
      expiresAt,
      state: "pending",
    });
    return {
      token,
      level: "L1",
      memory_id: memoryId,
      expires_at: new Date(expiresAt).toISOString(),
      confirmation: `ERASE L1:${memoryId}`,
      scope: {
        source_l0: sourceIds.length,
        index_l1: 1,
        derived_l2: derived.filter(({ level }) => level === "L2").length,
        derived_l3: derived.some(({ level }) => level === "L3") ? 1 : 0,
        readable_l0: readableL0,
        readable_l1: readableL1,
        managed_copies: artifacts.length,
      },
      managed_copies: artifacts.map(({ id, kind, path: artifactPath }) => ({
        id,
        kind,
        path: artifactPath,
      })),
      limitations: [
        "只验证 PersonalMemory 活跃数据根、精确来源引用和已登记副本。",
        "无法发现用户自行复制、同步或改名的文件；执行前必须确认已自行处理。",
        "缺少来源引用或仅保留改写含义的 L2/L3 内容无法自动归因。",
      ],
    };
  }

  cancel(token: string): void {
    const plan = this.requirePlan(token);
    if (plan.state === "running")
      throw new PrivacyDeletionError("PLAN_RUNNING");
    this.plans.delete(token);
  }

  async execute(
    token: string,
    input: z.infer<typeof privacyDeletionExecuteSchema>,
    requestId: string,
  ): Promise<PrivacyDeletionResult> {
    const plan = this.requirePlan(token);
    if (input.confirmation !== `ERASE L1:${plan.memoryId}`) {
      throw new PrivacyDeletionError("CONFIRMATION_MISMATCH");
    }
    if (plan.state === "running")
      throw new PrivacyDeletionError("PLAN_RUNNING");
    if (plan.state === "pending") {
      const current = await this.findL1(plan.memoryId, requestId);
      if (
        !current ||
        sha256(`${plan.token}\u0000${current.content}`) !== plan.contentHash
      ) {
        throw new PrivacyDeletionError("PLAN_STALE");
      }
    }
    plan.state = "running";
    const steps = Object.fromEntries(
      [
        "tombstone",
        "derived_l2",
        "derived_l3",
        "readable_l0",
        "readable_l1",
        "source_l0",
        "index_l1",
        "managed_copies",
        "product_metadata",
        "residual_verification",
      ].map((step) => [step, "not_found"]),
    ) as PrivacyDeletionResult["steps"];
    const errors: PrivacyDeletionResult["errors"] = [];
    const attempt = async (
      step: PrivacyDeletionStep,
      run: () => Promise<void> | void,
    ): Promise<void> => {
      try {
        await run();
        steps[step] = "complete";
      } catch {
        steps[step] = "failed";
        errors.push({ step, code: "ERASURE_STEP_FAILED" });
      }
    };

    await attempt("tombstone", () => this.upsertTombstone(plan.memoryId));
    if (steps.tombstone === "failed") {
      plan.state = "partial";
      plan.expiresAt = this.now() + PARTIAL_PLAN_TTL_MS;
      throw new Error("ERASURE_TOMBSTONE_FAILED");
    }
    await attempt("derived_l2", async () => {
      for (const copy of plan.derived.filter(({ level }) => level === "L2")) {
        await this.call(
          "/v2/scenario/write",
          {
            path: copy.path,
            content: copy.content.split(plan.content).join(REDACTION),
          },
          requestId,
        );
      }
    });
    await attempt("derived_l3", async () => {
      const copy = plan.derived.find(({ level }) => level === "L3");
      if (copy) {
        await this.call(
          "/v2/core/write",
          { content: copy.content.split(plan.content).join(REDACTION) },
          requestId,
        );
      }
    });
    await attempt("readable_l0", async () => {
      await removeJsonlRows(
        path.join(this.dataDirectory, "conversations"),
        new Set(plan.sourceIds),
        this.randomId,
      );
    });
    await attempt("readable_l1", async () => {
      await removeJsonlRows(
        path.join(this.dataDirectory, "records"),
        new Set([plan.memoryId]),
        this.randomId,
      );
    });
    await attempt("source_l0", async () => {
      for (let offset = 0; offset < plan.sourceIds.length; offset += 100) {
        await this.call(
          "/v2/conversation/delete",
          { message_ids: plan.sourceIds.slice(offset, offset + 100) },
          requestId,
        );
      }
    });
    const deletedArtifactIds: string[] = [];
    await attempt("managed_copies", async () => {
      for (const artifact of plan.artifacts) {
        await this.deleteManagedArtifact(artifact);
        deletedArtifactIds.push(artifact.id);
      }
    });
    await attempt("product_metadata", () =>
      this.cleanupProductMetadata(plan.memoryId, deletedArtifactIds),
    );
    if (errors.length === 0) {
      await attempt("index_l1", async () => {
        await this.call(
          "/v2/atomic/delete",
          { ids: [plan.memoryId] },
          requestId,
        );
      });
    } else {
      steps.index_l1 = "skipped";
    }

    let verification = {
      l1_remaining: 1,
      l0_remaining: plan.sourceIds.length,
      derived_occurrences: plan.derived.length,
      readable_rows: 1,
      managed_copies_remaining: plan.artifacts.length,
      tombstone_present: false,
    };
    await attempt("residual_verification", async () => {
      verification = await this.verify(plan, requestId);
      if (
        verification.l1_remaining ||
        verification.l0_remaining ||
        verification.derived_occurrences ||
        verification.readable_rows ||
        verification.managed_copies_remaining ||
        !verification.tombstone_present
      ) {
        throw new Error("RESIDUAL_DATA");
      }
    });
    let status: "complete" | "partial" =
      errors.length === 0 ? "complete" : "partial";
    try {
      this.receipts.save({
        memoryId: plan.memoryId,
        contentHash: plan.contentHash,
        planHash: plan.planHash,
        status,
        verification,
      });
    } catch {
      status = "partial";
      steps.product_metadata = "failed";
      errors.push({ step: "product_metadata", code: "ERASURE_RECEIPT_FAILED" });
    }
    if (status === "complete") this.plans.delete(token);
    else {
      plan.state = "partial";
      plan.expiresAt = this.now() + PARTIAL_PLAN_TTL_MS;
    }
    return {
      status,
      memory_id: plan.memoryId,
      retryable: status === "partial",
      steps,
      verification,
      errors,
    };
  }

  async executeRetentionBatch(
    input: { cutoffL0: string | null; cutoffL1: string | null },
    requestId: string,
    beforeExecute?: (plan: {
      candidateDigest: string;
      plannedL0: number;
      plannedL1: number;
      anomalyCount: number;
    }) => boolean,
  ): Promise<RetentionDeletionResult> {
    const plan = await this.planRetention(input, requestId);
    const result: RetentionDeletionResult = {
      candidate_digest: sha256(
        JSON.stringify({
          l0: [...plan.l0].sort(),
          l1: plan.l1.map(({ id }) => id).sort(),
        }),
      ),
      status: "draining",
      planned_l0: plan.l0.length,
      planned_l1: plan.l1.length,
      deleted_l0: 0,
      deleted_l1: 0,
      remaining_l0: plan.eligibleL0,
      remaining_l1: plan.eligibleL1,
      deleted_artifacts: 0,
      anomaly_count: plan.anomalyCount,
    };
    if (
      beforeExecute &&
      !beforeExecute({
        candidateDigest: result.candidate_digest,
        plannedL0: result.planned_l0,
        plannedL1: result.planned_l1,
        anomalyCount: result.anomaly_count,
      })
    ) {
      result.status = "partial";
      result.error_code = "RETENTION_LEASE_UNAVAILABLE";
      return result;
    }
    try {
      for (const candidate of plan.l1) {
        result.deleted_artifacts += await this.deleteRetentionL1(
          candidate,
          requestId,
        );
        result.deleted_l1 += 1;
      }
      if (plan.l0.length > 0) {
        result.deleted_artifacts += await this.deleteRetentionL0(
          plan.l0,
          requestId,
        );
        result.deleted_l0 = plan.l0.length;
      }
    } catch {
      result.remaining_l0 = Math.max(0, plan.eligibleL0 - result.deleted_l0);
      result.remaining_l1 = Math.max(0, plan.eligibleL1 - result.deleted_l1);
      result.status = "partial";
      result.error_code = "RETENTION_DELETE_FAILED";
      return result;
    }

    try {
      const verification = await this.planRetention(input, requestId);
      result.remaining_l0 = verification.eligibleL0;
      result.remaining_l1 = verification.eligibleL1;
      result.status =
        verification.eligibleL0 === 0 && verification.eligibleL1 === 0
          ? "drained"
          : "draining";
      return result;
    } catch {
      result.status = "partial";
      result.error_code = "RETENTION_VERIFY_FAILED";
      return result;
    }
  }

  private requirePlan(token: string): DeletionPlan {
    const plan = this.plans.get(token);
    if (!plan) throw new PrivacyDeletionError("PLAN_NOT_FOUND");
    if (plan.expiresAt <= this.now()) {
      this.plans.delete(token);
      throw new PrivacyDeletionError("PLAN_EXPIRED");
    }
    return plan;
  }

  private pruneExpired(): void {
    for (const [token, plan] of this.plans) {
      if (plan.expiresAt <= this.now() && plan.state !== "running") {
        this.plans.delete(token);
      }
    }
  }

  private async findL1(memoryId: string, requestId: string) {
    for (let offset = 0; offset < MAX_UPSTREAM_RECORDS; offset += 100) {
      const parsed = l1Schema.parse(
        await this.call("/v2/atomic/query", { limit: 100, offset }, requestId),
      );
      const found = parsed.items.find(({ id }) => id === memoryId);
      if (found) return found;
      if (
        parsed.items.length < 100 ||
        (parsed.total !== undefined &&
          offset + parsed.items.length >= parsed.total)
      ) {
        return undefined;
      }
    }
    throw new PrivacyDeletionError("UPSTREAM_REJECTED");
  }

  private async planRetention(
    input: { cutoffL0: string | null; cutoffL1: string | null },
    requestId: string,
  ): Promise<RetentionCandidatePlan> {
    const now = this.now();
    const cutoffL0 = input.cutoffL0 ? Date.parse(input.cutoffL0) : null;
    const cutoffL1 = input.cutoffL1 ? Date.parse(input.cutoffL1) : null;
    if (
      (input.cutoffL0 && !Number.isFinite(cutoffL0)) ||
      (input.cutoffL1 && !Number.isFinite(cutoffL1))
    )
      throw new Error("INVALID_RETENTION_CUTOFF");
    const eligibleL1: Array<{ id: string; content: string }> = [];
    const eligibleL0: string[] = [];
    let anomalyCount = 0;
    if (cutoffL1 !== null) {
      let complete = false;
      for (let offset = 0; offset < MAX_UPSTREAM_RECORDS; offset += 100) {
        const page = l1Schema.parse(
          await this.call(
            "/v2/atomic/query",
            { limit: 100, offset },
            requestId,
          ),
        );
        if ((page.total ?? page.items.length) > MAX_UPSTREAM_RECORDS)
          throw new Error("RETENTION_SCAN_LIMIT");
        for (const item of page.items) {
          const timestamp = item.updated_at ? Date.parse(item.updated_at) : NaN;
          if (!Number.isFinite(timestamp) || timestamp > now) anomalyCount += 1;
          else if (timestamp < cutoffL1)
            eligibleL1.push({ id: item.id, content: item.content });
        }
        if (
          page.items.length < 100 ||
          (page.total !== undefined && offset + page.items.length >= page.total)
        ) {
          complete = true;
          break;
        }
      }
      if (!complete) throw new Error("RETENTION_SCAN_LIMIT");
    }
    if (cutoffL0 !== null) {
      let complete = false;
      for (let offset = 0; offset < MAX_UPSTREAM_RECORDS; offset += 100) {
        const page = l0Schema.parse(
          await this.call(
            "/v2/conversation/query",
            { limit: 100, offset },
            requestId,
          ),
        );
        if ((page.total ?? page.messages.length) > MAX_UPSTREAM_RECORDS)
          throw new Error("RETENTION_SCAN_LIMIT");
        for (const item of page.messages) {
          const timestamp = item.timestamp ? Date.parse(item.timestamp) : NaN;
          if (!Number.isFinite(timestamp) || timestamp > now) anomalyCount += 1;
          else if (timestamp < cutoffL0) eligibleL0.push(item.id);
        }
        if (
          page.messages.length < 100 ||
          (page.total !== undefined &&
            offset + page.messages.length >= page.total)
        ) {
          complete = true;
          break;
        }
      }
      if (!complete) throw new Error("RETENTION_SCAN_LIMIT");
    }
    return {
      l0: eligibleL0.slice(0, 100),
      l1: eligibleL1.slice(0, 25),
      eligibleL0: eligibleL0.length,
      eligibleL1: eligibleL1.length,
      anomalyCount,
    };
  }

  private async deleteRetentionL1(
    candidate: { id: string; content: string },
    requestId: string,
  ): Promise<number> {
    this.upsertTombstone(candidate.id);
    const derived = await this.findDerived(candidate.content, requestId);
    for (const copy of derived.filter(({ level }) => level === "L2")) {
      await this.call(
        "/v2/scenario/write",
        {
          path: copy.path,
          content: copy.content.split(candidate.content).join(REDACTION),
        },
        requestId,
      );
    }
    const core = derived.find(({ level }) => level === "L3");
    if (core)
      await this.call(
        "/v2/core/write",
        { content: core.content.split(candidate.content).join(REDACTION) },
        requestId,
      );
    await removeJsonlRows(
      path.join(this.dataDirectory, "records"),
      new Set([candidate.id]),
      this.randomId,
    );
    const artifacts = this.artifacts.listActive();
    const deletedArtifactIds: string[] = [];
    for (const artifact of artifacts) {
      await this.deleteManagedArtifact(artifact);
      deletedArtifactIds.push(artifact.id);
    }
    this.cleanupProductMetadata(candidate.id, deletedArtifactIds);
    if (
      (await this.findDerived(candidate.content, requestId)).length > 0 ||
      (await countJsonlRows(
        path.join(this.dataDirectory, "records"),
        new Set([candidate.id]),
      )) > 0 ||
      this.artifacts.listActive().length > 0 ||
      !this.hasDeletionTombstone(candidate.id) ||
      this.productMetadataRemaining(candidate.id) > 0
    )
      throw new Error("RETENTION_L1_PRE_INDEX_RESIDUAL");
    await this.call("/v2/atomic/delete", { ids: [candidate.id] }, requestId);
    if (await this.findL1(candidate.id, requestId))
      throw new Error("RETENTION_L1_INDEX_RESIDUAL");
    return artifacts.length;
  }

  private async deleteRetentionL0(
    ids: string[],
    requestId: string,
  ): Promise<number> {
    const idSet = new Set(ids);
    await removeJsonlRows(
      path.join(this.dataDirectory, "conversations"),
      idSet,
      this.randomId,
    );
    const artifacts = this.artifacts.listActive();
    for (const artifact of artifacts)
      await this.deleteManagedArtifact(artifact);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const artifact of artifacts) this.artifacts.markDeleted(artifact.id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (
      (await countJsonlRows(
        path.join(this.dataDirectory, "conversations"),
        idSet,
      )) > 0 ||
      this.artifacts.listActive().length > 0
    )
      throw new Error("RETENTION_L0_PRE_INDEX_RESIDUAL");
    await this.call("/v2/conversation/delete", { message_ids: ids }, requestId);
    if (
      (await countJsonlRows(
        path.join(this.dataDirectory, "conversations"),
        idSet,
      )) > 0 ||
      (await this.findL0Remaining(idSet, requestId)) > 0 ||
      this.artifacts.listActive().length > 0
    )
      throw new Error("RETENTION_L0_RESIDUAL");
    return artifacts.length;
  }

  private hasDeletionTombstone(memoryId: string): boolean {
    return (
      (
        this.database
          .prepare(
            `SELECT status FROM personalmemory_memory_states
             WHERE level = 'L1' AND memory_id = ?`,
          )
          .get(memoryId) as { status?: string } | undefined
      )?.status === "deleted"
    );
  }

  private productMetadataRemaining(memoryId: string): number {
    const queries = [
      `SELECT COUNT(*) AS count FROM personalmemory_memory_reviews
       WHERE level = 'L1' AND memory_id = ?`,
      `SELECT COUNT(*) AS count FROM personalmemory_memory_validity
       WHERE level = 'L1' AND memory_id = ?`,
      `SELECT COUNT(*) AS count FROM personalmemory_memory_relations
       WHERE level = 'L1' AND (source_memory_id = ? OR target_memory_id = ?)`,
    ];
    return queries.reduce((total, query, index) => {
      const row = this.database
        .prepare(query)
        .get(...(index === 2 ? [memoryId, memoryId] : [memoryId])) as {
        count: number;
      };
      return total + row.count;
    }, 0);
  }

  private async findL0Remaining(ids: ReadonlySet<string>, requestId: string) {
    if (ids.size === 0) return 0;
    let remaining = 0;
    for (let offset = 0; offset < MAX_UPSTREAM_RECORDS; offset += 100) {
      const parsed = l0Schema.parse(
        await this.call(
          "/v2/conversation/query",
          { limit: 100, offset },
          requestId,
        ),
      );
      remaining += parsed.messages.filter(({ id }) => ids.has(id)).length;
      if (
        parsed.messages.length < 100 ||
        (parsed.total !== undefined &&
          offset + parsed.messages.length >= parsed.total)
      ) {
        return remaining;
      }
    }
    throw new PrivacyDeletionError("UPSTREAM_REJECTED");
  }

  private async findDerived(
    content: string,
    requestId: string,
  ): Promise<DerivedCopy[]> {
    if (!content) return [];
    const listed = scenariosSchema.parse(
      await this.call("/v2/scenario/ls", {}, requestId),
    );
    if (listed.entries.length > 1_000)
      throw new PrivacyDeletionError("UPSTREAM_REJECTED");
    const copies: DerivedCopy[] = [];
    for (const entry of listed.entries.filter(
      ({ path: value }) => !value.endsWith("/"),
    )) {
      const file = fileSchema.parse(
        await this.call("/v2/scenario/read", { path: entry.path }, requestId),
      );
      if (file.content?.includes(content)) {
        copies.push({ level: "L2", path: entry.path, content: file.content });
      }
    }
    const core = fileSchema.parse(
      await this.call("/v2/core/read", {}, requestId),
    );
    if (core.content?.includes(content)) {
      copies.push({ level: "L3", path: "persona.md", content: core.content });
    }
    return copies;
  }

  private async verify(plan: DeletionPlan, requestId: string) {
    const derived = await this.findDerived(plan.content, requestId);
    const l0Rows = await countJsonlRows(
      path.join(this.dataDirectory, "conversations"),
      new Set(plan.sourceIds),
    );
    const l1Rows = await countJsonlRows(
      path.join(this.dataDirectory, "records"),
      new Set([plan.memoryId]),
    );
    let managedRemaining = 0;
    for (const artifact of plan.artifacts) {
      try {
        await lstat(artifact.path);
        managedRemaining += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return {
      l1_remaining: (await this.findL1(plan.memoryId, requestId)) ? 1 : 0,
      l0_remaining: await this.findL0Remaining(
        new Set(plan.sourceIds),
        requestId,
      ),
      derived_occurrences: derived.length,
      readable_rows: l0Rows + l1Rows,
      managed_copies_remaining: managedRemaining,
      tombstone_present:
        (
          this.database
            .prepare(
              `SELECT status FROM personalmemory_memory_states
               WHERE level = 'L1' AND memory_id = ?`,
            )
            .get(plan.memoryId) as { status?: string } | undefined
        )?.status === "deleted",
    };
  }

  private upsertTombstone(memoryId: string): void {
    this.database
      .prepare(
        `INSERT INTO personalmemory_memory_states
         (level, memory_id, status, reason, revision, updated_at)
         VALUES ('L1', ?, 'deleted', NULL, 1, ?)
         ON CONFLICT(level, memory_id) DO UPDATE SET
           status = 'deleted', reason = NULL, updated_at = excluded.updated_at`,
      )
      .run(memoryId, new Date(this.now()).toISOString());
  }

  private cleanupProductMetadata(
    memoryId: string,
    artifactIds: string[],
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          "DELETE FROM personalmemory_memory_reviews WHERE level = 'L1' AND memory_id = ?",
        )
        .run(memoryId);
      this.database
        .prepare(
          "DELETE FROM personalmemory_memory_validity WHERE level = 'L1' AND memory_id = ?",
        )
        .run(memoryId);
      this.database
        .prepare(
          `DELETE FROM personalmemory_memory_relations
           WHERE level = 'L1' AND (source_memory_id = ? OR target_memory_id = ?)`,
        )
        .run(memoryId, memoryId);
      for (const id of artifactIds) this.artifacts.markDeleted(id);
      this.upsertTombstone(memoryId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private async deleteManagedArtifact(
    artifact: ManagedArtifact,
  ): Promise<void> {
    const target = path.resolve(artifact.path);
    const dataRoot = path.resolve(this.dataDirectory);
    if (!path.isAbsolute(artifact.path) || isInside(dataRoot, target)) {
      throw new Error("UNSAFE_MANAGED_PATH");
    }
    let cursor = target;
    for (;;) {
      try {
        if ((await lstat(cursor)).isSymbolicLink())
          throw new Error("UNSAFE_SYMLINK");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    try {
      if (artifact.kind === "portable_backup") {
        const manifest = JSON.parse(
          await readFile(path.join(target, "manifest.json"), "utf8"),
        ) as { format?: unknown };
        if (manifest.format !== "personalmemory-backup")
          throw new Error("INVALID_BACKUP");
        await rm(target, { recursive: true });
      } else {
        const content = await readFile(target, "utf8");
        const isJson = (() => {
          try {
            return (
              (JSON.parse(content) as { format?: unknown }).format ===
              "personalmemory-export"
            );
          } catch {
            return false;
          }
        })();
        if (!isJson && !content.startsWith("# PersonalMemory 导出\n")) {
          throw new Error("INVALID_EXPORT");
        }
        await rm(target);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async call(
    pathname: string,
    body: unknown,
    requestId: string,
  ): Promise<unknown> {
    const response = await this.upstream.request({
      path: pathname,
      body,
      requestId,
      timeoutMs: this.timeoutMs,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new PrivacyDeletionError("UPSTREAM_REJECTED");
    }
    const envelope = envelopeSchema.parse(response.body);
    if (envelope.code !== 0)
      throw new PrivacyDeletionError("UPSTREAM_REJECTED");
    return envelope.data;
  }
}
