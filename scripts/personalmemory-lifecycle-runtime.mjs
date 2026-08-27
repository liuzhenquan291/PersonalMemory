import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";

import {
  DataLifecycleMutex,
  createRetentionRestoreSnapshot,
} from "@personalmemory/core";

import { installPersonalMemory } from "./personalmemory-install-runtime.mjs";
import {
  readManagedHookStatus,
  uninstallManagedHooks,
} from "./personalmemory-hook-install.mjs";
import {
  createManagedHookRuntime,
  readHookDoctorStatus,
} from "./personalmemory-hook-managed.mjs";

async function drainRetentionBeforeBackup(stateDirectory, lifecycleToken) {
  const { gateway } = await createManagedHookRuntime({ stateDirectory });
  let frozen;
  for (let batch = 0; batch < 10_000; batch += 1) {
    const result = await gateway.retentionMaintenance({ lifecycleToken });
    if (result.status === "disabled" || result.status === "not_applicable")
      return result;
    const binding = JSON.stringify({
      authorizationRevision: result.authorizationRevision,
      policyRevision: result.policyRevision,
      cutoffL0: result.cutoffL0,
      cutoffL1: result.cutoffL1,
    });
    if (frozen === undefined) frozen = binding;
    else if (binding !== frozen)
      throw new Error("Retention policy changed during backup preflight");
    if (result.status === "drained") return result;
    if (result.status !== "draining")
      throw new Error("Retention maintenance did not complete before backup");
  }
  throw new Error("Retention maintenance exceeded the backup safety bound");
}

