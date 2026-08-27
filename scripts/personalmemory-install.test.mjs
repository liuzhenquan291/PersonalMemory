import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import test from "node:test";
import {
  ModelAuthorizationLedger,
  defaultMigrations,
  migrateDatabase,
} from "@personalmemory/core";

import {
  assertSupportedEnvironment,
  buildModelDisabledUpstreamEnvironment,
  defaultInstallRoot,
  defaultStateRoot,
  installPersonalMemory,
  resolveManagedUpstreamEnvironment,
  waitForHookWorker,
} from "./personalmemory-install-runtime.mjs";
import { readManagedHookStatus } from "./personalmemory-hook-install.mjs";

const readyWorker = async ({ pid }) => ({
  worker: "healthy",
  workerPid: pid,
  lastMaintenanceAt: Date.now(),
});

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unref = () => undefined;
  return child;
}

test("binds worker readiness to the live pid, generation and current time", async () => {
  const pid = 42;
  const generation = "a".repeat(32);
  const current = {
    worker: "healthy",
    workerPid: pid,
    workerGeneration: generation,
    lastMaintenanceAt: Date.now(),
  };
  assert.equal(
    await waitForHookWorker({
      stateDirectory: "/unused",
      pid,
      generation,
      timeoutMs: 100,
      isAlive: () => true,
      readStatus: async () => current,
    }),
    current,
  );
  await assert.rejects(
    waitForHookWorker({
      stateDirectory: "/unused",
      pid,
      generation,
      timeoutMs: 1,
      isAlive: () => false,
      readStatus: async () => current,
    }),
    /exited/u,
  );
});

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
  assert.equal(
    defaultStateRoot({ XDG_STATE_HOME: "/state" }, "linux", "/home/test"),
    "/state/personalmemory",
  );
});

test("rejects equal or nested data and state directories", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "personalmemory-install-overlap-")),
  );
  const cases = [
    [path.join(root, "shared"), path.join(root, "shared")],
    [path.join(root, "data"), path.join(root, "data", "state")],
    [path.join(root, "state", "data"), path.join(root, "state")],
  ];

  for (const [dataDirectory, stateDirectory] of cases) {
    await assert.rejects(
      installPersonalMemory({ dataDirectory, stateDirectory }),
      /must not overlap/u,
    );
  }
  await rm(root, { recursive: true });
});

test("builds a fail-closed upstream model environment", () => {
  const environment = buildModelDisabledUpstreamEnvironment({
    TDAI_LLM_ENABLED: "true",
    TDAI_LLM_BASE_URL: "https://inherited.example.test/v1",
    TDAI_LLM_API_KEY: "inherited-secret",
    TDAI_LLM_MODEL: "inherited-model",
    MEMORY_TENCENTDB_LLM_API_KEY: "legacy-inherited-secret",
    PATH: "/test/bin",
  });

  assert.deepEqual(environment, {
    PATH: "/test/bin",
    TDAI_LLM_ENABLED: "false",
  });
});

