import {
  AuditLedger,
  CapturePolicyLedger,
  HookCaptureLedger,
  HookAuthorizationLedger,
  HOOK_CAPTURE_COMMITTED,
  ImportLedger,
  MemoryGovernanceLedger,
  ModelAuthorizationLedger,
  MemoryStateLedger,
  MemoryReviewLedger,
  PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
  RetentionAuthorizationLedger,
  RetentionRunLedger,
  defaultMigrations,
  loadConfig,
  migrateDatabase,
  type PersonalMemoryConfig,
} from "@personalmemory/core";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createGatewayApp } from "../src/app.js";
import type { GatewayLogEvent, UpstreamGatewayClient } from "../src/types.js";
import { UpstreamGatewayError } from "../src/upstream-client.js";
import { ConversationImportManager } from "../src/import-manager.js";
import type { PrivacyDeletionService } from "../src/privacy-deletions.js";
import type {
  HookCaptureSink,
  HookLifecyclePolicy,
} from "../src/hook-lifecycle.js";

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
  withReviews?: boolean;
  withGovernance?: boolean;
  privacyDeletions?: PrivacyDeletionService;
  hookPolicy?: HookLifecyclePolicy;
  hookCaptureSink?: HookCaptureSink;
  modelConfiguration?: unknown;
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
  const database = new DatabaseSync(":memory:");
  migrateDatabase(database, defaultMigrations);
  let importSequence = 0;
  const importManager = new ConversationImportManager(
    new ImportLedger(database),
    upstream,
    (options.config ?? createConfig()).server.upstreamTimeoutMs,
    () => `import-job-${++importSequence}`,
  );
  const memoryStates = new MemoryStateLedger(database);
  const memoryReviews = options.withReviews
    ? new MemoryReviewLedger(database)
    : undefined;
  const memoryGovernance = options.withGovernance
    ? new MemoryGovernanceLedger(database)
    : undefined;
  let auditSequence = 0;
  const audit = new AuditLedger(
    database,
    () => "2026-08-11T00:00:00.000Z",
    () => `audit-event-${++auditSequence}`,
  );
  const hookCaptures = new HookCaptureLedger(database);
  const hookAuthorizations = new HookAuthorizationLedger(
    database,
    "install_0123456789abcdef",
    () => "2026-08-24T01:00:00.000Z",
  );
  const capturePolicies = new CapturePolicyLedger(
    database,
    () => "2026-08-24T01:00:00.000Z",
  );
  const modelAuthorizations = new ModelAuthorizationLedger(
    database,
    () => "2026-08-24T00:00:00.000Z",
  );
  const retentionAuthorizations = new RetentionAuthorizationLedger(
    database,
    () => "2026-08-24T02:00:00.000Z",
  );
  const retentionRuns = new RetentionRunLedger(database);
  const app = createGatewayApp({
    config: options.config ?? createConfig(),
    upstream,
    importManager,
    memoryStates,
    memoryReviews,
    memoryGovernance,
    privacyDeletions: options.privacyDeletions,
    audit,
    hookCaptures,
    hookAuthorizations,
    capturePolicies,
    modelAuthorizations,
    retentionAuthorizations,
    retentionRuns,
    hookPolicy: options.hookPolicy,
    hookCaptureSink: options.hookCaptureSink,
    modelConfiguration: options.modelConfiguration,
    now: options.now,
    randomId: () => `test-id-${String(++sequence).padStart(4, "0")}`,
    logger: {
      info: (event) => logs.push(event),
      error: (event) => logs.push(event),
    },
  } as Parameters<typeof createGatewayApp>[0]);
  return {
    app,
    upstream,
    logs,
    importManager,
    memoryStates,
    memoryReviews,
    memoryGovernance,
    audit,
    hookCaptures,
    hookAuthorizations,
    capturePolicies,
    modelAuthorizations,
  };
}

