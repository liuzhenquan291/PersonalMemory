import { spawn } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";

import { installPersonalMemory } from "./personalmemory-install-runtime.mjs";
import {
  readManagedHookStatus,
  uninstallManagedHooks,
} from "./personalmemory-hook-install.mjs";
import { readHookDoctorStatus } from "./personalmemory-hook-managed.mjs";

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

  await Promise.all([
    stopImpl(receipt.webPid),
    stopImpl(receipt.gatewayPid),
    ...(receipt.version === 2 ? [stopImpl(receipt.upstreamPid)] : []),
    ...(receipt.version === 3
      ? [stopImpl(receipt.upstreamPid), stopImpl(receipt.hookWorkerPid)]
      : []),
  ]);
  if (command === "stop") {
    await removeImpl(path.join(stateDirectory, "install.json"));
    return { stopped: true, dataDirectory, stateDirectory };
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
      await installImpl({
        root,
        dataDirectory,
        stateDirectory,
        home: options.home,
      });
    }
  }

  if (command === "restore") {
    await removeImpl(path.join(stateDirectory, "install.json"));
    try {
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
        ],
        {
          cwd: root,
          stdio: "inherit",
          env: { ...process.env, PERSONALMEMORY_DATA_DIR: dataDirectory },
        },
      );
      return { restored: true, input: path.resolve(options.input) };
    } finally {
      await installImpl({
        root,
        dataDirectory,
        stateDirectory,
        home: options.home,
      });
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
