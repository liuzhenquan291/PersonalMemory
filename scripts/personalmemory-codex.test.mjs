import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
  CodexMcpConfigError,
  installCodexMcp,
  uninstallCodexMcp,
} from "./personalmemory-codex.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "personalmemory-codex-"));
  chmodSync(root, 0o700);
  const configPath = path.join(root, ".codex", "config.toml");
  const serverEntry = path.join(root, "server.js");
  writeFileSync(serverEntry, "// fixture\n", { mode: 0o600 });
  return {
    root,
    configPath,
    options: {
      projectRoot: root,
      configPath,
      serverEntry,
      nodePath: process.execPath,
    },
  };
}

test("installs idempotently without persisting the bearer token and removes a new config", async () => {
  const item = fixture();
  try {
    const installed = await installCodexMcp(item.options);
    assert.equal(installed.changed, true);
    const config = readFileSync(item.configPath, "utf8");
    assert.match(config, /\[mcp_servers\.personalmemory\]/u);
    assert.match(config, /env_vars = \[.*PERSONALMEMORY_AUTH_TOKEN/u);
    assert.match(config, /required = false/u);
    assert.match(config, /default_tools_approval_mode = "prompt"/u);
    assert.match(
      config,
      /tools\.personalmemory_search\]\napproval_mode = "auto"/u,
    );
    assert.doesNotMatch(config, /test-secret|Bearer /u);
    assert.doesNotMatch(
      readFileSync(
        path.join(
          path.dirname(item.configPath),
          ".personalmemory-mcp-install.json",
        ),
        "utf8",
      ),
      /test-secret|Bearer /u,
    );
    assert.equal(lstatSync(item.configPath).mode & 0o777, 0o600);
    assert.equal((await installCodexMcp(item.options)).changed, false);
    assert.equal((await uninstallCodexMcp(item.options)).changed, true);
    assert.equal(existsSync(item.configPath), false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("requires a built regular server entry before editing config", async () => {
  const item = fixture();
  try {
    rmSync(item.options.serverEntry);
    await assert.rejects(installCodexMcp(item.options), (error) => {
      assert.equal(error.code, "SERVER_NOT_BUILT");
      return true;
    });
    assert.equal(existsSync(item.configPath), false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("preserves an existing config byte-for-byte across install and uninstall", async () => {
  const item = fixture();
  try {
    mkdirSync(path.dirname(item.configPath), { recursive: true, mode: 0o700 });
    const original =
      'model = "gpt-test"\n\n[mcp_servers.existing]\ncommand = "existing"\n';
    writeFileSync(item.configPath, original, { mode: 0o640 });
    await installCodexMcp(item.options);
    assert.match(readFileSync(item.configPath, "utf8"), /existing/u);
    await uninstallCodexMcp(item.options);
    assert.equal(readFileSync(item.configPath, "utf8"), original);
    assert.equal(lstatSync(item.configPath).mode & 0o777, 0o640);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("refuses a conflicting server entry without changing the config", async () => {
  const item = fixture();
  try {
    mkdirSync(path.dirname(item.configPath), { recursive: true, mode: 0o700 });
    const original = '[mcp_servers.personalmemory]\ncommand = "other"\n';
    writeFileSync(item.configPath, original, { mode: 0o600 });
    await assert.rejects(installCodexMcp(item.options), (error) => {
      assert.ok(error instanceof CodexMcpConfigError);
      assert.equal(error.code, "INSTALL_CONFLICT");
      return true;
    });
    assert.equal(readFileSync(item.configPath, "utf8"), original);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("refuses dotted and nested conflicting server entries", async () => {
  for (const original of [
    'mcp_servers.personalmemory.command = "other"\n',
    '[mcp_servers . "personalmemory" . tools.read]\napproval_mode = "auto"\n',
    '[mcp_servers]\npersonalmemory = { command = "other" }\n',
    'mcp_servers = { personalmemory = { command = "other" } }\n',
  ]) {
    const item = fixture();
    try {
      mkdirSync(path.dirname(item.configPath), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(item.configPath, original, { mode: 0o600 });
      await assert.rejects(installCodexMcp(item.options), (error) => {
        assert.equal(error.code, "INSTALL_CONFLICT");
        return true;
      });
      assert.equal(readFileSync(item.configPath, "utf8"), original);
    } finally {
      rmSync(item.root, { recursive: true, force: true });
    }
  }
});

test("fails closed when an installation receipt is malformed", async () => {
  const item = fixture();
  try {
    await installCodexMcp(item.options);
    const receiptPath = path.join(
      path.dirname(item.configPath),
      ".personalmemory-mcp-install.json",
    );
    writeFileSync(receiptPath, "{invalid\n", { mode: 0o600 });
    await assert.rejects(installCodexMcp(item.options), (error) => {
      assert.equal(error.code, "INVALID_RECEIPT");
      return true;
    });
    await assert.rejects(uninstallCodexMcp(item.options), (error) => {
      assert.equal(error.code, "INVALID_RECEIPT");
      return true;
    });
    assert.equal(existsSync(item.configPath), true);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("refuses a receipt that expands the managed removal range", async () => {
  const item = fixture();
  try {
    mkdirSync(path.dirname(item.configPath), { recursive: true, mode: 0o700 });
    const original = 'model = "gpt-test"\n';
    writeFileSync(item.configPath, original, { mode: 0o600 });
    await installCodexMcp(item.options);
    const receiptPath = path.join(
      path.dirname(item.configPath),
      ".personalmemory-mcp-install.json",
    );
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.appended = `${original}${receipt.appended}`;
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    await assert.rejects(uninstallCodexMcp(item.options), (error) => {
      assert.equal(error.code, "INVALID_RECEIPT");
      return true;
    });
    assert.match(readFileSync(item.configPath, "utf8"), /gpt-test/u);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("refuses to remove an edited managed block", async () => {
  const item = fixture();
  try {
    await installCodexMcp(item.options);
    writeFileSync(
      item.configPath,
      readFileSync(item.configPath, "utf8").replace(
        "tool_timeout_sec = 35",
        "tool_timeout_sec = 99",
      ),
    );
    await assert.rejects(uninstallCodexMcp(item.options), (error) => {
      assert.equal(error.code, "CONFIG_CHANGED");
      return true;
    });
    assert.equal(existsSync(item.configPath), true);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("refuses to remove a duplicated managed block", async () => {
  const item = fixture();
  try {
    await installCodexMcp(item.options);
    const config = readFileSync(item.configPath, "utf8");
    writeFileSync(item.configPath, `${config}${config}`);
    await assert.rejects(uninstallCodexMcp(item.options), (error) => {
      assert.equal(error.code, "CONFIG_CHANGED");
      return true;
    });
    assert.equal(readFileSync(item.configPath, "utf8"), `${config}${config}`);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});
