import { readManagedPorts } from "./personalmemory-install-options.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_INSTALL_PORTS,
  parseInstallArguments,
  parseAgentArguments,
  resolveInstallAgents,
  resolveInstallOptions,
} from "./personalmemory-install-options.mjs";

test("uses the product default service ports", () => {
  assert.deepEqual(DEFAULT_INSTALL_PORTS, {
    upstreamPort: 17173,
    gatewayPort: 17175,
    webPort: 17177,
  });
});

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

test("parses optional service ports with repeatable Agents", async () => {
  assert.deepEqual(
    parseInstallArguments([
      "--gateway-port",
      "8788",
      "--agent",
      "claude-code",
      "--agent",
      "codex",
      "--web-port",
      "4174",
    ]),
    {
      agents: ["codex", "claude-code"],
      gatewayPort: 8788,
      webPort: 4174,
    },
  );
  assert.deepEqual(
    await resolveInstallOptions(["--agent", "none", "--gateway-port", "8788"]),
    { agents: [], gatewayPort: 8788 },
  );
});

test("rejects invalid, duplicate, or overlapping service ports", () => {
  for (const args of [
    ["--gateway-port"],
    ["--gateway-port", "0"],
    ["--gateway-port", "65536"],
    ["--gateway-port", "abc"],
    ["--gateway-port", "8788", "--gateway-port", "8789"],
    ["--gateway-port", "17173"],
  ]) {
    assert.throws(() => parseInstallArguments(args), /port|repeated|distinct/u);
  }
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

test("managed ports preserve HTTP 80 and legacy defaults, rejecting unsafe receipts", () => {
  const receipt = {
    version: 3,
    upstreamHealthUrl: "http://127.0.0.1:80/health",
    gatewayHealthUrl: "http://127.0.0.1:28175/health",
    webUrl: "http://127.0.0.1:28177/memories",
  };
  assert.deepEqual(readManagedPorts(receipt), {
    upstreamPort: 80,
    gatewayPort: 28175,
    webPort: 28177,
  });
  assert.deepEqual(readManagedPorts({ version: 1 }), {
    upstreamPort: 17173,
    gatewayPort: 17175,
    webPort: 17177,
  });
  for (const url of [
    undefined,
    "http://remote.example:80/health",
    "http://user@localhost/health",
    "https://localhost/health",
    "http://localhost:0/health",
    "http://localhost:28175/health",
  ]) {
    assert.throws(() =>
      readManagedPorts({ ...receipt, upstreamHealthUrl: url }),
    );
  }
});
