import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { PrivateTurnStore } from "./personalmemory-hook-adapter.mjs";
import {
  HookGatewayClient,
  HookLifecycleRuntime,
  PrivateHookOutbox,
} from "./personalmemory-hook-runtime.mjs";

const RUNTIME_VERSION = 1;

async function assertPrivateDirectory(target, label) {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error(`${label} must be a private real directory`);
}

async function readPrivateFile(target, label) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error(`${label} must be a private regular file`);
  return await readFile(target, "utf8");
}

async function writePrivateJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function tokenFromEnvironment(contents) {
  const line = contents
    .trimEnd()
    .split("\n")
    .find((candidate) => candidate.startsWith("PERSONALMEMORY_AUTH_TOKEN="));
  const token = line?.slice("PERSONALMEMORY_AUTH_TOKEN=".length);
  if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token))
    throw new Error("Gateway credential is invalid");
  return token;
}

function parseRuntime(contents) {
  const value = JSON.parse(contents);
  if (
    value?.version !== RUNTIME_VERSION ||
    typeof value.gatewayBaseUrl !== "string" ||
    typeof value.authorization?.installation_id !== "string" ||
    !Number.isInteger(value.authorization?.authorization_revision) ||
    !Number.isInteger(value.authorization?.policy_revision)
  )
    throw new Error("Managed Hook runtime configuration is invalid");
  return value;
}

export async function createManagedHookRuntime(options = {}) {
  const stateDirectory = path.resolve(options.stateDirectory);
  const hooksDirectory = path.join(stateDirectory, "hooks");
  await assertPrivateDirectory(stateDirectory, "Hook state directory");
  await assertPrivateDirectory(hooksDirectory, "Hook runtime directory");
  const [credential, secret, configuration] = await Promise.all([
    readPrivateFile(
      path.join(stateDirectory, "gateway.env"),
      "Gateway credential",
    ),
    readPrivateFile(path.join(hooksDirectory, "secret"), "Hook secret"),
    readPrivateFile(
      path.join(hooksDirectory, "runtime.json"),
      "Hook runtime configuration",
    ),
  ]);
  const settings = parseRuntime(configuration);
  const hookSecret = secret.trimEnd();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(hookSecret))
    throw new Error("Hook secret is invalid");
  const gateway =
    options.gatewayFactory?.({
      baseUrl: settings.gatewayBaseUrl,
      token: tokenFromEnvironment(credential),
    }) ??
    new HookGatewayClient({
      baseUrl: settings.gatewayBaseUrl,
      token: tokenFromEnvironment(credential),
    });
  const turns = new PrivateTurnStore(path.join(hooksDirectory, "turns"));
  const outbox = new PrivateHookOutbox(path.join(hooksDirectory, "outbox"));
  const runtime = new HookLifecycleRuntime({
    gateway,
    turns,
    outbox,
    authorization: settings.authorization,
    secret: hookSecret,
    telemetry: options.telemetry,
  });
  return { runtime, turns, outbox, gateway, settings, hooksDirectory };
}

export async function recordFirstHookEvent(options) {
  const stateDirectory = path.resolve(options.stateDirectory);
  if (!new Set(["codex", "claude-code"]).has(options.client))
    throw new Error("Hook event receipt client is invalid");
  if (!/^[a-f0-9]{64}$/u.test(options.definitionId ?? ""))
    throw new Error("Hook event receipt definition is invalid");
  const target = path.join(
    stateDirectory,
    "hooks",
    `first-event-${options.client}-${options.event}-${options.definitionId}.json`,
  );
  await assertPrivateDirectory(path.dirname(target), "Hook runtime directory");
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error("Hook event receipt must be a private regular file");
    const existing = JSON.parse(await readFile(target, "utf8"));
    if (
      existing.client !== options.client ||
      existing.event !== options.event ||
      existing.definitionId !== options.definitionId
    )
      throw new Error("Hook event receipt does not match this definition");
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writePrivateJson(target, {
    version: 1,
    client: options.client,
    event: options.event,
    definitionId: options.definitionId,
    receivedAt: options.now?.() ?? Date.now(),
  });
}

