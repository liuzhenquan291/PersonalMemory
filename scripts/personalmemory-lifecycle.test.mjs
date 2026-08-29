import assert from "node:assert/strict";
import test from "node:test";

import {
  managePersonalMemory,
  writePrivateAtomic,
} from "./personalmemory-lifecycle-runtime.mjs";

function fixture() {
  const calls = [];
  const dataDirectory = "/safe/data";
  const stateDirectory = "/safe/state";
  const receipt = {
    version: 2,
    productVersion: "0.1.1",
    schemaVersion: 7,
    upstreamPid: 40,
    gatewayPid: 41,
    webPid: 42,
    upstreamHealthUrl: "http://127.0.0.1:8420/health",
    gatewayHealthUrl: "http://127.0.0.1:8788/health",
    webUrl: "http://127.0.0.1:4173/memories",
  };
  return {
    calls,
    dataDirectory,
    stateDirectory,
    options: {
      root: "/safe/repo",
      stateDirectory,
      readManagedReceiptImpl: async () => ({
        receipt,
        dataDirectory,
        stateDirectory,
      }),
      stopImpl: async (pid) => calls.push(["stop", pid]),
      runImpl: async (command, args) => calls.push([command, args]),
      removeImpl: async (...args) => calls.push(["remove", ...args]),
      installImpl: async (installOptions) =>
        calls.push(["install", installOptions]),
      validateManagedCommandImpl: async () => calls.push(["validate-command"]),
      uninstallManagedCommandImpl: async (commandOptions) =>
        calls.push(["uninstall-command", commandOptions]),
      lifecycleMutex: {
        acquire: () => ({
          token: "fixture-lifecycle-token",
          release: () => calls.push(["release"]),
        }),
      },
      retentionPreflightImpl: async (_stateDirectory, token) =>
        calls.push(["retention", token]),
      createRetentionRestoreFilesImpl: async () => {
        calls.push(["retention-restore-snapshot"]);
        return "/safe/state/retention-restore-snapshot.json";
      },
    },
  };
}

test("cleans private atomic-write temporaries after every failed stage", async () => {
  for (const failedStage of ["write", "chmod", "rename"]) {
    const calls = [];
    const fail = async () => {
      throw new Error(`${failedStage} failed`);
    };
    await assert.rejects(
      writePrivateAtomic(
        "/safe/state/snapshot.json",
        { private: true },
        {
          writeFileImpl:
            failedStage === "write"
              ? fail
              : async (target) => calls.push(["write", target]),
          chmodImpl:
            failedStage === "chmod"
              ? fail
              : async (target) => calls.push(["chmod", target]),
          renameImpl:
            failedStage === "rename"
              ? fail
              : async (source) => calls.push(["rename", source]),
          removeImpl: async (target) => calls.push(["remove", target]),
        },
      ),
      new RegExp(`${failedStage} failed`, "u"),
    );
    const writtenPath = calls.find((call) => call[0] === "write")?.[1];
    const removedPath = calls.find((call) => call[0] === "remove")?.[1];
    assert.match(removedPath, /^\/safe\/state\/snapshot\.json\.tmp-/u);
    if (writtenPath) assert.equal(removedPath, writtenPath);
  }
});

test("reports managed service status without stopping services", async () => {
  const item = fixture();
  item.options.isAliveImpl = () => true;
  const result = await managePersonalMemory("status", item.options);
  assert.equal(result.installed, true);
  assert.deepEqual(result.services, {
    state: "running",
    upstream: true,
    gateway: true,
    web: true,
    hookWorker: undefined,
  });
  assert.deepEqual(item.calls, []);
});

test("reports stopped managed services from the retained receipt", async () => {
  const item = fixture();
  item.options.isAliveImpl = () => false;
  const result = await managePersonalMemory("status", item.options);
  assert.equal(result.services.state, "stopped");
  assert.equal(result.services.gateway, false);
  assert.equal(result.services.web, false);
});

