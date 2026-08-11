import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MemoryClient } from "../sdk/typescript/src/client.js";
import { createGatewayApp } from "../apps/gateway/src/app.js";
import { ConversationImportManager } from "../apps/gateway/src/import-manager.js";
import { FetchUpstreamGatewayClient } from "../apps/gateway/src/upstream-client.js";
import {
  ImportLedger,
  MemoryStateLedger,
  createReadableExport,
  defaultMigrations,
  loadConfig,
  migrateDatabase,
} from "../packages/personal-memory/src/index.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const forceTimer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 2_000);
    server.close((error) => {
      clearTimeout(forceTimer);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`condition timed out${lastError ? `: ${String(lastError)}` : ""}`);
}

describe("standalone Gateway golden path", () => {
  let dataDir: string;
  let configPath: string;
  let GatewayClass: typeof import("./server.js").TdaiGateway;
  let gateway: InstanceType<typeof GatewayClass> | undefined;
  let gatewayPort: number;
  let llmServer: Server;
  let llmPort: number;

  beforeAll(async () => {
    dataDir = await realpath(await mkdtemp(join(tmpdir(), "personalmemory-golden-")));
    configPath = join(dataDir, "gateway.yaml");

    llmServer = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const sourceIds = [...body.matchAll(/(?:msg-[a-z0-9]+|l0_[a-z0-9_-]+)/g)].map(
          ([id]) => id,
        );
        const memoryContent = body.includes("M2_CHAIN_MARKER")
          ? "用户要求记住 M2_CHAIN_MARKER 并采用本地优先模式"
          : "用户希望 PersonalMemory 始终采用本地优先模式";
        const content = JSON.stringify([{
          scene_name: "用户在设置个人记忆产品的长期偏好",
          message_ids: sourceIds,
          memories: [{
            content: memoryContent,
            type: "instruction",
            priority: 95,
            source_message_ids: sourceIds.slice(0, 1),
            metadata: {},
          }],
        }]);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "golden-path",
          object: "chat.completion",
          created: 0,
          model: "golden-model",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }));
      });
    });
    llmPort = await listen(llmServer);

    await writeFile(configPath, `
deployMode: standalone
stateBackend: local
server:
  host: 127.0.0.1
  port: 0
data:
  baseDir: ${JSON.stringify(dataDir)}
llm:
  baseUrl: http://127.0.0.1:${llmPort}/v1
  apiKey: golden-test-placeholder
  model: golden-model
memory:
  capture:
    enabled: true
  extraction:
    enabled: true
    enableDedup: false
    maxMemoriesPerSession: 5
  pipeline:
    everyNConversations: 1
    enableWarmup: true
    l1IdleTimeoutSeconds: 1
    l2DelayAfterL1Seconds: 3600
    l2MinIntervalSeconds: 3600
    l2MaxIntervalSeconds: 7200
  storeBackend: sqlite
  embedding:
    provider: none
  bm25:
    enabled: true
    language: zh
observability:
  otel:
    enabled: false
  clickhouse:
    enabled: false
  kafka:
    enabled: false
  langfuse:
    enabled: false
`);
    vi.stubEnv("TDAI_GATEWAY_CONFIG", configPath);
    vi.stubEnv("TDAI_DATA_DIR", dataDir);
    vi.stubEnv("TDAI_GATEWAY_HOST", "127.0.0.1");
    vi.stubEnv("TDAI_GATEWAY_PORT", "0");
    vi.stubEnv("TDAI_LLM_BASE_URL", `http://127.0.0.1:${llmPort}/v1`);
    vi.stubEnv("TDAI_LLM_API_KEY", "golden-test-placeholder");
    vi.stubEnv("TDAI_LLM_MODEL", "golden-model");
    vi.stubEnv("OPIK_ENABLED", "false");
    vi.stubEnv("TDAI_OTEL_ENABLED", "false");
    vi.stubEnv("LOG_PATH", join(dataDir, "logs"));

    ({ TdaiGateway: GatewayClass } = await import("../src/gateway/server.js"));
    gateway = new GatewayClass();
    const startAt = performance.now();
    await gateway.start();
    gatewayPort = gateway.getListeningAddress().port;
    expect(performance.now() - startAt).toBeLessThan(15_000);
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      const results = await Promise.allSettled([
        gateway?.stop(),
        llmServer ? close(llmServer) : Promise.resolve(),
      ]);
      cleanupErrors.push(...results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason));
    } finally {
      vi.unstubAllEnvs();
      if (dataDir) {
        try {
          await rm(dataDir, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "golden path cleanup failed");
  });

  it("persists, extracts, searches and traces a memory without external services", async () => {
    const endpoint = `http://127.0.0.1:${gatewayPort}`;
    const healthAt = performance.now();
    const health = await fetch(`${endpoint}/health`).then((response) => response.json());
    expect(health).toEqual(expect.objectContaining({ status: "ok" }));
    expect(performance.now() - healthAt).toBeLessThan(1_000);

    const client = new MemoryClient({ endpoint, apiKey: "local", serviceId: "default" });
    const sessionId = "golden-session";
    const added = await client.addConversation({
      session_id: sessionId,
      messages: [
        { role: "user", content: "请记住，PersonalMemory 始终采用本地优先模式。" },
        { role: "assistant", content: "好的，我会遵循这个长期偏好。" },
      ],
    });
    expect(added.accepted_ids).toHaveLength(2);

    const conversation = await client.queryConversation({ session_id: sessionId });
    expect(conversation.messages).toHaveLength(2);
    const searchAt = performance.now();
    const l0Search = await client.searchConversation({ query: "本地优先", session_id: sessionId });
    expect(l0Search.messages.length).toBeGreaterThan(0);
    expect(performance.now() - searchAt).toBeLessThan(2_000);

    const atomic = await waitFor(async () => {
      const result = await client.searchAtomic({ query: "本地优先", limit: 5 });
      return result.items.length > 0 ? result.items[0] : undefined;
    });
    expect(atomic.content).toContain("本地优先");
    expect(atomic.source_message_ids).toContain(added.accepted_ids[0]);

    const recordFiles = await readdir(join(dataDir, "records"));
    const records = (await Promise.all(
      recordFiles.filter((file) => file.endsWith(".jsonl"))
        .map((file) => readFile(join(dataDir, "records", file), "utf8")),
    )).join("\n");
    const l1Records = records.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(l1Records.some((record) =>
      Array.isArray(record.source_message_ids)
      && record.source_message_ids.includes(added.accepted_ids[0]),
    )).toBe(true);

    const firstGateway = gateway!;
    const stopping = firstGateway.stop();
    await waitFor(async () => {
      try {
        await fetch(`${endpoint}/health`);
        return undefined;
      } catch {
        return true;
      }
    }, 3_000);
    await stopping;
    gateway = undefined;
    gateway = new GatewayClass();
    await gateway.start();
    gatewayPort = gateway.getListeningAddress().port;
    const restartedEndpoint = `http://127.0.0.1:${gatewayPort}`;
    const restartedClient = new MemoryClient({ endpoint: restartedEndpoint, apiKey: "local", serviceId: "default" });
    const afterRestart = await restartedClient.queryConversation({ session_id: sessionId });
    expect(afterRestart.messages).toHaveLength(2);
    const memoryAfterRestart = await restartedClient.searchAtomic({ query: "本地优先", limit: 5 });
    expect(memoryAfterRestart.items[0]?.content).toContain("本地优先");
    await Promise.all([client.close(), restartedClient.close()]);
  });

  it("completes the M2 product chain from import through controlled deletion", async () => {
    const authToken = "m2-golden-auth";
    const authHeaders = {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
    };
    const productDatabasePath = join(dataDir, "personalmemory.sqlite");
    const openProduct = () => {
      const database = new DatabaseSync(productDatabasePath);
      migrateDatabase(database, defaultMigrations);
      const upstream = new FetchUpstreamGatewayClient(
        new URL(`http://127.0.0.1:${gatewayPort}`),
      );
      const { config } = loadConfig({
        environment: {
          PERSONALMEMORY_AUTH_ENABLED: "true",
          PERSONALMEMORY_AUTH_TOKEN: authToken,
          PERSONALMEMORY_DATA_DIR: dataDir,
          PERSONALMEMORY_UPSTREAM_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
        },
      });
      const imports = new ConversationImportManager(
        new ImportLedger(database),
        upstream,
        config.server.upstreamTimeoutMs,
      );
      const app = createGatewayApp({
        config,
        upstream,
        importManager: imports,
        memoryStates: new MemoryStateLedger(database),
        logger: { info() {}, error() {} },
      });
      return { app, database, imports };
    };

    let product = openProduct();
    const imported = await product.app.request("/api/v1/conversations/imports", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        idempotency_key: "m2-golden-import",
        sessions: [
          {
            session_key: "m2-golden-session",
            session_id: "m2-golden-session",
            messages: [
              { role: "user", content: "请记住 M2_CHAIN_MARKER，并始终采用本地优先模式。" },
              { role: "assistant", content: "好的，我会遵循这个长期偏好。" },
            ],
          },
        ],
      }),
    });
    expect(imported.status).toBe(202);
    const importJob = (await imported.json()) as { id: string };
    await waitFor(async () => {
      const response = await product.app.request(
        `/api/v1/conversations/imports/${importJob.id}`,
        { headers: authHeaders },
      );
      const job = (await response.json()) as { status: string };
      return job.status === "completed" ? true : undefined;
    });

    const memory = await waitFor(async () => {
      const response = await product.app.request(
        "/api/v1/memories?level=L1&query=M2_CHAIN_MARKER",
        { headers: authHeaders },
      );
      const body = (await response.json()) as {
        items: Array<{
          id: string;
          content: string;
          source: { status: string; explanation: string };
        }>;
      };
      return body.items[0];
    });
    expect(memory.content).toContain("M2_CHAIN_MARKER");
    expect(memory.source.status).toBe("original");
    expect(memory.source.explanation).toContain("l0_m2-golden-session_");

    const corrected = await product.app.request(
      `/api/v1/memories/L1/${encodeURIComponent(memory.id)}/update`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          content: "用户默认使用墨绿色界面",
          expected_revision: 0,
        }),
      },
    );
    expect(corrected.status).toBe(200);

    await product.imports.shutdown();
    product.database.close();
    const stopping = gateway!.stop();
    gateway = undefined;
    await stopping;
    const exportFile = join(
      await realpath(tmpdir()),
      `personalmemory-m2-${randomUUID()}.json`,
    );
    try {
      const exported = await createReadableExport(dataDir, exportFile, "json");
      expect(exported.counts.memories).toBeGreaterThan(0);
      expect(exported.counts.states).toBeGreaterThan(0);
    } finally {
      await rm(exportFile, { force: true });
    }

    gateway = new GatewayClass();
    await gateway.start();
    gatewayPort = gateway.getListeningAddress().port;
    product = openProduct();
    const deleted = await product.app.request(
      `/api/v1/memories/L1/${encodeURIComponent(memory.id)}/delete`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          confirmation: `DELETE L1:${memory.id}`,
          reason: "M2 golden controlled deletion",
          expected_revision: 1,
        }),
      },
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({
      upstream_deleted: true,
      scope: {
        hidden_from_personalmemory: true,
        source_conversations_deleted: false,
        complete_erasure: false,
      },
    });
    const afterDelete = await product.app.request(
      "/api/v1/memories?level=L1&query=%E5%A2%A8%E7%BB%BF%E8%89%B2",
      { headers: authHeaders },
    );
    expect(await afterDelete.json()).toMatchObject({ items: [] });
    await product.imports.shutdown();
    product.database.close();
  });
});