async function waitForImport(
  app: ReturnType<typeof createGatewayApp>,
  id: string,
): Promise<ImportJobResponse> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.request(`/api/v1/conversations/imports/${id}`, {
      headers: authHeaders,
    });
    const job = (await response.json()) as ImportJobResponse;
    if (!["pending", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("import did not settle");
}

const authHeaders = {
  authorization: "Bearer test-auth-secret",
  "content-type": "application/json",
};

interface ImportJobResponse {
  id: string;
  status: string;
  progress: { total: number; completed: number; failed: number };
  cancel_requested?: boolean;
}

describe("PersonalMemory Gateway app", () => {
  it("runs authorized retention maintenance under a persisted lease and records drained proof", async () => {
    const executeRetentionBatch = vi.fn(
      async (_input, _requestId, beforeExecute) => {
        expect(
          beforeExecute({
            candidateDigest: "a".repeat(64),
            plannedL0: 1,
            plannedL1: 1,
            anomalyCount: 0,
          }),
        ).toBe(true);
        return {
          candidate_digest: "a".repeat(64),
          status: "drained" as const,
          planned_l0: 1,
          planned_l1: 1,
          deleted_l0: 1,
          deleted_l1: 1,
          remaining_l0: 0,
          remaining_l1: 0,
          deleted_artifacts: 2,
          anomaly_count: 0,
        };
      },
    );
    const { app } = createHarness({
      now: () => Date.parse("2026-08-25T12:00:00.000Z"),
      privacyDeletions: {
        executeRetentionBatch,
      } as unknown as PrivacyDeletionService,
    });
    await app.request("/api/v1/capture-policy", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        expected_policy_revision: 1,
        capture_enabled: true,
        excluded_clients: [],
        excluded_working_directories: [],
        excluded_sources: [],
        sensitive_categories: ["credentials", "financial", "identity"],
        l0_retention_days: 30,
        l1_retention_days: 365,
      }),
    });
    await app.request("/api/v1/retention/authorization", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ expected_authorization_revision: 0 }),
    });
    const maintenance = await app.request("/api/v1/retention/maintenance", {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    });
    expect(await maintenance.json()).toMatchObject({
      status: "drained",
      run: {
        policyRevision: 2,
        authorizationRevision: 1,
        remainingL0: 0,
        remainingL1: 0,
      },
    });
    expect(executeRetentionBatch).toHaveBeenCalledOnce();
    const status = await app.request("/api/v1/retention/status", {
      headers: authHeaders,
    });
    expect(await status.json()).toMatchObject({ status: "drained" });
  });
  it("keeps retention execution disabled until separately authorized and makes policy changes stale", async () => {
    const { app } = createHarness({});
    const initial = await app.request("/api/v1/retention/status", {
      headers: authHeaders,
    });
    expect(await initial.json()).toMatchObject({
      status: "not_applicable",
      authorization: { status: "disabled", revision: 0 },
    });

    const authorized = await app.request("/api/v1/retention/authorization", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ expected_authorization_revision: 0 }),
    });
    expect(await authorized.json()).toMatchObject({
      authorization: { status: "authorized", revision: 1 },
    });

    await app.request("/api/v1/capture-policy", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        expected_policy_revision: 1,
        capture_enabled: true,
        excluded_clients: [],
        excluded_working_directories: [],
        excluded_sources: [],
        sensitive_categories: ["credentials", "financial", "identity"],
        l0_retention_days: 30,
        l1_retention_days: 365,
      }),
    });
    const stale = await app.request("/api/v1/retention/status", {
      headers: authHeaders,
    });
    expect(await stale.json()).toMatchObject({
      status: "disabled",
      authorization: {
        status: "stale",
        revision: 1,
        binding: { policyRevision: 1 },
      },
      policy_revision: 2,
    });
  });
  it("independently authorizes and revokes automatic recall and local capture", async () => {
    const { app } = createHarness({});

    const initial = await app.request("/api/v1/hooks/authorization", {
      headers: authHeaders,
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      disclosure: {
        version: 1,
        recall: {
          data: "approved L1 memory text",
          timing: "before the model request",
          purpose: "provide relevant memory for the current response",
          destination: "the current agent model input",
          budget:
            "up to 5 items, 4000 characters, 1000 estimated tokens, and 1000 ms",
          failure: "the prompt continues without memory",
          revocation:
            "the Gateway rejects recall immediately; clients synchronize the new revision before maintenance",
        },
        capture: {
          data: "raw user and assistant text",
          timing: "after a successful main-agent response",
          purpose: "build local memory for later review and recall",
          destination: "local L0 memory and a private retry outbox",
          budget:
            "one user/assistant pair per successful turn, a 1000 ms Gateway request, and a bounded 24-hour outbox",
          failure: "the agent response is never blocked",
          revocation:
            "the Gateway rejects capture immediately; queued entries cannot flush under the old revision",
        },
      },
      authorization: {
        installation_id: "install_0123456789abcdef",
        authorization_revision: 1,
        policy_revision: 1,
        recall_enabled: false,
        capture_enabled: false,
        changed_at: "2026-08-24T01:00:00.000Z",
      },
    });

    const enabled = await app.request("/api/v1/hooks/authorization", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        disclosure_version: 1,
        expected_authorization_revision: 1,
        recall_enabled: true,
        capture_enabled: false,
      }),
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      authorization: {
        authorization_revision: 2,
        recall_enabled: true,
        capture_enabled: false,
      },
    });

    const stale = await app.request("/api/v1/hooks/authorization", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        disclosure_version: 1,
        expected_authorization_revision: 1,
        recall_enabled: true,
        capture_enabled: true,
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "HOOK_AUTHORIZATION_CHANGED" },
    });

    const revoked = await app.request("/api/v1/hooks/authorization", {
      method: "DELETE",
      headers: authHeaders,
      body: JSON.stringify({ expected_authorization_revision: 2 }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      authorization: {
        authorization_revision: 3,
        recall_enabled: false,
        capture_enabled: false,
      },
    });
  });

  it("exposes a versioned authenticated capture policy without leaking content", async () => {
    const { app } = createHarness({});
    const initial = await app.request("/api/v1/capture-policy", {
      headers: authHeaders,
    });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      policy: {
        policy_revision: 1,
        capture_enabled: true,
        sensitive_categories: ["credentials", "financial", "identity"],
        l0_retention_days: null,
        l1_retention_days: null,
      },
    });

    const updated = await app.request("/api/v1/capture-policy", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        expected_policy_revision: 1,
        capture_enabled: true,
        excluded_clients: ["codex"],
        excluded_working_directories: ["/private/work/../project"],
        excluded_sources: [],
        sensitive_categories: ["credentials"],
        l0_retention_days: 30,
        l1_retention_days: 365,
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      policy: {
        policy_revision: 2,
        excluded_clients: ["codex"],
        excluded_working_directories: ["/private/project"],
        l0_retention_days: 30,
        l1_retention_days: 365,
      },
      authorization: { authorization_revision: 2, policy_revision: 2 },
    });

    const stale = await app.request("/api/v1/capture-policy", {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        expected_policy_revision: 1,
        capture_enabled: false,
        excluded_clients: [],
        excluded_working_directories: [],
        excluded_sources: [],
        sensitive_categories: [],
        l0_retention_days: null,
        l1_retention_days: null,
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "CAPTURE_POLICY_CHANGED" },
    });
    const history = await app.request(
      "/api/v1/capture-policy/history?before_revision=3&limit=1",
      { headers: authHeaders },
    );
    expect(await history.json()).toMatchObject({
      policies: [{ policy_revision: 2 }],
    });
  });

  it("keeps hook routes authenticated and validates the frozen request", async () => {
    const policy: HookLifecyclePolicy = {
      authorization: () => ({
        installationId: "installation-1",
        authorizationRevision: 1,
        policyRevision: 1,
        recallEnabled: false,
        captureEnabled: false,
      }),
      allowsSource: () => false,
    };
    const { app } = createHarness({
      hookPolicy: policy,
      withReviews: true,
      withGovernance: true,
    });
    const request = {
      contract_version: PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
      event: {
        client: "codex",
        session_id: "session-1",
        turn_id: "turn-1",
        subagent: false,
      },
      authorization: {
        installation_id: "installation-1",
        authorization_revision: 1,
        policy_revision: 1,
      },
      source: { kind: "agent_lifecycle", working_directory: "/project" },
      prompt: "remember",
    };
    expect(
      await app.request("/api/v1/hooks/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    ).toMatchObject({ status: 401 });
    const response = await app.request("/api/v1/hooks/recall", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: "skipped",
      reason: "recall_not_authorized",
    });
  });

  it("enforces the public capture route, conflict alert and local sink errors", async () => {
    const policy: HookLifecyclePolicy = {
      authorization: () => ({
        installationId: "installation-1",
        authorizationRevision: 1,
        policyRevision: 1,
        recallEnabled: true,
        captureEnabled: true,
      }),
      allowsSource: () => true,
    };
    const capture = vi.fn(() => HOOK_CAPTURE_COMMITTED);
    const { app, logs } = createHarness({
      hookPolicy: policy,
      hookCaptureSink: { capture },
      withReviews: true,
      withGovernance: true,
    });
    const request = {
      contract_version: PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
      event: {
        client: "codex",
        session_id: "private-session",
        turn_id: "private-turn",
        subagent: false,
      },
      authorization: {
        installation_id: "installation-1",
        authorization_revision: 1,
        policy_revision: 1,
      },
      source: {
        kind: "agent_lifecycle",
        working_directory: "/private/project",
      },
      idempotency_key: `hook:v1:${"c".repeat(64)}`,
      messages: [
        { role: "user", content: "private user text" },
        { role: "assistant", content: "private assistant text" },
      ],
    };
    const post = (body: unknown) =>
      app.request("/api/v1/hooks/capture", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(body),
      });

    expect(
      await (await post({ ...request, unexpected: true })).json(),
    ).toMatchObject({
      error: { code: "INVALID_HOOK_REQUEST" },
    });
    expect(await (await post(request)).json()).toMatchObject({
      outcome: "captured",
    });
    expect(await (await post(request)).json()).toMatchObject({
      outcome: "duplicate",
    });
    expect(
      await (
        await post({
          ...request,
          messages: [
            request.messages[0],
            { role: "assistant", content: "changed" },
          ],
        })
      ).json(),
    ).toMatchObject({ outcome: "conflict", reason: "idempotency_conflict" });
    expect(capture).toHaveBeenCalledTimes(1);
    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).toContain('"outcome":"conflict"');
    expect(serializedLogs).not.toContain("private user text");
    expect(serializedLogs).not.toContain("private assistant text");
    expect(serializedLogs).not.toContain("/private/project");
    expect(serializedLogs).not.toContain("private-session");

    const failed = createHarness({
      hookPolicy: policy,
      hookCaptureSink: {
        capture: () => {
          throw new Error("local failure");
        },
      },
      withReviews: true,
      withGovernance: true,
    });
    const unavailable = await failed.app.request("/api/v1/hooks/capture", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(request),
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: { code: "HOOK_CAPTURE_UNAVAILABLE" },
    });
  });
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
      schemaVersion: 12,
    });
  });

  it("provides an authenticated MCP preflight without exposing configuration", async () => {
    const { app } = createHarness({});
    const response = await app.request("/api/v1/mcp/status", {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      api_version: "v1",
    });
    expect(await app.request("/api/v1/mcp/status")).toMatchObject({
      status: 401,
    });
  });

  it("reviews memories in a bounded batch and reports per-item results", async () => {
    const { app, memoryReviews } = createHarness({ withReviews: true });
    const response = await app.request("/api/v1/memory-reviews", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        items: [
          { id: "memory-1", action: "approve", expected_revision: 0 },
          {
            id: "memory-2",
            action: "reject",
            expected_revision: 0,
            reason: "不准确",
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      results: [
        { id: "memory-1", ok: true, review: { status: "approved" } },
        { id: "memory-2", ok: true, review: { status: "rejected" } },
      ],
    });
    expect(memoryReviews?.isApproved("L1", "memory-1")).toBe(true);
  });

  it("returns a privacy-preserving, cursor-paged audit timeline", async () => {
    const { app } = createHarness({ withReviews: true });
    await app.request("/api/v1/memory-reviews", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        items: [
          {
            id: "private-memory-id",
            action: "reject",
            expected_revision: 0,
            reason: "sensitive-reason",
          },
        ],
      }),
    });
    const response = await app.request(
      "/api/v1/audit?level=L1&memory_id=private-memory-id&limit=1",
      { headers: authHeaders },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("private-memory-id");
    expect(text).not.toContain("sensitive-reason");
    expect(JSON.parse(text)).toMatchObject({
      events: [
        {
          action: "memory.reviewed",
          outcome: "success",
          subject: { level: "L1" },
          details: { status: "rejected" },
        },
      ],
    });
  });

  it("creates and revokes an explicit supersedes relation", async () => {
    const { app } = createHarness({ withGovernance: true });
    const created = await app.request("/api/v1/memory-relations", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        level: "L1",
        kind: "supersedes",
        source_id: "current",
        target_id: "old",
        reason: "用户确认新事实替代旧事实",
      }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as {
      relation: { id: string; revision: number };
    };
    const governance = await app.request("/api/v1/memories/L1/old/governance", {
      headers: authHeaders,
    });
    expect(await governance.json()).toMatchObject({
      recallable: false,
      relations: [{ status: "active" }],
    });
    const revoked = await app.request(
      `/api/v1/memory-relations/${body.relation.id}/revoke`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ expected_revision: body.relation.revision }),
      },
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      relation: { status: "revoked", revision: 2 },
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

  it("exposes unified recall with explicit levels and hard budgets", async () => {
    const upstream: UpstreamGatewayClient = {
      async request({ path }) {
        expect(path).toBe("/v2/atomic/search");
        return {
          status: 200,
          body: {
            code: 0,
            data: {
              items: [{ id: "memory-1", content: "x".repeat(400), score: 0.9 }],
            },
          },
        };
      },
    };
    const { app } = createHarness({ upstream });
    const response = await app.request("/api/v1/recall/query", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        query: "local memory",
        levels: ["L1"],
        budget: {
          max_items: 1,
          max_chars: 300,
          max_tokens: 64,
          timeout_ms: 1_000,
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ id: "memory-1", level: "L1", truncated: true }],
      degraded_levels: [],
      budget: {
        used_items: 1,
        used_chars: 256,
        estimated_tokens: 64,
        exhausted: true,
      },
    });
  });

  it("exposes authenticated read-only memory browsing with pagination metadata", async () => {
    const upstream: UpstreamGatewayClient = {
      async request({ path, body }) {
        expect(path).toBe("/v2/atomic/query");
        expect(body).toEqual({ limit: 12, offset: 12 });
        return {
          status: 200,
          body: {
            code: 0,
            data: {
              items: [
                {
                  id: "memory-13",
                  type: "fact",
                  content: "第十三条记忆",
                  updated_at: "2026-08-11T00:00:00Z",
                },
              ],
              total: 13,
            },
          },
        };
      },
    };
    const { app } = createHarness({ upstream });
    const response = await app.request(
      "/api/v1/memories?level=L1&page=2&page_size=12",
      { headers: authHeaders },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [
        {
          id: "memory-13",
          level: "L1",
          source: { status: "unavailable", label: "来源未记录" },
        },
      ],
      page: 2,
      page_size: 12,
      total: 13,
      has_previous: true,
      has_next: false,
    });
  });

  it("updates L1 with optimistic revision tracking", async () => {
    const upstream: UpstreamGatewayClient = {
      async request({ path, body }) {
        expect(path).toBe("/v2/atomic/update");
        expect(body).toEqual({ id: "memory-1", content: "修正后的内容" });
        return { status: 200, body: { code: 0, data: { id: "memory-1" } } };
      },
    };
    const { app } = createHarness({ upstream });
    const response = await app.request("/api/v1/memories/L1/memory-1/update", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        content: "修正后的内容",
        expected_revision: 0,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: { status: "active", revision: 1 },
    });

    const stale = await app.request("/api/v1/memories/L1/memory-1/update", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ content: "过期写入", expected_revision: 0 }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "MEMORY_CONFLICT" },
    });
  });

  it("keeps deletion scope explicit and tombstones L1 on upstream failure", async () => {
    const upstream: UpstreamGatewayClient = {
      async request() {
        throw new UpstreamGatewayError("unavailable", "UPSTREAM_UNAVAILABLE");
      },
    };
    const { app, memoryStates } = createHarness({ upstream });
    const response = await app.request("/api/v1/memories/L1/memory-1/delete", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        confirmation: "DELETE L1:memory-1",
        reason: "用户确认该记忆错误",
        expected_revision: 0,
      }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      state: { status: "deleted", revision: 1 },
      upstream_deleted: false,
      scope: {
        hidden_from_personalmemory: true,
        source_conversations_deleted: false,
        derived_profiles_deleted: false,
        exports_or_backups_deleted: false,
        complete_erasure: false,
      },
    });
    expect(memoryStates.isSuppressed("L1", "memory-1")).toBe(true);
  });

  it("requires preview and strong acknowledgement for a cascade deletion", async () => {
    const preview = vi.fn(async () => ({
      token: "plan-1",
      level: "L1" as const,
      memory_id: "memory-1",
      expires_at: "2030-08-11T00:10:00.000Z",
      confirmation: "ERASE L1:memory-1",
      scope: {
        source_l0: 1,
        index_l1: 1,
        derived_l2: 0,
        derived_l3: 0,
        readable_l0: 1,
        readable_l1: 1,
        managed_copies: 0,
      },
      managed_copies: [],
      limitations: ["controlled scope"],
    }));
    const execute = vi.fn(async () => ({
      status: "complete" as const,
      memory_id: "memory-1",
      retryable: false,
      steps: {},
      verification: {
        l1_remaining: 0,
        l0_remaining: 0,
        derived_occurrences: 0,
        readable_rows: 0,
        managed_copies_remaining: 0,
        tombstone_present: true,
      },
      errors: [],
    }));
    const privacyDeletions = {
      preview,
      execute,
      cancel: vi.fn(),
    } as unknown as PrivacyDeletionService;
    const { app } = createHarness({ privacyDeletions });
    const planned = await app.request("/api/v1/privacy-deletions/preview", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ level: "L1", memory_id: "memory-1" }),
    });
    expect(planned.status).toBe(200);
    expect(await planned.json()).toMatchObject({
      token: "plan-1",
      confirmation: "ERASE L1:memory-1",
    });
    expect(preview).toHaveBeenCalledWith("memory-1", expect.any(String));

    const handedOff = await app.request("/api/v1/privacy-deletions/handoffs", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ level: "L1", memory_id: "memory-1" }),
    });
    expect(handedOff.status).toBe(200);
    const handoffBody = (await handedOff.json()) as { handoff_id: string };
    expect(JSON.stringify(handoffBody)).not.toContain("plan-1");
    expect(JSON.stringify(handoffBody)).not.toContain("ERASE L1");
    const bearerPreview = await app.request(
      `/api/v1/privacy-deletions/handoffs/${handoffBody.handoff_id}`,
      { headers: authHeaders },
    );
    expect(bearerPreview.status).toBe(403);
    const session = await app.request("/api/v1/session", {
      method: "POST",
      headers: authHeaders,
    });
    const cookie = session.headers.get("set-cookie")!;
    const webPreview = await app.request(
      `/api/v1/privacy-deletions/handoffs/${handoffBody.handoff_id}`,
      { headers: { cookie } },
    );
    expect(await webPreview.json()).toMatchObject({
      token: "plan-1",
      confirmation: "ERASE L1:memory-1",
    });

    const weak = await app.request("/api/v1/privacy-deletions/plan-1/execute", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        confirmation: "ERASE L1:memory-1",
        delete_managed_copies: true,
      }),
    });
    expect(weak.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();

    const erased = await app.request(
      "/api/v1/privacy-deletions/plan-1/execute",
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          confirmation: "ERASE L1:memory-1",
          delete_managed_copies: true,
          unmanaged_copies_acknowledged: true,
        }),
      },
    );
    expect(erased.status).toBe(200);
    expect(await erased.json()).toMatchObject({ status: "complete" });
  });

  it("captures one session idempotently without sending expected data externally", async () => {
    const { app, upstream, logs } = createHarness({});
    const body = {
      idempotency_key: "single-key",
      session: {
        session_key: "session-1",
        messages: [
          { role: "assistant", content: "private assistant body" },
          { role: "user", content: "private user body" },
        ],
      },
    };
    const created = await app.request("/api/v1/conversations/capture", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(202);
    const job = (await created.json()) as { id: string };
    await expect(waitForImport(app, job.id)).resolves.toMatchObject({
      status: "completed",
      progress: { total: 1, completed: 1, failed: 0 },
    });
    expect(upstream.request).toHaveBeenCalledTimes(1);
    expect(upstream.request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/capture",
        body: expect.objectContaining({
          user_content: "private user body",
          assistant_content: "private assistant body",
        }),
      }),
    );

    const duplicate = await app.request("/api/v1/conversations/capture", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body),
    });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()) as { id: string }).toMatchObject({
      id: job.id,
    });
    expect(upstream.request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs)).not.toMatch(
      /private assistant body|private user body/,
    );
    expect(
      (
        await app.request(`/api/v1/conversations/imports/${job.id}/retry`, {
          method: "POST",
          headers: authHeaders,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request(`/api/v1/conversations/imports/${job.id}/cancel`, {
          method: "POST",
          headers: authHeaders,
        })
      ).status,
    ).toBe(409);
  });

  it("does not accept a per-request acknowledgement as model authorization", async () => {
    const { config } = loadConfig({
      environment: {
        PERSONALMEMORY_AUTH_ENABLED: "true",
        PERSONALMEMORY_AUTH_TOKEN: "test-auth-secret",
        PERSONALMEMORY_MODEL_ENABLED: "true",
        PERSONALMEMORY_MODEL_PROVIDER: "openai-compatible",
        PERSONALMEMORY_MODEL_BASE_URL: "https://models.example.test/v1",
        PERSONALMEMORY_MODEL_ALLOWED_ORIGINS: "https://models.example.test",
        PERSONALMEMORY_MODEL_API_KEY: "private-model-key",
        PERSONALMEMORY_MODEL_NAME: "test-model",
      },
    });
    const { app, upstream } = createHarness({ config });
    const status = await app.request("/api/v1/config/status");
    expect(await status.json()).toMatchObject({
      modelOutboundDisclosure: {
        provider: "openai-compatible",
        targetOrigin: "https://models.example.test",
        sentFields: [
          "model input",
          "selected memory context",
          "imported conversation messages",
        ],
      },
    });
    const payload = {
      idempotency_key: "outbound-key",
      session: {
        session_key: "session-1",
        messages: [
          { role: "user", content: "private user" },
          { role: "assistant", content: "private assistant" },
        ],
      },
    };
    const denied = await app.request("/api/v1/conversations/capture", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(payload),
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      error: { code: "MODEL_OUTBOUND_CONSENT_REQUIRED" },
    });
    expect(upstream.request).not.toHaveBeenCalled();

    const stillDenied = await app.request("/api/v1/conversations/capture", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        ...payload,
        model_outbound_acknowledged: true,
      }),
    });
    expect(stillDenied.status).toBe(409);
    expect(await stillDenied.json()).toMatchObject({
      error: { code: "MODEL_OUTBOUND_CONSENT_REQUIRED" },
    });
    expect(upstream.request).not.toHaveBeenCalled();
  });

  it("configures a private OpenAI-compatible model without returning its key", async () => {
    let saved:
      | {
          provider: string;
          baseUrl: string;
          apiKey: string;
          modelName: string;
        }
      | undefined;
    const disclosure = {
      version: 1 as const,
      provider: "openai-compatible" as const,
      targetOrigin: "https://models.example.test",
      sentFields: [
        "model input",
        "selected memory context",
        "imported conversation messages",
      ],
    };
    const modelConfiguration = {
      status: () => ({
        enabled: Boolean(saved),
        provider: saved?.provider,
        baseUrl: saved?.baseUrl,
        modelName: saved?.modelName,
        apiKeyConfigured: Boolean(saved),
        disclosure: saved ? disclosure : undefined,
        restartRequired: Boolean(saved),
      }),
      configure: async (input: typeof saved) => {
        saved = input;
        return modelConfiguration.status();
      },
      disable: async () => {
        saved = undefined;
        return modelConfiguration.status();
      },
    };
    const { app } = createHarness({ modelConfiguration });

    const configured = await app.request("/api/v1/model/configuration", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        provider: "openai-compatible",
        base_url: "https://models.example.test/v1",
        api_key: "private-model-key",
        model_name: "test-model",
      }),
    });

    expect(configured.status).toBe(200);
    const configuredBody = await configured.json();
    expect(configuredBody).toEqual({
      configuration: {
        enabled: true,
        provider: "openai-compatible",
        base_url: "https://models.example.test/v1",
        model_name: "test-model",
        api_key_configured: true,
      },
      disclosure,
      restart_required: true,
    });
    expect(saved).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://models.example.test/v1",
      apiKey: "private-model-key",
      modelName: "test-model",
    });
    expect(JSON.stringify(configuredBody).toLowerCase()).not.toContain(
      "private-model-key",
    );

    const authorization = await app.request("/api/v1/model/authorization", {
      headers: authHeaders,
    });
    expect(authorization.status).toBe(200);
    expect(await authorization.json()).toMatchObject({
      disclosure,
      authorization: { status: "required", revision: 0 },
      restart_required: true,
    });

    const current = await app.request("/api/v1/model/configuration", {
      headers: authHeaders,
    });
    expect(await current.json()).toEqual({
      configuration: {
        enabled: true,
        provider: "openai-compatible",
        base_url: "https://models.example.test/v1",
        model_name: "test-model",
        api_key_configured: true,
      },
      disclosure,
      restart_required: true,
    });

    const disabled = await app.request("/api/v1/model/configuration", {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(await disabled.json()).toEqual({
      configuration: {
        enabled: false,
        api_key_configured: false,
      },
      restart_required: false,
    });
  });

  it("persists versioned model authorization and rejects stale disclosure", async () => {
    const { config } = loadConfig({
      environment: {
        PERSONALMEMORY_AUTH_ENABLED: "true",
        PERSONALMEMORY_AUTH_TOKEN: "test-auth-secret",
        PERSONALMEMORY_MODEL_ENABLED: "true",
        PERSONALMEMORY_MODEL_PROVIDER: "openai-compatible",
        PERSONALMEMORY_MODEL_BASE_URL: "https://models.example.test/v1",
        PERSONALMEMORY_MODEL_ALLOWED_ORIGINS: "https://models.example.test",
        PERSONALMEMORY_MODEL_API_KEY: "private-model-key",
        PERSONALMEMORY_MODEL_NAME: "test-model",
      },
    });
    const { app, upstream } = createHarness({ config });

    const initial = await app.request("/api/v1/model/authorization", {
      headers: authHeaders,
    });
    expect(await initial.json()).toEqual({
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
      authorization: { status: "required", revision: 0 },
      restart_required: false,
    });
    expect(
      JSON.stringify(
        await app
          .request("/api/v1/model/authorization", {
            headers: authHeaders,
          })
          .then((response) => response.json()),
      ),
    ).not.toContain("private-model-key");

    const stale = await app.request("/api/v1/model/authorization", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        version: 1,
        provider: "openai-compatible",
        targetOrigin: "https://changed.example.test",
        sentFields: [
          "model input",
          "selected memory context",
          "imported conversation messages",
        ],
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "MODEL_DISCLOSURE_CHANGED" },
    });

    const authorized = await app.request("/api/v1/model/authorization", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        version: 1,
        provider: "openai-compatible",
        targetOrigin: "https://models.example.test",
        sentFields: [
          "model input",
          "selected memory context",
          "imported conversation messages",
        ],
      }),
    });
    expect(await authorized.json()).toEqual({
      authorization: {
        status: "authorized",
        revision: 1,
        authorizedAt: "2026-08-24T00:00:00.000Z",
      },
      restart_required: true,
    });

    const payload = {
      idempotency_key: "persistent-authorization-key",
      session: {
        session_key: "session-persistent-authorization",
        messages: [
          { role: "user", content: "private user" },
          { role: "assistant", content: "private assistant" },
        ],
      },
    };
    expect(
      (
        await app.request("/api/v1/conversations/capture", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(payload),
        })
      ).status,
    ).toBe(202);

    const revoked = await app.request("/api/v1/model/authorization", {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(await revoked.json()).toEqual({
      authorization: {
        status: "revoked",
        revision: 2,
        revokedAt: "2026-08-24T00:00:00.000Z",
      },
      restart_required: true,
    });
    expect(upstream.request).toHaveBeenCalledTimes(1);
  });

  it("reports partial batch failure and retries only the failed round", async () => {
    let sessionTwoAttempts = 0;
    const upstream: UpstreamGatewayClient = {
      async request({ body }) {
        const session = (body as { session_key: string }).session_key;
        if (session === "session-2" && sessionTwoAttempts++ === 0) {
          throw new UpstreamGatewayError(
            "safe failure",
            "UPSTREAM_UNAVAILABLE",
          );
        }
        return { status: 200, body: { ok: true } };
      },
    };
    const { app } = createHarness({ upstream });
    const created = await app.request("/api/v1/conversations/imports", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        idempotency_key: "batch-key",
        sessions: ["session-1", "session-2"].map((session_key) => ({
          session_key,
          messages: [
            { role: "user", content: `user-${session_key}` },
            { role: "assistant", content: `assistant-${session_key}` },
          ],
        })),
      }),
    });
    const { id } = (await created.json()) as { id: string };
    await expect(waitForImport(app, id)).resolves.toMatchObject({
      status: "partial",
      progress: { completed: 1, failed: 1 },
    });
    const retried = await app.request(
      `/api/v1/conversations/imports/${id}/retry`,
      { method: "POST", headers: authHeaders },
    );
    expect(retried.status).toBe(202);
    await expect(waitForImport(app, id)).resolves.toMatchObject({
      status: "completed",
      progress: { completed: 2, failed: 0 },
    });
    expect(sessionTwoAttempts).toBe(2);
  });

  it("rejects illegal roles, incomplete pairs, oversized fields, and changed idempotent input", async () => {
    const { app } = createHarness({});
    const submit = (messages: unknown[], key = "validation-key") =>
      app.request("/api/v1/conversations/capture", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          idempotency_key: key,
          session: { session_key: "session-1", messages },
        }),
      });
    expect(
      (
        await submit([
          { role: "system", content: "not allowed" },
          { role: "assistant", content: "answer" },
        ])
      ).status,
    ).toBe(400);
    expect(
      (await submit([{ role: "user", content: "incomplete" }])).status,
    ).toBe(400);
    expect(
      (
        await submit([
          { role: "user", content: "x".repeat(32_769) },
          { role: "assistant", content: "answer" },
        ])
      ).status,
    ).toBe(400);

    const original = [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
    ];
    expect((await submit(original, "same-key")).status).toBe(202);
    const conflict = await submit(
      [
        { role: "user", content: "changed" },
        { role: "assistant", content: "answer" },
      ],
      "same-key",
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });

  it("cancels in-flight and pending import work", async () => {
    let started!: () => void;
    const startPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const upstream: UpstreamGatewayClient = {
      async request({ signal }) {
        started();
        await new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          }),
        );
        return { status: 200, body: {} };
      },
    };
    const { app } = createHarness({ upstream });
    const created = await app.request("/api/v1/conversations/imports", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        idempotency_key: "cancel-key",
        sessions: ["session-1", "session-2"].map((session_key) => ({
          session_key,
          messages: [
            { role: "user", content: "user" },
            { role: "assistant", content: "assistant" },
          ],
        })),
      }),
    });
    const { id } = (await created.json()) as { id: string };
    await startPromise;
    const cancelled = await app.request(
      `/api/v1/conversations/imports/${id}/cancel`,
      { method: "POST", headers: authHeaders },
    );
    expect(cancelled.status).toBe(202);
    await expect(waitForImport(app, id)).resolves.toMatchObject({
      status: "cancelled",
      cancel_requested: true,
    });
  });

  it("settles active imports before shutdown returns", async () => {
    let started!: () => void;
    const startPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const upstream: UpstreamGatewayClient = {
      async request({ signal }) {
        started();
        await new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          }),
        );
        return { status: 200, body: {} };
      },
    };
    const { app, importManager } = createHarness({ upstream });
    const created = await app.request("/api/v1/conversations/capture", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        idempotency_key: "shutdown-key",
        session: {
          session_key: "session-1",
          messages: [
            { role: "user", content: "user" },
            { role: "assistant", content: "assistant" },
          ],
        },
      }),
    });
    const { id } = (await created.json()) as { id: string };
    await startPromise;
    await importManager.shutdown();
    await expect(waitForImport(app, id)).resolves.toMatchObject({
      status: "cancelled",
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
