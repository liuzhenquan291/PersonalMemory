import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { startPersonalMemoryMcpStdio } from "../src/runtime.js";
import type { PersonalMemoryMcpService } from "../src/service.js";

describe("PersonalMemory MCP stdio lifecycle", () => {
  it("preflights before transport startup and keeps stdout protocol-only", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stdoutText = "";
    let stderrText = "";
    stdout.setEncoding("utf8").on("data", (chunk) => (stdoutText += chunk));
    stderr.setEncoding("utf8").on("data", (chunk) => (stderrText += chunk));
    const preflight = vi.fn(async () => undefined);
    const runtime = await startPersonalMemoryMcpStdio({
      service: { preflight } as unknown as PersonalMemoryMcpService,
      stdin,
      stdout,
      stderr,
      maxBufferSize: 1_024,
    });
    expect(preflight).toHaveBeenCalledOnce();
    expect(stdoutText).toBe("");
    expect(stderrText).toContain("ready on stdio");
    stdin.end();
    await expect(runtime.closed).resolves.toBeUndefined();
    await Promise.all([runtime.close(), runtime.close()]);
  });

  it("fails closed before attaching stdio when Gateway preflight fails", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stdoutText = "";
    stdout.setEncoding("utf8").on("data", (chunk) => (stdoutText += chunk));
    await expect(
      startPersonalMemoryMcpStdio({
        service: {
          preflight: vi.fn(async () => {
            throw new Error("private token and internal path");
          }),
        } as unknown as PersonalMemoryMcpService,
        stdin,
        stdout,
        stderr,
        maxBufferSize: 1_024,
      }),
    ).rejects.toThrow();
    expect(stdoutText).toBe("");
  });
});
