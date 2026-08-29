import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { URL } from "node:url";

import { initializeDataDirectory } from "@personalmemory/core";

import {
  installManagedHooks,
  pruneManagedHookEventReceipts,
  uninstallManagedHooks,
} from "./personalmemory-hook-install.mjs";
import {
  readHookDoctorStatus,
  writeManagedHookRuntimeConfiguration,
} from "./personalmemory-hook-managed.mjs";
import { installManagedCommand } from "./personalmemory-command-install.mjs";
import { DEFAULT_INSTALL_PORTS } from "./personalmemory-install-options.mjs";

const UPSTREAM_MODEL_ENVIRONMENT_KEYS = [
  "TDAI_LLM_ENABLED",
  "TDAI_LLM_BASE_URL",
  "TDAI_LLM_API_KEY",
  "TDAI_LLM_MODEL",
  "TDAI_LLM_MAX_TOKENS",
  "TDAI_LLM_TIMEOUT_MS",
  "MEMORY_TENCENTDB_LLM_BASE_URL",
  "MEMORY_TENCENTDB_LLM_API_KEY",
  "MEMORY_TENCENTDB_LLM_MODEL",
];
const PRODUCT_MODEL_ENVIRONMENT_KEYS = [
  "PERSONALMEMORY_MODEL_ENABLED",
  "PERSONALMEMORY_MODEL_PROVIDER",
  "PERSONALMEMORY_MODEL_BASE_URL",
  "PERSONALMEMORY_MODEL_ALLOWED_ORIGINS",
  "PERSONALMEMORY_MODEL_API_KEY",
  "PERSONALMEMORY_MODEL_NAME",
];
const PRIVATE_GATEWAY_ENVIRONMENT_KEYS = new Set([
  "PERSONALMEMORY_AUTH_ENABLED",
  "PERSONALMEMORY_AUTH_TOKEN",
  ...PRODUCT_MODEL_ENVIRONMENT_KEYS,
]);
const MODEL_PROXY_ENVIRONMENT_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NODE_USE_ENV_PROXY",
];

export function buildModelDisabledUpstreamEnvironment(environment) {
  const managed = { ...environment };
  for (const key of [
    ...UPSTREAM_MODEL_ENVIRONMENT_KEYS,
    ...MODEL_PROXY_ENVIRONMENT_KEYS,
  ])
    delete managed[key];
  managed.TDAI_LLM_ENABLED = "false";
  return managed;
}

function buildManagedGatewayEnvironment(environment, gatewayEnvironment) {
  const managed = { ...environment };
  for (const key of PRODUCT_MODEL_ENVIRONMENT_KEYS) delete managed[key];
  return { ...managed, ...gatewayEnvironment };
}

export async function resolveManagedUpstreamEnvironment({
  environment,
  gatewayEnvironment,
  dataDirectory,
}) {
  const disabled = buildModelDisabledUpstreamEnvironment(environment);
  if (gatewayEnvironment.PERSONALMEMORY_MODEL_ENABLED !== "true") {
    return disabled;
  }
  const { ModelAuthorizationLedger, getModelOutboundDisclosure, loadConfig } =
    await import("@personalmemory/core");
  const { config } = loadConfig({ environment: gatewayEnvironment });
  const disclosure = getModelOutboundDisclosure(config);
  if (!disclosure) return disabled;
  let database;
  try {
    database = new DatabaseSync(
      path.join(dataDirectory, "personalmemory.sqlite"),
      { readOnly: true },
    );
    if (
      new ModelAuthorizationLedger(database).status(disclosure).status !==
      "authorized"
    )
      return disabled;
  } catch {
    return disabled;
  } finally {
    database?.close();
  }
  return {
    ...disabled,
    TDAI_LLM_ENABLED: "true",
    TDAI_LLM_BASE_URL: config.model.baseUrl.href.replace(/\/$/u, ""),
    TDAI_LLM_API_KEY: config.model.apiKey.reveal(),
    TDAI_LLM_MODEL: config.model.name,
  };
}

export function hookInstallationId(secret) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret))
    throw new Error("Hook secret is invalid");
  return `hook-install-${createHash("sha256").update(secret).digest("hex").slice(0, 32)}`;
}

