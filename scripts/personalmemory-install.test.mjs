import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import test from "node:test";

import {
  assertSupportedEnvironment,
  defaultInstallRoot,
  installPersonalMemory,
} from "./personalmemory-install-runtime.mjs";

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => undefined;
  return child;
}

test("checks the supported platform and minimum Node version", () => {
  assert.doesNotThrow(() =>
    assertSupportedEnvironment({ platform: "darwin", nodeVersion: "22.19.0" }),
  );
  assert.doesNotThrow(() =>
    assertSupportedEnvironment({ platform: "linux", nodeVersion: "23.0.0" }),
  );
  assert.throws(
    () =>
      assertSupportedEnvironment({ platform: "win32", nodeVersion: "22.19.0" }),
    /macOS and Linux/,
  );
  assert.throws(
    () =>
      assertSupportedEnvironment({ platform: "linux", nodeVersion: "22.18.9" }),
    /22\.19\.0/,
  );
});

test("selects native private data roots", () => {
  assert.equal(
    defaultInstallRoot({}, "darwin", "/Users/test"),
    "/Users/test/Library/Application Support/PersonalMemory",
  );
  assert.equal(
    defaultInstallRoot({}, "linux", "/home/test"),
    "/home/test/.local/share/personalmemory",
  );
  assert.equal(
    defaultInstallRoot({ XDG_DATA_HOME: "/data" }, "linux", "/home/test"),
    "/data/personalmemory",
  );
});

test("builds, starts, writes private state, and reports a healthy installation", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "personalmemory-install-test-"),
  );
  const dataDirectory = path.join(root, "data");
  await mkdir(path.join(root, "node_modules", "vite", "bin"), {
    recursive: true,
  });
  const calls = [];
  let nextPid = 2_000_000;
  const result = await installPersonalMemory({
    root,
    dataDirectory,
    gatewayPort: 0,
    webPort: 0,
    run: async (...args) => calls.push(args),
    assertPortAvailableImpl: async () => undefined,
    spawnImpl: (...args) => {
      calls.push(args);
      return fakeChild(nextPid++);
    },
    fetchImpl: async () => ({ ok: true }),
  });
  assert.equal(result.changed, true);
  assert.equal(calls[0][0], "npm");
  assert.deepEqual(calls[0][1], ["run", "build:products"]);
  assert.equal(calls.filter((call) => call[0] === process.execPath).length, 2);
  assert.equal(calls[2][2].env.PERSONALMEMORY_DEV_GATEWAY_PORT, "0");
  assert.equal((await stat(result.receiptPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.secretPath)).mode & 0o777, 0o600);
  const secret = await readFile(result.secretPath, "utf8");
  assert.match(secret, /PERSONALMEMORY_MODEL_ENABLED=false/);
  assert.match(secret, /PERSONALMEMORY_AUTH_TOKEN=\S+/);
  assert.doesNotMatch(await readFile(result.receiptPath, "utf8"), /AUTH_TOKEN/);
  await rm(root, { recursive: true });
});

test("does not install dependencies when they are already present", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "personalmemory-install-offline-"),
  );
  await mkdir(path.join(root, "node_modules", "vite", "bin"), {
    recursive: true,
  });
  const commands = [];
  let nextPid = 2_100_000;
  await installPersonalMemory({
    root,
    dataDirectory: path.join(root, "data"),
    gatewayPort: 0,
    webPort: 0,
    run: async (command, args) => commands.push([command, args]),
    assertPortAvailableImpl: async () => undefined,
    spawnImpl: () => fakeChild(nextPid++),
    fetchImpl: async () => ({ ok: true }),
  });
  assert.deepEqual(commands, [["npm", ["run", "build:products"]]]);
  await rm(root, { recursive: true });
});

test("fails before changing data when a port is occupied", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "personalmemory-install-port-"),
  );
  await assert.rejects(
    installPersonalMemory({
      root,
      dataDirectory: path.join(root, "data"),
      assertPortAvailableImpl: async () => {
        throw new Error("EADDRINUSE");
      },
    }),
    /EADDRINUSE/,
  );
  await assert.rejects(stat(path.join(root, "data")), { code: "ENOENT" });
  await rm(root, { recursive: true });
});

test("cleans started services and leaves no receipt after failed health checks", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "personalmemory-install-failure-"),
  );
  await mkdir(path.join(root, "node_modules", "vite", "bin"), {
    recursive: true,
  });
  const children = [];
  let nextPid = 2_200_000;
  await assert.rejects(
    installPersonalMemory({
      root,
      dataDirectory: path.join(root, "data"),
      gatewayPort: 0,
      webPort: 0,
      run: async () => undefined,
      assertPortAvailableImpl: async () => undefined,
      spawnImpl: () => fakeChild(nextPid++),
      fetchImpl: async () => {
        throw new Error("health unavailable");
      },
      startupTimeoutMs: 1,
      stopStartedImpl: async (started) => children.push(...started),
    }),
    /Timed out waiting/,
  );
  assert.equal(children.length, 2);
  await assert.rejects(
    stat(path.join(root, "data", "runtime", "install.json")),
    { code: "ENOENT" },
  );
  await rm(root, { recursive: true });
});
