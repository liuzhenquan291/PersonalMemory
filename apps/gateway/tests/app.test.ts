import { loadConfig, type PersonalMemoryConfig } from "@personalmemory/core";
import { describe, expect, it, vi } from "vitest";
import { createGatewayApp } from "../src/app.js";
import type { GatewayLogEvent, UpstreamGatewayClient } from "../src/types.js";
import { UpstreamGatewayError } from "../src/upstream-client.js";

function createConfig(
  overrides: Partial<PersonalMemoryConfig["server"]> = {},
): PersonalMemoryConfig {
  const { config } = loadConfig({
    environment: {
      PERSONALMEMORY_AUTH_ENABLED: "true",
      PERSONALMEMORY_AUTH_TOKEN: "test-auth-secret",
      PERSONALMEMORY_CORS_ORIGINS: "http://127.0.0.1:5173",
    },
  });
  return { ...config, server: { ...config.server, ...overrides } };
}

function createHarness(options: {
  config?: PersonalMemoryConfig;
  upstream?: UpstreamGatewayClient;
  now?: () => number;
}) {
  const logs: GatewayLogEvent[] = [];
  let sequence = 0;
  const upstream =
    options.upstream ??
    ({
      request: vi.fn(async ({ path, body }) => ({
        status: 200,
        body: { path, body },
      })),
    } satisfies UpstreamGatewayClient);
  const app = createGatewayApp({
    config: options.config ?? createConfig(),
    upstream,
    now: options.now,
    randomId: () => `test-id-${String(++sequence).padStart(4, "0")}`,
    logger: {
      info: (event) => logs.push(event),
      error: (event) => logs.push(event),
    },
  });
  return { app, upstream, logs };
}

const authHeaders = {
  authorization: "Bearer test-auth-secret",
  "content-type": "application/json",
};

