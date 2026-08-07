import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  assertOutboundAllowed,
  getModelOutboundDisclosure,
  loadConfig,
} from "../src/index.js";

const isolatedEnvironment = (): NodeJS.ProcessEnv => ({});

describe("PersonalMemory configuration", () => {
  it("starts safely without secrets and requests model setup", () => {
    const loaded = loadConfig({
      environment: isolatedEnvironment(),
      platform: "linux",
      homeDirectory: "/home/alice",
    });

    expect(loaded.readiness).toEqual({
      ready: false,
      reason: "model-configuration-required",
    });
    expect(loaded.config).toMatchObject({
      server: {
        host: "127.0.0.1",
        port: 8787,
        authenticationEnabled: false,
      },
      dataDirectory: "/home/alice/.local/share/personalmemory",
      telemetryEnabled: false,
      model: { enabled: false, allowedOrigins: [] },
    });
  });

  it("uses environment variables over file configuration", () => {
    const loaded = loadConfig({
      file: {
        server: { port: 9000 },
        dataDirectory: "/from-file",
      },
      environment: {
        PERSONALMEMORY_PORT: "9100",
        PERSONALMEMORY_DATA_DIR: "/from-environment",
      },
    });

    expect(loaded.config.server.port).toBe(9100);
    expect(loaded.config.dataDirectory).toBe("/from-environment");
  });

  it("rejects unknown configuration including file-based secrets", () => {
    expect(() =>
      loadConfig({
        file: { model: { apiKey: "must-not-be-stored-here" } },
        environment: isolatedEnvironment(),
      }),
    ).toThrow(/Unrecognized key.*apiKey/s);
  });

  it("requires authentication for non-loopback listening", () => {
    expect(() =>
      loadConfig({
        environment: { PERSONALMEMORY_HOST: "0.0.0.0" },
      }),
    ).toThrow(/Non-loopback listening requires authentication/);

    const loaded = loadConfig({
      environment: {
        PERSONALMEMORY_HOST: "0.0.0.0",
        PERSONALMEMORY_AUTH_ENABLED: "true",
        PERSONALMEMORY_AUTH_TOKEN: "private-auth-token",
      },
    });
    expect(loaded.config.server.authenticationToken?.toString()).toBe(
      "[REDACTED]",
    );
    expect(JSON.stringify(loaded.config)).not.toContain("private-auth-token");
  });

  it("requires an explicit allowlisted origin for remote model access", () => {
    expect(() =>
      loadConfig({
        environment: {
          PERSONALMEMORY_MODEL_ENABLED: "true",
          PERSONALMEMORY_MODEL_PROVIDER: "openai-compatible",
          PERSONALMEMORY_MODEL_BASE_URL: "https://models.example.test/v1",
          PERSONALMEMORY_MODEL_API_KEY: "private-model-key",
        },
      }),
    ).toThrow(/not in PERSONALMEMORY_MODEL_ALLOWED_ORIGINS/);

    const loaded = loadConfig({
      environment: {
        PERSONALMEMORY_MODEL_ENABLED: "true",
        PERSONALMEMORY_MODEL_PROVIDER: "openai-compatible",
        PERSONALMEMORY_MODEL_BASE_URL: "https://models.example.test/v1",
        PERSONALMEMORY_MODEL_ALLOWED_ORIGINS: "https://models.example.test",
        PERSONALMEMORY_MODEL_API_KEY: "private-model-key",
      },
    });
    expect(loaded.readiness).toEqual({ ready: true });
    expect(loaded.config.model.apiKey?.toString()).toBe("[REDACTED]");
    expect(getModelOutboundDisclosure(loaded.config)).toEqual({
      provider: "openai-compatible",
      targetOrigin: "https://models.example.test",
      sentFields: ["model input", "selected memory context"],
    });
  });

  it("requires HTTPS remotely and rejects URL-embedded credentials", () => {
    const common = {
      PERSONALMEMORY_MODEL_ENABLED: "true",
      PERSONALMEMORY_MODEL_PROVIDER: "openai-compatible",
      PERSONALMEMORY_MODEL_API_KEY: "private-model-key",
    };
    expect(() =>
      loadConfig({
        environment: {
          ...common,
          PERSONALMEMORY_MODEL_BASE_URL: "http://models.example.test/v1",
          PERSONALMEMORY_MODEL_ALLOWED_ORIGINS: "http://models.example.test",
        },
      }),
    ).toThrow(/require.*HTTPS/);
    expect(() =>
      loadConfig({
        environment: {
          ...common,
          PERSONALMEMORY_MODEL_BASE_URL:
            "https://user:password@models.example.test/v1",
          PERSONALMEMORY_MODEL_ALLOWED_ORIGINS: "https://models.example.test",
        },
      }),
    ).toThrow(/must not contain credentials/);
  });

  it("does not let proxy environment variables change the logical allowlist", () => {
    const loaded = loadConfig({
      environment: {
        HTTP_PROXY: "http://proxy.example.test:8080",
        HTTPS_PROXY: "http://proxy.example.test:8080",
        PERSONALMEMORY_MODEL_ENABLED: "true",
        PERSONALMEMORY_MODEL_PROVIDER: "openai-compatible",
        PERSONALMEMORY_MODEL_BASE_URL: "https://allowed.example.test/v1",
        PERSONALMEMORY_MODEL_ALLOWED_ORIGINS: "https://allowed.example.test",
        PERSONALMEMORY_MODEL_API_KEY: "private-model-key",
      },
    });

    expect(() =>
      assertOutboundAllowed("https://blocked.example.test/v1", loaded.config),
    ).toThrow(/not in the model provider allowlist/);
    expect(
      assertOutboundAllowed(
        "https://allowed.example.test/v1/chat/completions",
        loaded.config,
      ).origin,
    ).toBe("https://allowed.example.test");
  });

  it("rejects plaintext remote origins at load and request time", () => {
    expect(() =>
      loadConfig({
        environment: {
          PERSONALMEMORY_MODEL_ENABLED: "true",
          PERSONALMEMORY_MODEL_PROVIDER: "openai-compatible",
          PERSONALMEMORY_MODEL_BASE_URL: "https://models.example.test/v1",
          PERSONALMEMORY_MODEL_ALLOWED_ORIGINS:
            "https://models.example.test,http://models.example.test",
          PERSONALMEMORY_MODEL_API_KEY: "private-model-key",
        },
      }),
    ).toThrow(/allowlist origins require HTTPS/);

    const loaded = loadConfig({
      environment: {
        PERSONALMEMORY_MODEL_ENABLED: "true",
        PERSONALMEMORY_MODEL_PROVIDER: "openai-compatible",
        PERSONALMEMORY_MODEL_BASE_URL: "https://models.example.test/v1",
        PERSONALMEMORY_MODEL_ALLOWED_ORIGINS: "https://models.example.test",
        PERSONALMEMORY_MODEL_API_KEY: "private-model-key",
      },
    });
    const manuallyExpandedConfig = {
      ...loaded.config,
      model: {
        ...loaded.config.model,
        allowedOrigins: [
          ...loaded.config.model.allowedOrigins,
          "http://models.example.test",
        ],
      },
    };
    expect(() =>
      assertOutboundAllowed(
        "http://models.example.test/plaintext",
        manuallyExpandedConfig,
      ),
    ).toThrow(/requires HTTPS/);
  });

  it("keeps the default configuration network-disabled", () => {
    const { config } = loadConfig({ environment: isolatedEnvironment() });
    expect(() =>
      assertOutboundAllowed("https://models.example.test", config),
    ).toThrow(ConfigurationError);
  });

  it("returns actionable messages for malformed environment values", () => {
    expect(() =>
      loadConfig({ environment: { PERSONALMEMORY_PORT: "not-a-port" } }),
    ).toThrow(/PERSONALMEMORY_PORT must be an integer/);
    expect(() =>
      loadConfig({
        environment: { PERSONALMEMORY_TELEMETRY_ENABLED: "sometimes" },
      }),
    ).toThrow(/must be true, false, 1, or 0/);
    expect(() =>
      loadConfig({
        environment: {
          PERSONALMEMORY_MODEL_ALLOWED_ORIGINS: "not-a-url",
        },
      }),
    ).toThrow(/must contain absolute URLs/);
    expect(() =>
      loadConfig({
        environment: {
          PERSONALMEMORY_MODEL_ALLOWED_ORIGINS:
            "https://models.example.test/v1",
        },
      }),
    ).toThrow(/must contain absolute URLs/);
  });
});
