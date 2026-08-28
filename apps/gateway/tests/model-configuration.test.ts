import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ModelAuthorizationLedger,
  defaultMigrations,
  loadConfig,
  migrateDatabase,
} from "@personalmemory/core";

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

    const beforeRevocation = await readFile(secretPath, "utf8");
    const database = new DatabaseSync(":memory:");
    migrateDatabase(database, defaultMigrations);
    const authorization = new ModelAuthorizationLedger(database);
    authorization.authorize(status.disclosure!);
    authorization.revoke(status.disclosure!);
    expect(await readFile(secretPath, "utf8")).toBe(beforeRevocation);

    const disabled = await manager.disable();
    expect(disabled).toEqual({
      enabled: false,
      apiKeyConfigured: false,
      restartRequired: false,
    });
    const afterDisable = await readFile(secretPath, "utf8");
    expect(afterDisable).toContain(
      `PERSONALMEMORY_AUTH_TOKEN=${"a".repeat(43)}`,
    );
    expect(afterDisable).toContain("PERSONALMEMORY_MODEL_ENABLED=false");
    expect(afterDisable).not.toContain("private-model-key");
    expect(afterDisable).not.toContain("PERSONALMEMORY_MODEL_BASE_URL");
    expect(afterDisable).not.toContain("PERSONALMEMORY_MODEL_NAME");
  });
});
