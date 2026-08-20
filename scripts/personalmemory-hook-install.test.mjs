import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  installManagedHooks,
  readManagedHookStatus,
  uninstallManagedHooks,
} from "./personalmemory-hook-install.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-hook-install-"));
  await chmod(root, 0o700);
  const home = path.join(root, "home");
  const stateDirectory = path.join(root, "state");
  await mkdir(path.join(home, ".codex"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(home, ".claude"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(home, ".codex", "hooks.json"),
    `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "existing" }] }] } })}\n`,
  );
  await writeFile(
    path.join(home, ".claude", "settings.json"),
    `${JSON.stringify({ theme: "dark", hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "existing" }] }] } })}\n`,
  );
  return { root, home, stateDirectory };
}

test("installs private managed Codex and Claude hooks without replacing existing settings", async () => {
  const current = await fixture();
  try {
    const result = await installManagedHooks({
      home: current.home,
      stateDirectory: current.stateDirectory,
      projectRoot: "/opt/personalmemory",
      nodePath: process.execPath,
    });
    assert.equal(result.codex, "installed_untrusted");
    assert.equal(result.claude, "installed");
    const codex = JSON.parse(
      await readFile(path.join(current.home, ".codex", "hooks.json"), "utf8"),
    );
    const claude = JSON.parse(
      await readFile(
        path.join(current.home, ".claude", "settings.json"),
        "utf8",
      ),
    );
    assert.equal(codex.hooks.SessionStart[0].hooks[0].command, "existing");
    assert.equal(claude.theme, "dark");
    assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, "existing");
    for (const config of [codex, claude]) {
      for (const event of ["UserPromptSubmit", "Stop"]) {
        const managed = config.hooks[event].find((entry) =>
          entry.hooks?.[0]?.command?.includes("personalmemory-hook-cli.mjs"),
        );
        assert.equal(managed.hooks[0].timeout, event === "Stop" ? 3 : 1);
        assert.match(managed.hooks[0].command, /--state-directory/u);
        assert.match(
          managed.hooks[0].command,
          new RegExp(current.stateDirectory),
        );
        assert.doesNotMatch(
          JSON.stringify(managed),
          /Bearer|AUTH_TOKEN|prompt/u,
        );
      }
    }
    assert.equal((await stat(result.receiptPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(
      await readFile(result.receiptPath, "utf8"),
      /AUTH_TOKEN/,
    );
    assert.deepEqual(
      await readManagedHookStatus({
        home: current.home,
        stateDirectory: current.stateDirectory,
      }),
      {
        installed: true,
        codex: "installed_untrusted",
        claude: "installed",
        firstEventReceived: false,
      },
    );
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

test("is idempotent, fails closed on edited managed entries, and uninstalls exactly", async () => {
  const current = await fixture();
  try {
    const options = {
      home: current.home,
      stateDirectory: current.stateDirectory,
      projectRoot: "/opt/personalmemory",
      nodePath: process.execPath,
    };
    const first = await installManagedHooks(options);
    assert.equal((await installManagedHooks(options)).changed, false);
    const codexPath = path.join(current.home, ".codex", "hooks.json");
    const codex = JSON.parse(await readFile(codexPath, "utf8"));
    codex.hooks.Stop.at(-1).hooks[0].command += " --edited";
    await writeFile(codexPath, `${JSON.stringify(codex)}\n`);
    await assert.rejects(uninstallManagedHooks(options), /modified/u);
    assert.equal(await stat(first.receiptPath).then(() => true), true);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

test("upgrades only receipt-owned definitions, requires Codex retrust, and reverses cleanly", async () => {
  const current = await fixture();
  try {
    const initial = {
      home: current.home,
      stateDirectory: current.stateDirectory,
      projectRoot: "/opt/personalmemory-v1",
      nodePath: process.execPath,
    };
    const firstInstall = await installManagedHooks(initial);
    const firstReceipt = JSON.parse(
      await readFile(firstInstall.receiptPath, "utf8"),
    );
    for (const client of ["codex", "claude-code"]) {
      for (const event of ["UserPromptSubmit", "Stop"])
        await writeFile(
          path.join(
            current.stateDirectory,
            "hooks",
            `first-event-${client}-${event}-${firstReceipt.eventReceiptIds[client][event]}.json`,
          ),
          "{}\n",
          { mode: 0o600 },
        );
    }
    const upgraded = await installManagedHooks({
      ...initial,
      projectRoot: "/opt/personalmemory-v2",
    });
    assert.equal(upgraded.changed, true);
    assert.equal(upgraded.codex, "installed_untrusted");
    for (const client of ["codex", "claude-code"])
      for (const event of ["UserPromptSubmit", "Stop"])
        await assert.rejects(
          stat(
            path.join(
              current.stateDirectory,
              "hooks",
              `first-event-${client}-${event}-${firstReceipt.eventReceiptIds[client][event]}.json`,
            ),
          ),
          { code: "ENOENT" },
        );
    assert.equal(
      (
        await readManagedHookStatus({
          home: current.home,
          stateDirectory: current.stateDirectory,
        })
      ).firstEventReceived,
      false,
    );
    const codexPath = path.join(current.home, ".codex", "hooks.json");
    assert.match(await readFile(codexPath, "utf8"), /personalmemory-v2/u);
    await uninstallManagedHooks({
      ...initial,
      projectRoot: "/opt/personalmemory-v2",
    });
    const codex = JSON.parse(await readFile(codexPath, "utf8"));
    const claude = JSON.parse(
      await readFile(
        path.join(current.home, ".claude", "settings.json"),
        "utf8",
      ),
    );
    assert.deepEqual(Object.keys(codex.hooks), ["SessionStart"]);
    assert.equal(claude.theme, "dark");
    assert.deepEqual(Object.keys(claude.hooks), ["PreToolUse"]);
    await assert.rejects(stat(upgraded.receiptPath), { code: "ENOENT" });
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

test("fails closed when Codex disables or duplicates managed hook events", async () => {
  for (const contents of [
    "[features]\nhooks = false\n",
    "[features]\ncodex_hooks = false\n",
    '[features]\n"hooks" = false\n',
    "features.hooks = false\n",
    "features . hooks = false\n",
    "features = { hooks = false }\n",
    'features = { note = "#", hooks = false }\n',
    'features = { "hoo\\u006bs" = false }\n',
    "[[hooks.UserPromptSubmit]]\ncommand = 'other'\n",
    "hooks.UserPromptSubmit = [{ command = 'other' }]\n",
    "[hooks]\nStop = [{ command = 'other' }]\n",
    "[hooks]\n\"UserPromptSubmit\" = [{ command = 'other' }]\n",
    '[["hooks"."UserPromptSubmit"]]\n[["hooks"."UserPromptSubmit"."hooks"]]\ntype="command"\ncommand="echo conflict"\n',
    "hooks . UserPromptSubmit = [{ command = 'other' }]\n",
    'hooks = { SessionStart = [{ hooks = [{ command = "echo #" }] }], Stop = [{ hooks = [{ command = "echo conflict" }] }] }\n',
  ]) {
    const current = await fixture();
    try {
      await writeFile(
        path.join(current.home, ".codex", "config.toml"),
        contents,
      );
      await assert.rejects(
        installManagedHooks({
          home: current.home,
          stateDirectory: current.stateDirectory,
          projectRoot: "/opt/personalmemory",
          nodePath: process.execPath,
        }),
        /disabled|conflicts/u,
      );
    } finally {
      await rm(current.root, { recursive: true, force: true });
    }
  }
});

test("preserves unrelated Codex TOML comments and strings", async () => {
  const current = await fixture();
  try {
    await writeFile(
      path.join(current.home, ".codex", "config.toml"),
      '# hooks.Stop is documentation only\nmodel = "hooks.Stop is not configured"\n',
    );
    assert.equal(
      (
        await installManagedHooks({
          home: current.home,
          stateDirectory: current.stateDirectory,
          projectRoot: "/opt/personalmemory",
          nodePath: process.execPath,
        })
      ).changed,
      true,
    );
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

test("requires both current Codex definitions before reporting healthy", async () => {
  const current = await fixture();
  try {
    const installed = await installManagedHooks({
      home: current.home,
      stateDirectory: current.stateDirectory,
      projectRoot: "/opt/personalmemory",
      nodePath: process.execPath,
    });
    const receipt = JSON.parse(await readFile(installed.receiptPath, "utf8"));
    await writeFile(
      path.join(
        current.stateDirectory,
        "hooks",
        `first-event-codex-UserPromptSubmit-${receipt.eventReceiptIds.codex.UserPromptSubmit}.json`,
      ),
      `${JSON.stringify({
        version: 1,
        client: "codex",
        event: "UserPromptSubmit",
        definitionId: receipt.eventReceiptIds.codex.UserPromptSubmit,
      })}\n`,
      { mode: 0o600 },
    );
    const status = await readManagedHookStatus({
      home: current.home,
      stateDirectory: current.stateDirectory,
      projectRoot: "/opt/personalmemory",
      nodePath: process.execPath,
    });
    assert.equal(status.codex, "installed_untrusted");
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});
