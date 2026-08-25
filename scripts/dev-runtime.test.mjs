import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import process from "node:process";
import { setImmediate, setTimeout } from "node:timers";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import test from "node:test";

import {
  assertPortAvailable,
  createDevRuntime,
  DevRuntimeStoppedError,
  parseDevPort,
  stopChild,
} from "./dev-runtime.mjs";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Condition was not met before timeout");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("rejects an occupied port with a clear error", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await assert.rejects(
    assertPortAvailable("127.0.0.1", address.port),
    /Port 127\.0\.0\.1:\d+ is unavailable \(EADDRINUSE\)/,
  );
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("accepts only explicit valid development ports", () => {
  assert.equal(parseDevPort(undefined, 8787, "PORT"), 8787);
  assert.equal(parseDevPort("18420", 8787, "PORT"), 18420);
  for (const value of ["0", "65536", "12.5", "abc", " 8787"]) {
    assert.throws(
      () => parseDevPort(value, 8787, "PORT"),
      /PORT must be an integer between 1 and 65535/,
    );
  }
});

test("isolates and removes a run-specific temporary data directory", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-unit-"),
  );
  const runtime = await createDevRuntime({ temporaryRoot });
  assert.equal(path.dirname(runtime.dataDirectory), temporaryRoot);
  assert.equal(await pathExists(runtime.dataDirectory), true);
  await runtime.stop();
  assert.equal(await pathExists(runtime.dataDirectory), false);
  await rm(temporaryRoot, { recursive: true });
});

test("removes a partially initialized run when state directory creation fails", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-partial-"),
  );
  let calls = 0;
  await assert.rejects(
    createDevRuntime({
      temporaryRoot,
      async mkdtempImpl(prefix) {
        calls += 1;
        if (calls === 2) throw new Error("injected state directory failure");
        return mkdtemp(prefix);
      },
    }),
    /injected state directory failure/,
  );
  assert.deepEqual(await readdir(temporaryRoot), []);
  await rm(temporaryRoot, { recursive: true });
});

test("never removes an injected directory outside the development root", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-outside-root-"),
  );
  const outsideDirectory = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-outside-target-"),
  );
  let calls = 0;
  await assert.rejects(
    createDevRuntime({
      temporaryRoot,
      async mkdtempImpl() {
        calls += 1;
        if (calls === 1) return outsideDirectory;
        throw new Error("injected state directory failure");
      },
    }),
    /injected state directory failure/,
  );
  assert.equal(await pathExists(outsideDirectory), true);
  await rm(outsideDirectory, { recursive: true });
  await rm(temporaryRoot, { recursive: true });
});

test("never treats another run's state directory as a data directory", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-cross-prefix-"),
  );
  const existingStateDirectory = await mkdtemp(
    path.join(temporaryRoot, "personalmemory-dev-state-"),
  );
  let calls = 0;
  await assert.rejects(
    createDevRuntime({
      temporaryRoot,
      async mkdtempImpl() {
        calls += 1;
        if (calls === 1) return existingStateDirectory;
        throw new Error("injected state directory failure");
      },
    }),
    /injected state directory failure/,
  );
  assert.equal(await pathExists(existingStateDirectory), true);
  await rm(temporaryRoot, { recursive: true });
});

test("rejects symlink and broadly writable temporary roots", async () => {
  const realRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-safe-"),
  );
  const symlinkRoot = `${realRoot}-link`;
  await symlink(realRoot, symlinkRoot, "dir");
  await assert.rejects(
    createDevRuntime({ temporaryRoot: symlinkRoot }),
    /temporary path must contain real directories/,
  );
  await rm(symlinkRoot);

  await chmod(realRoot, 0o777);
  await assert.rejects(
    createDevRuntime({ temporaryRoot: realRoot }),
    /temporary path is writable by other users/,
  );
  await chmod(realRoot, 0o700);
  await rm(realRoot, { recursive: true });

  const safeRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-link-parent-"),
  );
  const outsideRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-link-outside-"),
  );
  await symlink(outsideRoot, path.join(safeRoot, "link"), "dir");
  await assert.rejects(
    createDevRuntime({
      temporaryRoot: path.join(safeRoot, "link", "new-root"),
    }),
    /temporary path must contain real directories/,
  );
  assert.equal(await pathExists(path.join(outsideRoot, "new-root")), false);
  await rm(safeRoot, { recursive: true });
  await rm(outsideRoot, { recursive: true });
});

