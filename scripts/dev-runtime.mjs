import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const DEFAULT_GATEWAY_PORT = 8787;
const DEFAULT_UPSTREAM_PORT = 8420;
const DEFAULT_WEB_PORT = 4173;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const FORCE_KILL_TIMEOUT_MS = 1_000;
const STARTUP_TIMEOUT_MS = 30_000;

export class DevRuntimeStoppedError extends Error {
  constructor() {
    super("Development startup was stopped");
    this.name = "DevRuntimeStoppedError";
  }
}

function projectRootFromModule() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function parseDevPort(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

export async function assertPortAvailable(host, port) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      reject(
        new Error(
          `Port ${host}:${port} is unavailable${error.code ? ` (${error.code})` : ""}`,
          { cause: error },
        ),
      );
    });
    probe.listen(port, host, () => probe.close(resolve));
  });
}

function abortableDelay(durationMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? STARTUP_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const signal = options.signal;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason;
    try {
      const requestSignal = signal
        ? globalThis.AbortSignal.any([
            signal,
            globalThis.AbortSignal.timeout(1_000),
          ])
        : globalThis.AbortSignal.timeout(1_000);
      const response = await fetchImpl(url, { signal: requestSignal });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      lastError = error;
    }
    await abortableDelay(100, signal);
  }
  throw new Error(`Timed out waiting for ${url}`, { cause: lastError });
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function signalProcessTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      if (child.exitCode === null) child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForTreeExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive =
      process.platform === "win32"
        ? child.exitCode === null
        : !!child.pid && processGroupExists(child.pid);
    if (!alive) return true;
    await abortableDelay(25);
  }
  return false;
}

export async function stopChild(child, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  if (!child.pid) return;
  const alive =
    process.platform === "win32"
      ? child.exitCode === null
      : processGroupExists(child.pid);
  if (!alive) return;
  signalProcessTree(child, "SIGTERM");
  if (await waitForTreeExit(child, timeoutMs)) return;
  signalProcessTree(child, "SIGKILL");
  if (!(await waitForTreeExit(child, FORCE_KILL_TIMEOUT_MS))) {
    throw new Error(`Process tree ${child.pid} did not exit after SIGKILL`);
  }
}

async function validateExistingChain(target) {
  const effectiveUserId = process.geteuid?.();
  const chain = [];
  let cursor = path.resolve(target);
  for (;;) {
    chain.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const component of chain.reverse()) {
    const componentStat = await lstat(component);
    if (componentStat.isSymbolicLink() || !componentStat.isDirectory()) {
      throw new Error(
        `Development temporary path must contain real directories: ${component}`,
      );
    }
    if (
      effectiveUserId !== undefined &&
      componentStat.uid !== 0 &&
      componentStat.uid !== effectiveUserId
    ) {
      throw new Error(
        `Development temporary path has an unsafe owner: ${component}`,
      );
    }
    if ((componentStat.mode & 0o022) !== 0) {
      throw new Error(
        `Development temporary path is writable by other users: ${component}`,
      );
    }
  }
}

async function validateTemporaryRoot(temporaryRoot) {
  const resolvedRoot = path.resolve(temporaryRoot);
  let existingAncestor = resolvedRoot;
  for (;;) {
    try {
      const ancestorStat = await lstat(existingAncestor);
      if (ancestorStat.isSymbolicLink() || !ancestorStat.isDirectory()) {
        throw new Error(
          `Development temporary path must contain real directories: ${existingAncestor}`,
        );
      }
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      existingAncestor = parent;
    }
  }
  await validateExistingChain(existingAncestor);
  await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  await validateExistingChain(resolvedRoot);
  const rootStat = await lstat(resolvedRoot);
  if ((rootStat.mode & 0o777) !== 0o700) {
    throw new Error(
      "Development temporary root permissions must be exactly 0700",
    );
  }
}

function isManagedRunDirectory(directory, temporaryRoot, prefix) {
  if (typeof directory !== "string") return false;
  const resolvedDirectory = path.resolve(directory);
  return (
    path.dirname(resolvedDirectory) === path.resolve(temporaryRoot) &&
    path.basename(resolvedDirectory).startsWith(prefix)
  );
}

