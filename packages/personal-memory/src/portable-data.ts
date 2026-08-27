import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { DatabaseSync, backup as backupDatabase } from "node:sqlite";
import path from "node:path";
import { z } from "zod";
import { PERSONAL_MEMORY_SCHEMA_VERSION } from "./migrations.js";
import { AuditLedger } from "./audit-ledger.js";
import { ManagedArtifactLedger } from "./privacy-ledger.js";
import { assertDataDirectoryOffline } from "./runtime-marker.js";

const BACKUP_FORMAT_VERSION = 1;
const EXPORT_FORMAT_VERSION = 1;
const ROOT_FILES = new Set([
  "personalmemory.sqlite",
  "vectors.db",
  "persona.md",
]);
const ROOT_DIRECTORIES = new Set([
  "conversations",
  "records",
  "scene_blocks",
  ".metadata",
]);
const SQLITE_FILES = new Set(["personalmemory.sqlite", "vectors.db"]);
const MAX_EXPORT_TEXT_BYTES = 256 * 1_024 * 1_024;
const MAX_EXPORT_RECORDS = 1_000_000;
const EXCLUDED_ROOT_NAMES = new Set([
  ".backup",
  ".personalmemory-running",
  "exports",
  "logs",
  "gateway.yaml",
  "gateway.yml",
  "personalmemory.json",
  "personalmemory.yaml",
  "tdai-gateway.json",
  "tdai-gateway.yaml",
]);

export class PortableDataError extends Error {
  constructor(
    readonly code:
      | "UNSAFE_PATH"
      | "BACKUP_EXISTS"
      | "INVALID_BACKUP"
      | "CHECKSUM_MISMATCH"
      | "INCOMPATIBLE_VERSION"
      | "INVALID_DATA",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PortableDataError";
  }
}

const assetSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const backupManifestSchema = z.object({
  format: z.literal("personalmemory-backup"),
  format_version: z.number().int(),
  product_schema_version: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  assets: z.array(assetSchema),
  excluded: z.array(z.string()),
});
const upstreamManifestSchema = z.object({
  version: z.literal(1),
  store: z.object({
    type: z.literal("sqlite"),
    sqlite: z.object({ path: z.literal("vectors.db") }),
  }),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;

interface ExportStateRow {
  level: string;
  memory_id: string;
  status: string;
  reason: string | null;
  revision: number;
  updated_at: string;
}

interface ExportReviewRow {
  level: string;
  memory_id: string;
  status: string;
  reason: string | null;
  revision: number;
  updated_at: string;
}

interface ExportValidityRow {
  level: string;
  memory_id: string;
  valid_from: string | null;
  expires_at: string | null;
  revision: number;
  updated_at: string;
}

interface ExportRelationRow {
  id: string;
  level: string;
  kind: string;
  source_memory_id: string;
  target_memory_id: string;
  status: string;
  reason: string;
  merged_content_hash: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface ExportAuditRow {
  sequence: number;
  event_id: string;
  action: string;
  outcome: string;
  subject_level: string | null;
  subject_hash: string | null;
  details_json: string;
  occurred_at: string;
}

export interface ReadableExport {
  format: "personalmemory-export";
  format_version: number;
  product_schema_version: number;
  created_at: string;
  conversations: unknown[];
  memories: unknown[];
  scenarios: { path: string; content: string }[];
  core: { path: "persona.md"; content: string } | null;
  states: ExportStateRow[];
  reviews: ExportReviewRow[];
  validity: ExportValidityRow[];
  relations: ExportRelationRow[];
  audit_events: ExportAuditRow[];
}

function resolved(value: string): string {
  return path.resolve(value);
}

function rejectFilesystemRoot(target: string): void {
  if (target === path.parse(target).root) {
    throw new PortableDataError(
      "UNSAFE_PATH",
      "The filesystem root cannot be a data directory",
    );
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function rejectSymlinkChain(target: string): Promise<void> {
  let cursor = resolved(target);
  for (;;) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new PortableDataError(
          "UNSAFE_PATH",
          `Symbolic links are not allowed: ${cursor}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function sha256(file: string): Promise<string> {
  const handle = await open(file, "r");
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function listAssetFiles(dataDirectory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (relativeDirectory: string): Promise<void> => {
    const directory = path.join(dataDirectory, relativeDirectory);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new PortableDataError(
          "UNSAFE_PATH",
          `Backup source contains a symbolic link: ${relative}`,
        );
      }
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) files.push(relative);
    }
  };

  const rootEntries = await readdir(dataDirectory, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isSymbolicLink()) {
      throw new PortableDataError(
        "UNSAFE_PATH",
        `Backup source contains a symbolic link: ${entry.name}`,
      );
    }
    if (entry.isFile() && ROOT_FILES.has(entry.name)) {
      files.push(entry.name);
      continue;
    }
    if (entry.isDirectory() && ROOT_DIRECTORIES.has(entry.name)) {
      await visit(entry.name);
      continue;
    }
    if (!EXCLUDED_ROOT_NAMES.has(entry.name)) {
      throw new PortableDataError(
        "INVALID_DATA",
        `Data root contains an unclassified asset: ${entry.name}`,
      );
    }
  }
  return files.sort();
}

function readProductSchema(databasePath: string): number {
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database
        .prepare(
          "SELECT MAX(version) AS version FROM personalmemory_schema_migrations",
        )
        .get() as { version: number | null };
      return row.version ?? 0;
    } finally {
      database.close();
    }
  } catch (error) {
    throw new PortableDataError(
      "INVALID_DATA",
      "PersonalMemory database is not readable",
      {
        cause: error,
      },
    );
  }
}

async function snapshotFile(
  source: string,
  destination: string,
  relative: string,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (SQLITE_FILES.has(relative)) {
    const database = new DatabaseSync(source, { readOnly: true });
    try {
      await backupDatabase(database, destination);
    } finally {
      database.close();
    }
  } else {
    await copyFile(source, destination);
  }
  await chmod(destination, 0o600);
}

async function assertLocalDataRoot(dataDirectory: string): Promise<void> {
  try {
    upstreamManifestSchema.parse(
      JSON.parse(
        await readFile(
          path.join(dataDirectory, ".metadata", "manifest.json"),
          "utf8",
        ),
      ),
    );
    const vectors = await lstat(path.join(dataDirectory, "vectors.db"));
    if (!vectors.isFile() || vectors.isSymbolicLink())
      throw new Error("vectors.db is unsafe");
  } catch (error) {
    throw new PortableDataError(
      "INVALID_DATA",
      "Portable operations require a unified local SQLite data root",
      { cause: error },
    );
  }
}

export async function createPortableBackup(
  dataDirectoryInput: string,
  backupDirectoryInput: string,
  now: () => Date = () => new Date(),
): Promise<BackupManifest> {
  const dataDirectory = resolved(dataDirectoryInput);
  const backupDirectory = resolved(backupDirectoryInput);
  const stagingDirectory = `${backupDirectory}.tmp-${randomUUID()}`;
  rejectFilesystemRoot(dataDirectory);
  await rejectSymlinkChain(dataDirectory);
  assertDataDirectoryOffline(dataDirectory);
  await rejectSymlinkChain(backupDirectory);
  if (isInside(dataDirectory, backupDirectory)) {
    throw new PortableDataError(
      "UNSAFE_PATH",
      "Backup destination must be outside the data directory",
    );
  }
  try {
    await lstat(backupDirectory);
    throw new PortableDataError(
      "BACKUP_EXISTS",
      "Backup destination already exists",
    );
  } catch (error) {
    if (error instanceof PortableDataError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const files = await listAssetFiles(dataDirectory);
  await assertLocalDataRoot(dataDirectory);
  const productDatabase = path.join(dataDirectory, "personalmemory.sqlite");
  if (!files.includes("personalmemory.sqlite")) {
    throw new PortableDataError(
      "INVALID_DATA",
      "PersonalMemory database is missing",
    );
  }
  const schemaVersion = readProductSchema(productDatabase);
  await mkdir(path.join(stagingDirectory, "data"), {
    recursive: true,
    mode: 0o700,
  });
  const assets = [];
  try {
    for (const relative of files) {
      const destination = path.join(stagingDirectory, "data", relative);
      await snapshotFile(
        path.join(dataDirectory, relative),
        destination,
        relative,
      );
      const info = await stat(destination);
      assets.push({
        path: relative.split(path.sep).join("/"),
        size: info.size,
        sha256: await sha256(destination),
      });
    }
    const manifest: BackupManifest = {
      format: "personalmemory-backup",
      format_version: BACKUP_FORMAT_VERSION,
      product_schema_version: schemaVersion,
      created_at: now().toISOString(),
      assets,
      excluded: [
        "configuration",
        "environment secrets",
        "logs",
        "historical backups",
        "exports",
      ],
    };
    await writeFile(
      path.join(stagingDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    await chmod(stagingDirectory, 0o700);
    await rename(stagingDirectory, backupDirectory);
    const database = new DatabaseSync(productDatabase);
    try {
      new ManagedArtifactLedger(database, () => now().toISOString()).register(
        "portable_backup",
        backupDirectory,
      );
    } catch (error) {
      await rm(backupDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      database.close();
    }
    return manifest;
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw new PortableDataError(
      "INVALID_DATA",
      "Backup could not be completed",
      { cause: error },
    );
  }
}

function safeManifestPath(relative: string): string {
  const segments = relative.split("/");
  const normalized = segments.join(path.sep);
  if (
    path.isAbsolute(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new PortableDataError(
      "INVALID_BACKUP",
      `Unsafe manifest path: ${relative}`,
    );
  }
  const root = segments[0]!;
  if (!ROOT_FILES.has(normalized) && !ROOT_DIRECTORIES.has(root)) {
    throw new PortableDataError(
      "INVALID_BACKUP",
      `Unsupported backup asset: ${relative}`,
    );
  }
  return normalized;
}

export async function verifyPortableBackup(
  backupDirectoryInput: string,
): Promise<BackupManifest> {
  const backupDirectory = resolved(backupDirectoryInput);
  await rejectSymlinkChain(backupDirectory);
  let manifest: BackupManifest;
  try {
    const manifestInfo = await lstat(
      path.join(backupDirectory, "manifest.json"),
    );
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      throw new Error("manifest is not a regular file");
    }
    manifest = backupManifestSchema.parse(
      JSON.parse(
        await readFile(path.join(backupDirectory, "manifest.json"), "utf8"),
      ),
    );
  } catch (error) {
    throw new PortableDataError(
      "INVALID_BACKUP",
      "Backup manifest is invalid",
      { cause: error },
    );
  }
  if (
    manifest.format_version !== BACKUP_FORMAT_VERSION ||
    manifest.product_schema_version > PERSONAL_MEMORY_SCHEMA_VERSION
  ) {
    throw new PortableDataError(
      "INCOMPATIBLE_VERSION",
      "Backup version is newer than this PersonalMemory build",
    );
  }
  const seen = new Set<string>();
  for (const asset of manifest.assets) {
    const relative = safeManifestPath(asset.path);
    if (seen.has(relative))
      throw new PortableDataError(
        "INVALID_BACKUP",
        `Duplicate asset: ${asset.path}`,
      );
    seen.add(relative);
    const file = path.join(backupDirectory, "data", relative);
    const info = await lstat(file).catch(() => undefined);
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      info.size !== asset.size ||
      (await sha256(file)) !== asset.sha256
    ) {
      throw new PortableDataError(
        "CHECKSUM_MISMATCH",
        `Backup asset failed verification: ${asset.path}`,
      );
    }
  }
  if (!seen.has("personalmemory.sqlite")) {
    throw new PortableDataError(
      "INVALID_BACKUP",
      "Backup does not contain the PersonalMemory database",
    );
  }
  const actualAssets = (
    await listAssetFiles(path.join(backupDirectory, "data"))
  )
    .map((asset) => asset.split(path.sep).join("/"))
    .sort();
  const declaredAssets = [...seen]
    .map((asset) => asset.split(path.sep).join("/"))
    .sort();
  if (actualAssets.join("\n") !== declaredAssets.join("\n")) {
    throw new PortableDataError(
      "INVALID_BACKUP",
      "Backup files do not match the manifest inventory",
    );
  }
  if (
    readProductSchema(
      path.join(backupDirectory, "data", "personalmemory.sqlite"),
    ) !== manifest.product_schema_version
  ) {
    throw new PortableDataError(
      "INVALID_BACKUP",
      "Backup schema does not match its manifest",
    );
  }
  await assertLocalDataRoot(path.join(backupDirectory, "data"));
  return manifest;
}

function verifySqliteDatabase(file: string): void {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    if (row.integrity_check !== "ok") throw new Error(row.integrity_check);
  } finally {
    database.close();
  }
}

export async function restorePortableBackup(
  backupDirectoryInput: string,
  dataDirectoryInput: string,
  options: {
    prepareStaging?: (stagingDirectory: string) => Promise<void>;
    finalizeRestored?: (dataDirectory: string) => Promise<void>;
  } = {},
): Promise<{ restored: true; rollbackDirectory?: string }> {
  const backupDirectory = resolved(backupDirectoryInput);
  const dataDirectory = resolved(dataDirectoryInput);
  rejectFilesystemRoot(dataDirectory);
  if (
    isInside(dataDirectory, backupDirectory) ||
    isInside(backupDirectory, dataDirectory)
  ) {
    throw new PortableDataError(
      "UNSAFE_PATH",
      "Backup and data directories must not contain each other",
    );
  }
  const manifest = await verifyPortableBackup(backupDirectory);
  await rejectSymlinkChain(dataDirectory);
  assertDataDirectoryOffline(dataDirectory);
  const parent = path.dirname(dataDirectory);
  const staging = path.join(
    parent,
    `.${path.basename(dataDirectory)}.restore-${randomUUID()}`,
  );
  const rollback = path.join(
    parent,
    `.${path.basename(dataDirectory)}.pre-restore-${randomUUID()}`,
  );
  let hadExisting = false;
  let switched = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const asset of manifest.assets) {
      const relative = safeManifestPath(asset.path);
      const destination = path.join(staging, relative);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(path.join(backupDirectory, "data", relative), destination);
      await chmod(destination, 0o600);
    }
    verifySqliteDatabase(path.join(staging, "personalmemory.sqlite"));
    if (manifest.assets.some((asset) => asset.path === "vectors.db")) {
      verifySqliteDatabase(path.join(staging, "vectors.db"));
    }
    await options.prepareStaging?.(staging);
    verifySqliteDatabase(path.join(staging, "personalmemory.sqlite"));
    if (manifest.assets.some((asset) => asset.path === "vectors.db")) {
      verifySqliteDatabase(path.join(staging, "vectors.db"));
    }
    try {
      await lstat(dataDirectory);
      hadExisting = true;
      await rename(dataDirectory, rollback);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(staging, dataDirectory);
    switched = true;
    await options.finalizeRestored?.(dataDirectory);
  } catch (error) {
    if (hadExisting) {
      try {
        if (switched) await rm(dataDirectory, { recursive: true, force: true });
        await rename(rollback, dataDirectory);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Restore and rollback both failed",
          { cause: rollbackError },
        );
      }
    }
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return hadExisting
    ? { restored: true, rollbackDirectory: rollback }
    : { restored: true };
}

interface ExportBudget {
  bytes: number;
  records: number;
}

async function readText(file: string, budget: ExportBudget): Promise<string> {
  const info = await stat(file);
  budget.bytes += info.size;
  if (budget.bytes > MAX_EXPORT_TEXT_BYTES) {
    throw new PortableDataError(
      "INVALID_DATA",
      "Readable export exceeds the 256 MiB text budget",
    );
  }
  return await readFile(file, "utf8");
}

async function readJsonLines(
  directory: string,
  budget: ExportBudget,
): Promise<unknown[]> {
  let files: string[];
  try {
    files = (await readdir(directory))
      .filter((file) => file.endsWith(".jsonl"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: unknown[] = [];
  for (const file of files) {
    const content = await readText(path.join(directory, file), budget);
    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
        budget.records += 1;
        if (budget.records > MAX_EXPORT_RECORDS) {
          throw new PortableDataError(
            "INVALID_DATA",
            "Readable export exceeds one million records",
          );
        }
      } catch (error) {
        throw new PortableDataError(
          "INVALID_DATA",
          `Invalid JSONL at ${file}:${index + 1}`,
          { cause: error },
        );
      }
    }
  }
  return records;
}

async function readableExport(
  dataDirectory: string,
  now: () => Date,
): Promise<ReadableExport> {
  const budget: ExportBudget = { bytes: 0, records: 0 };
  const scenarios: { path: string; content: string }[] = [];
  const scenarioDirectory = path.join(dataDirectory, "scene_blocks");
  try {
    for (const file of (await readdir(scenarioDirectory))
      .filter((name) => name.endsWith(".md"))
      .sort()) {
      scenarios.push({
        path: file,
        content: await readText(path.join(scenarioDirectory, file), budget),
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const personaPath = path.join(dataDirectory, "persona.md");
  const core = await readText(personaPath, budget)
    .then((content) => ({ path: "persona.md" as const, content }))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  const databasePath = path.join(dataDirectory, "personalmemory.sqlite");
  const schemaVersion = readProductSchema(databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let states: ExportStateRow[];
  let reviews: ExportReviewRow[];
  let validity: ExportValidityRow[];
  let relations: ExportRelationRow[];
  let auditEvents: ExportAuditRow[];
  try {
    states = database
      .prepare(
        `SELECT level, memory_id, status, reason, revision, updated_at
         FROM personalmemory_memory_states ORDER BY level, memory_id`,
      )
      .all() as unknown as ExportStateRow[];
    reviews = database
      .prepare(
        `SELECT level, memory_id, status, reason, revision, updated_at
         FROM personalmemory_memory_reviews ORDER BY level, memory_id`,
      )
      .all() as unknown as ExportReviewRow[];
    validity = database
      .prepare(
        `SELECT level, memory_id, valid_from, expires_at, revision, updated_at
         FROM personalmemory_memory_validity ORDER BY level, memory_id`,
      )
      .all() as unknown as ExportValidityRow[];
    relations = database
      .prepare(
        `SELECT id, level, kind, source_memory_id, target_memory_id, status,
                reason, merged_content_hash, revision, created_at, updated_at
         FROM personalmemory_memory_relations ORDER BY created_at, id`,
      )
      .all() as unknown as ExportRelationRow[];
    auditEvents = database
      .prepare(
        `SELECT sequence, event_id, action, outcome, subject_level,
                subject_hash, details_json, occurred_at
         FROM personalmemory_audit_events ORDER BY sequence`,
      )
      .all() as unknown as ExportAuditRow[];
  } finally {
    database.close();
  }
  return {
    format: "personalmemory-export",
    format_version: EXPORT_FORMAT_VERSION,
    product_schema_version: schemaVersion,
    created_at: now().toISOString(),
    conversations: await readJsonLines(
      path.join(dataDirectory, "conversations"),
      budget,
    ),
    memories: await readJsonLines(path.join(dataDirectory, "records"), budget),
    scenarios,
    core,
    states,
    reviews,
    validity,
    relations,
    audit_events: auditEvents,
  };
}

function markdownExport(snapshot: ReadableExport): string {
  const sections = [
    "# PersonalMemory 导出",
    "",
    `- 格式版本：${snapshot.format_version}`,
    `- 数据库版本：${snapshot.product_schema_version}`,
    `- 导出时间：${snapshot.created_at}`,
    "",
  ];
  const appendJson = (title: string, records: unknown[]) => {
    sections.push(`## ${title}`, "");
    if (records.length === 0) sections.push("_无记录_", "");
    for (const record of records)
      sections.push("```json", JSON.stringify(record, null, 2), "```", "");
  };
  appendJson("L0 对话原文", snapshot.conversations);
  appendJson("L1 结构化记忆", snapshot.memories);
  sections.push("## L2 情境摘要", "");
  for (const scenario of snapshot.scenarios)
    sections.push(`### ${scenario.path}`, "", scenario.content, "");
  if (snapshot.scenarios.length === 0) sections.push("_无记录_", "");
  sections.push("## L3 核心画像", "", snapshot.core?.content ?? "_无记录_", "");
  appendJson("PersonalMemory 状态与 tombstone", snapshot.states);
  appendJson("PersonalMemory 审核状态", snapshot.reviews);
  appendJson("PersonalMemory 有效期", snapshot.validity);
  appendJson("PersonalMemory 冲突与替代关系", snapshot.relations);
  appendJson("PersonalMemory 隐私保护审计", snapshot.audit_events);
  return `${sections.join("\n")}\n`;
}

export async function createReadableExport(
  dataDirectoryInput: string,
  outputFileInput: string,
  format: "json" | "markdown",
  now: () => Date = () => new Date(),
): Promise<{
  outputFile: string;
  sha256: string;
  counts: Record<string, number>;
}> {
  const dataDirectory = resolved(dataDirectoryInput);
  const outputFile = resolved(outputFileInput);
  rejectFilesystemRoot(dataDirectory);
  await rejectSymlinkChain(dataDirectory);
  assertDataDirectoryOffline(dataDirectory);
  await listAssetFiles(dataDirectory);
  await assertLocalDataRoot(dataDirectory);
  await rejectSymlinkChain(outputFile);
  if (isInside(dataDirectory, outputFile)) {
    throw new PortableDataError(
      "UNSAFE_PATH",
      "Readable exports must be written outside the data directory",
    );
  }
  const snapshot = await readableExport(dataDirectory, now);
  const content =
    format === "json"
      ? `${JSON.stringify(snapshot, null, 2)}\n`
      : markdownExport(snapshot);
  await mkdir(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  await writeFile(outputFile, content, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const database = new DatabaseSync(
    path.join(dataDirectory, "personalmemory.sqlite"),
  );
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      new ManagedArtifactLedger(database, () => now().toISOString()).register(
        "readable_export",
        outputFile,
      );
      new AuditLedger(database, () => now().toISOString()).record({
        action: "data.exported",
        details: { format },
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      await rm(outputFile, { force: true });
      throw error;
    }
  } finally {
    database.close();
  }
  return {
    outputFile,
    sha256: await sha256(outputFile),
    counts: {
      conversations: snapshot.conversations.length,
      memories: snapshot.memories.length,
      scenarios: snapshot.scenarios.length,
      core: snapshot.core ? 1 : 0,
      states: snapshot.states.length,
      reviews: snapshot.reviews.length,
      validity: snapshot.validity.length,
      relations: snapshot.relations.length,
      audit_events: snapshot.audit_events.length,
    },
  };
}