test("maps only a currently authorized private model configuration upstream", async () => {
  const root = await realpath(
    await mkdtemp(
      path.join(os.tmpdir(), "personalmemory-install-model-authorized-"),
    ),
  );
  const stateDirectory = path.join(root, "state");
  const dataDirectory = path.join(root, "data");
  await mkdir(path.join(root, "node_modules", "vite", "bin"), {
    recursive: true,
  });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const token = "m".repeat(43);
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      path.join(stateDirectory, "gateway.env"),
      [
        "PERSONALMEMORY_AUTH_ENABLED=true",
        `PERSONALMEMORY_AUTH_TOKEN=${token}`,
        "PERSONALMEMORY_MODEL_ENABLED=true",
        "PERSONALMEMORY_MODEL_PROVIDER=openai-compatible",
        "PERSONALMEMORY_MODEL_BASE_URL=https://models.example.test/v1",
        "PERSONALMEMORY_MODEL_ALLOWED_ORIGINS=https://models.example.test",
        "PERSONALMEMORY_MODEL_API_KEY=private-model-key",
        "PERSONALMEMORY_MODEL_NAME=test-model",
        "",
      ].join("\n"),
      { mode: 0o600 },
    ),
  );
  const database = new DatabaseSync(
    path.join(dataDirectory, "personalmemory.sqlite"),
  );
  migrateDatabase(database, defaultMigrations);
  new ModelAuthorizationLedger(database).authorize({
    version: 1,
    provider: "openai-compatible",
    targetOrigin: "https://models.example.test",
    sentFields: [
      "model input",
      "selected memory context",
      "imported conversation messages",
    ],
  });
  database.close();

  const environments = [];
  let nextPid = 2_050_000;
  await installPersonalMemory({
    waitForHookWorkerImpl: readyWorker,
    root,
    home: path.join(root, "home"),
    dataDirectory,
    stateDirectory,
    gatewayPort: 0,
    webPort: 0,
    environment: {
      PATH: process.env.PATH,
      TDAI_LLM_ENABLED: "true",
      TDAI_LLM_BASE_URL: "https://inherited.example.test/v1",
      TDAI_LLM_API_KEY: "inherited-secret",
      HTTPS_PROXY: "http://proxy.example.test:8080",
      NODE_USE_ENV_PROXY: "1",
    },
    run: async () => undefined,
    assertPortAvailableImpl: async () => undefined,
    spawnImpl: (_command, _args, options) => {
      environments.push(options.env);
      return fakeChild(nextPid++);
    },
    fetchImpl: async (_url, options) =>
      options?.method === "POST"
        ? { ok: true, json: async () => ({ degraded_levels: [] }) }
        : { ok: true },
  });

  assert.equal(environments[0].TDAI_LLM_ENABLED, "true");
  assert.equal(
    environments[0].TDAI_LLM_BASE_URL,
    "https://models.example.test/v1",
  );
  assert.equal(environments[0].TDAI_LLM_API_KEY, "private-model-key");
  assert.equal(environments[0].TDAI_LLM_MODEL, "test-model");
  assert.equal(environments[0].HTTPS_PROXY, undefined);
  assert.equal(environments[0].NODE_USE_ENV_PROXY, undefined);
  assert.equal(environments[1].PERSONALMEMORY_MODEL_ENABLED, "true");
  assert.equal(environments[1].PERSONALMEMORY_MODEL_NAME, "test-model");

  const revokedDatabase = new DatabaseSync(
    path.join(dataDirectory, "personalmemory.sqlite"),
  );
  new ModelAuthorizationLedger(revokedDatabase).revoke({
    version: 1,
    provider: "openai-compatible",
    targetOrigin: "https://models.example.test",
    sentFields: [
      "model input",
      "selected memory context",
      "imported conversation messages",
    ],
  });
  revokedDatabase.close();
  const revokedEnvironment = await resolveManagedUpstreamEnvironment({
    environment: {
      PATH: process.env.PATH,
      TDAI_LLM_ENABLED: "true",
      TDAI_LLM_API_KEY: "inherited-secret",
      HTTPS_PROXY: "http://proxy.example.test:8080",
    },
    gatewayEnvironment: {
      ...environments[1],
      PERSONALMEMORY_PORT: "8787",
    },
    dataDirectory,
  });
  assert.equal(revokedEnvironment.TDAI_LLM_ENABLED, "false");
  assert.equal(revokedEnvironment.TDAI_LLM_API_KEY, undefined);
  assert.equal(revokedEnvironment.HTTPS_PROXY, undefined);
  await rm(root, { recursive: true });
});

