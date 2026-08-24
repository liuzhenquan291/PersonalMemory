import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type AuditAction,
  getModelOutboundDisclosure,
  HookAuthorizationConflictError,
  CapturePolicyConflictError,
  hookCaptureRequestSchema,
  hookCaptureResponseSchema,
  hookRecallRequestSchema,
  hookRecallResponseSchema,
  PERSONAL_MEMORY_SCHEMA_VERSION,
} from "@personalmemory/core";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type {
  GatewayAppOptions,
  GatewayErrorEnvelope,
  GatewayLogEvent,
  GatewayLogger,
} from "./types.js";
import { UpstreamGatewayError } from "./upstream-client.js";
import { ImportIdempotencyConflictError } from "./import-manager.js";
import type { ImportJobView, ImportRoundPayload } from "@personalmemory/core";
import { RecallService, unifiedRecallRequestSchema } from "./recall-service.js";
import { MemoryBrowser, memoryBrowseQuerySchema } from "./memory-browser.js";
import {
  MemoryMutationError,
  MemoryMutationService,
  editableMemoryLevelSchema,
  memoryDeleteSchema,
  memoryInvalidateSchema,
  memoryUpdateSchema,
} from "./memory-mutations.js";
import {
  MemoryReviewService,
  memoryReviewBatchSchema,
} from "./memory-reviews.js";
import {
  MemoryGovernanceService,
  MemoryGovernanceServiceError,
  memoryRelationSchema,
  memoryValiditySchema,
  relationRevokeSchema,
} from "./memory-governance.js";
import {
  PrivacyDeletionError,
  privacyDeletionExecuteSchema,
  privacyDeletionPreviewSchema,
  type PrivacyDeletionPreview,
} from "./privacy-deletions.js";
import {
  HookLifecycleCaptureError,
  HookLifecycleService,
} from "./hook-lifecycle.js";

const API_VERSION = "v1";
const SESSION_COOKIE = "personalmemory_session";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BROWSER_SESSIONS = 32;
const MAX_FAILED_AUTH_ATTEMPTS_PER_MINUTE = 120;
const MAX_IMPORT_ROUNDS = 500;
const MAX_MCP_DELETION_HANDOFFS = 32;

const auditQuerySchema = z
  .object({
    action: z
      .enum([
        "memory.generated",
        "memory.reviewed",
        "memory.recalled",
        "memory.updated",
        "memory.invalidated",
        "memory.deleted",
        "memory.relation_created",
        "memory.relation_revoked",
        "memory.validity_updated",
        "data.exported",
      ])
      .optional(),
    level: z.enum(["L0", "L1", "L2", "L3"]).optional(),
    memory_id: z.string().min(1).max(2_048).optional(),
    before_sequence: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .superRefine((input, context) => {
    if (Boolean(input.level) !== Boolean(input.memory_id)) {
      context.addIssue({
        code: "custom",
        message: "level and memory_id must be supplied together",
      });
    }
  });

const importMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(32_768),
  })
  .strict();

const importSessionSchema = z
  .object({
    session_key: z.string().min(1).max(256),
    session_id: z.string().min(1).max(256).optional(),
    messages: z.array(importMessageSchema).min(2).max(200),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.messages.length % 2 !== 0) {
      context.addIssue({
        code: "custom",
        message: "Messages must form complete user/assistant pairs",
        path: ["messages"],
      });
      return;
    }
    for (let index = 0; index < session.messages.length; index += 2) {
      const roles = new Set([
        session.messages[index]?.role,
        session.messages[index + 1]?.role,
      ]);
      if (!roles.has("user") || !roles.has("assistant")) {
        context.addIssue({
          code: "custom",
          message: "Each message pair must contain one user and one assistant",
          path: ["messages", index],
        });
      }
    }
  });

const singleImportSchema = z
  .object({
    idempotency_key: z.string().min(1).max(200),
    model_outbound_acknowledged: z.boolean().optional(),
    session: importSessionSchema,
  })
  .strict();

const batchImportSchema = z
  .object({
    idempotency_key: z.string().min(1).max(200),
    model_outbound_acknowledged: z.boolean().optional(),
    sessions: z.array(importSessionSchema).min(1).max(50),
  })
  .strict()
  .superRefine((input, context) => {
    const rounds = input.sessions.reduce(
      (total, session) => total + session.messages.length / 2,
      0,
    );
    if (rounds > MAX_IMPORT_ROUNDS) {
      context.addIssue({
        code: "custom",
        message: `An import may contain at most ${MAX_IMPORT_ROUNDS} rounds`,
        path: ["sessions"],
      });
    }
  });

const modelDisclosureSchema = z
  .object({
    version: z.literal(1),
    provider: z.enum(["local", "openai-compatible"]),
    targetOrigin: z.url(),
    sentFields: z.array(z.string().min(1)).min(1).max(16),
  })
  .strict();

const hookAuthorizationUpdateSchema = z
  .object({
    disclosure_version: z.literal(1),
    expected_authorization_revision: z.number().int().positive(),
    recall_enabled: z.boolean(),
    capture_enabled: z.boolean(),
  })
  .strict();

const hookAuthorizationRevokeSchema = z
  .object({ expected_authorization_revision: z.number().int().positive() })
  .strict();

const capturePolicyUpdateSchema = z
  .object({
    expected_policy_revision: z.number().int().positive(),
    capture_enabled: z.boolean(),
    excluded_clients: z.array(z.enum(["codex", "claude-code"])).max(2),
    excluded_working_directories: z
      .array(z.string().startsWith("/").max(4_096))
      .max(128),
    excluded_sources: z.array(z.literal("agent_lifecycle")).max(1),
    sensitive_categories: z
      .array(z.enum(["credentials", "financial", "identity"]))
      .max(3),
    l0_retention_days: z.number().int().min(1).max(3_650).nullable(),
    l1_retention_days: z.number().int().min(1).max(3_650).nullable(),
  })
  .strict();