const RECEIPT_VERSION = 3;
const PRODUCT_VERSION = "0.1.1";
const SCHEMA_VERSION = 7;
const REINSTALL_FROM_STOPPED_RECEIPT = Symbol("reinstall-from-stopped-receipt");
const SUPPORTED_AGENTS = ["codex", "claude-code"];

function normalizeAgents(agents) {
  const selected = agents ?? SUPPORTED_AGENTS;
  if (
    !Array.isArray(selected) ||
    selected.some((agent) => !SUPPORTED_AGENTS.includes(agent))
  )
    throw new Error("Install agents must be codex and/or claude-code");
  return SUPPORTED_AGENTS.filter((agent) => selected.includes(agent));
}

export function assertSupportedEnvironment(options = {}) {
  const platform = options.platform ?? process.platform;
  if (!new Set(["darwin", "linux"]).has(platform)) {
    throw new Error("PersonalMemory supports macOS and Linux only");
  }
  const actual = (options.nodeVersion ?? process.versions.node)
    .split(".")
    .map(Number);
  const minimum = [22, 19, 0];
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return;
    if (actual[index] < minimum[index])
      throw new Error("Node.js 22.19.0 or newer is required");
  }
}

export function defaultInstallRoot(
  environment = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  if (platform === "darwin")
    return path.join(home, "Library", "Application Support", "PersonalMemory");
  return path.join(
    environment.XDG_DATA_HOME || path.join(home, ".local", "share"),
    "personalmemory",
  );
}

export function defaultStateRoot(
  environment = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  if (platform === "darwin")
    return path.join(
      home,
      "Library",
      "Application Support",
      "PersonalMemory Runtime",
    );
  return path.join(
    environment.XDG_STATE_HOME || path.join(home, ".local", "state"),
    "personalmemory",
  );
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function writePrivateAtomic(target, contents) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

async function loadOrCreateGatewayEnvironment(secretPath) {
  try {
    const info = await lstat(secretPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error(
        "Existing Gateway credential must be a private regular file",
      );
    }
    const contents = await readFile(secretPath, "utf8");
    const environment = {};
    for (const line of contents.trimEnd().split("\n")) {
      const separator = line.indexOf("=");
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      if (
        separator <= 0 ||
        !PRIVATE_GATEWAY_ENVIRONMENT_KEYS.has(key) ||
        Object.hasOwn(environment, key) ||
        value.length === 0
      )
        throw new Error("Existing Gateway credential has an invalid format");
      environment[key] = value;
    }
    const token = environment.PERSONALMEMORY_AUTH_TOKEN;
    if (
      environment.PERSONALMEMORY_AUTH_ENABLED !== "true" ||
      !new Set(["true", "false"]).has(environment.PERSONALMEMORY_MODEL_ENABLED)
    )
      throw new Error("Existing Gateway credential has an invalid format");
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      throw new Error("Existing Gateway credential token is invalid");
    }
    return { token, environment };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  await writePrivateAtomic(
    secretPath,
    `PERSONALMEMORY_AUTH_ENABLED=true\nPERSONALMEMORY_AUTH_TOKEN=${token}\nPERSONALMEMORY_MODEL_ENABLED=false\n`,
  );
  return {
    token,
    environment: {
      PERSONALMEMORY_AUTH_ENABLED: "true",
      PERSONALMEMORY_AUTH_TOKEN: token,
      PERSONALMEMORY_MODEL_ENABLED: "false",
    },
  };
}

async function loadOrCreateHookSecret(secretPath) {
  try {
    const info = await lstat(secretPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error("Existing Hook secret must be a private regular file");
    const secret = (await readFile(secretPath, "utf8")).trimEnd();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(secret))
      throw new Error("Existing Hook secret is invalid");
    return secret;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const secret = randomBytes(32).toString("base64url");
  await writePrivateAtomic(secretPath, `${secret}\n`);
  return secret;
}

async function assertPortAvailable(host, port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => server.close(resolve));
  });
}

async function waitForHttp(url, fetchImpl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, {
        signal: globalThis.AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await setTimeout(100);
  }
  throw new Error(`Timed out waiting for ${url}`, { cause: lastError });
}

