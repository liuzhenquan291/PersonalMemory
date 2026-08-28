import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@personalmemory/core";

import { createModelConfigurationManager } from "../src/model-configuration.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("private model configuration", () => {
  it("preserves Gateway authentication while saving a redacted model configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-model-config-"));
    roots.push(root);
    const secretPath = path.join(root, "gateway.env");
    await writeFile(
      secretPath,
      [
        "PERSONALMEMORY_AUTH_ENABLED=true",
        `PERSONALMEMORY_AUTH_TOKEN=${"a".repeat(43)}`,
        "PERSONALMEMORY_MODEL_ENABLED=false",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const manager = await createModelConfigurationManager({
      secretPath,
      activeConfig: loadConfig().config,
    });

    const status = await manager.configure({
      provider: "openai-compatible",
      baseUrl: "https://models.example.test/v1",
      apiKey: "private-model-key",
      modelName: "test-model",
    });

    expect(status).toEqual({
      enabled: true,
      provider: "openai-compatible",
      baseUrl: "https://models.example.test/v1",
      modelName: "test-model",
      apiKeyConfigured: true,
      disclosure: {
        version: 1,
        provider: "openai-compatible",
        targetOrigin: "https://models.example.test",
        sentFields: [
          "model input",
          "selected memory context",
          "imported conversation messages",
        ],
      },
      restartRequired: true,
    });
    expect(JSON.stringify(status)).not.toContain("private-model-key");
    const saved = await readFile(secretPath, "utf8");
    expect(saved).toContain(`PERSONALMEMORY_AUTH_TOKEN=${"a".repeat(43)}`);
    expect(saved).toContain("PERSONALMEMORY_MODEL_API_KEY=private-model-key");
    expect(saved).toContain(
      "PERSONALMEMORY_MODEL_ALLOWED_ORIGINS=https://models.example.test",
    );
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
  });
});