export async function createDevRuntime(options = {}) {
  const root = options.root ?? projectRootFromModule();
  const host = "127.0.0.1";
  const gatewayPort = options.gatewayPort ?? DEFAULT_GATEWAY_PORT;
  const upstreamPort = options.upstreamPort ?? DEFAULT_UPSTREAM_PORT;
  const webPort = options.webPort ?? DEFAULT_WEB_PORT;
  const spawnImpl = options.spawnImpl ?? spawn;
  const stopChildImpl = options.stopChildImpl ?? stopChild;
  const onUnexpectedExit = options.onUnexpectedExit ?? (() => undefined);
  const temporaryRoot =
    options.temporaryRoot ?? path.join(root, ".personalmemory-dev");
  await validateTemporaryRoot(temporaryRoot);
  const mkdtempImpl = options.mkdtempImpl ?? mkdtemp;
  let dataDirectory;
  let stateDirectory;
  try {
    dataDirectory = await mkdtempImpl(
      path.join(temporaryRoot, "personalmemory-dev-data-"),
    );
    stateDirectory = await mkdtempImpl(
      path.join(temporaryRoot, "personalmemory-dev-state-"),
    );
    const dataStat = await lstat(dataDirectory);
    const stateStat = await lstat(stateDirectory);
    if (
      !dataStat.isDirectory() ||
      dataStat.isSymbolicLink() ||
      (dataStat.mode & 0o777) !== 0o700 ||
      !stateStat.isDirectory() ||
      stateStat.isSymbolicLink() ||
      (stateStat.mode & 0o777) !== 0o700
    ) {
      throw new Error(
        "Development data and state directories must be real 0700 directories",
      );
    }
  } catch (error) {
    await Promise.all(
      [
        [dataDirectory, "personalmemory-dev-data-"],
        [stateDirectory, "personalmemory-dev-state-"],
      ]
        .filter(([directory, prefix]) =>
          isManagedRunDirectory(directory, temporaryRoot, prefix),
        )
        .map(([directory]) => rm(directory, { recursive: true, force: true })),
    );
    throw error;
  }

  await writeFile(
    path.join(stateDirectory, "gateway.env"),
    "PERSONALMEMORY_MODEL_ENABLED=false\n",
    { mode: 0o600, flag: "wx" },
  );

  const children = [];
  const startupController = new globalThis.AbortController();
  let stopping = false;
  let cleanupPromise;
  let rejectUnexpectedExit;
  const unexpectedExit = new Promise((_, reject) => {
    rejectUnexpectedExit = reject;
  });

  function assertNotStopping() {
    if (stopping || startupController.signal.aborted) {
      throw new DevRuntimeStoppedError();
    }
  }

  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    stopping = true;
    startupController.abort(new DevRuntimeStoppedError());
    cleanupPromise = (async () => {
      const stopResults = await Promise.allSettled(
        [...children].reverse().map((child) => stopChildImpl(child)),
      );
      let deletionError;
      try {
        const resolvedData = path.resolve(dataDirectory);
        const resolvedState = path.resolve(stateDirectory);
        const resolvedTemp = path.resolve(temporaryRoot);
        if (
          !isManagedRunDirectory(
            resolvedData,
            resolvedTemp,
            "personalmemory-dev-data-",
          ) ||
          !isManagedRunDirectory(
            resolvedState,
            resolvedTemp,
            "personalmemory-dev-state-",
          )
        ) {
          throw new Error("Refusing to clean an unexpected development path");
        }
        await Promise.all([
          rm(resolvedData, { recursive: true, force: true }),
          rm(resolvedState, { recursive: true, force: true }),
        ]);
      } catch (error) {
        deletionError = error;
      }
      const failures = stopResults
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (deletionError) failures.push(deletionError);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Development cleanup failed");
      }
    })();
    return cleanupPromise;
  }

  function handleUnexpectedExit(service, code, signal) {
    if (stopping) return;
    const error = new Error(
      `${service} exited before shutdown (${signal ?? code ?? "unknown"})`,
    );
    process.stderr.write(`${error.message}\n`);
    onUnexpectedExit(error);
    rejectUnexpectedExit(error);
    void cleanup().catch(onUnexpectedExit);
  }

  async function start() {
    try {
      assertNotStopping();
      await assertPortAvailable(host, upstreamPort);
      assertNotStopping();
      await assertPortAvailable(host, gatewayPort);
      assertNotStopping();
      await assertPortAvailable(host, webPort);
      assertNotStopping();
      await options.afterPortCheck?.();
      assertNotStopping();

      const common = {
        cwd: root,
        detached: process.platform !== "win32",
        env: { ...process.env },
        stdio: options.stdio ?? "inherit",
      };
      const upstream = spawnImpl(
        process.execPath,
        ["--import", "tsx", "src/gateway/server.ts"],
        {
          ...common,
          env: {
            ...common.env,
            TDAI_GATEWAY_HOST: host,
            TDAI_GATEWAY_PORT: String(upstreamPort),
            TDAI_DATA_DIR: dataDirectory,
            TDAI_LLM_ENABLED: "false",
          },
        },
      );
      children.push(upstream);
      let upstreamSettled = false;
      upstream.once("error", (error) => {
        if (upstreamSettled) return;
        upstreamSettled = true;
        handleUnexpectedExit(
          "Upstream Gateway",
          error.code ?? "spawn-error",
          undefined,
        );
      });
      upstream.once("exit", (code, signal) => {
        if (upstreamSettled) return;
        upstreamSettled = true;
        handleUnexpectedExit("Upstream Gateway", code, signal);
      });

      await Promise.race([
        waitForHttp(`http://${host}:${upstreamPort}/health`, {
          signal: startupController.signal,
        }),
        unexpectedExit,
      ]);
      assertNotStopping();

      const gateway = spawnImpl(
        process.execPath,
        ["--import", "tsx", "apps/gateway/src/cli.ts"],
        {
          ...common,
          env: {
            ...common.env,
            PERSONALMEMORY_HOST: host,
            PERSONALMEMORY_PORT: String(gatewayPort),
            PERSONALMEMORY_DATA_DIR: dataDirectory,
            PERSONALMEMORY_STATE_DIR: stateDirectory,
            PERSONALMEMORY_UPSTREAM_BASE_URL: `http://${host}:${upstreamPort}`,
            PERSONALMEMORY_HOOK_INSTALLATION_ID:
              "hook-install-00000000000000000000000000000000",
          },
        },
      );
      children.push(gateway);
      let gatewaySettled = false;
      gateway.once("error", (error) => {
        if (gatewaySettled) return;
        gatewaySettled = true;
        handleUnexpectedExit("Gateway", error.code ?? "spawn-error", undefined);
      });
      gateway.once("exit", (code, signal) => {
        if (gatewaySettled) return;
        gatewaySettled = true;
        handleUnexpectedExit("Gateway", code, signal);
      });

      const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
      const web = spawnImpl(
        process.execPath,
        [viteBin, "--host", host, "--port", String(webPort), "--strictPort"],
        {
          ...common,
          cwd: path.join(root, "apps", "web"),
          env: {
            ...common.env,
            PERSONALMEMORY_DEV_GATEWAY_PORT: String(gatewayPort),
          },
        },
      );
      children.push(web);
      let webSettled = false;
      web.once("error", (error) => {
        if (webSettled) return;
        webSettled = true;
        handleUnexpectedExit("Web", error.code ?? "spawn-error", undefined);
      });
      web.once("exit", (code, signal) => {
        if (webSettled) return;
        webSettled = true;
        handleUnexpectedExit("Web", code, signal);
      });

      await Promise.race([
        Promise.all([
          waitForHttp(`http://${host}:${gatewayPort}/health`, {
            signal: startupController.signal,
          }),
          waitForHttp(`http://${host}:${webPort}/memories`, {
            signal: startupController.signal,
          }),
        ]),
        unexpectedExit,
      ]);
      assertNotStopping();
      return {
        upstreamUrl: `http://${host}:${upstreamPort}`,
        gatewayUrl: `http://${host}:${gatewayPort}`,
        webUrl: `http://${host}:${webPort}/memories`,
        dataDirectory,
        stateDirectory,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  return { start, stop: cleanup, children, dataDirectory, stateDirectory };
}