async function waitForRecall(url, token, fetchImpl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "PersonalMemory readiness" }),
        signal: globalThis.AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const body = await response.json();
        if (
          Array.isArray(body?.degraded_levels) &&
          body.degraded_levels.length === 0
        )
          return;
        lastError = new Error("recall reported degraded memory levels");
      } else {
        lastError = new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await setTimeout(100);
  }
  throw new Error(`Timed out waiting for non-degraded recall at ${url}`, {
    cause: lastError,
  });
}

export async function waitForHookWorker(options) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (!options.isAlive(options.pid))
      throw new Error("Managed Hook worker exited before becoming ready");
    try {
      const status = await options.readStatus({
        stateDirectory: options.stateDirectory,
      });
      if (
        status.worker === "healthy" &&
        status.workerPid === options.pid &&
        status.workerGeneration === options.generation &&
        status.lastMaintenanceAt <= Date.now() &&
        Date.now() - status.lastMaintenanceAt <= 120_000
      )
        return status;
    } catch {
      // The worker may not have completed its first maintenance pass yet.
    }
    await setTimeout(50);
  }
  throw new Error("Managed Hook worker did not become ready");
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function stopStarted(children) {
  for (const child of children.reverse()) {
    if (!child.pid) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

async function defaultRun(command, args, options) {
  const child = spawn(command, args, options);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with status ${code}`)),
    );
  });
}

export async function installPersonalMemory(options = {}) {
  assertSupportedEnvironment(options);
  const environment = options.environment ?? process.env;
  const root = options.root ?? path.resolve(import.meta.dirname, "..");
  const dataDirectory = path.resolve(
    options.dataDirectory ??
      environment.PERSONALMEMORY_DATA_DIR ??
      defaultInstallRoot(environment),
  );
  const runtimeDirectory = path.resolve(
    options.stateDirectory ??
      environment.PERSONALMEMORY_STATE_DIR ??
      defaultStateRoot(environment),
  );
  if (
    runtimeDirectory === dataDirectory ||
    runtimeDirectory.startsWith(`${dataDirectory}${path.sep}`) ||
    dataDirectory.startsWith(`${runtimeDirectory}${path.sep}`)
  ) {
    throw new Error(
      "PERSONALMEMORY_STATE_DIR and PERSONALMEMORY_DATA_DIR must not overlap",
    );
  }
  const receiptPath = path.join(runtimeDirectory, "install.json");
  const secretPath = path.join(runtimeDirectory, "gateway.env");
  const hookSecretPath = path.join(runtimeDirectory, "hooks", "secret");
  const logPath = path.join(runtimeDirectory, "personalmemory.log");
  const commandBinDirectory = path.resolve(
    options.commandBinDirectory ??
      path.join(options.home ?? os.homedir(), ".local", "bin"),
  );
  const installManagedCommandImpl =
    options.installManagedCommandImpl ?? installManagedCommand;
  const host = "127.0.0.1";
  const upstreamPort =
    options.upstreamPort ?? DEFAULT_INSTALL_PORTS.upstreamPort;
  const gatewayPort = options.gatewayPort ?? DEFAULT_INSTALL_PORTS.gatewayPort;
  const webPort = options.webPort ?? DEFAULT_INSTALL_PORTS.webPort;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const run = options.run ?? defaultRun;
  const spawnImpl = options.spawnImpl ?? spawn;
  const assertPortAvailableImpl =
    options.assertPortAvailableImpl ?? assertPortAvailable;
  const stopStartedImpl = options.stopStartedImpl ?? stopStarted;
  const installManagedHooksImpl =
    options.installManagedHooksImpl ?? installManagedHooks;
  const uninstallManagedHooksImpl =
    options.uninstallManagedHooksImpl ?? uninstallManagedHooks;
  const isAliveImpl = options.isAliveImpl ?? isAlive;
  const readHookDoctorStatusImpl =
    options.readHookDoctorStatusImpl ?? readHookDoctorStatus;
  const pruneManagedHookEventReceiptsImpl =
    options.pruneManagedHookEventReceiptsImpl ?? pruneManagedHookEventReceipts;
  const writePrivateAtomicImpl =
    options.writePrivateAtomicImpl ?? writePrivateAtomic;
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;

  if (
    (await pathExists(receiptPath)) &&
    options[REINSTALL_FROM_STOPPED_RECEIPT] !== receiptPath
  ) {
    const receiptInfo = await lstat(receiptPath);
    if (
      !receiptInfo.isFile() ||
      receiptInfo.isSymbolicLink() ||
      (receiptInfo.mode & 0o077) !== 0
    )
      throw new Error(`Installation receipt must be private: ${receiptPath}`);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (
      receipt.version !== RECEIPT_VERSION ||
      !Number.isSafeInteger(receipt.upstreamPid) ||
      !Number.isSafeInteger(receipt.gatewayPid) ||
      !Number.isSafeInteger(receipt.webPid) ||
      !Number.isSafeInteger(receipt.hookWorkerPid) ||
      !/^[a-f0-9]{32}$/u.test(receipt.hookWorkerGeneration ?? "") ||
      (receipt.agents !== undefined &&
        (!Array.isArray(receipt.agents) ||
          receipt.agents.some((agent) => !SUPPORTED_AGENTS.includes(agent)) ||
          new Set(receipt.agents).size !== receipt.agents.length)) ||
      path.resolve(receipt.secretPath ?? "") !== secretPath ||
      ![
        receipt.upstreamHealthUrl,
        receipt.gatewayHealthUrl,
        receipt.recallUrl,
        receipt.webUrl,
      ].every((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "http:" &&
            new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname)
          );
        } catch {
          return false;
        }
      })
    ) {
      throw new Error(`Invalid installation receipt: ${receiptPath}`);
    }
    const managedProcessStates = [
      receipt.upstreamPid,
      receipt.gatewayPid,
      receipt.webPid,
      receipt.hookWorkerPid,
    ].map((pid) => isAliveImpl(pid));
    if (managedProcessStates.every((alive) => !alive)) {
      return installPersonalMemory({
        ...options,
        upstreamPort:
          options.upstreamPort ??
          Number(new URL(receipt.upstreamHealthUrl).port),
        gatewayPort:
          options.gatewayPort ?? Number(new URL(receipt.gatewayHealthUrl).port),
        webPort: options.webPort ?? Number(new URL(receipt.webUrl).port),
        [REINSTALL_FROM_STOPPED_RECEIPT]: receiptPath,
      });
    }
    if (managedProcessStates.some((alive) => !alive)) {
      throw new Error(
        `A partial installation exists at ${receiptPath}; stop all managed processes before retrying`,
      );
    }
    for (const [option, receiptUrl, label] of [
      [options.upstreamPort, receipt.upstreamHealthUrl, "upstream"],
      [options.gatewayPort, receipt.gatewayHealthUrl, "gateway"],
      [options.webPort, receipt.webUrl, "web"],
    ]) {
      if (option !== undefined && Number(new URL(receiptUrl).port) !== option)
        throw new Error(
          `The running installation uses a different ${label} port; stop it before changing ports`,
        );
    }
    await Promise.all([
      waitForHttp(receipt.upstreamHealthUrl, fetchImpl, 3_000),
      waitForHttp(receipt.gatewayHealthUrl, fetchImpl, 3_000),
      waitForHttp(receipt.webUrl, fetchImpl, 3_000),
    ]);
    const { token } = await loadOrCreateGatewayEnvironment(receipt.secretPath);
    await loadOrCreateHookSecret(hookSecretPath);
    await waitForRecall(receipt.recallUrl, token, fetchImpl, 3_000);
    const previousAgents = normalizeAgents(receipt.agents);
    const agents = normalizeAgents(options.agents ?? receipt.agents);
    const hookRuntime = await readHookDoctorStatusImpl({
      stateDirectory: runtimeDirectory,
    });
    if (
      hookRuntime.worker !== "healthy" ||
      hookRuntime.workerPid !== receipt.hookWorkerPid ||
      hookRuntime.workerGeneration !== receipt.hookWorkerGeneration ||
      !Number.isFinite(hookRuntime.lastMaintenanceAt) ||
      Date.now() - hookRuntime.lastMaintenanceAt > 120_000
    )
      throw new Error("Managed Hook installation or worker is not healthy");
    const hookOptions = {
      home: options.home,
      stateDirectory: runtimeDirectory,
      projectRoot: root,
      nodePath: process.execPath,
    };
    const hookInstall = await installManagedHooksImpl({
      ...hookOptions,
      clients: agents,
    });
    if (!hookInstall.installed)
      throw new Error("Managed Hook installation or worker is not healthy");
    const commandInstall = await installManagedCommandImpl({
      sourceRoot: root,
      stateDirectory: runtimeDirectory,
      binDirectory: commandBinDirectory,
    });
    const updatedReceipt = {
      ...receipt,
      agents,
      codexHookStatus: hookInstall.codex,
      claudeHookStatus: hookInstall.claude,
    };
    if (hookInstall.changed || !Array.isArray(receipt.agents)) {
      try {
        await writePrivateAtomicImpl(
          receiptPath,
          `${JSON.stringify(updatedReceipt, null, 2)}\n`,
        );
      } catch (error) {
        if (hookInstall.changed)
          await installManagedHooksImpl({
            ...hookOptions,
            clients: previousAgents,
          }).catch(() => undefined);
        throw error;
      }
    }
    await pruneManagedHookEventReceiptsImpl(hookOptions);
    return {
      ...updatedReceipt,
      commandPath: commandInstall.commandPath,
      commandPathConfigured:
        (options.environment ?? process.env).PATH?.split(
          path.delimiter,
        ).includes(commandBinDirectory) ?? false,
      changed: hookInstall.changed || commandInstall.changed,
      receiptPath,
    };
  }

  const agents = normalizeAgents(options.agents);
  await assertPortAvailableImpl(host, upstreamPort);
  await assertPortAvailableImpl(host, gatewayPort);
  await assertPortAvailableImpl(host, webPort);
  if (!(await pathExists(path.join(root, "node_modules"))))
    await run("npm", ["ci"], { cwd: root, stdio: "inherit" });
  await run("npm", ["run", "build:products"], { cwd: root, stdio: "inherit" });
  initializeDataDirectory(dataDirectory);
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const { token, environment: gatewayEnvironment } =
    await loadOrCreateGatewayEnvironment(secretPath);
  const upstreamEnvironment = await resolveManagedUpstreamEnvironment({
    environment,
    gatewayEnvironment,
    dataDirectory,
  });
  const hookSecret = await loadOrCreateHookSecret(hookSecretPath);
  const installationId = hookInstallationId(hookSecret);
  await writeManagedHookRuntimeConfiguration({
    stateDirectory: runtimeDirectory,
    gatewayBaseUrl: `http://${host}:${gatewayPort}`,
    authorization: {
      installation_id: installationId,
      authorization_revision: 1,
      policy_revision: 1,
    },
    recallEnabled: false,
    captureEnabled: false,
  });
  const log = await open(logPath, "a", 0o600);
  const children = [];
  const hookReceiptExisted = await pathExists(
    path.join(runtimeDirectory, "hooks", "install.json"),
  );
  let hookInstallCompleted = false;
  let rollbackManagedCommand;
  try {
    const common = {
      cwd: root,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    };
    const upstream = spawnImpl(
      process.execPath,
      ["--import", "tsx", path.join(root, "src", "gateway", "server.ts")],
      {
        ...common,
        env: {
          ...upstreamEnvironment,
          TDAI_GATEWAY_HOST: host,
          TDAI_GATEWAY_PORT: String(upstreamPort),
          TDAI_DATA_DIR: dataDirectory,
        },
      },
    );
    children.push(upstream);
    await waitForHttp(
      `http://${host}:${upstreamPort}/health`,
      fetchImpl,
      startupTimeoutMs,
    );
    const gateway = spawnImpl(
      process.execPath,
      [path.join(root, "apps", "gateway", "dist", "cli.js")],
      {
        ...common,
        env: {
          ...buildManagedGatewayEnvironment(environment, gatewayEnvironment),
          PERSONALMEMORY_HOST: host,
          PERSONALMEMORY_PORT: String(gatewayPort),
          PERSONALMEMORY_CORS_ORIGINS: `http://${host}:${webPort}`,
          PERSONALMEMORY_DATA_DIR: dataDirectory,
          PERSONALMEMORY_STATE_DIR: runtimeDirectory,
          PERSONALMEMORY_AUTH_ENABLED: "true",
          PERSONALMEMORY_AUTH_TOKEN: token,
          PERSONALMEMORY_HOOK_INSTALLATION_ID: installationId,
        },
      },
    );
    children.push(gateway);
    const web = spawnImpl(
      process.execPath,
      [
        path.join(root, "node_modules", "vite", "bin", "vite.js"),
        "preview",
        "--host",
        host,
        "--port",
        String(webPort),
        "--strictPort",
      ],
      {
        ...common,
        cwd: path.join(root, "apps", "web"),
        env: {
          ...environment,
          PERSONALMEMORY_DEV_GATEWAY_PORT: String(gatewayPort),
        },
      },
    );
    children.push(web);
    await Promise.all([
      waitForHttp(
        `http://${host}:${upstreamPort}/health`,
        fetchImpl,
        startupTimeoutMs,
      ),
      waitForHttp(
        `http://${host}:${gatewayPort}/health`,
        fetchImpl,
        startupTimeoutMs,
      ),
      waitForHttp(
        `http://${host}:${webPort}/memories`,
        fetchImpl,
        startupTimeoutMs,
      ),
    ]);
    await waitForRecall(
      `http://${host}:${gatewayPort}/api/v1/recall/query`,
      token,
      fetchImpl,
      startupTimeoutMs,
    );
    const hookWorkerGeneration = randomBytes(16).toString("hex");
    const hookWorker = spawnImpl(
      process.execPath,
      [path.join(root, "scripts", "personalmemory-hook-worker.mjs")],
      {
        ...common,
        env: {
          ...environment,
          PERSONALMEMORY_STATE_DIR: runtimeDirectory,
          PERSONALMEMORY_HOOK_WORKER_GENERATION: hookWorkerGeneration,
        },
      },
    );
    children.push(hookWorker);
    await (options.waitForHookWorkerImpl ?? waitForHookWorker)({
      stateDirectory: runtimeDirectory,
      pid: hookWorker.pid,
      generation: hookWorkerGeneration,
      timeoutMs: startupTimeoutMs,
      isAlive: isAliveImpl,
      readStatus: readHookDoctorStatusImpl,
    });
    const hookInstall = await installManagedHooksImpl({
      home: options.home,
      stateDirectory: runtimeDirectory,
      projectRoot: root,
      nodePath: process.execPath,
      clients: agents,
    });
    hookInstallCompleted = true;
    const commandInstall = await installManagedCommandImpl({
      sourceRoot: root,
      stateDirectory: runtimeDirectory,
      binDirectory: commandBinDirectory,
    });
    rollbackManagedCommand = commandInstall.rollback;
    const receipt = {
      version: RECEIPT_VERSION,
      productVersion: PRODUCT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      installedAt: new Date().toISOString(),
      dataDirectory,
      upstreamPid: upstream.pid,
      gatewayPid: gateway.pid,
      webPid: web.pid,
      hookWorkerPid: hookWorker.pid,
      hookWorkerGeneration,
      agents,
      codexHookStatus: hookInstall.codex,
      claudeHookStatus: hookInstall.claude,
      upstreamHealthUrl: `http://${host}:${upstreamPort}/health`,
      gatewayHealthUrl: `http://${host}:${gatewayPort}/health`,
      recallUrl: `http://${host}:${gatewayPort}/api/v1/recall/query`,
      webUrl: `http://${host}:${webPort}/memories`,
      secretPath,
      hookReceiptPath: hookInstall.receiptPath,
      logPath,
    };
    await pruneManagedHookEventReceiptsImpl({
      home: options.home,
      stateDirectory: runtimeDirectory,
      projectRoot: root,
      nodePath: process.execPath,
    });
    await writePrivateAtomicImpl(
      receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    upstream.unref();
    gateway.unref();
    web.unref();
    hookWorker.unref();
    return {
      ...receipt,
      commandPath: commandInstall.commandPath,
      commandPathConfigured:
        (options.environment ?? process.env).PATH?.split(
          path.delimiter,
        ).includes(commandBinDirectory) ?? false,
      changed: true,
      receiptPath,
    };
  } catch (error) {
    await stopStartedImpl(children);
    if (hookInstallCompleted && !hookReceiptExisted)
      await uninstallManagedHooksImpl({
        home: options.home,
        stateDirectory: runtimeDirectory,
        projectRoot: root,
        nodePath: process.execPath,
      }).catch(() => undefined);
    if (rollbackManagedCommand)
      await rollbackManagedCommand().catch(() => undefined);
    if (options[REINSTALL_FROM_STOPPED_RECEIPT] !== receiptPath)
      await rm(receiptPath, { force: true });
    throw error;
  } finally {
    await log.close();
  }
}
