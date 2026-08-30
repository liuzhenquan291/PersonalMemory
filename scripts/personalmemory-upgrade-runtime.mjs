import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";

import { DataLifecycleMutex } from "@personalmemory/core";

import {
  defaultStateRoot,
  installPersonalMemory,
} from "./personalmemory-install-runtime.mjs";
import { readManagedPorts } from "./personalmemory-install-options.mjs";
import { installManagedCommand } from "./personalmemory-command-install.mjs";

const TARGET_PRODUCT_VERSION = "0.1.3";
const TARGET_SCHEMA_VERSION = 7;
const SPACE_MARGIN_BYTES = 128 * 1024 * 1024;

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

async function readReceiptFile(stateDirectory) {
  const target = path.join(stateDirectory, "install.json");
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("Installation receipt must be a private regular file");
  }
  return JSON.parse(await readFile(target, "utf8"));
}

async function writeReceiptFile(stateDirectory, receipt) {
  const target = path.join(stateDirectory, "install.json");
  const temporary = `${target}.upgrade-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

async function removeReceiptFile(stateDirectory, receipt) {
  const current = await readReceiptFile(stateDirectory);
  if (JSON.stringify(current) !== JSON.stringify(receipt)) {
    throw new Error("Installation receipt changed during upgrade preparation");
  }
  await rm(path.join(stateDirectory, "install.json"));
}

async function measureData(dataDirectory) {
  let total = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink())
        throw new Error(`Data root contains a symbolic link: ${target}`);
      if (info.isDirectory()) await visit(target);
      else if (info.isFile()) total += info.size;
      else
        throw new Error(`Data root contains an unsupported asset: ${target}`);
    }
  }
  await visit(dataDirectory);
  return total;
}

async function defaultStop(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error("Installation receipt contains an unsafe managed PID");
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await setTimeout(50);
  }
  throw new Error(`Managed process ${pid} did not stop`);
}

function validateReceipt(receipt, dataDirectory, stateDirectory) {
  if (
    !new Set([1, 2, 3]).has(receipt.version) ||
    path.resolve(receipt.dataDirectory) !== dataDirectory ||
    path.resolve(receipt.secretPath ?? "") !==
      path.join(stateDirectory, "gateway.env") ||
    path.resolve(receipt.logPath ?? "") !==
      path.join(stateDirectory, "personalmemory.log") ||
    (receipt.version === 2 && !Number.isSafeInteger(receipt.upstreamPid)) ||
    (receipt.version === 3 &&
      (!Number.isSafeInteger(receipt.upstreamPid) ||
        !Number.isSafeInteger(receipt.hookWorkerPid) ||
        !/^[a-f0-9]{32}$/u.test(receipt.hookWorkerGeneration ?? "") ||
        (receipt.agents !== undefined &&
          (!Array.isArray(receipt.agents) ||
            receipt.agents.some(
              (agent) => !["codex", "claude-code"].includes(agent),
            ) ||
            new Set(receipt.agents).size !== receipt.agents.length)) ||
        path.resolve(receipt.hookReceiptPath ?? "") !==
          path.join(stateDirectory, "hooks", "install.json"))) ||
    !Number.isSafeInteger(receipt.gatewayPid) ||
    !Number.isSafeInteger(receipt.webPid)
  ) {
    throw new Error(
      "Installation receipt is invalid or expands the managed upgrade scope",
    );
  }
}

async function assertDiskSpace(dataDirectory, requiredBytes, statfsImpl) {
  const filesystem = await statfsImpl(path.dirname(dataDirectory));
  const available = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (!Number.isSafeInteger(available) || available < requiredBytes) {
    throw new Error(
      `Insufficient disk space for upgrade backup; need at least ${requiredBytes} bytes`,
    );
  }
}

async function upgradePersonalMemoryUnderLock(options = {}) {
  const root = options.root ?? path.resolve(import.meta.dirname, "..");
  const dataDirectory = path.resolve(options.dataDirectory);
  const stateDirectory = path.resolve(
    options.stateDirectory ??
      process.env.PERSONALMEMORY_STATE_DIR ??
      defaultStateRoot(),
  );
  if (
    stateDirectory === dataDirectory ||
    stateDirectory.startsWith(`${dataDirectory}${path.sep}`)
  ) {
    throw new Error("The state directory must be outside the memory data root");
  }
  const readReceipt = options.readReceipt ?? readReceiptFile;
  const writeReceipt = options.writeReceipt ?? writeReceiptFile;
  const removeReceipt = options.removeReceipt ?? removeReceiptFile;
  const receipt = await readReceipt(stateDirectory);
  validateReceipt(receipt, dataDirectory, stateDirectory);
  if (
    receipt.version === 3 &&
    receipt.productVersion === TARGET_PRODUCT_VERSION &&
    receipt.schemaVersion === TARGET_SCHEMA_VERSION
  ) {
    const command = await (
      options.installManagedCommandImpl ?? installManagedCommand
    )({
      sourceRoot: root,
      stateDirectory,
      binDirectory: path.resolve(
        options.commandBinDirectory ??
          path.join(options.home ?? os.homedir(), ".local", "bin"),
      ),
    });
    return {
      changed: command.changed,
      productVersion: TARGET_PRODUCT_VERSION,
      schemaVersion: TARGET_SCHEMA_VERSION,
    };
  }

  const ports = readManagedPorts(receipt);
  const dataEnvironment = {
    ...process.env,
    PERSONALMEMORY_DATA_DIR: dataDirectory,
    ...(receipt.upstreamHealthUrl
      ? {
          PERSONALMEMORY_UPSTREAM_BASE_URL: `http://127.0.0.1:${ports.upstreamPort}`,
        }
      : {}),
  };
  const runImpl = options.runImpl ?? defaultRun;
  const stopImpl = options.stopImpl ?? defaultStop;
  const installImpl =
    options.installImpl ??
    ((installOptions) => installPersonalMemory(installOptions));
  const measureDataImpl = options.measureDataImpl ?? measureData;
  const dataBytes = await measureDataImpl(dataDirectory);
  await assertDiskSpace(
    dataDirectory,
    dataBytes * 2 + SPACE_MARGIN_BYTES,
    options.statfsImpl ?? statfs,
  );
  const backupDirectory = path.join(
    stateDirectory,
    "upgrade-backups",
    `${receipt.productVersion ?? "legacy"}-to-${TARGET_PRODUCT_VERSION}-${Date.now()}`,
  );
  await runImpl("npm", ["run", "build:products"], {
    cwd: root,
    stdio: "inherit",
  });
  await Promise.all([
    stopImpl(receipt.webPid),
    stopImpl(receipt.gatewayPid),
    ...(receipt.version === 2 ? [stopImpl(receipt.upstreamPid)] : []),
    ...(receipt.version === 3
      ? [stopImpl(receipt.upstreamPid), stopImpl(receipt.hookWorkerPid)]
      : []),
  ]);
  let backupCreated = false;
  try {
    await runImpl(
      "npm",
      ["run", "data:backup", "--", "--output", backupDirectory],
      {
        cwd: root,
        stdio: "inherit",
        env: dataEnvironment,
      },
    );
    backupCreated = true;
    await runImpl(
      "npm",
      ["run", "data:verify", "--", "--input", backupDirectory],
      { cwd: root, stdio: "inherit" },
    );
    await runImpl(
      process.execPath,
      ["--import", "tsx", "scripts/personalmemory-migrate.ts"],
      {
        cwd: root,
        stdio: "inherit",
        env: dataEnvironment,
      },
    );
    await removeReceipt(stateDirectory, receipt);
    const started = await installImpl({
      ...ports,
      root,
      dataDirectory,
      stateDirectory,
      home: options.home,
      agents: receipt.agents,
    });
    const next = {
      ...started,
      installedAt: receipt.installedAt,
      upgradedAt: new Date().toISOString(),
      productVersion: TARGET_PRODUCT_VERSION,
      schemaVersion: TARGET_SCHEMA_VERSION,
    };
    await writeReceipt(stateDirectory, next);
    return {
      changed: true,
      productVersion: TARGET_PRODUCT_VERSION,
      schemaVersion: TARGET_SCHEMA_VERSION,
      backupDirectory,
    };
  } catch (upgradeError) {
    const rollbackErrors = [];
    if (backupCreated) {
      try {
        await runImpl(
          "npm",
          [
            "run",
            "data:restore",
            "--",
            "--input",
            backupDirectory,
            "--confirm",
            `RESTORE ${dataDirectory}`,
          ],
          {
            cwd: root,
            stdio: "inherit",
            env: dataEnvironment,
          },
        );
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [upgradeError, ...rollbackErrors],
        "Upgrade failed and automatic rollback was incomplete",
        { cause: upgradeError },
      );
    }
    throw new Error(
      "Upgrade failed; the verified backup was restored and services remain stopped. Run npm run install:product after resolving the reported cause",
      { cause: upgradeError },
    );
  }
}

export async function upgradePersonalMemory(options = {}) {
  const stateDirectory = path.resolve(
    options.stateDirectory ??
      process.env.PERSONALMEMORY_STATE_DIR ??
      defaultStateRoot(),
  );
  const mutex =
    options.lifecycleMutex ?? new DataLifecycleMutex(stateDirectory);
  const lease = mutex.acquire({ operation: "upgrade" });
  if (!lease) throw new Error("Another data lifecycle operation is active");
  try {
    return await upgradePersonalMemoryUnderLock(options);
  } finally {
    lease.release();
  }
}

export const upgradeTarget = Object.freeze({
  productVersion: TARGET_PRODUCT_VERSION,
  schemaVersion: TARGET_SCHEMA_VERSION,
});
