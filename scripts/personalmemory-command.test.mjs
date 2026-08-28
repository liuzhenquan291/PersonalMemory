import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPersonalMemoryCommand } from "./personalmemory-command.mjs";

test("token show reveals only a valid private token in an interactive terminal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, "state");
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(stateDirectory, { mode: 0o700 }),
  );
  const token = "a".repeat(43);
  await writeFile(
    path.join(stateDirectory, "gateway.env"),
    `PERSONALMEMORY_AUTH_ENABLED=true\nPERSONALMEMORY_AUTH_TOKEN=${token}\nPERSONALMEMORY_MODEL_ENABLED=false\n`,
    { mode: 0o600 },
  );
  let output = "";

  const result = await runPersonalMemoryCommand(["token", "show"], {
    stateDirectory,
    stdout: { isTTY: true, write: (value) => (output += value) },
  });

  assert.deepEqual(result, { command: "token.show" });
  assert.equal(output, `${token}\n`);
});

test("token show refuses non-interactive output", async () => {
  await assert.rejects(
    runPersonalMemoryCommand(["token", "show"], {
      stateDirectory: "/unused",
      stdout: { isTTY: false, write() {} },
    }),
    /interactive terminal/u,
  );
});

test("lifecycle commands reuse the managed lifecycle interface", async () => {
  const calls = [];
  const runLifecycle = async (args) => {
    calls.push(args);
    return 0;
  };

  await runPersonalMemoryCommand(["status"], { runLifecycle });
  await runPersonalMemoryCommand(["restart"], { runLifecycle });
  await runPersonalMemoryCommand(["stop"], { runLifecycle });
  await runPersonalMemoryCommand(["backup", "--output", "/tmp/backup"], {
    runLifecycle,
  });

  assert.deepEqual(calls, [
    ["status"],
    ["restart"],
    ["stop"],
    ["backup", "--output", "/tmp/backup"],
  ]);
});

test("rejects malformed backup arguments before lifecycle work", async () => {
  const calls = [];
  const runLifecycle = async (args) => calls.push(args);
  for (const args of [
    ["backup", "foo", "bar"],
    ["backup", "--output", ""],
    ["backup", "--output", "/safe/backup", "--extra"],
  ]) {
    await assert.rejects(
      runPersonalMemoryCommand(args, { runLifecycle }),
      /Unknown or incomplete command/u,
    );
  }
  assert.deepEqual(calls, []);
});

test("open delegates only the installed Web URL", async () => {
  const opened = [];
  await runPersonalMemoryCommand(["open"], {
    readInstalledWebUrl: async () => "http://127.0.0.1:4173/memories",
    openUrl: async (url) => opened.push(url),
  });
  assert.deepEqual(opened, ["http://127.0.0.1:4173/memories"]);
});
