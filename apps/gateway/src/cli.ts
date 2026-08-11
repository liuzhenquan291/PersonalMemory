import {
  AuditLedger,
  defaultMigrations,
  ImportLedger,
  MemoryGovernanceLedger,
  MemoryReviewLedger,
  MemoryStateLedger,
  acquireRuntimeMarker,
  initializeDataDirectory,
  loadConfig,
  migrateDatabase,
} from "@personalmemory/core";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import process from "node:process";

import { createGatewayApp } from "./app.js";
import { PersonalMemoryGatewayServer } from "./server.js";
import { FetchUpstreamGatewayClient } from "./upstream-client.js";
import { ConversationImportManager } from "./import-manager.js";
import { PrivacyDeletionService } from "./privacy-deletions.js";

let server: PersonalMemoryGatewayServer | undefined;
let stopping = false;
let database: DatabaseSync | undefined;
let importManager: ConversationImportManager | undefined;
let memoryStates: MemoryStateLedger | undefined;
let memoryReviews: MemoryReviewLedger | undefined;
let memoryGovernance: MemoryGovernanceLedger | undefined;
let audit: AuditLedger | undefined;
let privacyDeletions: PrivacyDeletionService | undefined;
let releaseRuntimeMarker: (() => void) | undefined;

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await server?.stop();
    await importManager?.shutdown();
    importManager = undefined;
    memoryStates = undefined;
    memoryReviews = undefined;
    memoryGovernance = undefined;
    audit = undefined;
    privacyDeletions = undefined;
    database?.close();
    database = undefined;
    releaseRuntimeMarker?.();
    releaseRuntimeMarker = undefined;
    process.stdout.write(`PersonalMemory Gateway stopped (${signal})\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(
      `PersonalMemory Gateway failed to stop: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  try {
    const { config } = loadConfig();
    const dataDirectory = initializeDataDirectory(config.dataDirectory);
    releaseRuntimeMarker = acquireRuntimeMarker(dataDirectory);
    database = new DatabaseSync(join(dataDirectory, "personalmemory.sqlite"));
    migrateDatabase(database, defaultMigrations);
    const upstream = new FetchUpstreamGatewayClient(
      config.server.upstreamBaseUrl,
    );
    importManager = new ConversationImportManager(
      new ImportLedger(database),
      upstream,
      config.server.upstreamTimeoutMs,
    );
    memoryStates = new MemoryStateLedger(database);
    memoryReviews = new MemoryReviewLedger(database);
    memoryGovernance = new MemoryGovernanceLedger(database);
    audit = new AuditLedger(database);
    privacyDeletions = new PrivacyDeletionService(
      database,
      dataDirectory,
      upstream,
      config.server.upstreamTimeoutMs,
    );
    const app = createGatewayApp({
      config,
      upstream,
      importManager,
      memoryStates,
      memoryReviews,
      memoryGovernance,
      privacyDeletions,
      audit,
    });
    server = new PersonalMemoryGatewayServer(app, config);

    process.on("SIGINT", () => void stop("SIGINT"));
    process.on("SIGTERM", () => void stop("SIGTERM"));

    const address = await server.start();
    process.stdout.write(
      `PersonalMemory Gateway ready at http://${address.host}:${address.port}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `PersonalMemory Gateway failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
