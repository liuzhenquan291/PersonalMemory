import {
  createPortableBackup,
  createReadableExport,
  loadConfig,
  restorePortableBackup,
  verifyPortableBackup,
} from "@personalmemory/core";
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
  npm run data:export -- --format <json|markdown> --output <file>
  npm run data:backup -- --output <directory>
  npm run data:verify -- --input <backup-directory>
  npm run data:restore -- --input <backup-directory> --confirm "RESTORE <absolute-data-directory>"
`);
  process.exit(2);
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
    const result = await createReadableExport(
      dataDirectory,
      required("--output"),
      format,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "backup") {
    await assertUpstreamOffline(config.server.upstreamBaseUrl);
    const manifest = await createPortableBackup(
      dataDirectory,
      required("--output"),
    );
    process.stdout.write(
      `${JSON.stringify({ assets: manifest.assets.length, createdAt: manifest.created_at })}\n`,
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
    const result = await restorePortableBackup(
      required("--input"),
      dataDirectory,
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
