import {
  createPortableBackup,
  createReadableExport,
  loadConfig,
  parseRetentionRestoreSnapshot,
  restorePortableBackup,
  verifyPortableBackup,
} from "@personalmemory/core";
import { readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import process from "node:process";
import { request } from "node:http";

async function assertUpstreamOffline(baseUrl: URL): Promise<void> {
  const target = new URL("/health", baseUrl);
  const reachable = await new Promise<boolean>((resolve, reject) => {
    const check = request(
      target,
      { method: "GET", agent: false, timeout: 500 },
      (response) => {
        response.destroy();
        resolve(true);
      },
    );
    check.once("timeout", () =>
      check.destroy(new Error("upstream health check timed out")),
    );
    check.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
    check.end();
  });
  if (reachable) {
    throw new Error(
      "The upstream Gateway is still running; stop it before portable data operations",
    );
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}

function usage(): never {
  process.stderr.write(`Usage:
  npm run data:export -- --format <json|markdown> --output <personalmemory-export-YYYYMMDD.file>
  npm run data:backup -- --output <personalmemory-backup-YYYYMMDD>
  npm run data:verify -- --input <backup-directory>
  npm run data:restore -- --input <backup-directory> --confirm "RESTORE <absolute-data-directory>"
`);
  process.exit(2);
}

function artifactNameWarning(
  destination: string,
  kind: "export" | "backup",
): string | undefined {
  if (path.basename(destination).toLowerCase().includes("personalmemory"))
    return undefined;
  return kind === "export"
    ? "建议使用 personalmemory-export-YYYYMMDD.* 命名；移动、复制或改名后的副本无法被产品继续追踪。"
    : "建议使用 personalmemory-backup-YYYYMMDD 命名；移动、复制或改名后的副本无法被产品继续追踪。";
}

async function withDiagnosticsOnStderr<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const original = {
    debug: console.debug,
    info: console.info,
    log: console.log,
  };
  const redirect = (...values: unknown[]): void => {
    process.stderr.write(`${values.map(String).join(" ")}\n`);
  };
  console.debug = redirect;
  console.info = redirect;
  console.log = redirect;
  try {
    return await operation();
  } finally {
    console.debug = original.debug;
    console.info = original.info;
    console.log = original.log;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "verify") {
    const manifest = await verifyPortableBackup(required("--input"));
    process.stdout.write(
      `${JSON.stringify({ valid: true, assets: manifest.assets.length })}\n`,
    );
    return;
  }
  const config = loadConfig().config;
  const dataDirectory = path.resolve(config.dataDirectory);
  if (command === "export") {
    await assertUpstreamOffline(config.server.upstreamBaseUrl);
    const format = required("--format");
    if (format !== "json" && format !== "markdown") usage();
    const output = required("--output");
    const result = await createReadableExport(dataDirectory, output, format);
    process.stdout.write(
      `${JSON.stringify({ ...result, warning: artifactNameWarning(output, "export") })}\n`,
    );
    return;
  }
  if (command === "backup") {
    await assertUpstreamOffline(config.server.upstreamBaseUrl);
    const output = required("--output");
    const manifest = await createPortableBackup(dataDirectory, output);
    process.stdout.write(
      `${JSON.stringify({ assets: manifest.assets.length, createdAt: manifest.created_at, warning: artifactNameWarning(output, "backup") })}\n`,
    );
    return;
  }
  if (command === "restore") {
    await assertUpstreamOffline(config.server.upstreamBaseUrl);
    const confirmation = required("--confirm");
    if (confirmation !== `RESTORE ${dataDirectory}`) {
      throw new Error(
        `Confirmation must exactly match: RESTORE ${dataDirectory}`,
      );
    }
    const input = path.resolve(required("--input"));
    const snapshotPath = option("--retention-envelope");
    const snapshot = snapshotPath
      ? parseRetentionRestoreSnapshot(
          JSON.parse(await readFile(snapshotPath, "utf8")),
        )
      : undefined;
    const deferredArtifact = snapshot?.active_artifacts.find(
      (artifact) => path.resolve(artifact.path) === input,
    );
    const executionAuthorized =
      snapshot?.envelope.payload.authorization?.status === "authorized";
    const result = await restorePortableBackup(
      input,
      dataDirectory,
      snapshot
        ? {
            prepareStaging: async (stagingDirectory) =>
              withDiagnosticsOnStderr(async () =>
                (
                  await import("./personalmemory-retention-restore.js")
                ).prepareRetentionRestoreStaging({
                  stagingDirectory,
                  envelope: snapshot,
                  deferredArtifactPath: input,
                }),
              ),
            finalizeRestored: async (restoredDirectory) => {
              if (!executionAuthorized || !deferredArtifact) return;
              await rm(input, { recursive: true });
              const database = new DatabaseSync(
                path.join(restoredDirectory, "personalmemory.sqlite"),
              );
              try {
                database
                  .prepare(
                    `INSERT INTO personalmemory_managed_artifacts
                     (id, kind, path, status, created_at, deleted_at)
                     VALUES (?, ?, ?, 'deleted', ?, ?)
                     ON CONFLICT(path) DO UPDATE SET
                       status = 'deleted', deleted_at = excluded.deleted_at`,
                  )
                  .run(
                    deferredArtifact.id,
                    deferredArtifact.kind,
                    input,
                    deferredArtifact.created_at,
                    new Date().toISOString(),
                  );
              } finally {
                database.close();
              }
            },
          }
        : {},
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  usage();
}

await main().catch((error) => {
  process.stderr.write(
    `PersonalMemory data operation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
