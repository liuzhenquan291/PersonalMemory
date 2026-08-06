import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("secure project defaults", () => {
  it("does not mutate OpenClaw during dependency installation", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.postinstall).toBeUndefined();
    expect(packageJson.scripts?.["patch:openclaw"]).toBeDefined();
  });

  it("keeps the local offload service on loopback with integrations disabled", () => {
    const script = readFileSync("scripts/start-offload-local.sh", "utf8");

    expect(script).toContain('TDAI_GATEWAY_HOST="127.0.0.1"');
    expect(script).toContain('LLM_BASE_URL="${LLM_BASE_URL:-}"');
    expect(script).toContain('LLM_API_KEY="${LLM_API_KEY:-}"');
    expect(script).toContain('LLM_MODEL="${LLM_MODEL:-}"');
    expect(script).toContain('OPIK_ENABLED="${OPIK_ENABLED:-false}"');
    expect(script).toContain('OPIK_URL_OVERRIDE="${OPIK_URL_OVERRIDE:-}"');
  });
});
