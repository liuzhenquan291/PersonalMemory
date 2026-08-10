import { describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import {
  FetchUpstreamGatewayClient,
  UpstreamGatewayError,
  type UpstreamTransport,
} from "../src/upstream-client.js";

describe("FetchUpstreamGatewayClient", () => {
  const listen = async (server: Server): Promise<number> => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");
    return address.port;
  };

  const close = async (server: Server): Promise<void> => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  it("calls only allowlisted loopback operations with request metadata", async () => {
    const transport = vi.fn(async () => ({
      status: 200,
      async json() {
        return { context: "result" };
      },
    }));
    const client = new FetchUpstreamGatewayClient(
      new URL("http://127.0.0.1:8420"),
      transport,
    );
    await expect(
      client.request({
        path: "/recall",
        body: { query: "q" },
        requestId: "request-123",
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ status: 200, body: { context: "result" } });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        target: new URL("http://127.0.0.1:8420/recall"),
        headers: expect.objectContaining({ "x-request-id": "request-123" }),
      }),
    );
  });

  it("rejects unknown operations before fetch", async () => {
    const transport = vi.fn();
    const client = new FetchUpstreamGatewayClient(
      new URL("http://127.0.0.1:8420"),
      transport,
    );
    await expect(
      client.request({
        path: "/v2/instance/destroy",
        body: {},
        requestId: "request-123",
        timeoutMs: 100,
      }),
    ).rejects.toThrow(UpstreamGatewayError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("adds fixed internal authentication only for allowlisted v2 read routes", async () => {
    const transport = vi.fn(async () => ({
      status: 200,
      async json() {
        return { code: 0, data: { content: null } };
      },
    }));
    const client = new FetchUpstreamGatewayClient(
      new URL("http://127.0.0.1:8420"),
      transport,
    );
    await client.request({
      path: "/v2/core/read",
      body: {},
      requestId: "request-123",
      timeoutMs: 100,
    });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer personalmemory-loopback",
          "x-tdai-service-id": "personalmemory",
        }),
      }),
    );
  });

  it("rejects remote or credential-bearing base URLs", () => {
    expect(
      () => new FetchUpstreamGatewayClient(new URL("https://example.test")),
    ).toThrow(/loopback/);
    expect(
      () =>
        new FetchUpstreamGatewayClient(
          new URL("http://user:password@127.0.0.1:8420"),
        ),
    ).toThrow(/loopback/);
  });

  it("accepts an IPv6 loopback base URL", () => {
    expect(
      () =>
        new FetchUpstreamGatewayClient(new URL("http://[::1]:8420"), vi.fn()),
    ).not.toThrow();
  });

  it("connects directly to loopback even when proxy variables are present", async () => {
    let proxyRequests = 0;
    const proxy = createServer((_request, response) => {
      proxyRequests += 1;
      response.writeHead(502).end();
    });
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ direct: true }));
    });
    const [proxyPort, upstreamPort] = await Promise.all([
      listen(proxy),
      listen(upstream),
    ]);
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${proxyPort}`);
    vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${proxyPort}`);
    vi.stubEnv("ALL_PROXY", `http://127.0.0.1:${proxyPort}`);
    try {
      const client = new FetchUpstreamGatewayClient(
        new URL(`http://127.0.0.1:${upstreamPort}`),
      );
      await expect(
        client.request({
          path: "/recall",
          body: {},
          requestId: "request-123",
          timeoutMs: 1_000,
        }),
      ).resolves.toEqual({ status: 200, body: { direct: true } });
      expect(proxyRequests).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      await Promise.all([close(proxy), close(upstream)]);
    }
  });

  it.each(["declared", "chunked"])(
    "rejects %s upstream responses over 10 MiB",
    async (mode) => {
      const upstream = createServer((_request, response) => {
        if (mode === "declared") {
          response.writeHead(200, {
            "content-type": "application/json",
            "content-length": String(11 * 1_024 * 1_024),
          });
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(Buffer.alloc(11 * 1_024 * 1_024, 0x20));
      });
      const port = await listen(upstream);
      try {
        const client = new FetchUpstreamGatewayClient(
          new URL(`http://127.0.0.1:${port}`),
        );
        await expect(
          client.request({
            path: "/recall",
            body: {},
            requestId: "request-123",
            timeoutMs: 2_000,
          }),
        ).rejects.toMatchObject({ code: "UPSTREAM_INVALID_RESPONSE" });
      } finally {
        await close(upstream);
      }
    },
  );

  it("maps invalid JSON and timeouts to stable errors", async () => {
    const invalid = new FetchUpstreamGatewayClient(
      new URL("http://127.0.0.1:8420"),
      vi.fn(async () => ({
        status: 200,
        async json() {
          throw new SyntaxError("not json");
        },
      })),
    );
    await expect(
      invalid.request({
        path: "/recall",
        body: {},
        requestId: "request-123",
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_INVALID_RESPONSE" });

    const timedOut = new FetchUpstreamGatewayClient(
      new URL("http://127.0.0.1:8420"),
      vi.fn(async ({ signal }: Parameters<UpstreamTransport>[0]) => {
        await new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
        throw new DOMException("timed out", "TimeoutError");
      }),
    );
    await expect(
      timedOut.request({
        path: "/recall",
        body: {},
        requestId: "request-123",
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
  });
});