test("cancels startup immediately when stopped before readiness", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-cancel-"),
  );
  const runtime = await createDevRuntime({
    upstreamPort: await freePort(),
    gatewayPort: await freePort(),
    webPort: await freePort(),
    temporaryRoot,
    stdio: "ignore",
  });
  const startedAt = Date.now();
  const startPromise = runtime.start();
  await runtime.stop();
  await assert.rejects(startPromise, DevRuntimeStoppedError);
  assert(Date.now() - startedAt < 2_000);
  assert.equal(await pathExists(runtime.dataDirectory), false);
  await rm(temporaryRoot, { recursive: true });
});

test("cleans every child and data even when one stop operation fails", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-stop-error-"),
  );
  let calls = 0;
  const runtime = await createDevRuntime({
    temporaryRoot,
    stopChildImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("injected stop failure");
    },
  });
  runtime.children.push({ pid: 1001 }, { pid: 1002 });
  const firstStop = runtime.stop();
  await assert.rejects(firstStop, /Development cleanup failed/);
  assert.equal(calls, 2);
  assert.equal(await pathExists(runtime.dataDirectory), false);
  assert.equal(runtime.stop(), firstStop);
  await assert.rejects(runtime.stop(), /Development cleanup failed/);
  await rm(temporaryRoot, { recursive: true });
});

test("handles asynchronous spawn errors through shared cleanup", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-spawn-error-"),
  );
  let spawnCount = 0;
  let stoppedChildren = 0;
  let reportedError;
  const runtime = await createDevRuntime({
    upstreamPort: await freePort(),
    gatewayPort: await freePort(),
    webPort: await freePort(),
    temporaryRoot,
    stdio: "ignore",
    spawnImpl: () => {
      spawnCount += 1;
      const child = new EventEmitter();
      child.pid = 2_000 + spawnCount;
      child.exitCode = null;
      child.kill = () => true;
      if (spawnCount === 1) {
        setImmediate(() => {
          child.emit(
            "error",
            Object.assign(new Error("resource unavailable"), {
              code: "EAGAIN",
            }),
          );
        });
      }
      return child;
    },
    stopChildImpl: async () => {
      stoppedChildren += 1;
    },
    onUnexpectedExit(error) {
      reportedError = error;
    },
  });
  await assert.rejects(
    runtime.start(),
    /Upstream Gateway exited before shutdown \(EAGAIN\)/,
  );
  assert.equal(stoppedChildren, 1);
  assert.match(reportedError.message, /EAGAIN/);
  assert.equal(await pathExists(runtime.dataDirectory), false);
  await rm(temporaryRoot, { recursive: true });
});

test("cleans safely when a competitor takes a port after preflight", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-port-race-"),
  );
  const gatewayPort = await freePort();
  const competitor = createHttpServer((_request, response) => {
    response.setHeader("connection", "close");
    response.statusCode = 503;
    response.end("occupied");
  });
  const runtime = await createDevRuntime({
    upstreamPort: await freePort(),
    gatewayPort,
    webPort: await freePort(),
    temporaryRoot,
    stdio: "ignore",
    afterPortCheck: async () =>
      await new Promise((resolve) =>
        competitor.listen(gatewayPort, "127.0.0.1", resolve),
      ),
  });
  await assert.rejects(runtime.start(), /Gateway exited before shutdown/);
  assert.equal(await pathExists(runtime.dataDirectory), false);
  assert(competitor.listening);
  await new Promise((resolve, reject) =>
    competitor.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(temporaryRoot, { recursive: true });
});

