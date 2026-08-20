import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parse as parseToml } from "smol-toml";

const RECEIPT_VERSION = 1;
const EVENTS = ["UserPromptSubmit", "Stop"];

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function eventReceiptId(client, event, options) {
  return digest({
    version: RECEIPT_VERSION,
    client,
    event,
    nodePath: options.nodePath,
    projectRoot: options.projectRoot,
    stateDirectory: options.stateDirectory,
  });
}

function definition(client, event, options) {
  const command = [
    quote(options.nodePath),
    quote(
      path.join(options.projectRoot, "scripts", "personalmemory-hook-cli.mjs"),
    ),
    quote(client),
    "--state-directory",
    quote(options.stateDirectory),
    "--definition-id",
    quote(eventReceiptId(client, event, options)),
  ].join(" ");
  return {
    hooks: [{ type: "command", command, timeout: event === "Stop" ? 3 : 1 }],
  };
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJsonFile(target) {
  await assertNoSymlinkAncestors(path.dirname(target));
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Managed Hook config is not a regular file: ${target}`);
    const parsed = JSON.parse(await readFile(target, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`Managed Hook config must be a JSON object: ${target}`);
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function assertCodexHookPolicy(target) {
  await assertNoSymlinkAncestors(path.dirname(target));
  let contents;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Codex config.toml must be a regular file");
    contents = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  let configuration;
  try {
    configuration = parseToml(contents);
  } catch (error) {
    throw new Error("Codex config.toml is invalid", { cause: error });
  }
  if (
    configuration.features?.hooks === false ||
    configuration.features?.codex_hooks === false
  )
    throw new Error("Codex hooks are disabled in config.toml");
  if (
    ["UserPromptSubmit", "Stop"].some((event) =>
      Object.hasOwn(configuration.hooks ?? {}, event),
    )
  )
    throw new Error("Codex config.toml conflicts with managed hooks");
}

async function assertNoSymlinkAncestors(target) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    try {
      if (
        (await lstat(current)).isSymbolicLink() &&
        !(
          process.platform === "darwin" &&
          new Set(["/var", "/tmp"]).has(current)
        )
      )
        throw new Error(
          `Managed Hook path contains a symbolic link: ${current}`,
        );
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
}

async function writeAtomic(target, value, mode = 0o600, expected) {
  await assertNoSymlinkAncestors(path.dirname(target));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode,
    });
    if (expected !== undefined) {
      const current = await readJsonFile(target);
      if (digest(current) !== digest(expected))
        throw new Error(`Managed Hook config changed concurrently: ${target}`);
    }
    await rename(temporary, target);
    await chmod(target, mode);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function inspectConfig(config, managed) {
  if (
    config.hooks !== undefined &&
    (!config.hooks ||
      typeof config.hooks !== "object" ||
      Array.isArray(config.hooks))
  )
    throw new Error("Hook config hooks field must be an object");
  let present = 0;
  for (const event of EVENTS) {
    const entries = config.hooks?.[event] ?? [];
    if (!Array.isArray(entries))
      throw new Error(`Hook event ${event} must be an array`);
    const matching = entries.filter(
      (entry) => digest(entry) === digest(managed[event]),
    );
    if (matching.length > 1)
      throw new Error(`Managed Hook ${event} is duplicated`);
    if (matching.length === 1) present += 1;
    if (matching.length === 0 && entries.length > 0)
      throw new Error(
        `Hook event ${event} conflicts with the managed definition`,
      );
    if (matching.length === 1 && entries.length !== 1)
      throw new Error(`Hook event ${event} contains a conflicting duplicate`);
  }
  if (present !== 0 && present !== EVENTS.length)
    throw new Error("Managed Hook installation is partial or modified");
  return present === EVENTS.length;
}

function addManaged(config, managed) {
  const hooks = { ...(config.hooks ?? {}) };
  for (const event of EVENTS) hooks[event] = [managed[event]];
  return { ...config, hooks };
}

function removeManaged(config, managed) {
  const hooks = { ...(config.hooks ?? {}) };
  for (const event of EVENTS) {
    const entries = hooks[event] ?? [];
    if (entries.length !== 1 || digest(entries[0]) !== digest(managed[event]))
      throw new Error(`Managed Hook ${event} was modified`);
    delete hooks[event];
  }
  return Object.keys(hooks).length === 0
    ? Object.fromEntries(
        Object.entries(config).filter(([key]) => key !== "hooks"),
      )
    : { ...config, hooks };
}

function locations(options = {}) {
  const home = path.resolve(options.home ?? os.homedir());
  const stateDirectory = path.resolve(options.stateDirectory);
  const projectRoot = path.resolve(
    options.projectRoot ?? path.join(import.meta.dirname, ".."),
  );
  const nodePath = path.resolve(options.nodePath ?? process.execPath);
  const codexPath = path.join(home, ".codex", "hooks.json");
  const codexConfigPath = path.join(home, ".codex", "config.toml");
  const claudePath = path.join(home, ".claude", "settings.json");
  const receiptPath = path.join(stateDirectory, "hooks", "install.json");
  const managed = Object.fromEntries(
    ["codex", "claude-code"].map((client) => [
      client,
      Object.fromEntries(
        EVENTS.map((event) => [
          event,
          definition(client, event, {
            projectRoot,
            nodePath,
            stateDirectory,
          }),
        ]),
      ),
    ]),
  );
  return {
    home,
    stateDirectory,
    projectRoot,
    nodePath,
    codexPath,
    codexConfigPath,
    claudePath,
    receiptPath,
    managed,
  };
}

function receiptFor(paths) {
  return {
    version: RECEIPT_VERSION,
    installedAt: new Date().toISOString(),
    codexPath: paths.codexPath,
    claudePath: paths.claudePath,
    definitions: {
      codex: Object.fromEntries(
        EVENTS.map((event) => [event, digest(paths.managed.codex[event])]),
      ),
      claude: Object.fromEntries(
        EVENTS.map((event) => [
          event,
          digest(paths.managed["claude-code"][event]),
        ]),
      ),
    },
    eventReceiptIds: Object.fromEntries(
      ["codex", "claude-code"].map((client) => [
        client,
        Object.fromEntries(
          EVENTS.map((event) => [event, eventReceiptId(client, event, paths)]),
        ),
      ]),
    ),
    codexTrust: "untrusted",
  };
}

async function readReceipt(paths) {
  await assertNoSymlinkAncestors(path.dirname(paths.receiptPath));
  const info = await lstat(paths.receiptPath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("Managed Hook receipt must be a private regular file");
  const receipt = JSON.parse(await readFile(paths.receiptPath, "utf8"));
  if (
    receipt.version !== RECEIPT_VERSION ||
    path.resolve(receipt.codexPath ?? "") !== paths.codexPath ||
    path.resolve(receipt.claudePath ?? "") !== paths.claudePath ||
    !["codex", "claude"].every((client) =>
      EVENTS.every((event) =>
        /^[a-f0-9]{64}$/u.test(receipt.definitions?.[client]?.[event]),
      ),
    ) ||
    !["codex", "claude-code"].every((client) =>
      EVENTS.every((event) =>
        /^[a-f0-9]{64}$/u.test(receipt.eventReceiptIds?.[client]?.[event]),
      ),
    )
  )
    throw new Error("Managed Hook receipt expands the managed scope");
  return receipt;
}

function assertReceiptConfig(config, definitions) {
  for (const event of EVENTS) {
    const entries = config.hooks?.[event];
    if (
      !Array.isArray(entries) ||
      entries.length !== 1 ||
      digest(entries[0]) !== definitions[event]
    )
      throw new Error(`Managed Hook ${event} is partial or modified`);
  }
}

async function clearEventReceipts(paths) {
  const directory = path.join(paths.stateDirectory, "hooks");
  await assertNoSymlinkAncestors(directory);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (
      !/^first-event-(?:codex|claude-code)-(?:UserPromptSubmit|Stop)(?:-[a-f0-9]{64})?\.json$/u.test(
        name,
      )
    )
      continue;
    const target = path.join(directory, name);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error("Managed Hook event receipt must be private");
    await rm(target);
  }
}

export async function installManagedHooks(options = {}) {
  const paths = locations(options);
  await assertCodexHookPolicy(paths.codexConfigPath);
  const [codex, claude] = await Promise.all([
    readJsonFile(paths.codexPath),
    readJsonFile(paths.claudePath),
  ]);
  const receiptExists = await exists(paths.receiptPath);
  if (receiptExists) {
    const receipt = await readReceipt(paths);
    assertReceiptConfig(codex, receipt.definitions.codex);
    assertReceiptConfig(claude, receipt.definitions.claude);
    const nextReceipt = receiptFor(paths);
    if (
      EVENTS.every(
        (event) =>
          nextReceipt.definitions.codex[event] ===
            receipt.definitions.codex[event] &&
          nextReceipt.definitions.claude[event] ===
            receipt.definitions.claude[event],
      )
    )
      return {
        changed: false,
        codex: "installed_untrusted",
        claude: "installed",
        receiptPath: paths.receiptPath,
      };
    await clearEventReceipts(paths);
    const writtenReceipt = {
      ...nextReceipt,
      installedAt: receipt.installedAt,
      upgradedAt: new Date().toISOString(),
    };
    await writeAtomic(
      paths.codexPath,
      addManaged(codex, paths.managed.codex),
      0o600,
      codex,
    );
    try {
      await writeAtomic(
        paths.claudePath,
        addManaged(claude, paths.managed["claude-code"]),
        0o600,
        claude,
      );
      await writeAtomic(paths.receiptPath, writtenReceipt, 0o600, receipt);
    } catch (error) {
      await writeAtomic(
        paths.codexPath,
        codex,
        0o600,
        addManaged(codex, paths.managed.codex),
      ).catch(() => undefined);
      await writeAtomic(
        paths.claudePath,
        claude,
        0o600,
        addManaged(claude, paths.managed["claude-code"]),
      ).catch(() => undefined);
      await writeAtomic(
        paths.receiptPath,
        receipt,
        0o600,
        writtenReceipt,
      ).catch(() => undefined);
      throw error;
    }
    return {
      changed: true,
      codex: "installed_untrusted",
      claude: "installed",
      receiptPath: paths.receiptPath,
    };
  }
  await clearEventReceipts(paths);
  const codexInstalled = inspectConfig(codex, paths.managed.codex);
  const claudeInstalled = inspectConfig(claude, paths.managed["claude-code"]);
  if (codexInstalled || claudeInstalled)
    throw new Error("Managed Hook installation is missing its receipt");
  await writeAtomic(
    paths.codexPath,
    addManaged(codex, paths.managed.codex),
    0o600,
    codex,
  );
  try {
    await writeAtomic(
      paths.claudePath,
      addManaged(claude, paths.managed["claude-code"]),
      0o600,
      claude,
    );
    await writeAtomic(paths.receiptPath, receiptFor(paths));
  } catch (error) {
    await writeAtomic(
      paths.codexPath,
      codex,
      0o600,
      addManaged(codex, paths.managed.codex),
    ).catch(() => undefined);
    await writeAtomic(
      paths.claudePath,
      claude,
      0o600,
      addManaged(claude, paths.managed["claude-code"]),
    ).catch(() => undefined);
    throw error;
  }
  return {
    changed: true,
    codex: "installed_untrusted",
    claude: "installed",
    receiptPath: paths.receiptPath,
  };
}

export async function readManagedHookStatus(options = {}) {
  const paths = locations(options);
  try {
    await assertCodexHookPolicy(paths.codexConfigPath);
    const receipt = await readReceipt(paths);
    const [codex, claude] = await Promise.all([
      readJsonFile(paths.codexPath),
      readJsonFile(paths.claudePath),
    ]);
    assertReceiptConfig(codex, receipt.definitions.codex);
    assertReceiptConfig(claude, receipt.definitions.claude);
    const eventHealthy = async (client, event) => {
      const target = path.join(
        paths.stateDirectory,
        "hooks",
        `first-event-${client}-${event}-${receipt.eventReceiptIds[client][event]}.json`,
      );
      await assertNoSymlinkAncestors(path.dirname(target));
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
        throw new Error("Managed Hook event receipt must be private");
      const value = JSON.parse(await readFile(target, "utf8"));
      return (
        value.version === 1 &&
        value.client === client &&
        value.event === event &&
        value.definitionId === receipt.eventReceiptIds[client][event]
      );
    };
    const healthy = async (client) =>
      (
        await Promise.all(
          EVENTS.map((event) =>
            eventHealthy(client, event).catch((error) => {
              if (error?.code === "ENOENT") return false;
              throw error;
            }),
          ),
        )
      ).every(Boolean);
    const [codexEvent, claudeEvent] = await Promise.all([
      healthy("codex"),
      healthy("claude-code"),
    ]);
    return {
      installed: true,
      codex: codexEvent ? "healthy" : "installed_untrusted",
      claude: claudeEvent ? "healthy" : "installed",
      firstEventReceived: codexEvent && claudeEvent,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { installed: false };
    throw error;
  }
}

export async function uninstallManagedHooks(options = {}) {
  const paths = locations(options);
  await assertCodexHookPolicy(paths.codexConfigPath);
  await readReceipt(paths);
  const [codex, claude] = await Promise.all([
    readJsonFile(paths.codexPath),
    readJsonFile(paths.claudePath),
  ]);
  const nextCodex = removeManaged(codex, paths.managed.codex);
  const nextClaude = removeManaged(claude, paths.managed["claude-code"]);
  await writeAtomic(paths.codexPath, nextCodex, 0o600, codex);
  try {
    await writeAtomic(paths.claudePath, nextClaude, 0o600, claude);
    await rm(paths.receiptPath);
  } catch (error) {
    await writeAtomic(paths.codexPath, codex, 0o600, nextCodex).catch(
      () => undefined,
    );
    await writeAtomic(paths.claudePath, claude, 0o600, nextClaude).catch(
      () => undefined,
    );
    throw error;
  }
  return { uninstalled: true };
}
