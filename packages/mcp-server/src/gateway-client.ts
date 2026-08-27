import { randomUUID } from "node:crypto";
import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_RESPONSE_BYTES = 1_048_576;

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new GatewayClientError(
      502,
      "INVALID_UPSTREAM_RESPONSE",
      "Gateway response was too large",
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GatewayClientError(
          502,
          "INVALID_UPSTREAM_RESPONSE",
          "Gateway response was too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

const gatewayErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export class GatewayClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GatewayClientError";
  }
}

export interface GatewayResponse<T> {
  status: number;
  data: T;
}

export class PersonalMemoryGatewayClient {
  readonly #baseUrl: URL;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(input: { baseUrl: URL; token: string; fetch?: typeof fetch }) {
    if (
      input.baseUrl.protocol !== "http:" ||
      !LOOPBACK_HOSTS.has(input.baseUrl.hostname.toLowerCase()) ||
      input.baseUrl.username ||
      input.baseUrl.password ||
      input.baseUrl.pathname !== "/" ||
      input.baseUrl.search ||
      input.baseUrl.hash
    ) {
      throw new GatewayClientError(
        500,
        "INVALID_CONFIGURATION",
        "The MCP Gateway URL must be credential-free loopback HTTP",
      );
    }
    if (!input.token.trim()) {
      throw new GatewayClientError(
        500,
        "INVALID_CONFIGURATION",
        "Gateway authentication must be configured before MCP starts",
      );
    }
    this.#baseUrl = new URL(input.baseUrl.href);
    this.#token = input.token;
    this.#fetch = input.fetch ?? fetch;
  }

  async preflight(signal?: AbortSignal): Promise<void> {
    const response = await this.request({
      method: "GET",
      path: "/api/v1/mcp/status",
      schema: z.object({
        status: z.literal("ready"),
        api_version: z.literal("v1"),
      }),
      timeoutMs: 2_000,
      ...(signal ? { signal } : {}),
    });
    if (response.data.status !== "ready") {
      throw new GatewayClientError(
        503,
        "UPSTREAM_UNAVAILABLE",
        "Gateway is not ready",
      );
    }
  }

  async get<T>(
    path: string,
    schema: z.ZodType<T>,
    input: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<GatewayResponse<T>> {
    return await this.request({ method: "GET", path, schema, ...input });
  }

  async post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    input: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<GatewayResponse<T>> {
    return await this.request({ method: "POST", path, body, schema, ...input });
  }

  private async request<T>(input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    schema: z.ZodType<T>;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<GatewayResponse<T>> {
    if (!input.path.startsWith("/api/v1/") || input.path.includes("..")) {
      throw new GatewayClientError(
        500,
        "INVALID_CONFIGURATION",
        "Gateway path is not allowed",
      );
    }
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)])
      : AbortSignal.timeout(input.timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(new URL(input.path, this.#baseUrl), {
        method: input.method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          "x-request-id": randomUUID(),
        },
        ...(input.body === undefined
          ? {}
          : { body: JSON.stringify(input.body) }),
        signal,
      });
    } catch (error) {
      throw new GatewayClientError(
        503,
        signal.aborted ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE",
        signal.aborted ? "Gateway request timed out" : "Gateway is unavailable",
        { cause: error },
      );
    }
    let text: string;
    try {
      text = await readBoundedBody(response);
    } catch (error) {
      if (error instanceof GatewayClientError) throw error;
      throw new GatewayClientError(
        503,
        signal.aborted ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE",
        signal.aborted
          ? "Gateway response timed out"
          : "Gateway response was interrupted",
        { cause: error },
      );
    }
    let body: unknown;
    try {
      body = text ? (JSON.parse(text) as unknown) : {};
    } catch (error) {
      throw new GatewayClientError(
        502,
        "INVALID_UPSTREAM_RESPONSE",
        "Gateway returned invalid JSON",
        {
          cause: error,
        },
      );
    }
    if (!response.ok) {
      const parsed = gatewayErrorSchema.safeParse(body);
      throw new GatewayClientError(
        response.status,
        parsed.success ? parsed.data.error.code : "UPSTREAM_UNAVAILABLE",
        parsed.success ? parsed.data.error.message : "Gateway request failed",
      );
    }
    const parsed = input.schema.safeParse(body);
    if (!parsed.success) {
      throw new GatewayClientError(
        502,
        "INVALID_UPSTREAM_RESPONSE",
        "Gateway response did not match its contract",
        {
          cause: parsed.error,
        },
      );
    }
    return { status: response.status, data: parsed.data };
  }
}