test("kills descendants after a detached process-group leader exits", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-tree-"),
  );
  const pidFile = path.join(fixtureRoot, "grandchild.pid");
  const leader = spawn(
    process.execPath,
    ["scripts/dev-process-tree-fixture.mjs", pidFile],
    { cwd: process.cwd(), detached: true, stdio: "ignore" },
  );
  await new Promise((resolve) => leader.once("exit", resolve));
  const grandchildPid = Number(await readFile(pidFile, "utf8"));
  assert(processExists(grandchildPid));

  await stopChild(leader, 100);
  await waitUntil(() => !processExists(grandchildPid));
  await rm(fixtureRoot, { recursive: true });
});

test("starts, stops and starts both real services again without leaking ports or data", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-integration-"),
  );
  const gatewayPort = await freePort();
  const upstreamPort = await freePort();
  const webPort = await freePort();

  for (let iteration = 0; iteration < 2; iteration += 1) {
    const runtime = await createDevRuntime({
      gatewayPort,
      upstreamPort,
      webPort,
      temporaryRoot,
      stdio: "ignore",
    });
    const ready = await runtime.start();
    assert.equal(
      (await globalThis.fetch(`${ready.gatewayUrl}/health`)).status,
      200,
    );
    assert.equal((await globalThis.fetch(ready.webUrl)).status, 200);
    const proxiedStatus = await globalThis.fetch(
      `http://127.0.0.1:${webPort}/api/v1/config/status`,
    );
    assert.equal(proxiedStatus.status, 200);
    assert.deepEqual(await proxiedStatus.json(), {
      authenticationConfigured: false,
      modelConfigured: false,
    });
    assert.equal(await pathExists(runtime.dataDirectory), true);

    await runtime.stop();
    assert.equal(await pathExists(runtime.dataDirectory), false);
    assert.equal(await pathExists(runtime.stateDirectory), false);
    await assertPortAvailable("127.0.0.1", gatewayPort);
    await assertPortAvailable("127.0.0.1", upstreamPort);
    await assertPortAvailable("127.0.0.1", webPort);
  }
  await rm(temporaryRoot, { recursive: true });
});

test("stops sibling processes and cleans data when one service exits unexpectedly", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(process.cwd(), ".personalmemory-dev-failure-"),
  );
  const gatewayPort = await freePort();
  const upstreamPort = await freePort();
  const webPort = await freePort();
  let unexpectedError;
  const runtime = await createDevRuntime({
    gatewayPort,
    upstreamPort,
    webPort,
    temporaryRoot,
    stdio: "ignore",
    onUnexpectedExit(error) {
      unexpectedError = error;
    },
  });
  await runtime.start();
  runtime.children[1].kill("SIGTERM");

  await waitUntil(() => unexpectedError !== undefined);
  assert.match(unexpectedError.message, /Gateway exited before shutdown/);
  await waitUntil(async () => !(await pathExists(runtime.dataDirectory)));
  await assertPortAvailable("127.0.0.1", gatewayPort);
  await assertPortAvailable("127.0.0.1", upstreamPort);
  await assertPortAvailable("127.0.0.1", webPort);
  await rm(temporaryRoot, { recursive: true });
});

test("the real CLI handles two signals before readiness and exits cleanly", async () => {
  const gatewayPort = await freePort();
  const upstreamPort = await freePort();
  const webPort = await freePort();
  const devRoot = path.join(process.cwd(), ".personalmemory-dev");
  const before = new Set(await readdir(devRoot).catch(() => []));
  const child = spawn(process.execPath, ["scripts/dev.mjs"], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      PERSONALMEMORY_DEV_UPSTREAM_PORT: String(upstreamPort),
      PERSONALMEMORY_DEV_GATEWAY_PORT: String(gatewayPort),
      PERSONALMEMORY_DEV_WEB_PORT: String(webPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let signaled = false;
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (!signaled && output.includes("PersonalMemory Gateway ready")) {
      signaled = true;
      child.kill("SIGINT");
      child.kill("SIGINT");
    }
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const result = await new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  assert(signaled);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.doesNotMatch(output, /environment failed/i);
  await assertPortAvailable("127.0.0.1", gatewayPort);
  await assertPortAvailable("127.0.0.1", upstreamPort);
  await assertPortAvailable("127.0.0.1", webPort);
  const after = new Set(await readdir(devRoot).catch(() => []));
  assert.deepEqual(after, before);
});