const capturePolicyHistoryQuerySchema = z
  .object({
    before_revision: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

function capturePolicyResponse(
  status: NonNullable<
    GatewayAppOptions["capturePolicies"]
  >["status"] extends () => infer T
    ? T
    : never,
) {
  return {
    policy_revision: status.revision,
    capture_enabled: status.captureEnabled,
    excluded_clients: status.excludedClients,
    excluded_working_directories: status.excludedWorkingDirectories,
    excluded_sources: status.excludedSources,
    sensitive_categories: status.sensitiveCategories,
    l0_retention_days: status.l0RetentionDays,
    l1_retention_days: status.l1RetentionDays,
    changed_at: status.changedAt,
  };
}

const HOOK_AUTHORIZATION_DISCLOSURE = Object.freeze({
  version: 1 as const,
  recall: Object.freeze({
    data: "approved L1 memory text",
    timing: "before the model request",
    purpose: "provide relevant memory for the current response",
    destination: "the current agent model input",
    budget:
      "up to 5 items, 4000 characters, 1000 estimated tokens, and 1000 ms",
    failure: "the prompt continues without memory",
    revocation:
      "the Gateway rejects recall immediately; clients synchronize the new revision before maintenance",
  }),
  capture: Object.freeze({
    data: "raw user and assistant text",
    timing: "after a successful main-agent response",
    purpose: "build local memory for later review and recall",
    destination: "local L0 memory and a private retry outbox",
    budget:
      "one user/assistant pair per successful turn, a 1000 ms Gateway request, and a bounded 24-hour outbox",
    failure: "the agent response is never blocked",
    revocation:
      "the Gateway rejects capture immediately; queued entries cannot flush under the old revision",
  }),
});

function hookAuthorizationResponse(status: {
  installationId: string;
  authorizationRevision: number;
  policyRevision: number;
  recallEnabled: boolean;
  captureEnabled: boolean;
  changedAt: string;
}) {
  return {
    installation_id: status.installationId,
    authorization_revision: status.authorizationRevision,
    policy_revision: status.policyRevision,
    recall_enabled: status.recallEnabled,
    capture_enabled: status.captureEnabled,
    changed_at: status.changedAt,
  };
}

function toImportRounds(
  sessions: z.infer<typeof importSessionSchema>[],
): ImportRoundPayload[] {
  return sessions.flatMap((session) => {
    const rounds: ImportRoundPayload[] = [];
    for (let index = 0; index < session.messages.length; index += 2) {
      const messages = session.messages.slice(index, index + 2);
      const user = messages.find(({ role }) => role === "user")!;
      const assistant = messages.find(({ role }) => role === "assistant")!;
      rounds.push({
        sessionKey: session.session_key,
        ...(session.session_id ? { sessionId: session.session_id } : {}),
        userContent: user.content,
        assistantContent: assistant.content,
        messages,
      });
    }
    return rounds;
  });
}

function importJobResponse(job: ImportJobView): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    cancel_requested: job.cancelRequested,
    progress: {
      total: job.totalItems,
      completed: job.completedItems,
      failed: job.failedItems,
    },
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

export type GatewayEnv = { Variables: { requestId: string } };

const proxyRoutes = [
  {
    route: "/api/v1/memories/capture",
    upstreamPath: "/capture",
    schema: z
      .object({
        user_content: z.string().min(1),
        assistant_content: z.string().min(1),
        session_key: z.string().min(1),
        session_id: z.string().min(1).optional(),
        user_id: z.string().min(1).optional(),
        messages: z.array(z.unknown()).optional(),
      })
      .strict(),
  },
  {
    route: "/api/v1/memories/recall",
    upstreamPath: "/recall",
    schema: z
      .object({
        query: z.string().min(1),
        session_key: z.string().min(1),
        user_id: z.string().min(1).optional(),
      })
      .strict(),
  },
  {
    route: "/api/v1/memories/search",
    upstreamPath: "/search/memories",
    schema: z
      .object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        type: z.string().min(1).optional(),
        scene: z.string().min(1).optional(),
      })
      .strict(),
  },
  {
    route: "/api/v1/conversations/search",
    upstreamPath: "/search/conversations",
    schema: z
      .object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        session_key: z.string().min(1).optional(),
      })
      .strict(),
  },
  {
    route: "/api/v1/sessions/end",
    upstreamPath: "/session/end",
    schema: z
      .object({
        session_key: z.string().min(1),
        user_id: z.string().min(1).optional(),
      })
      .strict(),
  },
] as const;

interface BrowserSession {
  csrfToken: string;
  expiresAt: number;
}

const defaultLogger: GatewayLogger = {
  info(event) {
    console.info(JSON.stringify(event));
  },
  error(event) {
    console.error(JSON.stringify(event));
  },
};

function jsonResponse(
  body: unknown,
  status: number,
  headers?: Headers | Record<string, string>,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=UTF-8");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  responseHeaders.set("x-frame-options", "DENY");
  responseHeaders.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

async function readLimitedJson(
  request: Request,
  limit: number,
): Promise<unknown> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim();
  if (contentType !== "application/json") {
    throw new GatewayHttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json",
    );
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > limit) {
    throw new GatewayHttpError(
      413,
      "REQUEST_TOO_LARGE",
      "Request body is too large",
    );
  }
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new GatewayHttpError(
        413,
        "REQUEST_TOO_LARGE",
        "Request body is too large",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new GatewayHttpError(
      400,
      "INVALID_JSON",
      "Request body must be valid JSON",
      {
        cause: error,
      },
    );
  }
}

class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
    readonly headers?: Record<string, string>,
  ) {
    super(message, options);
    this.name = "GatewayHttpError";
  }
}

