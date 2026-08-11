import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type AuditAction,
  getModelOutboundDisclosure,
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

const API_VERSION = "v1";
const SESSION_COOKIE = "personalmemory_session";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BROWSER_SESSIONS = 32;
const MAX_FAILED_AUTH_ATTEMPTS_PER_MINUTE = 120;
const MAX_IMPORT_ROUNDS = 500;

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
  const recallService = new RecallService(
    options.upstream,
    options.config.server.upstreamTimeoutMs,
    options.memoryStates,
    options.memoryReviews,
    options.memoryGovernance,
  );
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
      "POST /api/v1/session",
      "DELETE /api/v1/session",
      ...proxyRoutes.map((route) => `POST ${route.route}`),
      "POST /api/v1/conversations/capture",
      "POST /api/v1/conversations/imports",
      "GET /api/v1/conversations/imports/:id",
      "POST /api/v1/conversations/imports/:id/retry",
      "POST /api/v1/conversations/imports/:id/cancel",
      "POST /api/v1/recall/query",
      "GET /api/v1/memories",
      "GET /api/v1/audit",
      "POST /api/v1/memory-reviews",
      "GET /api/v1/memories/:level/:id/governance",
      "POST /api/v1/memories/:level/:id/validity",
      "POST /api/v1/memory-relations",
      "POST /api/v1/memory-relations/:id/revoke",
      "POST /api/v1/memories/:level/:id/update",
      "POST /api/v1/memories/:level/:id/invalidate",
      "POST /api/v1/memories/:level/:id/delete",
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
          "GET, POST, DELETE, OPTIONS",
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
      modelOutboundDisclosure: disclosure
        ? {
            ...disclosure,
            sentFields: [
              ...disclosure.sentFields,
              "imported conversation messages",
            ],
          }
        : undefined,
    });
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
    if (disclosure && parsed.data.model_outbound_acknowledged !== true) {
      throw new GatewayHttpError(
        409,
        "MODEL_OUTBOUND_CONSENT_REQUIRED",
        `Confirm model outbound fields (${[
          ...disclosure.sentFields,
          "imported conversation messages",
        ].join(", ")}) to ${disclosure.provider} at ${disclosure.targetOrigin}`,
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
