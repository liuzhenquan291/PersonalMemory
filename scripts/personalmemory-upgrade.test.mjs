import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  upgradePersonalMemory,
  upgradeTarget,
} from "./personalmemory-upgrade-runtime.mjs";

function fixture(overrides = {}) {
  const dataDirectory = "/safe/data";
  const stateDirectory = "/safe/state";
  const receipt = {
    version: 1,
    productVersion: "0.0.9",
    schemaVersion: 6,
    installedAt: "2026-08-01T00:00:00.000Z",
    dataDirectory,
    gatewayPid: 2001,
    webPid: 2002,
    secretPath: path.join(stateDirectory, "gateway.env"),
    logPath: path.join(stateDirectory, "personalmemory.log"),
  };
  const calls = [];
  return {
    dataDirectory,
    stateDirectory,
    receipt,
    calls,
    options: {
      root: "/safe/repo",
      dataDirectory,
      stateDirectory,
      readReceipt: async () => receipt,
      writeReceipt: async (_state, value) => calls.push(["write", value]),
      removeReceipt: async () => calls.push(["remove"]),
      measureDataImpl: async () => 1_024,
      statfsImpl: async () => ({ bavail: 1_000_000, bsize: 4_096 }),
      stopImpl: async (pid) => calls.push(["stop", pid]),
      runImpl: async (command, args) => calls.push([command, args]),
      installImpl: async () => ({ ...receipt, gatewayPid: 3001, webPid: 3002 }),
      ...overrides,
    },
  };
}

test("upgrades a previous version through backup migration and restart", async () => {
  const item = fixture();
  const result = await upgradePersonalMemory(item.options);
  assert.equal(result.changed, true);
  assert.deepEqual(item.calls.slice(0, 3), [
    ["npm", ["run", "build:products"]],
    ["stop", 2002],
    ["stop", 2001],
  ]);
  assert(
    item.calls.some(
      (call) => Array.isArray(call[1]) && call[1].includes("data:backup"),
    ),
  );
  assert(
    item.calls.some(
      (call) => Array.isArray(call[1]) && call[1].includes("data:verify"),
    ),
  );
  assert(
    item.calls.some(
      (call) =>
        Array.isArray(call[1]) &&
        call[1].some((arg) => arg.endsWith("personalmemory-migrate.ts")),
    ),
  );
  const written = item.calls.find((call) => call[0] === "write")[1];
  assert.equal(written.productVersion, upgradeTarget.productVersion);
  assert.equal(written.gatewayPid, 3001);
});

test("is idempotent when product and schema versions are current", async () => {
  const item = fixture();
  item.receipt.productVersion = upgradeTarget.productVersion;
  item.receipt.schemaVersion = upgradeTarget.schemaVersion;
  assert.equal((await upgradePersonalMemory(item.options)).changed, false);
  assert.deepEqual(item.calls, []);
});

test("rejects insufficient space before build or service stop", async () => {
  const item = fixture({ statfsImpl: async () => ({ bavail: 1, bsize: 1 }) });
  await assert.rejects(
    upgradePersonalMemory(item.options),
    /Insufficient disk space/,
  );
  assert.deepEqual(item.calls, []);
});

test("restores the verified backup after migration failure", async () => {
  const item = fixture();
  item.options.runImpl = async (command, args) => {
    item.calls.push([command, args]);
    if (args.some((arg) => arg.endsWith("personalmemory-migrate.ts")))
      throw new Error("migration interrupted");
  };
  await assert.rejects(
    upgradePersonalMemory(item.options),
    /services remain stopped/,
  );
  const restore = item.calls.find(
    (call) => Array.isArray(call[1]) && call[1].includes("data:restore"),
  );
  assert(restore?.[1].includes(`RESTORE ${item.dataDirectory}`));
  assert.equal(
    item.calls.some((call) => call[0] === "write"),
    false,
  );
});

test("reports incomplete rollback instead of hiding restore failure", async () => {
  const item = fixture();
  item.options.runImpl = async (command, args) => {
    item.calls.push([command, args]);
    if (args.some((arg) => arg.endsWith("personalmemory-migrate.ts")))
      throw new Error("migration interrupted");
    if (args.includes("data:restore")) throw new Error("restore failed");
  };
  await assert.rejects(
    upgradePersonalMemory(item.options),
    /automatic rollback was incomplete/,
  );
});

test("fails closed when the receipt expands the managed path scope", async () => {
  const item = fixture();
  item.receipt.secretPath = "/another/location/secret";
  await assert.rejects(
    upgradePersonalMemory(item.options),
    /expands the managed upgrade scope/,
  );
  assert.deepEqual(item.calls, []);
});