describe("PersonalMemory Gateway app", () => {
  it("serves public health and version with request IDs", async () => {
    const { app } = createHarness({});
    const health = await app.request("/health", {
      headers: { "x-request-id": "client-request-123" },
    });
    expect(health.status).toBe(200);
    expect(health.headers.get("x-request-id")).toBe("test-id-0001");
    expect(await health.json()).toEqual({
      status: "ok",
      service: "personalmemory-gateway",
    });

    const version = await app.request("/version");
    expect(await version.json()).toMatchObject({
      apiVersion: "v1",
      schemaVersion: 1,
    });
  });

  it("keeps memory access closed until authentication is configured", async () => {
    const { config } = loadConfig({ environment: {} });
    const { app } = createHarness({ config });
    const response = await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "q", session_key: "s" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_SETUP_REQUIRED" },
    });
  });

  it("validates and forwards only the stable route contract", async () => {
    const { app, upstream } = createHarness({});
    const response = await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ query: "local first", session_key: "session-1" }),
    });
    expect(response.status).toBe(200);
    expect(upstream.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/recall",
        body: { query: "local first", session_key: "session-1" },
      }),
    );

    const invalid = await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ query: "q", session_key: "s", unexpected: true }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("x-content-type-options")).toBe("nosniff");
    expect(invalid.headers.get("x-frame-options")).toBe("DENY");
    expect(await invalid.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("enforces media type and streaming body size limits", async () => {
    const config = createConfig({ requestBodyLimitBytes: 32 });
    const { app } = createHarness({ config });
    const wrongType = await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: { authorization: authHeaders.authorization },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);

    const oversized = await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ query: "x".repeat(100), session_key: "s" }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      error: { code: "REQUEST_TOO_LARGE" },
    });
  });

  it("applies strict CORS and rejects origin values with paths", async () => {
    const { app } = createHarness({});
    const denied = await app.request("/api/v1/config/status", {
      headers: { origin: "https://evil.example.test" },
    });
    expect(denied.status).toBe(403);

    const pathOrigin = await app.request("/api/v1/config/status", {
      headers: { origin: "http://127.0.0.1:5173/path" },
    });
    expect(pathOrigin.status).toBe(403);

    const preflight = await app.request("/api/v1/memories/recall", {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:5173" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:5173",
    );
  });

  it("exchanges bearer auth for a loopback browser session with CSRF", async () => {
    const { app } = createHarness({});
    const session = await app.request("/api/v1/session", {
      method: "POST",
      headers: {
        authorization: authHeaders.authorization,
        origin: "http://127.0.0.1:5173",
      },
    });
    expect(session.status).toBe(200);
    const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
    const { csrfToken } = (await session.json()) as { csrfToken: string };
    expect(cookie).toBeTruthy();

    const missingCsrf = await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: {
        cookie: cookie!,
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
      },
      body: JSON.stringify({ query: "q", session_key: "s" }),
    });
    expect(missingCsrf.status).toBe(403);

    const accepted = await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: {
        cookie: cookie!,
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({ query: "q", session_key: "s" }),
    });
    expect(accepted.status).toBe(200);
  });

  it("expires browser sessions and disables them off loopback", async () => {
    let currentTime = 1_000;
    const config = createConfig({ sessionTtlSeconds: 60 });
    const { app } = createHarness({ config, now: () => currentTime });
    const session = await app.request("/api/v1/session", {
      method: "POST",
      headers: authHeaders,
    });
    const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
    const { csrfToken } = (await session.json()) as { csrfToken: string };
    currentTime += 60_001;
    const expired = await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: {
        cookie: cookie!,
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({ query: "q", session_key: "s" }),
    });
    expect(expired.status).toBe(401);

    const remoteConfig = createConfig({ host: "0.0.0.0" });
    const remote = createHarness({ config: remoteConfig });
    const rejected = await remote.app.request("/api/v1/session", {
      method: "POST",
      headers: authHeaders,
    });
    expect(rejected.status).toBe(403);
  });

  it("rate limits requests without logging secrets or bodies", async () => {
    const config = createConfig({ rateLimitPerMinute: 1 });
    const { app, logs } = createHarness({ config, now: () => 1_000 });
    await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ query: "private-memory-body", session_key: "s" }),
    });
    const limited = await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ query: "private-memory-body", session_key: "s" }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("log-secret");
    expect(serialized).not.toContain("test-auth-secret");
    expect(serialized).not.toContain("private-memory-body");
    expect(logs.at(-1)).toMatchObject({
      event: "request.failed",
      status: 429,
    });
  });

  it("keeps public and failed-auth traffic out of the valid user quota", async () => {
    const config = createConfig({ rateLimitPerMinute: 1 });
    const { app } = createHarness({ config, now: () => 1_000 });
    for (let index = 0; index < 5; index += 1) {
      expect((await app.request("/api/v1/config/status")).status).toBe(200);
    }
    const invalid = await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: {
        authorization: "Bearer invalid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "q", session_key: "s" }),
    });
    expect(invalid.status).toBe(401);
    const valid = await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ query: "q", session_key: "s" }),
    });
    expect(valid.status).toBe(200);
  });

  it("rate limits missing sessions, unknown sessions, and invalid CSRF together", async () => {
    const config = createConfig({ rateLimitPerMinute: 1_000 });
    const { app } = createHarness({ config, now: () => 1_000 });
    const body = JSON.stringify({ query: "q", session_key: "s" });

    for (let index = 0; index < 40; index += 1) {
      const response = await app.request("/api/v1/memories/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(401);
    }
    for (let index = 0; index < 40; index += 1) {
      const response = await app.request("/api/v1/memories/recall", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "personalmemory_session=unknown-session",
        },
        body,
      });
      expect(response.status).toBe(401);
    }

    const session = await app.request("/api/v1/session", {
      method: "POST",
      headers: authHeaders,
    });
    const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
    for (let index = 0; index < 40; index += 1) {
      const response = await app.request("/api/v1/memories/recall", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookie!,
          "x-csrf-token": "invalid-csrf",
        },
        body,
      });
      expect(response.status).toBe(403);
    }
    const limited = await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookie!,
        "x-csrf-token": "invalid-csrf",
      },
      body,
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      error: { code: "AUTH_RATE_LIMITED" },
    });

    const valid = await app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: authHeaders,
      body,
    });
    expect(valid.status).toBe(200);
  });

  it("bounds browser sessions and reclaims expired orphan sessions", async () => {
    let currentTime = 1_000;
    const config = createConfig({
      rateLimitPerMinute: 100,
      sessionTtlSeconds: 60,
    });
    const { app } = createHarness({ config, now: () => currentTime });
    for (let index = 0; index < 32; index += 1) {
      const response = await app.request("/api/v1/session", {
        method: "POST",
        headers: authHeaders,
      });
      expect(response.status).toBe(200);
    }
    const full = await app.request("/api/v1/session", {
      method: "POST",
      headers: authHeaders,
    });
    expect(full.status).toBe(429);
    expect(await full.json()).toMatchObject({
      error: { code: "SESSION_LIMIT_REACHED" },
    });

    currentTime += 60_001;
    const reclaimed = await app.request("/api/v1/session", {
      method: "POST",
      headers: authHeaders,
    });
    expect(reclaimed.status).toBe(200);
  });

  it("logs only server-generated IDs and finite route labels", async () => {
    const { app, logs } = createHarness({});
    await app.request("/private-token-shaped-value", {
      headers: { "x-request-id": "secret-token-shaped-request-id" },
    });
    expect(JSON.stringify(logs)).not.toMatch(
      /private-token-shaped-value|secret-token-shaped-request-id/,
    );
    expect(logs.at(-1)).toMatchObject({ path: "<unmatched>" });
  });

  it("maps upstream failures without exposing upstream response details", async () => {
    const rejected = createHarness({
      upstream: {
        async request() {
          return {
            status: 500,
            body: { error: "/private/path", secret: "upstream-secret" },
          };
        },
      },
    });
    const response = await rejected.app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ query: "q", session_key: "s" }),
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(/private\/path|upstream-secret/);

    const timedOut = createHarness({
      upstream: {
        async request() {
          throw new UpstreamGatewayError("safe timeout", "UPSTREAM_TIMEOUT");
        },
      },
    });
    const timeout = await timedOut.app.request("/api/v1/memories/recall", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ query: "q", session_key: "s" }),
    });
    expect(timeout.status).toBe(504);
    expect(await timeout.json()).toMatchObject({
      error: { code: "UPSTREAM_TIMEOUT" },
    });
  });

  it("does not expose a path traversal proxy route", async () => {
    const { app, upstream } = createHarness({});
    const response = await app.request("/api/v1/../../capture", {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    });
    expect(response.status).toBe(404);
    expect(upstream.request).not.toHaveBeenCalled();
  });
});
