import type { UpstreamGatewayClient } from "./types.js";
import { request as httpRequest } from "node:http";

const MAX_UPSTREAM_RESPONSE_BYTES = 10 * 1_024 * 1_024;

export interface UpstreamTransportResponse {
  status: number;
  json(): Promise<unknown>;
}

export type UpstreamTransport = (input: {
  target: URL;
  body: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<UpstreamTransportResponse>;

const directLoopbackTransport: UpstreamTransport = async (input) =>
  await new Promise((resolve, reject) => {
    const request = httpRequest(
      input.target,
      {
        method: "POST",
        headers: input.headers,
        agent: false,
        signal: input.signal,
      },
      (response) => {
        const declaredLength = Number(response.headers["content-length"]);
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_UPSTREAM_RESPONSE_BYTES
        ) {
          const error = new UpstreamGatewayError(
            "The upstream Gateway response is too large",
            "UPSTREAM_INVALID_RESPONSE",
          );
          response.destroy(error);
          reject(error);
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.byteLength;
          if (length > MAX_UPSTREAM_RESPONSE_BYTES) {
            response.destroy(
              new UpstreamGatewayError(
                "The upstream Gateway response is too large",
                "UPSTREAM_INVALID_RESPONSE",
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 502,
            async json() {
              return JSON.parse(body) as unknown;
            },
          });
        });
      },
    );
    request.once("error", reject);
    request.end(input.body);
  });

const ALLOWED_UPSTREAM_PATHS = new Set([
  "/capture",
  "/recall",
  "/search/memories",
  "/search/conversations",
  "/session/end",
  "/v2/conversation/search",
  "/v2/conversation/query",
  "/v2/atomic/search",
  "/v2/atomic/query",
  "/v2/scenario/ls",
  "/v2/scenario/read",
  "/v2/core/read",
  "/v2/atomic/update",
  "/v2/atomic/delete",
  "/v2/scenario/write",
  "/v2/core/write",
]);

export class UpstreamGatewayError extends Error {
  constructor(
    message: string,
    readonly code:
      "UPSTREAM_TIMEOUT" | "UPSTREAM_UNAVAILABLE" | "UPSTREAM_INVALID_RESPONSE",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UpstreamGatewayError";
  }
}

export class FetchUpstreamGatewayClient implements UpstreamGatewayClient {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: URL,
    private readonly transport: UpstreamTransport = directLoopbackTransport,
  ) {
    if (
      baseUrl.protocol !== "http:" ||
      !["127.0.0.1", "::1", "[::1]", "localhost"].includes(
        baseUrl.hostname.toLowerCase(),
      ) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.pathname !== "/" ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new UpstreamGatewayError(
        "The upstream Gateway must use credential-free loopback HTTP",
        "UPSTREAM_INVALID_RESPONSE",
      );
    }
    this.baseUrl = baseUrl;
  }

  async request(input: {
    path: string;
    body: unknown;
    requestId: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: unknown }> {
    if (!ALLOWED_UPSTREAM_PATHS.has(input.path)) {
      throw new UpstreamGatewayError(
        "The requested upstream operation is not allowed",
        "UPSTREAM_INVALID_RESPONSE",
      );
    }
    const target = new URL(input.path, this.baseUrl);
    if (target.origin !== this.baseUrl.origin) {
      throw new UpstreamGatewayError(
        "The upstream target escaped its configured origin",
        "UPSTREAM_INVALID_RESPONSE",
      );
    }
    const timeoutSignal = AbortSignal.timeout(input.timeoutMs);
    const signal = input.signal
      ? AbortSignal.any([timeoutSignal, input.signal])
      : timeoutSignal;
    try {
      const response = await this.transport({
        target,
        headers: {
          "content-type": "application/json",
          "x-request-id": input.requestId,
          ...(input.path.startsWith("/v2/")
            ? {
                authorization: "Bearer personalmemory-loopback",
                "x-tdai-service-id": "personalmemory",
              }
            : {}),
        },
        body: JSON.stringify(input.body),
        signal,
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new UpstreamGatewayError(
          "The upstream Gateway returned invalid JSON",
          "UPSTREAM_INVALID_RESPONSE",
          { cause: error },
        );
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof UpstreamGatewayError) throw error;
      if (timeoutSignal.aborted) {
        throw new UpstreamGatewayError(
          "The upstream Gateway timed out",
          "UPSTREAM_TIMEOUT",
          { cause: error },
        );
      }
      throw new UpstreamGatewayError(
        "The upstream Gateway is unavailable",
        "UPSTREAM_UNAVAILABLE",
        { cause: error },
      );
    }
  }
}