test("stops services while retaining restart metadata", async () => {
  const item = fixture();
  const result = await managePersonalMemory("stop", item.options);
  assert.equal(result.stopped, true);
  assert.deepEqual(item.calls, [
    ["stop", 42],
    ["stop", 41],
    ["stop", 40],
  ]);
  await managePersonalMemory("restart", item.options);
  assert.ok(item.calls.some((call) => call[0] === "install"));
});

test("restarts managed services so model authorization changes take effect", async () => {
  const item = fixture();
  const result = await managePersonalMemory("restart", item.options);
  assert.equal(result.restarted, true);
  assert.deepEqual(item.calls, [
    ["stop", 42],
    ["stop", 41],
    ["stop", 40],
    ["remove", "/safe/state/install.json"],
    ["install", item.calls.at(-1)[1]],
  ]);
  assert.equal(item.calls.at(-1)[1].upstreamPort, 8420);
  assert.equal(item.calls.at(-1)[1].gatewayPort, 8788);
  assert.equal(item.calls.at(-1)[1].webPort, 4173);
});

test("creates and verifies a backup then restarts", async () => {
  const item = fixture();
  const result = await managePersonalMemory("backup", {
    ...item.options,
    output: "/safe/backup",
  });
  assert.equal(result.backedUp, true);
  assert(item.calls.some((call) => call[1]?.includes?.("data:backup")));
  assert(item.calls.some((call) => call[1]?.includes?.("data:verify")));
  assert.deepEqual(item.calls[0], ["retention", "fixture-lifecycle-token"]);
  assert.deepEqual(
    item.calls.slice(-2).map((call) => call[0]),
    ["install", "release"],
  );
});

test("does not stop services when backup cannot acquire the lifecycle lock", async () => {
  const item = fixture();
  await assert.rejects(
    managePersonalMemory("backup", {
      ...item.options,
      output: "/safe/backup",
      lifecycleMutex: { acquire: () => undefined },
    }),
    /lifecycle operation is active/u,
  );
  assert.deepEqual(item.calls, []);
});

test("restarts even when backup fails", async () => {
  const item = fixture();
  item.options.runImpl = async () => {
    throw new Error("backup failed");
  };
  await assert.rejects(
    managePersonalMemory("backup", { ...item.options, output: "/safe/backup" }),
    /backup failed/,
  );
  assert.deepEqual(
    item.calls.slice(-2).map((call) => call[0]),
    ["install", "release"],
  );
});

test("restores only after verification and restarts", async () => {
  const item = fixture();
  await managePersonalMemory("restore", {
    ...item.options,
    input: "/safe/backup",
  });
  const commands = item.calls
    .filter((call) => call[0] === "npm")
    .map((call) => call[1][1]);
  assert.deepEqual(commands, ["data:verify", "data:restore"]);
  assert.ok(
    item.calls.some(
      (call) =>
        call[0] === "npm" &&
        call[1].includes("--retention-envelope") &&
        call[1].includes("/safe/state/retention-restore-snapshot.json"),
    ),
  );
  assert.ok(
    item.calls.some((call) => call[0] === "retention-restore-snapshot"),
  );
  const snapshotIndex = item.calls.findIndex(
    (call) => call[0] === "retention-restore-snapshot",
  );
  const finalStopIndex = Math.max(
    ...item.calls
      .map((call, index) => (call[0] === "stop" ? index : -1))
      .filter((index) => index >= 0),
  );
  assert.ok(snapshotIndex > finalStopIndex);
  assert.deepEqual(
    item.calls.slice(-3).map((call) => call[0]),
    ["install", "remove", "release"],
  );
  assert.deepEqual(item.calls.slice(-2), [
    ["remove", "/safe/state/retention-restore-snapshot.json", { force: true }],
    ["release"],
  ]);
});

test("restarts the existing data when restore verification fails", async () => {
  const item = fixture();
  item.options.runImpl = async () => {
    throw new Error("invalid backup");
  };
  await assert.rejects(
    managePersonalMemory("restore", {
      ...item.options,
      input: "/safe/backup",
    }),
    /invalid backup/,
  );
  assert.deepEqual(
    item.calls.slice(-3).map((call) => call[0]),
    ["install", "remove", "release"],
  );
  assert.deepEqual(item.calls.slice(-2), [
    ["remove", "/safe/state/retention-restore-snapshot.json", { force: true }],
    ["release"],
  ]);
});

