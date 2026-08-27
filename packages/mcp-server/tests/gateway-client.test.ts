import { describe, expect, it, vi } from "vitest";
import {
  GatewayClientError,
  PersonalMemoryGatewayClient,
} from "../src/gateway-client.js";
import { z } from "zod";

describe("PersonalMemoryGatewayClient", () => {
  it("accepts only credential-free loopback HTTP URLs", () => {
    for (const href of [
      "https://127.0.0.1:8787/",
      "http://example.com:8787/",
      "http://user:pass@127.0.0.1:8787/",
      "http://127.0.0.1:8787/private",
    ]) {
      expect(
        () =>
          new PersonalMemoryGatewayClient({
            baseUrl: new URL(href),
            token: "secret",
          }),
      ).toThrow(GatewayClientError);
    }
  });

  it("sends bearer auth without exposing it in errors", async () => {
    const request = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer private-secret",
        );
        return new Response(
          JSON.stringify({
            error: {
              code: "UNAUTHORIZED",
              message: "Authentication required",
              requestId: "internal-request-id",
            },
          }),
          { status: 401 },
        );
      },
    ) as typeof fetch;
    const client = new PersonalMemoryGatewayClient({
      baseUrl: new URL("http://127.0.0.1:8787/"),
      token: "private-secret",
      fetch: request,
    });
    await expect(
      client.get("/api/v1/mcp/status", z.object({ ok: z.boolean() }), {
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      client.get("/api/v1/mcp/status", z.object({ ok: z.boolean() }), {
        timeoutMs: 1_000,
      }),
    ).rejects.not.toThrow(/private-secret|internal-request-id/u);
  });

  it("bounds and validates Gateway responses", async () => {
    const client = new PersonalMemoryGatewayClient({
      baseUrl: new URL("http://localhost:8787/"),
      token: "secret",
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ wrong: true })),
      ) as typeof fetch,
    });
    await expect(
      client.get("/api/v1/mcp/status", z.object({ ok: z.boolean() }), {
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });

  it("stops reading a streamed response after the size limit", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(600_000));
      },
    });
    const client = new PersonalMemoryGatewayClient({
      baseUrl: new URL("http://localhost:8787/"),
      token: "secret",
      fetch: vi.fn(async () => new Response(stream)) as typeof fetch,
    });
    await expect(
      client.get("/api/v1/mcp/status", z.object({ ok: z.boolean() }), {
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("maps interrupted response streams to a bounded upstream error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("internal socket and path detail"));
      },
    });
    const client = new PersonalMemoryGatewayClient({
      baseUrl: new URL("http://localhost:8787/"),
      token: "secret",
      fetch: vi.fn(async () => new Response(stream)) as typeof fetch,
    });
    await expect(
      client.get("/api/v1/mcp/status", z.object({ ok: z.boolean() }), {
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await expect(
      client.get("/api/v1/mcp/status", z.object({ ok: z.boolean() }), {
        timeoutMs: 1_000,
      }),
    ).rejects.not.toThrow(/internal socket and path detail/u);
  });
});
