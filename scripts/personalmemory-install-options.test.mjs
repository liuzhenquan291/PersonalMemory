import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  parseAgentArguments,
  resolveInstallAgents,
} from "./personalmemory-install-options.mjs";

test("parses repeatable Agent arguments and shortcuts", () => {
  assert.deepEqual(
    parseAgentArguments([
      "--agent",
      "claude-code",
      "--agent",
      "codex",
      "--agent",
      "codex",
    ]),
    ["codex", "claude-code"],
  );
  assert.deepEqual(parseAgentArguments(["--agent", "all"]), [
    "codex",
    "claude-code",
  ]);
  assert.deepEqual(parseAgentArguments(["--agent", "none"]), []);
  assert.equal(parseAgentArguments([]), undefined);
});

test("rejects ambiguous or unsupported Agent arguments", () => {
  assert.throws(
    () => parseAgentArguments(["--agent", "none", "--agent", "codex"]),
    /cannot be combined/u,
  );
  assert.throws(
    () => parseAgentArguments(["--agent", "all", "--agent", "codex"]),
    /cannot be combined/u,
  );
  assert.throws(
    () => parseAgentArguments(["--agent", "unknown"]),
    /Unsupported Agent/u,
  );
  assert.throws(() => parseAgentArguments(["--agent"]), /requires a value/u);
  assert.throws(() => parseAgentArguments(["--other"]), /Unknown/u);
});

test("auto-detects installed Agents only when no explicit selection is given", async () => {
  const environment = { PATH: ["/bin", "/opt/bin"].join(path.delimiter) };
  const seen = [];
  const accessImpl = async (target) => {
    seen.push(target);
    if (target === "/opt/bin/claude") return;
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  };
  assert.deepEqual(await resolveInstallAgents([], environment, accessImpl), [
    "claude-code",
  ]);
  assert.ok(seen.includes("/bin/codex"));
  assert.deepEqual(
    await resolveInstallAgents(["--agent", "none"], environment, accessImpl),
    [],
  );
});
