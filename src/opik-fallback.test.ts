import { describe, expect, it, vi } from "vitest";

describe("optional Opik integration", () => {
  it("keeps the server tracer disabled when the optional package is absent", async () => {
    vi.resetModules();
    vi.stubEnv("OPIK_ENABLED", "true");
    const debug = vi.fn();
    const tracer = await import("./offload_server/opik-tracer.js");

    await expect(
      tracer.initServerOpikTracer({ info: vi.fn(), warn: vi.fn(), debug }),
    ).resolves.toBeUndefined();
    expect(tracer.isTracerEnabled()).toBe(false);
    expect(debug).toHaveBeenCalledWith(
      "[offload-server] opik package not available, tracer disabled",
    );
  });

  it("keeps the OpenClaw tracer disabled when the optional package is absent", async () => {
    vi.resetModules();
    const debug = vi.fn();
    const tracer = await import("./offload/opik-tracer.js");

    expect(() =>
      tracer.initOffloadOpikTracer(
        { plugins: { entries: { "opik-openclaw": { enabled: true } } } },
        { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ),
    ).not.toThrow();
    expect(debug).toHaveBeenCalledWith(
      "[context-offload] opik package not available, tracer disabled",
    );
  });
});
