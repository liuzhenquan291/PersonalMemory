import assert from "node:assert/strict";
import test from "node:test";

import { managePersonalMemory } from "./personalmemory-lifecycle-runtime.mjs";

function fixture() {
  const calls = [];
  const dataDirectory = "/safe/data";
  const stateDirectory = "/safe/state";
  const receipt = {
    productVersion: "0.1.0",
    schemaVersion: 7,
    gatewayPid: 41,
    webPid: 42,
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
      installImpl: async () => calls.push(["install"]),
    },
  };
}

test("reports managed status without stopping services", async () => {
  const item = fixture();
  const result = await managePersonalMemory("status", item.options);
  assert.equal(result.installed, true);
  assert.deepEqual(item.calls, []);
});

test("stops services and removes only the receipt", async () => {
  const item = fixture();
  const result = await managePersonalMemory("stop", item.options);
  assert.equal(result.stopped, true);
  assert.deepEqual(item.calls, [
    ["stop", 42],
    ["stop", 41],
    ["remove", "/safe/state/install.json"],
  ]);
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
  assert.deepEqual(item.calls.at(-1), ["install"]);
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
  assert.deepEqual(item.calls.at(-1), ["install"]);
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
  assert.deepEqual(item.calls.at(-1), ["install"]);
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
  assert.deepEqual(item.calls.at(-1), ["install"]);
});

test("uninstalls while preserving data by default", async () => {
  const item = fixture();
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
