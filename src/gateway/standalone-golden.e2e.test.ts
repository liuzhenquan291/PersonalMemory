import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MemoryClient } from "../../sdk/typescript/src/client.js";

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
    dataDir = await mkdtemp(join(tmpdir(), "personalmemory-golden-"));
    configPath = join(dataDir, "gateway.yaml");

    llmServer = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const sourceIds = [...body.matchAll(/msg-[a-z0-9]+/g)].map(([id]) => id);
        const content = JSON.stringify([{
          scene_name: "用户在设置个人记忆产品的长期偏好",
          message_ids: sourceIds,
          memories: [{
            content: "用户希望 PersonalMemory 始终采用本地优先模式",
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

    ({ TdaiGateway: GatewayClass } = await import("./server.js"));
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
});
