/**
 * Low-level HTTP transport for the TencentDB Agent Memory v2 API.
 *
 * - Auth: `Authorization: Bearer {apiKey}` + `x-tdai-service-id`
 * - Envelope unwrap: `code === 0` → return `data`; else throw `TDAMError`
 * - trace_id: extracted from `x-trace-id` response header
 * - Uses native `fetch` normally and a matching Undici fetch/Agent pair only
 *   for an explicit self-signed HTTPS opt-out.
 * - TLS: certificate verification is enabled by default; callers must explicitly
 *   opt out for a self-signed development endpoint.
 */

import { TDAMError } from "./errors.js";
import type { ApiResponseEnvelope } from "./types.js";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

export interface HttpTransportOptions {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  timeout?: number;
  /** Whether to reject self-signed / invalid TLS certs. Default: true. */
  rejectUnauthorized?: boolean;
}

export interface HttpTransportRuntime {
  createInsecureDispatcher(): Dispatcher;
  insecureFetch: typeof undiciFetch;
}

const defaultRuntime: HttpTransportRuntime = {
  createInsecureDispatcher: () => new Agent({ connect: { rejectUnauthorized: false } }),
  insecureFetch: undiciFetch,
};

export class HttpTransport {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;
  private dispatcher?: Dispatcher;
  private readonly insecureFetch: typeof undiciFetch;

  constructor(opts: HttpTransportOptions, runtime: HttpTransportRuntime = defaultRuntime) {
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.timeout = opts.timeout ?? 30_000;
    this.headers = {
      Authorization: `Bearer ${opts.apiKey}`,
      "x-tdai-service-id": opts.serviceId,
      "Content-Type": "application/json",
    };
    this.insecureFetch = runtime.insecureFetch;

    // Only create a custom TLS dispatcher for an explicit HTTPS opt-out.
    // Plain HTTP needs no TLS agent, and passing an Agent from a separately
    // installed undici version to Node's bundled fetch can be incompatible.
    if (opts.rejectUnauthorized === false && this.endpoint.startsWith("https://")) {
      this.dispatcher = runtime.createInsecureDispatcher();
    }
  }

  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T & { trace_id?: string }> {
    const url = `${this.endpoint}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const fetchOpts: RequestInit & { dispatcher?: unknown } = {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      };
      if (this.dispatcher) {
        fetchOpts.dispatcher = this.dispatcher;
      }

      const resp = this.dispatcher
        ? await this.insecureFetch(url, fetchOpts as Parameters<typeof undiciFetch>[1])
        : await fetch(url, fetchOpts as RequestInit);

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new TDAMError(resp.status, `HTTP ${resp.status}: ${text}`);
      }

      const envelope = (await resp.json()) as ApiResponseEnvelope<T>;

      if (envelope.code !== 0) {
        const reqId =
          resp.headers.get("x-qcloud-transaction-id") ?? envelope.request_id ?? "";
        throw new TDAMError(envelope.code, envelope.message, reqId);
      }

      const result = (envelope.data ?? {}) as T & { trace_id?: string };
      const traceId = resp.headers.get("x-trace-id");
      if (traceId) {
        (result as Record<string, unknown>).trace_id = traceId;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (!this.dispatcher) return;
    const dispatcher = this.dispatcher;
    this.dispatcher = undefined;
    await dispatcher.close();
  }
}