export async function writePrivateAtomic(target, value, operations = {}) {
  const write = operations.writeFileImpl ?? writeFile;
  const setMode = operations.chmodImpl ?? chmod;
  const move = operations.renameImpl ?? rename;
  const remove = operations.removeImpl ?? rm;
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await write(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await setMode(temporary, 0o600);
    await move(temporary, target);
  } catch (error) {
    try {
      await remove(temporary, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Private atomic write failed and temporary cleanup failed: ${temporary}`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

async function createRetentionRestoreFiles(dataDirectory, stateDirectory) {
  const database = new DatabaseSync(
    path.join(dataDirectory, "personalmemory.sqlite"),
    { readOnly: true },
  );
  let snapshot;
  try {
    snapshot = createRetentionRestoreSnapshot(database);
  } finally {
    database.close();
  }
  const envelopePath = path.join(
    stateDirectory,
    "retention-restore-envelope.json",
  );
  const snapshotPath = path.join(
    stateDirectory,
    `retention-restore-snapshot-${randomUUID()}.json`,
  );
  await writePrivateAtomic(envelopePath, snapshot.envelope);
  await writePrivateAtomic(snapshotPath, snapshot);
  return snapshotPath;
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

async function assertPrivateRealDirectory(target, label) {
  const resolved = path.resolve(target);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`${label} must not be a filesystem root`);
  }
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`${label} must be private`);
  }
  return resolved;
}

async function readManagedReceipt(stateDirectoryInput) {
  const stateDirectory = await assertPrivateRealDirectory(
    stateDirectoryInput,
    "State directory",
  );
  const target = path.join(stateDirectory, "install.json");
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("Installation receipt must be a private regular file");
  }
  const receipt = JSON.parse(await readFile(target, "utf8"));
  const dataDirectory = path.resolve(receipt.dataDirectory ?? "");
  if (
    !new Set([1, 2, 3]).has(receipt.version) ||
    dataDirectory === path.parse(dataDirectory).root ||
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
    throw new Error("Installation receipt expands the managed lifecycle scope");
  }
  await assertPrivateRealDirectory(dataDirectory, "Data directory");
  if (
    stateDirectory === dataDirectory ||
    stateDirectory.startsWith(`${dataDirectory}${path.sep}`) ||
    dataDirectory.startsWith(`${stateDirectory}${path.sep}`)
  ) {
    throw new Error("State and data directories must be separate");
  }
  return { receipt, stateDirectory, dataDirectory };
}

export async function managePersonalMemory(command, options = {}) {
  const { receipt, stateDirectory, dataDirectory } = await (
    options.readManagedReceiptImpl ?? readManagedReceipt
  )(options.stateDirectory);
  const stopImpl = options.stopImpl ?? defaultStop;
  const runImpl = options.runImpl ?? defaultRun;
  const removeImpl = options.removeImpl ?? rm;
  const installImpl =
    options.installImpl ??
    ((installOptions) => installPersonalMemory(installOptions));
  const root = options.root ?? path.resolve(import.meta.dirname, "..");
  let lifecycleLease;
  let retentionRestoreSnapshotPath;

  if (
    command === "uninstall" &&
    options.purgeData &&
    options.confirm !== `DELETE ${dataDirectory}`
  ) {
    throw new Error(`Confirmation must exactly match: DELETE ${dataDirectory}`);
  }

  if (command === "status") {
    const hookInstall =
      receipt.version === 3
        ? await (options.readManagedHookStatusImpl ?? readManagedHookStatus)({
            home: options.home,
            stateDirectory,
          })
        : { installed: false };
    const hookRuntime =
      receipt.version === 3
        ? await (options.readHookDoctorStatusImpl ?? readHookDoctorStatus)({
            stateDirectory,
          }).catch(() => ({ worker: "starting" }))
        : { worker: "not_installed" };
    if (
      receipt.version === 3 &&
      (hookRuntime.workerPid !== receipt.hookWorkerPid ||
        hookRuntime.workerGeneration !== receipt.hookWorkerGeneration)
    )
      hookRuntime.worker = "degraded";
    return {
      installed: true,
      productVersion: receipt.productVersion,
      schemaVersion: receipt.schemaVersion,
      dataDirectory,
      stateDirectory,
      hooks: { ...hookInstall, ...hookRuntime },
    };
  }

  if (command === "uninstall" && receipt.version === 3) {
    const hookInstall = await (
      options.readManagedHookStatusImpl ?? readManagedHookStatus
    )({
      home: options.home,
      stateDirectory,
    });
    if (!hookInstall.installed)
      throw new Error("Managed Hook installation is incomplete");
  }

  if (command === "backup" || command === "restore") {
    const mutex =
      options.lifecycleMutex ?? new DataLifecycleMutex(stateDirectory);
    lifecycleLease = mutex.acquire({ operation: command });
    if (!lifecycleLease)
      throw new Error("Another data lifecycle operation is active");
  }
  if (command === "backup") {
    try {
      if (receipt.version === 3 || options.retentionPreflightImpl)
        await (options.retentionPreflightImpl ?? drainRetentionBeforeBackup)(
          stateDirectory,
          lifecycleLease.token,
        );
    } catch (error) {
      lifecycleLease.release();
      throw error;
    }
  }
  try {
    await Promise.all([
      stopImpl(receipt.webPid),
      stopImpl(receipt.gatewayPid),
      ...(receipt.version === 2 ? [stopImpl(receipt.upstreamPid)] : []),
      ...(receipt.version === 3
        ? [stopImpl(receipt.upstreamPid), stopImpl(receipt.hookWorkerPid)]
        : []),
    ]);
  } catch (error) {
    try {
      if (retentionRestoreSnapshotPath)
        await removeImpl(retentionRestoreSnapshotPath, { force: true });
    } finally {
      lifecycleLease?.release();
    }
    throw error;
  }
  if (command === "stop") {
    await removeImpl(path.join(stateDirectory, "install.json"));
    return { stopped: true, dataDirectory, stateDirectory };
  }

  if (command === "restart") {
    await removeImpl(path.join(stateDirectory, "install.json"));
    await installImpl({
      root,
      dataDirectory,
      stateDirectory,
      home: options.home,
      agents: receipt.agents,
    });
    return { restarted: true, dataDirectory, stateDirectory };
  }

  if (command === "backup") {
    await removeImpl(path.join(stateDirectory, "install.json"));
    try {
      await runImpl(
        "npm",
        ["run", "data:backup", "--", "--output", options.output],
        {
          cwd: root,
          stdio: "inherit",
          env: { ...process.env, PERSONALMEMORY_DATA_DIR: dataDirectory },
        },
      );
      await runImpl(
        "npm",
        ["run", "data:verify", "--", "--input", options.output],
        { cwd: root, stdio: "inherit" },
      );
      return { backedUp: true, output: path.resolve(options.output) };
    } finally {
      try {
        await installImpl({
          root,
          dataDirectory,
          stateDirectory,
          home: options.home,
          agents: receipt.agents,
        });
      } finally {
        lifecycleLease?.release();
      }
    }
  }

  if (command === "restore") {
    await removeImpl(path.join(stateDirectory, "install.json"));
    try {
      retentionRestoreSnapshotPath = await (
        options.createRetentionRestoreFilesImpl ?? createRetentionRestoreFiles
      )(dataDirectory, stateDirectory);
      await runImpl(
        "npm",
        ["run", "data:verify", "--", "--input", options.input],
        { cwd: root, stdio: "inherit" },
      );
      await runImpl(
        "npm",
        [
          "run",
          "data:restore",
          "--",
          "--input",
          options.input,
          "--confirm",
          `RESTORE ${dataDirectory}`,
          "--retention-envelope",
          retentionRestoreSnapshotPath,
        ],
        {
          cwd: root,
          stdio: "inherit",
          env: { ...process.env, PERSONALMEMORY_DATA_DIR: dataDirectory },
        },
      );
      return { restored: true, input: path.resolve(options.input) };
    } finally {
      try {
        await installImpl({
          root,
          dataDirectory,
          stateDirectory,
          home: options.home,
          agents: receipt.agents,
        });
      } finally {
        try {
          if (retentionRestoreSnapshotPath)
            await removeImpl(retentionRestoreSnapshotPath, { force: true });
        } finally {
          lifecycleLease?.release();
        }
      }
    }
  }

  if (command === "uninstall") {
    if (receipt.version === 3) {
      await (options.uninstallManagedHooksImpl ?? uninstallManagedHooks)({
        home: options.home,
        stateDirectory,
        projectRoot: root,
        nodePath: process.execPath,
      });
    }
    await removeImpl(stateDirectory, { recursive: true });
    if (options.purgeData) {
      await removeImpl(dataDirectory, { recursive: true });
      return { uninstalled: true, dataDeleted: true, dataDirectory };
    }
    return { uninstalled: true, dataDeleted: false, dataDirectory };
  }
  throw new Error(`Unsupported lifecycle command: ${command}`);
}