test("builds, starts, writes private state, and reports a healthy installation", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "personalmemory-install-test-")),
  );
  const dataDirectory = path.join(root, "data");
  await mkdir(path.join(root, "node_modules", "vite", "bin"), {
    recursive: true,
  });
  const calls = [];
  let nextPid = 2_000_000;
  const result = await installPersonalMemory({
    waitForHookWorkerImpl: readyWorker,
    root,
    home: path.join(root, "home"),
    dataDirectory,
    stateDirectory: path.join(root, "state"),
    gatewayPort: 0,
    webPort: 0,
    run: async (...args) => calls.push(args),
    assertPortAvailableImpl: async () => undefined,
    spawnImpl: (...args) => {
      calls.push(args);
      return fakeChild(nextPid++);
    },
    fetchImpl: async (_url, options) =>
      options?.method === "POST"
        ? { ok: true, json: async () => ({ degraded_levels: [] }) }
        : { ok: true },
  });
  assert.equal(result.changed, true);
  assert.equal(calls[0][0], "npm");
  assert.deepEqual(calls[0][1], ["run", "build:products"]);
  assert.equal(calls.filter((call) => call[0] === process.execPath).length, 4);
  assert.equal(result.codexHookStatus, "installed_untrusted");
  assert.equal(result.claudeHookStatus, "installed");
  assert.equal(calls[1][2].env.TDAI_LLM_ENABLED, "false");
  assert.equal(calls[1][2].env.TDAI_LLM_BASE_URL, undefined);
  assert.equal(calls[1][2].env.TDAI_LLM_API_KEY, undefined);
  assert.equal(calls[1][2].env.TDAI_LLM_MODEL, undefined);
  assert.equal(calls[3][2].env.PERSONALMEMORY_DEV_GATEWAY_PORT, "0");
  assert.equal(
    calls[2][2].env.PERSONALMEMORY_STATE_DIR,
    path.join(root, "state"),
  );
  assert.equal((await stat(result.receiptPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.secretPath)).mode & 0o777, 0o600);
  const secret = await readFile(result.secretPath, "utf8");
  assert.match(secret, /PERSONALMEMORY_MODEL_ENABLED=false/);
  assert.match(secret, /PERSONALMEMORY_AUTH_TOKEN=\S+/);
  assert.doesNotMatch(await readFile(result.receiptPath, "utf8"), /AUTH_TOKEN/);
  assert.equal(
    (await stat(path.join(root, "state", "hooks", "secret"))).mode & 0o777,
    0o600,
  );

  const repeatOptions = {
    root,
    home: path.join(root, "home"),
    dataDirectory,
    stateDirectory: path.join(root, "state"),
    agents: ["codex"],
    isAliveImpl: () => true,
    readHookDoctorStatusImpl: async () => ({
      worker: "healthy",
      workerPid: result.hookWorkerPid,
      workerGeneration: result.hookWorkerGeneration,
      lastMaintenanceAt: Date.now(),
    }),
    fetchImpl: async (_url, options) =>
      options?.method === "POST"
        ? { ok: true, json: async () => ({ degraded_levels: [] }) }
        : { ok: true },
  };
  const reconfigured = await installPersonalMemory(repeatOptions);
  assert.equal(reconfigured.changed, true);
  assert.deepEqual(reconfigured.agents, ["codex"]);
  assert.equal(reconfigured.claudeHookStatus, "not_installed");
  assert.equal((await installPersonalMemory(repeatOptions)).changed, false);
  await assert.rejects(
    installPersonalMemory({ ...repeatOptions, gatewayPort: 8788 }),
    /different gateway port/u,
  );

  const hookReceipt = JSON.parse(
    await readFile(path.join(root, "state", "hooks", "install.json"), "utf8"),
  );
  const eventReceipt = path.join(
    root,
    "state",
    "hooks",
    `first-event-codex-UserPromptSubmit-${hookReceipt.eventReceiptIds.codex.UserPromptSubmit}.json`,
  );
  await writeFile(
    eventReceipt,
    `${JSON.stringify({
      version: 1,
      client: "codex",
      event: "UserPromptSubmit",
      definitionId: hookReceipt.eventReceiptIds.codex.UserPromptSubmit,
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    installPersonalMemory({
      ...repeatOptions,
      agents: ["codex", "claude-code"],
      writePrivateAtomicImpl: async () => {
        throw new Error("receipt write failed");
      },
    }),
    /receipt write failed/u,
  );
  assert.deepEqual(
    (
      await readManagedHookStatus({
        home: path.join(root, "home"),
        stateDirectory: path.join(root, "state"),
      })
    ).clients,
    ["codex"],
  );
  assert.equal((await stat(eventReceipt)).isFile(), true);
  await rm(root, { recursive: true });
});

test("does not install dependencies when they are already present", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "personalmemory-install-offline-")),
  );
  await mkdir(path.join(root, "node_modules", "vite", "bin"), {
    recursive: true,
  });
  const commands = [];
  let nextPid = 2_100_000;
  await installPersonalMemory({
    waitForHookWorkerImpl: readyWorker,
    root,
    home: path.join(root, "home"),
    dataDirectory: path.join(root, "data"),
    stateDirectory: path.join(root, "state"),
    gatewayPort: 0,
    webPort: 0,
    run: async (command, args) => commands.push([command, args]),
    assertPortAvailableImpl: async () => undefined,
    spawnImpl: () => fakeChild(nextPid++),
    fetchImpl: async (_url, options) =>
      options?.method === "POST"
        ? { ok: true, json: async () => ({ degraded_levels: [] }) }
        : { ok: true },
  });
  assert.deepEqual(commands, [["npm", ["run", "build:products"]]]);
  await rm(root, { recursive: true });
});

test("reuses a valid private credential when restarting without a receipt", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "personalmemory-install-restart-")),
  );
  const stateDirectory = path.join(root, "state");
  await mkdir(path.join(root, "node_modules", "vite", "bin"), {
    recursive: true,
  });
  await mkdir(stateDirectory, { mode: 0o700 });
  const token = "a".repeat(43);
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      path.join(stateDirectory, "gateway.env"),
      `PERSONALMEMORY_AUTH_ENABLED=true\nPERSONALMEMORY_AUTH_TOKEN=${token}\nPERSONALMEMORY_MODEL_ENABLED=false\n`,
      { mode: 0o600 },
    ),
  );
  const environments = [];
  let nextPid = 2_150_000;
  await installPersonalMemory({
    waitForHookWorkerImpl: readyWorker,
    root,
    home: path.join(root, "home"),
    dataDirectory: path.join(root, "data"),
    stateDirectory,
    gatewayPort: 0,
    webPort: 0,
    run: async () => undefined,
    assertPortAvailableImpl: async () => undefined,
    spawnImpl: (_command, _args, options) => {
      environments.push(options.env);
      return fakeChild(nextPid++);
    },
    fetchImpl: async (_url, options) =>
      options?.method === "POST"
        ? { ok: true, json: async () => ({ degraded_levels: [] }) }
        : { ok: true },
  });
  assert.equal(environments[1].PERSONALMEMORY_AUTH_TOKEN, token);
  assert.equal(
    environments[1].PERSONALMEMORY_CORS_ORIGINS,
    "http://127.0.0.1:0",
  );
  await rm(root, { recursive: true });
});

test("fails before changing data when a port is occupied", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "personalmemory-install-port-")),
  );
  await assert.rejects(
    installPersonalMemory({
      root,
      home: path.join(root, "home"),
      dataDirectory: path.join(root, "data"),
      stateDirectory: path.join(root, "state"),
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
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "personalmemory-install-failure-")),
  );
  await mkdir(path.join(root, "node_modules", "vite", "bin"), {
    recursive: true,
  });
  const children = [];
  let healthRequests = 0;
  let hookUninstallCalls = 0;
  let nextPid = 2_200_000;
  await assert.rejects(
    installPersonalMemory({
      root,
      home: path.join(root, "home"),
      dataDirectory: path.join(root, "data"),
      stateDirectory: path.join(root, "state"),
      gatewayPort: 0,
      webPort: 0,
      run: async () => undefined,
      assertPortAvailableImpl: async () => undefined,
      spawnImpl: () => fakeChild(nextPid++),
      fetchImpl: async () => {
        if (healthRequests++ === 0) return { ok: true };
        throw new Error("health unavailable");
      },
      startupTimeoutMs: 1,
      stopStartedImpl: async (started) => children.push(...started),
      uninstallManagedHooksImpl: async () => {
        hookUninstallCalls += 1;
      },
    }),
    /Timed out waiting/,
  );
  assert.equal(children.length, 3);
  assert.equal(hookUninstallCalls, 0);
  await assert.rejects(stat(path.join(root, "state", "install.json")), {
    code: "ENOENT",
  });
  await rm(root, { recursive: true });
});