export function createGatewayApp(options: GatewayAppOptions): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? randomUUID;
  const sessions = new Map<string, BrowserSession>();
  const mcpDeletionHandoffs = new Map<
    string,
    {
      preview: PrivacyDeletionPreview;
      expiresAt: number;
    }
  >();
  const recallService = new RecallService(
    options.upstream,
    options.config.server.upstreamTimeoutMs,
    options.memoryStates,
    options.memoryReviews,
    options.memoryGovernance,
  );
  const hookLifecycle =
    options.hookCaptures &&
    options.hookPolicy &&
    options.memoryStates &&
    options.memoryReviews &&
    options.memoryGovernance
      ? new HookLifecycleService(
          recallService,
          options.memoryReviews,
          options.hookCaptures,
          options.hookPolicy,
          options.hookCaptureSink,
        )
      : undefined;
  const memoryBrowser = new MemoryBrowser(
    options.upstream,
    options.config.server.upstreamTimeoutMs,
    options.memoryStates,
    options.memoryReviews,
    options.memoryGovernance,
  );
  const memoryMutations = options.memoryStates
    ? new MemoryMutationService(
        options.memoryStates,
        options.upstream,
        options.config.server.upstreamTimeoutMs,
      )
    : undefined;
  const memoryReviews = options.memoryReviews
    ? new MemoryReviewService(
        options.memoryReviews,
        options.upstream,
        options.config.server.upstreamTimeoutMs,
      )
    : undefined;
  const memoryGovernance = options.memoryGovernance
    ? new MemoryGovernanceService(
        options.memoryGovernance,
        options.upstream,
        options.config.server.upstreamTimeoutMs,
        randomId,
      )
    : undefined;
  const recordAudit = (input: {
    action: AuditAction;
    outcome?: "success" | "failure";
    subject?: { level: "L0" | "L1" | "L2" | "L3"; memoryId: string };
    details?: Record<string, string | number | boolean | string[] | number[]>;
    dedupe?: boolean;
  }): void => {
    options.audit?.record(input);
  };
  let businessRateLimit = { windowStart: 0, count: 0 };
  let failedAuthRateLimit = { windowStart: 0, count: 0 };

  const logRoute = (method: string, requestPath: string): string => {
    const key = `${method.toUpperCase()} ${requestPath}`;
    const known = new Set([
      "GET /health",
      "GET /version",
      "GET /api/v1/config/status",
      "GET /api/v1/mcp/status",
      "POST /api/v1/session",
      "DELETE /api/v1/session",
      ...proxyRoutes.map((route) => `POST ${route.route}`),
      "POST /api/v1/conversations/capture",
      "POST /api/v1/conversations/imports",
      "GET /api/v1/conversations/imports/:id",
      "POST /api/v1/conversations/imports/:id/retry",
      "POST /api/v1/conversations/imports/:id/cancel",
      "POST /api/v1/recall/query",
      "POST /api/v1/hooks/recall",
      "POST /api/v1/hooks/capture",
      "GET /api/v1/hooks/authorization",
      "POST /api/v1/hooks/authorization",
      "DELETE /api/v1/hooks/authorization",
      "GET /api/v1/capture-policy",
      "GET /api/v1/capture-policy/history",
      "PUT /api/v1/capture-policy",
      "GET /api/v1/memories",
      "GET /api/v1/memory",
      "GET /api/v1/audit",
      "POST /api/v1/memory-reviews",
      "GET /api/v1/memories/:level/:id/governance",
      "POST /api/v1/memories/:level/:id/validity",
      "POST /api/v1/memory-relations",
      "POST /api/v1/memory-relations/:id/revoke",
      "POST /api/v1/memories/:level/:id/update",
      "POST /api/v1/memories/:level/:id/invalidate",
      "POST /api/v1/memories/:level/:id/delete",
      "POST /api/v1/privacy-deletions/preview",
      "POST /api/v1/privacy-deletions/handoffs",
      "GET /api/v1/privacy-deletions/handoffs/:handoff",
      "POST /api/v1/privacy-deletions/:token/cancel",
      "POST /api/v1/privacy-deletions/:token/execute",
    ]);
    return known.has(key) ? key : "<unmatched>";
  };

  const incrementWindow = (current: {
    windowStart: number;
    count: number;
  }): { windowStart: number; count: number } => {
    const windowStart = Math.floor(now() / 60_000) * 60_000;
    return current.windowStart === windowStart
      ? { windowStart, count: current.count + 1 }
      : { windowStart, count: 1 };
  };

  const enforceBusinessRateLimit = (): void => {
    businessRateLimit = incrementWindow(businessRateLimit);
    if (businessRateLimit.count > options.config.server.rateLimitPerMinute) {
      throw new GatewayHttpError(
        429,
        "RATE_LIMITED",
        "Too many requests",
        undefined,
        { "retry-after": "60" },
      );
    }
  };

  const enforceFailedAuthRateLimit = (): void => {
    failedAuthRateLimit = incrementWindow(failedAuthRateLimit);
    if (failedAuthRateLimit.count > MAX_FAILED_AUTH_ATTEMPTS_PER_MINUTE) {
      throw new GatewayHttpError(
        429,
        "AUTH_RATE_LIMITED",
        "Too many failed authentication attempts",
        undefined,
        { "retry-after": "60" },
      );
    }
  };

  const errorResponse = (
    requestId: string,
    status: number,
    code: string,
    message: string,
  ): Response =>
    jsonResponse(
      { error: { code, message, requestId } } satisfies GatewayErrorEnvelope,
      status,
      { "x-request-id": requestId },
    );

  app.onError((error, context) => {
    const normalized =
      error instanceof GatewayHttpError
        ? error
        : new GatewayHttpError(500, "INTERNAL_ERROR", "Internal server error", {
            cause: error,
          });
    const requestId = context.get("requestId") ?? randomId();
    const headers: Record<string, string> = { "x-request-id": requestId };
    const origin = context.req.header("origin");
    if (origin && options.config.server.corsOrigins.includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-credentials"] = "true";
      headers.vary = "Origin";
    }
    for (const [name, value] of Object.entries(normalized.headers ?? {})) {
      headers[name] = value;
    }
    return jsonResponse(
      {
        error: {
          code: normalized.code,
          message: normalized.message,
          requestId,
        },
      } satisfies GatewayErrorEnvelope,
      normalized.status,
      headers,
    );
  });

  app.use("*", async (context, next) => {
    const startedAt = now();
    const requestId = randomId();
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);
    context.header("cache-control", "no-store");
    context.header("x-content-type-options", "nosniff");
    context.header("x-frame-options", "DENY");
    context.header("referrer-policy", "no-referrer");
    try {
      await next();
      const event: GatewayLogEvent = {
        event:
          context.res.status >= 400 ? "request.failed" : "request.completed",
        requestId,
        method: context.req.method,
        path: logRoute(context.req.method, context.req.path),
        status: context.res.status,
        durationMs: Math.max(0, now() - startedAt),
      };
      if (context.res.status >= 400) logger.error(event);
      else logger.info(event);
    } catch (error) {
      const normalized =
        error instanceof GatewayHttpError
          ? error
          : new GatewayHttpError(
              500,
              "INTERNAL_ERROR",
              "Internal server error",
              {
                cause: error,
              },
            );
      logger.error({
        event: "request.failed",
        requestId,
        method: context.req.method,
        path: logRoute(context.req.method, context.req.path),
        status: normalized.status,
        durationMs: Math.max(0, now() - startedAt),
        code: normalized.code,
      });
      context.res = errorResponse(
        requestId,
        normalized.status,
        normalized.code,
        normalized.message,
      );
    }
  });

  app.use("/api/*", async (context, next) => {
    const origin = context.req.header("origin");
    if (origin) {
      let normalizedOrigin: string;
      try {
        normalizedOrigin = new URL(origin).origin;
      } catch {
        throw new GatewayHttpError(
          403,
          "ORIGIN_DENIED",
          "Browser origin is not allowed",
        );
      }
      if (
        origin !== normalizedOrigin ||
        !options.config.server.corsOrigins.includes(normalizedOrigin)
      ) {
        throw new GatewayHttpError(
          403,
          "ORIGIN_DENIED",
          "Browser origin is not allowed",
        );
      }
      context.header("access-control-allow-origin", normalizedOrigin);
      context.header("vary", "Origin");
      context.header("access-control-allow-credentials", "true");
      if (context.req.method === "OPTIONS") {
        context.header(
          "access-control-allow-methods",
          "GET, POST, PUT, DELETE, OPTIONS",
        );
        context.header(
          "access-control-allow-headers",
          "Authorization, Content-Type, X-CSRF-Token, X-Request-ID",
        );
        context.res = new Response(null, {
          status: 204,
          headers: context.res.headers,
        });
        return;
      }
    } else if (context.req.method === "OPTIONS") {
      throw new GatewayHttpError(
        403,
        "ORIGIN_DENIED",
        "CORS preflight requires an allowed origin",
      );
    }
    await next();
  });

  app.get("/health", (context) =>
    context.json({ status: "ok", service: "personalmemory-gateway" }),
  );
  app.get("/version", (context) =>
    context.json({
      apiVersion: API_VERSION,
      schemaVersion: PERSONAL_MEMORY_SCHEMA_VERSION,
    }),
  );
  app.get("/api/v1/config/status", (context) => {
    const disclosure = getModelOutboundDisclosure(options.config);
    return context.json({
      authenticationConfigured:
        options.config.server.authenticationEnabled &&
        !!options.config.server.authenticationToken,
      modelConfigured: options.config.model.enabled,
      modelOutboundDisclosure: disclosure,
    });
  });
  app.get("/api/v1/mcp/status", (context) => {
    authenticateMemoryRequest(context, false);
    return context.json({ status: "ready", api_version: API_VERSION });
  });

  const requireHookAuthorizations = () => {
    if (!options.hookAuthorizations) {
      throw new GatewayHttpError(
        503,
        "HOOK_AUTHORIZATION_UNAVAILABLE",
        "Hook authorization storage is unavailable",
      );
    }
    return options.hookAuthorizations;
  };

  app.get("/api/v1/hooks/authorization", (context) => {
    authenticateMemoryRequest(context, false);
    return context.json({
      disclosure: HOOK_AUTHORIZATION_DISCLOSURE,
      authorization: hookAuthorizationResponse(
        requireHookAuthorizations().status(),
      ),
    });
  });

  app.post("/api/v1/hooks/authorization", async (context) => {
    authenticateMemoryRequest(context);
    const parsed = hookAuthorizationUpdateSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Request body does not match the Hook authorization contract",
      );
    }
    try {
      const status = requireHookAuthorizations().update({
        expectedRevision: parsed.data.expected_authorization_revision,
        recallEnabled: parsed.data.recall_enabled,
        captureEnabled: parsed.data.capture_enabled,
      });
      return context.json({ authorization: hookAuthorizationResponse(status) });
    } catch (error) {
      if (error instanceof HookAuthorizationConflictError) {
        throw new GatewayHttpError(
          409,
          "HOOK_AUTHORIZATION_CHANGED",
          error.message,
        );
      }
      throw error;
    }
  });

  app.delete("/api/v1/hooks/authorization", async (context) => {
    authenticateMemoryRequest(context);
    const parsed = hookAuthorizationRevokeSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Request body does not match the Hook authorization contract",
      );
    }
    try {
      const status = requireHookAuthorizations().update({
        expectedRevision: parsed.data.expected_authorization_revision,
        recallEnabled: false,
        captureEnabled: false,
      });
      return context.json({ authorization: hookAuthorizationResponse(status) });
    } catch (error) {
      if (error instanceof HookAuthorizationConflictError) {
        throw new GatewayHttpError(
          409,
          "HOOK_AUTHORIZATION_CHANGED",
          error.message,
        );
      }
      throw error;
    }
  });

  const requireCapturePolicies = () => {
    if (!options.capturePolicies)
      throw new GatewayHttpError(
        503,
        "CAPTURE_POLICY_UNAVAILABLE",
        "Capture policy storage is unavailable",
      );
    return options.capturePolicies;
  };

  app.get("/api/v1/capture-policy", (context) => {
    authenticateMemoryRequest(context, false);
    return context.json({
      policy: capturePolicyResponse(requireCapturePolicies().status()),
    });
  });

  app.get("/api/v1/capture-policy/history", (context) => {
    authenticateMemoryRequest(context, false);
    const query = capturePolicyHistoryQuerySchema.safeParse(
      context.req.query(),
    );
    if (!query.success)
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Query does not match the capture policy history contract",
      );
    return context.json({
      policies: requireCapturePolicies()
        .history({
          limit: query.data.limit,
          ...(query.data.before_revision === undefined
            ? {}
            : { beforeRevision: query.data.before_revision }),
        })
        .map(capturePolicyResponse),
    });
  });

  app.put("/api/v1/capture-policy", async (context) => {
    authenticateMemoryRequest(context);
    const parsed = capturePolicyUpdateSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success)
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Request body does not match the capture policy contract",
      );
    const authorizations = requireHookAuthorizations();
    if (
      authorizations.status().policyRevision !==
      parsed.data.expected_policy_revision
    ) {
      throw new GatewayHttpError(
        409,
        "CAPTURE_POLICY_CHANGED",
        "Capture policy changed; reload it before updating",
      );
    }
    try {
      const result = authorizations.advancePolicyRevision(
        parsed.data.expected_policy_revision,
        parsed.data.expected_policy_revision + 1,
        () =>
          requireCapturePolicies().update({
            expectedRevision: parsed.data.expected_policy_revision,
            captureEnabled: parsed.data.capture_enabled,
            excludedClients: [...new Set(parsed.data.excluded_clients)].sort(),
            excludedWorkingDirectories: [
              ...new Set(parsed.data.excluded_working_directories),
            ].sort(),
            excludedSources: [...new Set(parsed.data.excluded_sources)],
            sensitiveCategories: [
              ...new Set(parsed.data.sensitive_categories),
            ].sort(),
            l0RetentionDays: parsed.data.l0_retention_days,
            l1RetentionDays: parsed.data.l1_retention_days,
          }),
      );
      return context.json({
        policy: capturePolicyResponse(result.policy),
        authorization: hookAuthorizationResponse(result.authorization),
      });
    } catch (error) {
      if (
        error instanceof CapturePolicyConflictError ||
        error instanceof HookAuthorizationConflictError
      ) {
        throw new GatewayHttpError(
          409,
          "CAPTURE_POLICY_CHANGED",
          error.message,
        );
      }
      throw error;
    }
  });

  const requireBearer = (authorization: string | undefined): void => {
    if (
      !options.config.server.authenticationEnabled ||
      !options.config.server.authenticationToken
    ) {
      throw new GatewayHttpError(
        503,
        "AUTH_SETUP_REQUIRED",
        "Authentication must be configured before memory access is enabled",
      );
    }
    const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
    if (
      !match?.[1] ||
      !safeEqual(match[1], options.config.server.authenticationToken.reveal())
    ) {
      enforceFailedAuthRateLimit();
      throw new GatewayHttpError(
        401,
        "UNAUTHORIZED",
        "Authentication required",
      );
    }
  };

  app.post("/api/v1/session", (context) => {
    if (!LOOPBACK_HOSTS.has(options.config.server.host.toLowerCase())) {
      throw new GatewayHttpError(
        403,
        "BROWSER_SESSION_LOOPBACK_ONLY",
        "Browser sessions are only available on loopback",
      );
    }
    requireBearer(context.req.header("authorization"));
    enforceBusinessRateLimit();
    for (const [sessionId, session] of sessions) {
      if (session.expiresAt <= now()) sessions.delete(sessionId);
    }
    if (sessions.size >= MAX_BROWSER_SESSIONS) {
      throw new GatewayHttpError(
        429,
        "SESSION_LIMIT_REACHED",
        "Too many active browser sessions",
      );
    }
    const sessionId = randomId();
    const csrfToken = randomId();
    sessions.set(sessionId, {
      csrfToken,
      expiresAt: now() + options.config.server.sessionTtlSeconds * 1_000,
    });
    setCookie(context, SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "Strict",
      secure: false,
      path: "/api/",
      maxAge: options.config.server.sessionTtlSeconds,
    });
    return context.json({
      csrfToken,
      expiresIn: options.config.server.sessionTtlSeconds,
    });
  });

  app.delete("/api/v1/session", (context) => {
    const sessionId = getCookie(context, SESSION_COOKIE);
    if (sessionId) sessions.delete(sessionId);
    deleteCookie(context, SESSION_COOKIE, { path: "/api/" });
    return new Response(null, { status: 204 });
  });

  const authenticateMemoryRequest = (
    context: Context<GatewayEnv>,
    requireCsrf = true,
  ): void => {
    if (
      !options.config.server.authenticationEnabled ||
      !options.config.server.authenticationToken
    ) {
      requireBearer(undefined);
    }
    const authorization = context.req.header("authorization");
    if (authorization) {
      requireBearer(authorization);
      enforceBusinessRateLimit();
      return;
    }
    const sessionId = getCookie(context, SESSION_COOKIE);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session || session.expiresAt <= now()) {
      if (sessionId) sessions.delete(sessionId);
      enforceFailedAuthRateLimit();
      throw new GatewayHttpError(
        401,
        "UNAUTHORIZED",
        "Authentication required",
      );
    }
    const csrfToken = context.req.header("x-csrf-token");
    if (
      requireCsrf &&
      (!csrfToken || !safeEqual(csrfToken, session.csrfToken))
    ) {
      enforceFailedAuthRateLimit();
      throw new GatewayHttpError(
        403,
        "CSRF_DENIED",
        "A valid CSRF token is required",
      );
    }
    enforceBusinessRateLimit();
  };

  const requireImportManager = () => {
    if (!options.importManager) {
      throw new GatewayHttpError(
        503,
        "IMPORT_UNAVAILABLE",
        "Conversation import is not available",
      );
    }
    return options.importManager;
  };

  const requireModelDisclosure = () => {
    const disclosure = getModelOutboundDisclosure(options.config);
    if (!disclosure) {
      throw new GatewayHttpError(
        409,
        "MODEL_CONFIG_REQUIRED",
        "Configure a model provider before authorizing outbound access",
      );
    }
    if (!options.modelAuthorizations) {
      throw new GatewayHttpError(
        503,
        "MODEL_AUTHORIZATION_UNAVAILABLE",
        "Model authorization storage is unavailable",
      );
    }
    return { disclosure, ledger: options.modelAuthorizations };
  };

  app.get("/api/v1/model/authorization", (context) => {
    authenticateMemoryRequest(context, false);
    const { disclosure, ledger } = requireModelDisclosure();
    return context.json({
      disclosure,
      authorization: ledger.status(disclosure),
      restart_required: false,
    });
  });

  app.post("/api/v1/model/authorization", async (context) => {
    authenticateMemoryRequest(context);
    const input = await readLimitedJson(
      context.req.raw,
      options.config.server.requestBodyLimitBytes,
    );
    const parsed = modelDisclosureSchema.safeParse(input);
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Request body does not match the model disclosure contract",
      );
    }
    const { disclosure, ledger } = requireModelDisclosure();
    if (
      parsed.data.version !== disclosure.version ||
      parsed.data.provider !== disclosure.provider ||
      new URL(parsed.data.targetOrigin).origin !== disclosure.targetOrigin ||
      parsed.data.sentFields.length !== disclosure.sentFields.length ||
      parsed.data.sentFields.some(
        (field, index) => field !== disclosure.sentFields[index],
      )
    ) {
      throw new GatewayHttpError(
        409,
        "MODEL_DISCLOSURE_CHANGED",
        "Model disclosure changed; reload it before authorizing",
      );
    }
    return context.json({
      authorization: ledger.authorize(disclosure),
      restart_required: true,
    });
  });

  app.delete("/api/v1/model/authorization", (context) => {
    authenticateMemoryRequest(context);
    const { disclosure, ledger } = requireModelDisclosure();
    return context.json({
      authorization: ledger.revoke(disclosure),
      restart_required: true,
    });
  });

  const submitImport = async (
    context: Context<GatewayEnv>,
    schema: typeof singleImportSchema | typeof batchImportSchema,
  ): Promise<Response> => {
    authenticateMemoryRequest(context);
    const input = await readLimitedJson(
      context.req.raw,
      options.config.server.requestBodyLimitBytes,
    );
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Request body does not match the import contract",
      );
    }
    const sessions =
      "session" in parsed.data ? [parsed.data.session] : parsed.data.sessions;
    const disclosure = getModelOutboundDisclosure(options.config);
    if (
      disclosure &&
      options.modelAuthorizations?.status(disclosure).status !== "authorized"
    ) {
      throw new GatewayHttpError(
        409,
        "MODEL_OUTBOUND_CONSENT_REQUIRED",
        `Authorize model outbound fields (${disclosure.sentFields.join(", ")}) to ${disclosure.provider} at ${disclosure.targetOrigin}`,
      );
    }
    try {
      const result = requireImportManager().submit({
        idempotencyKey: parsed.data.idempotency_key,
        rounds: toImportRounds(sessions),
      });
      return jsonResponse(
        importJobResponse(result.job),
        result.created ? 202 : 200,
      );
    } catch (error) {
      if (error instanceof ImportIdempotencyConflictError) {
        throw new GatewayHttpError(409, "IDEMPOTENCY_CONFLICT", error.message);
      }
      throw error;
    }
  };

  app.post("/api/v1/conversations/capture", (context) =>
    submitImport(context, singleImportSchema),
  );
  app.post("/api/v1/conversations/imports", (context) =>
    submitImport(context, batchImportSchema),
  );
  app.get("/api/v1/conversations/imports/:id", (context) => {
    authenticateMemoryRequest(context, false);
    const job = requireImportManager().get(context.req.param("id"));
    if (!job)
      throw new GatewayHttpError(404, "IMPORT_NOT_FOUND", "Import not found");
    return jsonResponse(importJobResponse(job), 200);
  });
  app.post("/api/v1/conversations/imports/:id/retry", (context) => {
    authenticateMemoryRequest(context);
    const manager = requireImportManager();
    const current = manager.get(context.req.param("id"));
    if (!current)
      throw new GatewayHttpError(404, "IMPORT_NOT_FOUND", "Import not found");
    if (!["failed", "partial", "cancelled"].includes(current.status)) {
      throw new GatewayHttpError(
        409,
        "IMPORT_NOT_RETRYABLE",
        "Import is not retryable",
      );
    }
    const job = manager.retry(current.id)!;
    return jsonResponse(importJobResponse(job), 202);
  });
  app.post("/api/v1/conversations/imports/:id/cancel", (context) => {
    authenticateMemoryRequest(context);
    const manager = requireImportManager();
    const current = manager.get(context.req.param("id"));
    if (!current)
      throw new GatewayHttpError(404, "IMPORT_NOT_FOUND", "Import not found");
    if (!["pending", "running"].includes(current.status)) {
      throw new GatewayHttpError(
        409,
        "IMPORT_NOT_CANCELLABLE",
        "Import is not active",
      );
    }
    const job = manager.cancel(current.id)!;
    return jsonResponse(importJobResponse(job), 202);
  });

  app.post("/api/v1/recall/query", async (context) => {
    authenticateMemoryRequest(context);
    const input = await readLimitedJson(
      context.req.raw,
      options.config.server.requestBodyLimitBytes,
    );
    const parsed = unifiedRecallRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Request body does not match the recall contract",
      );
    }
    const result = await recallService.recall(
      parsed.data,
      context.get("requestId"),
    );
    for (const item of result.items) {
      recordAudit({
        action: "memory.recalled",
        subject: { level: item.level, memoryId: item.id },
        details: { result_count: result.items.length },
      });
    }
    return jsonResponse(
      {
        items: result.items.map((item) => ({
          id: item.id,
          level: item.level,
          content: item.content,
          ...(item.score === undefined ? {} : { score: item.score }),
          ...(item.source === undefined ? {} : { source: item.source }),
          ...(item.sourceMessageIds === undefined
            ? {}
            : { source_reference_count: item.sourceMessageIds.length }),
          ...(item.level === "L1" && options.memoryReviews
            ? {
                review: {
                  status: options.memoryReviews.get("L1", item.id).status,
                  revision: options.memoryReviews.get("L1", item.id).revision,
                },
              }
            : {}),
          ...(item.createdAt === undefined
            ? {}
            : { created_at: item.createdAt }),
          ...(item.updatedAt === undefined
            ? {}
            : { updated_at: item.updatedAt }),
          truncated: item.truncated,
        })),
        degraded_levels: result.degradedLevels.map((entry) => ({
          level: entry.level,
          code: entry.code,
        })),
        page: {
          offset: result.page.offset,
          count: result.page.count,
          has_more: result.page.hasMore,
        },
        budget: {
          max_items: result.budget.maxItems,
          max_chars: result.budget.maxChars,
          max_tokens: result.budget.maxTokens,
          used_items: result.budget.usedItems,
          used_chars: result.budget.usedChars,
          estimated_tokens: result.budget.estimatedTokens,
          exhausted: result.budget.exhausted,
        },
      },
      200,
    );
  });

  const requireHookLifecycle = (): HookLifecycleService => {
    if (!hookLifecycle) {
      throw new GatewayHttpError(
        503,
        "HOOK_LIFECYCLE_UNAVAILABLE",
        "Automatic memory hooks are not configured",
      );
    }
    return hookLifecycle;
  };

  app.post("/api/v1/hooks/recall", async (context) => {
    authenticateMemoryRequest(context);
    const parsed = hookRecallRequestSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_HOOK_REQUEST",
        "Hook recall request is invalid",
      );
    }
    const hookStartedAt = now();
    const response = await requireHookLifecycle().recall(
      parsed.data,
      context.get("requestId"),
    );
    logger.info({
      event: "hook.lifecycle",
      requestId: context.get("requestId"),
      method: "POST",
      path: "POST /api/v1/hooks/recall",
      status: 200,
      durationMs: Math.max(0, now() - hookStartedAt),
      operation: "recall",
      client: parsed.data.event.client,
      outcome: response.outcome,
      itemCount: response.item_count,
      usedChars: response.used_chars,
      estimatedTokens: response.estimated_tokens,
    });
    return jsonResponse(hookRecallResponseSchema.parse(response), 200);
  });

  app.post("/api/v1/hooks/capture", async (context) => {
    authenticateMemoryRequest(context);
    const parsed = hookCaptureRequestSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_HOOK_REQUEST",
        "Hook capture request is invalid",
      );
    }
    const hookStartedAt = now();
    try {
      const response = await requireHookLifecycle().capture(
        parsed.data,
        context.get("requestId"),
      );
      const event: GatewayLogEvent = {
        event: "hook.lifecycle",
        requestId: context.get("requestId"),
        method: "POST",
        path: "POST /api/v1/hooks/capture",
        status: 200,
        durationMs: Math.max(0, now() - hookStartedAt),
        operation: "capture",
        client: parsed.data.event.client,
        outcome: response.outcome,
        idempotencyRef: createHash("sha256")
          .update(parsed.data.idempotency_key)
          .digest("hex")
          .slice(0, 16),
      };
      if (response.outcome === "conflict") logger.error(event);
      else logger.info(event);
      return jsonResponse(hookCaptureResponseSchema.parse(response), 200);
    } catch (error) {
      if (error instanceof HookLifecycleCaptureError) {
        logger.error({
          event: "hook.lifecycle",
          requestId: context.get("requestId"),
          method: "POST",
          path: "POST /api/v1/hooks/capture",
          status: 503,
          durationMs: Math.max(0, now() - hookStartedAt),
          operation: "capture",
          client: parsed.data.event.client,
          outcome: "unavailable",
          idempotencyRef: createHash("sha256")
            .update(parsed.data.idempotency_key)
            .digest("hex")
            .slice(0, 16),
        });
        throw new GatewayHttpError(
          503,
          "HOOK_CAPTURE_UNAVAILABLE",
          "Hook capture could not be persisted locally",
        );
      }
      throw error;
    }
  });

  app.get("/api/v1/memories", async (context) => {
    authenticateMemoryRequest(context, false);
    const parsed = memoryBrowseQuerySchema.safeParse(context.req.query());
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Query parameters do not match the memory browsing contract",
      );
    }
    const result = await memoryBrowser.browse(
      parsed.data,
      context.get("requestId"),
    );
    for (const item of result.items) {
      if (item.level !== "L0") {
        recordAudit({
          action: "memory.generated",
          subject: { level: item.level, memoryId: item.id },
          details: { scope: "first_observed" },
          dedupe: true,
        });
      }
    }
    return jsonResponse(
      {
        items: result.items.map((item) => ({
          id: item.id,
          level: item.level,
          title: item.title,
          content: item.content,
          ...(item.updatedAt ? { updated_at: item.updatedAt } : {}),
          ...(item.score === undefined ? {} : { score: item.score }),
          state: item.state,
          source: item.source,
          ...(item.review ? { review: item.review } : {}),
          ...(item.governance ? { governance: item.governance } : {}),
        })),
        page: result.page,
        page_size: result.pageSize,
        total: result.total,
        has_previous: result.hasPrevious,
        has_next: result.hasNext,
      },
      200,
    );
  });

  app.get("/api/v1/memory", async (context) => {
    authenticateMemoryRequest(context, false);
    const level = editableMemoryLevelSchema
      .or(z.enum(["L0"]))
      .safeParse(context.req.query("level"));
    const id = context.req.query("id");
    if (!level.success || !id || id.length > 2_048) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Memory identifier is invalid",
      );
    }
    const memory = await memoryBrowser.readExact(
      level.data,
      id,
      context.get("requestId"),
    );
    if (!memory) {
      throw new GatewayHttpError(
        404,
        "MEMORY_NOT_FOUND",
        "Memory was not found",
      );
    }
    return jsonResponse(
      {
        id: memory.id,
        level: memory.level,
        content: memory.content,
        ...(memory.score === undefined ? {} : { score: memory.score }),
        source: {
          status: memory.source.status,
          reference_count: memory.source.referenceCount ?? 0,
          ...(memory.source.messageIds
            ? { message_ids: memory.source.messageIds.slice(0, 20) }
            : {}),
          references_truncated: (memory.source.messageIds?.length ?? 0) > 20,
        },
        ...(memory.review ? { review: memory.review } : {}),
      },
      200,
    );
  });

  app.get("/api/v1/audit", (context) => {
    authenticateMemoryRequest(context, false);
    if (!options.audit) {
      throw new GatewayHttpError(
        503,
        "AUDIT_UNAVAILABLE",
        "Audit timeline is not available",
      );
    }
    const parsed = auditQuerySchema.safeParse(context.req.query());
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Audit query parameters are invalid",
      );
    }
    const result = options.audit.query({
      ...(parsed.data.action ? { action: parsed.data.action } : {}),
      ...(parsed.data.level ? { level: parsed.data.level } : {}),
      ...(parsed.data.memory_id ? { memoryId: parsed.data.memory_id } : {}),
      ...(parsed.data.before_sequence
        ? { beforeSequence: parsed.data.before_sequence }
        : {}),
      limit: parsed.data.limit,
    });
    return jsonResponse(
      {
        events: result.events.map((event) => ({
          sequence: event.sequence,
          event_id: event.eventId,
          action: event.action,
          outcome: event.outcome,
          ...(event.subject ? { subject: event.subject } : {}),
          details: event.details,
          occurred_at: event.occurredAt,
        })),
        ...(result.nextBeforeSequence
          ? { next_before_sequence: result.nextBeforeSequence }
          : {}),
      },
      200,
    );
  });

  app.post("/api/v1/memory-reviews", async (context) => {
    authenticateMemoryRequest(context);
    if (!memoryReviews) {
      throw new GatewayHttpError(
        503,
        "MEMORY_REVIEW_UNAVAILABLE",
        "Memory review state is not available",
      );
    }
    const parsed = memoryReviewBatchSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Memory review request is invalid",
      );
    }
    const results = await memoryReviews.applyBatch(
      parsed.data.items,
      context.get("requestId"),
    );
    for (const result of results) {
      recordAudit({
        action: "memory.reviewed",
        outcome: result.ok ? "success" : "failure",
        subject: { level: "L1", memoryId: result.id },
        details: {
          status: result.ok ? result.review!.status : result.code!,
          ...(result.ok &&
          parsed.data.items.find(({ id }) => id === result.id)?.content
            ? { changed_content: true }
            : {}),
        },
      });
    }
    return jsonResponse(
      { results },
      results.every((result) => result.ok) ? 200 : 207,
    );
  });

  const requireMemoryGovernance = (): MemoryGovernanceService => {
    if (!memoryGovernance) {
      throw new GatewayHttpError(
        503,
        "MEMORY_GOVERNANCE_UNAVAILABLE",
        "Memory governance state is not available",
      );
    }
    return memoryGovernance;
  };

  const translateGovernanceError = (error: unknown): never => {
    if (error instanceof MemoryGovernanceServiceError) {
      const definitions = {
        CONFLICT: [
          409,
          "MEMORY_GOVERNANCE_CONFLICT",
          "Governance state changed; reload and retry",
        ],
        CYCLE: [
          409,
          "MEMORY_RELATION_CYCLE",
          "The relation would create a supersedes cycle",
        ],
        UPSTREAM_REJECTED: [
          502,
          "UPSTREAM_REJECTED",
          "The local memory kernel rejected merged content",
        ],
      } as const;
      const [status, code, message] = definitions[error.code];
      throw new GatewayHttpError(status, code, message);
    }
    throw error;
  };

  app.get("/api/v1/memories/:level/:id/governance", (context) => {
    authenticateMemoryRequest(context, false);
    const target = mutationTarget(context);
    return jsonResponse(
      requireMemoryGovernance().get(target.level, target.id),
      200,
    );
  });

  app.post("/api/v1/memories/:level/:id/validity", async (context) => {
    authenticateMemoryRequest(context);
    const target = mutationTarget(context);
    const parsed = memoryValiditySchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success) {
      throw new GatewayHttpError(400, "INVALID_REQUEST", "Validity is invalid");
    }
    let validity;
    try {
      validity = requireMemoryGovernance().setValidity(
        target.level,
        target.id,
        parsed.data,
      );
    } catch (error) {
      recordAudit({
        action: "memory.validity_updated",
        outcome: "failure",
        subject: { level: target.level, memoryId: target.id },
        details: { status: "failed" },
      });
      return translateGovernanceError(error);
    }
    recordAudit({
      action: "memory.validity_updated",
      subject: { level: target.level, memoryId: target.id },
      details: { status: "updated" },
    });
    return jsonResponse({ validity }, 200);
  });

  app.post("/api/v1/memory-relations", async (context) => {
    authenticateMemoryRequest(context);
    const parsed = memoryRelationSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success) {
      throw new GatewayHttpError(400, "INVALID_REQUEST", "Relation is invalid");
    }
    let relation;
    try {
      relation = await requireMemoryGovernance().addRelation(
        parsed.data,
        context.get("requestId"),
      );
    } catch (error) {
      for (const memoryId of [parsed.data.source_id, parsed.data.target_id]) {
        recordAudit({
          action: "memory.relation_created",
          outcome: "failure",
          subject: { level: parsed.data.level, memoryId },
          details: { kind: parsed.data.kind },
        });
      }
      return translateGovernanceError(error);
    }
    for (const memoryId of [relation.sourceMemoryId, relation.targetMemoryId]) {
      recordAudit({
        action: "memory.relation_created",
        subject: { level: relation.level, memoryId },
        details: { kind: relation.kind },
      });
    }
    return jsonResponse({ relation }, 200);
  });

  app.post("/api/v1/memory-relations/:id/revoke", async (context) => {
    authenticateMemoryRequest(context);
    const id = context.req.param("id");
    const parsed = relationRevokeSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!id || id.length > 2_048 || !parsed.success) {
      throw new GatewayHttpError(400, "INVALID_REQUEST", "Revoke is invalid");
    }
    let relation;
    try {
      relation = requireMemoryGovernance().revoke(
        id,
        parsed.data.expected_revision,
      );
    } catch (error) {
      recordAudit({
        action: "memory.relation_revoked",
        outcome: "failure",
        details: { status: "failed" },
      });
      return translateGovernanceError(error);
    }
    for (const memoryId of [relation.sourceMemoryId, relation.targetMemoryId]) {
      recordAudit({
        action: "memory.relation_revoked",
        subject: { level: relation.level, memoryId },
        details: { kind: relation.kind },
      });
    }
    return jsonResponse({ relation }, 200);
  });

  const requireMemoryMutations = (): MemoryMutationService => {
    if (!memoryMutations) {
      throw new GatewayHttpError(
        503,
        "MEMORY_MUTATION_UNAVAILABLE",
        "Memory mutation state is not available",
      );
    }
    return memoryMutations;
  };

  const mutationTarget = (context: Context<GatewayEnv>) => {
    const level = editableMemoryLevelSchema.safeParse(
      context.req.param("level"),
    );
    const id = context.req.param("id");
    if (!level.success || !id || id.length > 1_024) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Memory target is invalid",
      );
    }
    return { level: level.data, id };
  };

  const translateMutationError = (error: unknown): never => {
    if (error instanceof MemoryMutationError) {
      const definitions = {
        CONFLICT: [409, "MEMORY_CONFLICT", "Memory changed; reload and retry"],
        INVALIDATED_MEMORY: [
          409,
          "MEMORY_INVALIDATED",
          "Invalidated memories cannot be edited without an explicit restore",
        ],
        DELETED_MEMORY: [
          409,
          "MEMORY_DELETED",
          "Deleted memories cannot be restored in M2",
        ],
        CONFIRMATION_MISMATCH: [
          400,
          "CONFIRMATION_MISMATCH",
          "Deletion confirmation does not match the target",
        ],
        UPSTREAM_REJECTED: [
          502,
          "UPSTREAM_REJECTED",
          "The local memory kernel rejected the operation",
        ],
      } as const;
      const [status, code, message] = definitions[error.code];
      throw new GatewayHttpError(status, code, message);
    }
    throw error;
  };

  app.post("/api/v1/memories/:level/:id/update", async (context) => {
    authenticateMemoryRequest(context);
    const target = mutationTarget(context);
    const parsed = memoryUpdateSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success) {
      throw new GatewayHttpError(400, "INVALID_REQUEST", "Update is invalid");
    }
    let state;
    try {
      state = await requireMemoryMutations().update(
        target.level,
        target.id,
        parsed.data.content,
        parsed.data.expected_revision,
        context.get("requestId"),
      );
    } catch (error) {
      recordAudit({
        action: "memory.updated",
        outcome: "failure",
        subject: { level: target.level, memoryId: target.id },
        details: { status: "failed" },
      });
      return translateMutationError(error);
    }
    recordAudit({
      action: "memory.updated",
      subject: { level: target.level, memoryId: target.id },
      details: { changed_content: true },
    });
    return jsonResponse({ state }, 200);
  });

  app.post("/api/v1/memories/:level/:id/invalidate", async (context) => {
    authenticateMemoryRequest(context);
    const target = mutationTarget(context);
    const parsed = memoryInvalidateSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Invalidation is invalid",
      );
    }
    let state;
    try {
      state = await requireMemoryMutations().invalidate(
        target.level,
        target.id,
        parsed.data.reason,
        parsed.data.expected_revision,
      );
    } catch (error) {
      recordAudit({
        action: "memory.invalidated",
        outcome: "failure",
        subject: { level: target.level, memoryId: target.id },
        details: { status: "failed" },
      });
      return translateMutationError(error);
    }
    recordAudit({
      action: "memory.invalidated",
      subject: { level: target.level, memoryId: target.id },
      details: { status: "invalidated" },
    });
    return jsonResponse({ state }, 200);
  });

  app.post("/api/v1/memories/:level/:id/delete", async (context) => {
    authenticateMemoryRequest(context);
    const target = mutationTarget(context);
    if (target.level !== "L1") {
      throw new GatewayHttpError(
        400,
        "DELETE_SCOPE_UNSUPPORTED",
        "M2 controlled deletion only supports L1 memories",
      );
    }
    const parsed = memoryDeleteSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success) {
      throw new GatewayHttpError(400, "INVALID_REQUEST", "Deletion is invalid");
    }
    let result;
    try {
      result = await requireMemoryMutations().deleteL1(
        target.id,
        parsed.data.confirmation,
        parsed.data.reason,
        parsed.data.expected_revision,
        context.get("requestId"),
      );
    } catch (error) {
      recordAudit({
        action: "memory.deleted",
        outcome: "failure",
        subject: { level: target.level, memoryId: target.id },
        details: { status: "failed" },
      });
      return translateMutationError(error);
    }
    recordAudit({
      action: "memory.deleted",
      subject: { level: target.level, memoryId: target.id },
      details: { upstream_deleted: result.upstreamDeleted },
    });
    return jsonResponse(
      {
        state: result.state,
        upstream_deleted: result.upstreamDeleted,
        scope: {
          hidden_from_personalmemory: true,
          l1_index_delete_attempted: true,
          source_conversations_deleted: false,
          derived_profiles_deleted: false,
          exports_or_backups_deleted: false,
          complete_erasure: false,
        },
      },
      result.upstreamDeleted ? 200 : 202,
    );
  });

  const requirePrivacyDeletions = () => {
    if (!options.privacyDeletions) {
      throw new GatewayHttpError(
        503,
        "PRIVACY_DELETION_UNAVAILABLE",
        "Privacy deletion control is not available",
      );
    }
    return options.privacyDeletions;
  };

  const translatePrivacyDeletionError = (error: unknown): never => {
    if (error instanceof PrivacyDeletionError) {
      const definitions = {
        NOT_FOUND: [404, "MEMORY_NOT_FOUND", "Memory was not found"],
        PLAN_NOT_FOUND: [
          404,
          "DELETION_PLAN_NOT_FOUND",
          "Deletion plan was not found",
        ],
        PLAN_EXPIRED: [
          410,
          "DELETION_PLAN_EXPIRED",
          "Deletion plan expired; create a new preview",
        ],
        PLAN_LIMIT: [
          429,
          "DELETION_PLAN_LIMIT",
          "Too many deletion previews are active; cancel one and retry",
        ],
        PLAN_RUNNING: [
          409,
          "DELETION_PLAN_RUNNING",
          "Deletion is already running",
        ],
        CONFIRMATION_MISMATCH: [
          400,
          "CONFIRMATION_MISMATCH",
          "Deletion confirmation does not match the target",
        ],
        PLAN_STALE: [
          409,
          "DELETION_PLAN_STALE",
          "Memory changed after preview; create a new preview",
        ],
        UPSTREAM_REJECTED: [
          502,
          "UPSTREAM_REJECTED",
          "The local memory kernel rejected the operation",
        ],
      } as const;
      const [status, code, message] = definitions[error.code];
      throw new GatewayHttpError(status, code, message);
    }
    throw error;
  };

  app.post("/api/v1/privacy-deletions/preview", async (context) => {
    authenticateMemoryRequest(context);
    const parsed = privacyDeletionPreviewSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Privacy deletion preview is invalid",
      );
    }
    try {
      const preview = await requirePrivacyDeletions().preview(
        parsed.data.memory_id,
        context.get("requestId"),
      );
      return jsonResponse(preview, 200);
    } catch (error) {
      return translatePrivacyDeletionError(error);
    }
  });

  app.post("/api/v1/privacy-deletions/handoffs", async (context) => {
    authenticateMemoryRequest(context);
    const parsed = privacyDeletionPreviewSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Privacy deletion handoff is invalid",
      );
    }
    for (const [handoff, value] of mcpDeletionHandoffs) {
      if (value.expiresAt <= now()) mcpDeletionHandoffs.delete(handoff);
    }
    if (mcpDeletionHandoffs.size >= MAX_MCP_DELETION_HANDOFFS) {
      throw new GatewayHttpError(
        429,
        "DELETION_HANDOFF_LIMIT",
        "Too many deletion handoffs are active",
      );
    }
    try {
      const preview = await requirePrivacyDeletions().preview(
        parsed.data.memory_id,
        context.get("requestId"),
      );
      const handoff = randomId();
      const expiresAt = Date.parse(preview.expires_at);
      mcpDeletionHandoffs.set(handoff, { preview, expiresAt });
      return jsonResponse(
        {
          handoff_id: handoff,
          expires_at: preview.expires_at,
          scope: preview.scope,
          limitations: preview.limitations,
        },
        200,
      );
    } catch (error) {
      return translatePrivacyDeletionError(error);
    }
  });

  app.get("/api/v1/privacy-deletions/handoffs/:handoff", (context) => {
    if (context.req.header("authorization")) {
      throw new GatewayHttpError(
        403,
        "BROWSER_SESSION_REQUIRED",
        "Deletion handoff details are only available in PersonalMemory Web",
      );
    }
    authenticateMemoryRequest(context, false);
    const handoff = context.req.param("handoff");
    if (!handoff || handoff.length > 2_048) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Deletion handoff is invalid",
      );
    }
    const value = mcpDeletionHandoffs.get(handoff);
    if (!value || value.expiresAt <= now()) {
      mcpDeletionHandoffs.delete(handoff);
      throw new GatewayHttpError(
        410,
        "DELETION_HANDOFF_EXPIRED",
        "Deletion handoff expired; prepare a new preview",
      );
    }
    return jsonResponse(value.preview, 200);
  });

  app.post("/api/v1/privacy-deletions/:token/cancel", (context) => {
    authenticateMemoryRequest(context);
    const token = context.req.param("token");
    if (!token || token.length > 2_048) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Deletion plan token is invalid",
      );
    }
    try {
      requirePrivacyDeletions().cancel(token);
      return new Response(null, { status: 204 });
    } catch (error) {
      return translatePrivacyDeletionError(error);
    }
  });

  app.post("/api/v1/privacy-deletions/:token/execute", async (context) => {
    authenticateMemoryRequest(context);
    const token = context.req.param("token");
    if (!token || token.length > 2_048) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Deletion plan token is invalid",
      );
    }
    const parsed = privacyDeletionExecuteSchema.safeParse(
      await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      ),
    );
    if (!parsed.success) {
      throw new GatewayHttpError(
        400,
        "INVALID_REQUEST",
        "Privacy deletion confirmation is invalid",
      );
    }
    try {
      const result = await requirePrivacyDeletions().execute(
        token,
        parsed.data,
        context.get("requestId"),
      );
      recordAudit({
        action: "memory.deleted",
        outcome: result.status === "complete" ? "success" : "failure",
        subject: { level: "L1", memoryId: result.memory_id },
        details: {
          scope: "cascade",
          status: result.status,
          upstream_deleted: result.verification.l1_remaining === 0,
        },
      });
      return jsonResponse(result, result.status === "complete" ? 200 : 207);
    } catch (error) {
      if (error instanceof PrivacyDeletionError) {
        return translatePrivacyDeletionError(error);
      }
      recordAudit({
        action: "memory.deleted",
        outcome: "failure",
        details: { scope: "cascade", status: "failed" },
      });
      throw error;
    }
  });

  for (const route of proxyRoutes) {
    app.post(route.route, async (context) => {
      authenticateMemoryRequest(context);
      const input = await readLimitedJson(
        context.req.raw,
        options.config.server.requestBodyLimitBytes,
      );
      const parsed = route.schema.safeParse(input);
      if (!parsed.success) {
        throw new GatewayHttpError(
          400,
          "INVALID_REQUEST",
          "Request body does not match the API contract",
        );
      }
      try {
        const result = await options.upstream.request({
          path: route.upstreamPath,
          body: parsed.data,
          requestId: context.get("requestId"),
          timeoutMs: options.config.server.upstreamTimeoutMs,
        });
        if (result.status < 200 || result.status >= 300) {
          throw new GatewayHttpError(
            502,
            "UPSTREAM_REJECTED",
            "The upstream Gateway rejected the request",
          );
        }
        return jsonResponse(result.body, 200);
      } catch (error) {
        if (error instanceof UpstreamGatewayError) {
          const status = error.code === "UPSTREAM_TIMEOUT" ? 504 : 502;
          throw new GatewayHttpError(status, error.code, error.message, {
            cause: error,
          });
        }
        throw error;
      }
    });
  }

  app.notFound((context) =>
    errorResponse(
      context.get("requestId") ?? randomId(),
      404,
      "NOT_FOUND",
      "Route not found",
    ),
  );
  return app;
}
