import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";

const RECEIPT_VERSION = 1;
const PRODUCT_VERSION = "0.1.0";
const SCHEMA_VERSION = 7;

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

async function loadOrCreateToken(secretPath) {
  try {
    const info = await lstat(secretPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new Error(
        "Existing Gateway credential must be a private regular file",
      );
    }
    const contents = await readFile(secretPath, "utf8");
    const lines = contents.trimEnd().split("\n");
    if (
      lines.length !== 3 ||
      lines[0] !== "PERSONALMEMORY_AUTH_ENABLED=true" ||
      !lines[1].startsWith("PERSONALMEMORY_AUTH_TOKEN=") ||
      lines[2] !== "PERSONALMEMORY_MODEL_ENABLED=false"
    ) {
      throw new Error("Existing Gateway credential has an invalid format");
    }
    const token = lines[1].slice("PERSONALMEMORY_AUTH_TOKEN=".length);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      throw new Error("Existing Gateway credential token is invalid");
    }
    return token;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  await writePrivateAtomic(
    secretPath,
    `PERSONALMEMORY_AUTH_ENABLED=true\nPERSONALMEMORY_AUTH_TOKEN=${token}\nPERSONALMEMORY_MODEL_ENABLED=false\n`,
  );
  return token;
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
  const root = options.root ?? path.resolve(import.meta.dirname, "..");
  const dataDirectory = path.resolve(
    options.dataDirectory ??
      process.env.PERSONALMEMORY_DATA_DIR ??
      defaultInstallRoot(),
  );
  const runtimeDirectory = path.resolve(
    options.stateDirectory ??
      process.env.PERSONALMEMORY_STATE_DIR ??
      defaultStateRoot(),
  );
  if (
    runtimeDirectory === dataDirectory ||
    runtimeDirectory.startsWith(`${dataDirectory}${path.sep}`)
  ) {
    throw new Error(
      "PERSONALMEMORY_STATE_DIR must be outside the memory data directory",
    );
  }
  const receiptPath = path.join(runtimeDirectory, "install.json");
  const secretPath = path.join(runtimeDirectory, "gateway.env");
  const logPath = path.join(runtimeDirectory, "personalmemory.log");
  const host = "127.0.0.1";
  const gatewayPort = options.gatewayPort ?? 8787;
  const webPort = options.webPort ?? 4173;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const run = options.run ?? defaultRun;
  const spawnImpl = options.spawnImpl ?? spawn;
  const assertPortAvailableImpl =
    options.assertPortAvailableImpl ?? assertPortAvailable;
  const stopStartedImpl = options.stopStartedImpl ?? stopStarted;
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;

  if (await pathExists(receiptPath)) {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (
      receipt.version !== RECEIPT_VERSION ||
      !Number.isSafeInteger(receipt.gatewayPid) ||
      !Number.isSafeInteger(receipt.webPid)
    ) {
      throw new Error(`Invalid installation receipt: ${receiptPath}`);
    }
    if (!isAlive(receipt.gatewayPid) || !isAlive(receipt.webPid)) {
      throw new Error(
        `A stopped or partial installation exists at ${receiptPath}; remove only this stale receipt before retrying`,
      );
    }
    await Promise.all([
      waitForHttp(receipt.gatewayHealthUrl, fetchImpl, 3_000),
      waitForHttp(receipt.webUrl, fetchImpl, 3_000),
    ]);
    return { ...receipt, changed: false, receiptPath };
  }

  await assertPortAvailableImpl(host, gatewayPort);
  await assertPortAvailableImpl(host, webPort);
  if (!(await pathExists(path.join(root, "node_modules"))))
    await run("npm", ["ci"], { cwd: root, stdio: "inherit" });
  await run("npm", ["run", "build:products"], { cwd: root, stdio: "inherit" });
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const token = await loadOrCreateToken(secretPath);
  const log = await open(logPath, "a", 0o600);
  const children = [];
  try {
    const common = {
      cwd: root,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    };
    const gateway = spawnImpl(
      process.execPath,
      [path.join(root, "apps", "gateway", "dist", "cli.js")],
      {
        ...common,
        env: {
          ...process.env,
          PERSONALMEMORY_HOST: host,
          PERSONALMEMORY_PORT: String(gatewayPort),
          PERSONALMEMORY_DATA_DIR: dataDirectory,
          PERSONALMEMORY_AUTH_ENABLED: "true",
          PERSONALMEMORY_AUTH_TOKEN: token,
          PERSONALMEMORY_MODEL_ENABLED: "false",
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
          ...process.env,
          PERSONALMEMORY_DEV_GATEWAY_PORT: String(gatewayPort),
        },
      },
    );
    children.push(web);
    await Promise.all([
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
    const receipt = {
      version: RECEIPT_VERSION,
      productVersion: PRODUCT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      installedAt: new Date().toISOString(),
      dataDirectory,
      gatewayPid: gateway.pid,
      webPid: web.pid,
      gatewayHealthUrl: `http://${host}:${gatewayPort}/health`,
      webUrl: `http://${host}:${webPort}/memories`,
      secretPath,
      logPath,
    };
    await writePrivateAtomic(
      receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    gateway.unref();
    web.unref();
    return { ...receipt, changed: true, receiptPath };
  } catch (error) {
    await stopStartedImpl(children);
    await rm(receiptPath, { force: true });
    throw error;
  } finally {
    await log.close();
  }
}
