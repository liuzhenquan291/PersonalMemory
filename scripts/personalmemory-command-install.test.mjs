import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installManagedCommand,
  uninstallManagedCommand,
} from "./personalmemory-command-install.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-command-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const stateDirectory = path.join(root, "state");
  const binDirectory = path.join(root, "bin");
  await Promise.all([
    mkdir(path.join(sourceRoot, "scripts"), { recursive: true, mode: 0o700 }),
    mkdir(stateDirectory, { mode: 0o700 }),
  ]);
  const sourceCommand = path.join(
    sourceRoot,
    "scripts",
    "personalmemory-command.mjs",
  );
  await writeFile(sourceCommand, "#!/usr/bin/env node\n", { mode: 0o755 });
  await chmod(sourceCommand, 0o755);
  return { root, sourceRoot, stateDirectory, binDirectory };
}

test("installs an idempotent user command and private ownership receipt", async (t) => {
  const item = await fixture(t);
  const first = await installManagedCommand(item);
  const second = await installManagedCommand(item);

  assert.equal(
    first.commandPath,
    path.join(item.binDirectory, "personalmemory"),
  );
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  const wrapper = await readFile(first.commandPath, "utf8");
  assert.match(wrapper, /personalmemory-command\.mjs/u);
  assert.match(wrapper, new RegExp(JSON.stringify(item.stateDirectory), "u"));
  assert.equal((await stat(first.commandPath)).mode & 0o777, 0o755);
  assert.equal(
    (await stat(path.join(item.stateDirectory, "command.json"))).mode & 0o777,
    0o600,
  );
});

test("refuses to replace an unknown command", async (t) => {
  const item = await fixture(t);
  await mkdir(item.binDirectory, { mode: 0o700 });
  await writeFile(
    path.join(item.binDirectory, "personalmemory"),
    "user file\n",
    {
      mode: 0o755,
    },
  );

  await assert.rejects(installManagedCommand(item), /not managed/u);
  assert.equal(
    await readFile(path.join(item.binDirectory, "personalmemory"), "utf8"),
    "user file\n",
  );
});

test("restores the previous command and receipt when an update is interrupted", async (t) => {
  const item = await fixture(t);
  const first = await installManagedCommand(item);
  const previousCommand = await readFile(first.commandPath, "utf8");
  const previousReceipt = await readFile(first.receiptPath, "utf8");
  const nextSourceRoot = path.join(item.root, "next-source");
  await mkdir(path.join(nextSourceRoot, "scripts"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    path.join(nextSourceRoot, "scripts", "personalmemory-command.mjs"),
    "#!/usr/bin/env node\n",
    { mode: 0o755 },
  );
  let writes = 0;
  await assert.rejects(
    installManagedCommand({
      ...item,
      sourceRoot: nextSourceRoot,
      writeAtomicImpl: async (...args) => {
        writes += 1;
        if (writes === 2) throw new Error("receipt write interrupted");
        return await import("./personalmemory-command-install.mjs").then(
          ({ writeManagedCommandAtomic }) => writeManagedCommandAtomic(...args),
        );
      },
    }),
    /receipt write interrupted/u,
  );
  assert.equal(await readFile(first.commandPath, "utf8"), previousCommand);
  assert.equal(await readFile(first.receiptPath, "utf8"), previousReceipt);
});

test("rejects an unknown command when the private receipt is missing", async (t) => {
  const item = await fixture(t);
  await mkdir(item.binDirectory, { mode: 0o700 });
  await writeFile(path.join(item.binDirectory, "personalmemory"), "unknown\n", {
    mode: 0o755,
  });
  await assert.rejects(
    uninstallManagedCommand(item),
    /not managed by this installation/u,
  );
});

test("uninstalls only an unmodified managed command", async (t) => {
  const item = await fixture(t);
  const installed = await installManagedCommand(item);
  await writeFile(installed.commandPath, "edited\n", { mode: 0o755 });
  await assert.rejects(uninstallManagedCommand(item), /modified/u);

  await rm(installed.commandPath);
  await rm(path.join(item.stateDirectory, "command.json"));
  await installManagedCommand(item);
  assert.deepEqual(await uninstallManagedCommand(item), { removed: true });
  await assert.rejects(stat(installed.commandPath), { code: "ENOENT" });
});