test("does not stop services when restore cannot acquire the lifecycle lock", async () => {
  const item = fixture();
  await assert.rejects(
    managePersonalMemory("restore", {
      ...item.options,
      input: "/safe/backup",
      lifecycleMutex: { acquire: () => undefined },
    }),
    /lifecycle operation is active/u,
  );
  assert.deepEqual(item.calls, []);
});

test("validates the managed command before stopping or removing hooks", async () => {
  const item = fixture();
  item.options.validateManagedCommandImpl = async () => {
    throw new Error("Managed personalmemory command was modified");
  };
  await assert.rejects(
    managePersonalMemory("uninstall", item.options),
    /command was modified/u,
  );
  assert.deepEqual(item.calls, []);
});

test("uninstalls while preserving data by default", async () => {
  const item = fixture();
  item.options.uninstallManagedCommandImpl = async (options) =>
    item.calls.push(["uninstall-command", options]);
  const result = await managePersonalMemory("uninstall", item.options);
  assert.equal(result.dataDeleted, false);
  assert(
    item.calls.some(
      (call) => call[0] === "remove" && call[1] === "/safe/state",
    ),
  );
  assert.equal(
    item.calls.some((call) => call[1] === "/safe/data"),
    false,
  );
  assert.ok(
    item.calls.some(
      (call) =>
        call[0] === "uninstall-command" &&
        call[1].stateDirectory === "/safe/state",
    ),
  );
});

test("requires exact confirmation before stopping or deleting data", async () => {
  const item = fixture();
  await assert.rejects(
    managePersonalMemory("uninstall", {
      ...item.options,
      purgeData: true,
      confirm: "DELETE wrong",
    }),
    /Confirmation must exactly match/,
  );
  assert.deepEqual(item.calls, []);
});

test("deletes only validated state and data roots after confirmation", async () => {
  const item = fixture();
  const result = await managePersonalMemory("uninstall", {
    ...item.options,
    purgeData: true,
    confirm: "DELETE /safe/data",
  });
  assert.equal(result.dataDeleted, true);
  assert(
    item.calls.some((call) => call[0] === "remove" && call[1] === "/safe/data"),
  );
});

test("reports and uninstalls managed Hook v3 state with the worker lifecycle", async () => {
  const item = fixture();
  const receipt = {
    version: 3,
    productVersion: "0.1.1",
    schemaVersion: 7,
    upstreamPid: 40,
    gatewayPid: 41,
    webPid: 42,
    hookWorkerPid: 43,
    hookWorkerGeneration: "a".repeat(32),
    hookReceiptPath: "/safe/state/hooks/install.json",
    upstreamHealthUrl: "http://127.0.0.1:8420/health",
    gatewayHealthUrl: "http://127.0.0.1:8788/health",
    webUrl: "http://127.0.0.1:4173/memories",
  };
  item.options.readManagedReceiptImpl = async () => ({
    receipt,
    dataDirectory: item.dataDirectory,
    stateDirectory: item.stateDirectory,
  });
  item.options.readManagedHookStatusImpl = async () => ({
    installed: true,
    codex: "installed_untrusted",
    claude: "installed",
    firstEventReceived: true,
  });
  item.options.readHookDoctorStatusImpl = async () => ({
    worker: "healthy",
    workerPid: 43,
    workerGeneration: "a".repeat(32),
    backlog: { queued: 1, failed: 0, total: 1 },
  });
  item.options.uninstallManagedHooksImpl = async () =>
    item.calls.push(["uninstall-hooks"]);
  const status = await managePersonalMemory("status", item.options);
  assert.equal(status.hooks.worker, "healthy");
  assert.equal(status.hooks.codex, "installed_untrusted");
  await managePersonalMemory("uninstall", item.options);
  assert.ok(item.calls.some((call) => call[0] === "stop" && call[1] === 43));
  assert.ok(item.calls.some((call) => call[0] === "uninstall-hooks"));
});
