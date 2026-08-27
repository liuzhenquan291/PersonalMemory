import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpTransport } from "../src/http.js";
import type { Dispatcher, fetch as UndiciFetch } from "undici";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HttpTransport TLS defaults", () => {
  it("uses native fetch without a custom dispatcher by default", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpTransport({
      endpoint: "https://memory.example.test",
      apiKey: "test",
      serviceId: "default",
    });

    await transport.post("/v2/conversation/query");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("dispatcher");
  });

  it("uses native fetch for plain HTTP even when TLS opt-out is requested", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new HttpTransport({
      endpoint: "http://127.0.0.1:8420",
      apiKey: "test",
      serviceId: "default",
      rejectUnauthorized: false,
    });

    await transport.post("/v2/conversation/query");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("dispatcher");
  });

  it("uses and closes the matching dispatcher for an explicit HTTPS opt-out", async () => {
    const close = vi.fn(async () => undefined);
    const dispatcher = { close } as unknown as Dispatcher;
    const insecureFetch = vi.fn(async (_url: unknown, init?: { dispatcher?: Dispatcher }) => {
      expect(init?.dispatcher).toBe(dispatcher);
      return new Response(JSON.stringify({ code: 0, data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof UndiciFetch;
    const transport = new HttpTransport({
      endpoint: "https://memory.example.test",
      apiKey: "test",
      serviceId: "default",
      rejectUnauthorized: false,
    }, {
      createInsecureDispatcher: () => dispatcher,
      insecureFetch,
    });

    await expect(transport.post("/v2/conversation/query")).resolves.toEqual({ ok: true });
    expect(insecureFetch).toHaveBeenCalledOnce();
    await expect(transport.close()).resolves.toBeUndefined();
    await expect(transport.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
});
