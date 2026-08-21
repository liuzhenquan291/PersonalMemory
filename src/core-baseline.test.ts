import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { StandaloneLLMRunner } from "./adapters/standalone/llm-runner.js";
import { initOTelSDK, shutdownOTelSDK } from "./core/report/otel-sdk-init.js";
import { LocalStorageBackend } from "./core/storage/local-backend.js";
import { loadGatewayConfig } from "./gateway/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("PersonalMemory core baseline", () => {
  it("keeps the upstream model gate disabled despite inherited credentials", () => {
    vi.stubEnv("TDAI_LLM_ENABLED", "false");
    vi.stubEnv("TDAI_LLM_BASE_URL", "https://models.example.test/v1");
    vi.stubEnv("TDAI_LLM_API_KEY", "inherited-secret");
    vi.stubEnv("TDAI_LLM_MODEL", "inherited-model");

    expect(loadGatewayConfig().llm.enabled).toBe(false);
  });

  it("rejects model execution before any outbound request when disabled", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(500).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");

    const runner = new StandaloneLLMRunner({
      config: {
        enabled: false,
        apiKey: "inherited-secret",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "inherited-model",
      },
    });

    try {
      await expect(
        runner.run({ taskId: "disabled-gate", systemPrompt: "system", prompt: "prompt" }),
      ).rejects.toThrow("Model outbound access is disabled");
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it("round-trips memory data through isolated local storage", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "personalmemory-storage-"));
    temporaryDirectories.push(rootDir);
    const storage = new LocalStorageBackend(rootDir);

    await storage.putObject("memories/session-1.json", '{"fact":"local-first"}');

    const stored = await storage.getObject("memories/session-1.json");
    expect(stored?.content.toString("utf8")).toBe('{"fact":"local-first"}');
    await expect(storage.getObject("../outside.txt")).rejects.toThrow(
      "Path traversal rejected",
    );
  });

  it("runs the upgraded AI SDK adapter without external network access", async () => {
    let requestBody = "";
    const server = createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "offline-completion",
          object: "chat.completion",
          created: 0,
          model: "offline-model",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "offline response" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");

    const runner = new StandaloneLLMRunner({
      config: {
        apiKey: "test-placeholder",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "offline-model",
      },
    });

    try {
      await expect(
        runner.run({ taskId: "offline-smoke", systemPrompt: "system", prompt: "prompt" }),
      ).resolves.toBe("offline response");
      expect(JSON.parse(requestBody)).toEqual(
        expect.objectContaining({ model: "offline-model" }),
      );
      expect(runner.lastUsage).toEqual({
        promptTokens: 2,
        completionTokens: 3,
        totalTokens: 5,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it("initializes and shuts down the upgraded telemetry SDK offline", async () => {
    await expect(
      initOTelSDK({
        endpoint: "http://127.0.0.1:9",
        protocol: "http/protobuf",
        serviceName: "personalmemory-test",
      }),
    ).resolves.toBe(true);
    await expect(shutdownOTelSDK()).resolves.toBeUndefined();
  });
});
