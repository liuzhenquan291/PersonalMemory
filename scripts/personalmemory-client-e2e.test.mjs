import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import {
  acceptancePrompt,
  acceptanceSchema,
  expectedAcceptanceResult,
} from "./personalmemory-client-e2e-fixture.mjs";
import {
  claudeToolNames,
  createClaudeMcpConfig,
} from "./personalmemory-claude-e2e.mjs";

test("keeps the cross-client acceptance schema closed and security explicit", () => {
  assert.equal(acceptanceSchema.additionalProperties, false);
  assert.deepEqual(
    new Set(acceptanceSchema.required),
    new Set(Object.keys(expectedAcceptanceResult)),
  );
  assert.match(acceptancePrompt, /untrusted data/u);
  assert.match(acceptancePrompt, /prepare_forget cannot delete/u);
  assert.match(acceptancePrompt, /page_size 1/u);
});

test("limits Claude Code to the same five PersonalMemory tools", () => {
  assert.deepEqual(claudeToolNames(), [
    "mcp__personalmemory__personalmemory_search",
    "mcp__personalmemory__personalmemory_read",
    "mcp__personalmemory__personalmemory_capture",
    "mcp__personalmemory__personalmemory_feedback",
    "mcp__personalmemory__personalmemory_prepare_forget",
  ]);
});

test("builds a loopback-only stdio Claude Code MCP config", () => {
  const config = createClaudeMcpConfig({
    port: 19_876,
    token: "fixture-token",
  });
  const server = config.mcpServers.personalmemory;
  assert.equal(server.type, "stdio");
  assert.equal(server.command, process.execPath);
  assert.match(server.args[0], /packages\/mcp-server\/dist\/cli\.js$/u);
  assert.deepEqual(server.env, {
    PERSONALMEMORY_AUTH_ENABLED: "true",
    PERSONALMEMORY_AUTH_TOKEN: "fixture-token",
    PERSONALMEMORY_HOST: "127.0.0.1",
    PERSONALMEMORY_PORT: "19876",
  });
});