export async function runHookMaintenance(options = {}) {
  const stateDirectory = path.resolve(options.stateDirectory);
  await assertPrivateDirectory(stateDirectory, "Hook state directory");
  await assertPrivateDirectory(
    path.join(stateDirectory, "hooks"),
    "Hook runtime directory",
  );
  let managed;
  const now = options.now ?? Date.now;
  let outcome = "healthy";
  let recentError;
  let retention = { status: "disabled" };
  let hookMaintenanceReady = false;
  try {
    managed =
      options.runtime && options.turns && options.outbox
        ? options
        : await createManagedHookRuntime(options);
    if (managed.gateway?.authorization) {
      const current = await managed.gateway.authorization();
      if (
        current.installation_id !==
        managed.settings.authorization.installation_id
      )
        throw new Error("Hook authorization installation identity changed");
      await writeManagedHookRuntimeConfiguration({
        stateDirectory,
        gatewayBaseUrl: managed.settings.gatewayBaseUrl,
        authorization: {
          installation_id: current.installation_id,
          authorization_revision: current.authorization_revision,
          policy_revision: current.policy_revision,
        },
        recallEnabled: current.recall_enabled,
        captureEnabled: current.capture_enabled,
      });
      managed = await createManagedHookRuntime(options);
    }
    await managed.turns.maintain();
    await managed.runtime.maintain("managed-worker", {
      maxEntries: options.maxEntries ?? 16,
    });
    hookMaintenanceReady = true;
  } catch {
    outcome = "degraded";
    recentError = "maintenance_failed";
  }
  if (
    options.retentionExecutionEnabled === true &&
    hookMaintenanceReady &&
    managed.gateway?.retentionMaintenance
  ) {
    try {
      retention = await managed.gateway.retentionMaintenance();
      if (retention.status === "partial") {
        outcome = "degraded";
        recentError = "retention_maintenance_failed";
      }
    } catch {
      outcome = "degraded";
      recentError = "retention_maintenance_failed";
      retention = { status: "partial" };
    }
  }
  let backlog;
  try {
    backlog = managed
      ? await managed.outbox.status()
      : { queued: 0, failed: 0, total: 0 };
  } catch {
    outcome = "degraded";
    recentError = "maintenance_failed";
    backlog = { queued: 0, failed: 0, total: 0 };
  }
  const statusPath = path.join(stateDirectory, "hooks", "worker-status.json");
  await writePrivateJson(statusPath, {
    version: 1,
    worker: outcome,
    workerPid: options.workerPid ?? process.pid,
    workerGeneration: options.workerGeneration ?? "test-worker",
    lastMaintenanceAt: now(),
    backlog,
    retention,
    ...(recentError ? { recentError } : {}),
  });
  return { backlog, retention, statusPath, worker: outcome };
}

export async function readHookDoctorStatus(options = {}) {
  const stateDirectory = path.resolve(options.stateDirectory);
  await assertPrivateDirectory(stateDirectory, "Hook state directory");
  await assertPrivateDirectory(
    path.join(stateDirectory, "hooks"),
    "Hook runtime directory",
  );
  const [statusText, runtimeText] = await Promise.all([
    readPrivateFile(
      path.join(stateDirectory, "hooks", "worker-status.json"),
      "Hook worker status",
    ),
    readPrivateFile(
      path.join(stateDirectory, "hooks", "runtime.json"),
      "Hook runtime configuration",
    ),
  ]);
  const status = JSON.parse(statusText);
  const now = options.now?.() ?? Date.now();
  const settings = parseRuntime(runtimeText);
  if (
    status?.version !== 1 ||
    !new Set(["healthy", "degraded"]).has(status.worker) ||
    !Number.isFinite(status.lastMaintenanceAt) ||
    !Number.isSafeInteger(status.workerPid) ||
    !/^[A-Za-z0-9_-]{8,64}$/u.test(status.workerGeneration) ||
    !["queued", "failed", "total"].every(
      (key) =>
        Number.isInteger(status.backlog?.[key]) &&
        status.backlog[key] >= 0 &&
        status.backlog[key] <= 64,
    ) ||
    status.backlog.queued + status.backlog.failed !== status.backlog.total ||
    !new Set([
      "disabled",
      "not_applicable",
      "draining",
      "drained",
      "partial",
    ]).has(status.retention?.status) ||
    (status.recentError !== undefined &&
      !new Set(["maintenance_failed", "retention_maintenance_failed"]).has(
        status.recentError,
      ))
  )
    throw new Error("Hook worker status is invalid");
  return {
    worker:
      status.worker === "healthy" &&
      status.lastMaintenanceAt <= now &&
      now - status.lastMaintenanceAt <= 120_000
        ? "healthy"
        : "degraded",
    workerPid: status.workerPid,
    workerGeneration: status.workerGeneration,
    lastMaintenanceAt: status.lastMaintenanceAt,
    backlog: status.backlog,
    retention: status.retention,
    authorization: {
      recall: settings.recallEnabled === true ? "enabled" : "disabled",
      capture: settings.captureEnabled === true ? "enabled" : "disabled",
      authorizationRevision: settings.authorization.authorization_revision,
      policyRevision: settings.authorization.policy_revision,
    },
    ...(status.recentError ? { recentError: status.recentError } : {}),
  };
}

export async function writeManagedHookRuntimeConfiguration(options) {
  const stateDirectory = path.resolve(options.stateDirectory);
  const hooksDirectory = path.join(stateDirectory, "hooks");
  await mkdir(hooksDirectory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(stateDirectory, "Hook state directory");
  await assertPrivateDirectory(hooksDirectory, "Hook runtime directory");
  await writePrivateJson(path.join(hooksDirectory, "runtime.json"), {
    version: RUNTIME_VERSION,
    gatewayBaseUrl: options.gatewayBaseUrl,
    authorization: options.authorization,
    recallEnabled: options.recallEnabled === true,
    captureEnabled: options.captureEnabled === true,
  });
}
