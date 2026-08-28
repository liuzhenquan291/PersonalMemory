import { createHash, randomUUID } from "node:crypto";
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
import { pathToFileURL } from "node:url";

const RECEIPT_VERSION = 1;

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function pathInfo(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeManagedCommandAtomic(target, contents, mode) {
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function wrapper(sourceCommand, stateDirectory) {
  return `#!/usr/bin/env node
import { runPersonalMemoryCommand } from ${JSON.stringify(pathToFileURL(sourceCommand).href)};

runPersonalMemoryCommand(process.argv.slice(2), {
  stateDirectory: ${JSON.stringify(stateDirectory)},
}).catch((error) => {
  process.stderr.write(\`PersonalMemory command failed: \${error.message}\\n\`);
  process.exitCode = 1;
});
`;
}

async function validateBinDirectory(binDirectory) {
  await mkdir(binDirectory, { recursive: true, mode: 0o755 });
  const info = await lstat(binDirectory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0)
    throw new Error(
      "PersonalMemory command directory must be a private regular directory",
    );
}

async function readReceipt(receiptPath, commandPath) {
  const info = await pathInfo(receiptPath);
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error("PersonalMemory command receipt must be private");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (
    receipt.version !== RECEIPT_VERSION ||
    path.resolve(receipt.commandPath ?? "") !== commandPath ||
    !/^[a-f0-9]{64}$/u.test(receipt.digest ?? "")
  ) {
    throw new Error(
      "PersonalMemory command receipt expands the managed path scope",
    );
  }
  return receipt;
}

export async function installManagedCommand(options) {
  const sourceRoot = path.resolve(options.sourceRoot);
  const stateDirectory = path.resolve(options.stateDirectory);
  const binDirectory = path.resolve(options.binDirectory);
  const sourceCommand = path.join(
    sourceRoot,
    "scripts",
    "personalmemory-command.mjs",
  );
  const commandPath = path.join(binDirectory, "personalmemory");
  const receiptPath = path.join(stateDirectory, "command.json");
  const sourceInfo = await lstat(sourceCommand);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
    throw new Error("PersonalMemory command source is unavailable");
  await validateBinDirectory(binDirectory);

  const receipt = await readReceipt(receiptPath, commandPath);
  const commandInfo = await pathInfo(commandPath);
  const previousReceiptContents = receipt
    ? await readFile(receiptPath, "utf8")
    : undefined;
  if (!receipt && commandInfo)
    throw new Error(
      "Existing personalmemory command is not managed by this installation",
    );
  let previousCommandContents;
  if (receipt) {
    if (!commandInfo?.isFile() || commandInfo.isSymbolicLink())
      throw new Error("Managed personalmemory command is missing or unsafe");
    previousCommandContents = await readFile(commandPath, "utf8");
    if (digest(previousCommandContents) !== receipt.digest)
      throw new Error("Managed personalmemory command was modified");
  }

  const contents = wrapper(sourceCommand, stateDirectory);
  const nextDigest = digest(contents);
  if (receipt?.digest === nextDigest) {
    return {
      commandPath,
      receiptPath,
      changed: false,
      rollback: async () => undefined,
    };
  }
  const writeAtomicImpl = options.writeAtomicImpl ?? writeManagedCommandAtomic;
  const removeImpl = options.removeImpl ?? rm;
  const rollback = async () => {
    const rollbackErrors = [];
    try {
      if (previousCommandContents === undefined)
        await removeImpl(commandPath, { force: true });
      else
        await writeManagedCommandAtomic(
          commandPath,
          previousCommandContents,
          0o755,
        );
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      if (previousReceiptContents === undefined)
        await removeImpl(receiptPath, { force: true });
      else
        await writeManagedCommandAtomic(
          receiptPath,
          previousReceiptContents,
          0o600,
        );
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length)
      throw new AggregateError(
        rollbackErrors,
        "Managed PersonalMemory command rollback was incomplete",
      );
  };
  try {
    await writeAtomicImpl(commandPath, contents, 0o755);
    await writeAtomicImpl(
      receiptPath,
      `${JSON.stringify(
        {
          version: RECEIPT_VERSION,
          commandPath,
          sourceCommand,
          digest: nextDigest,
        },
        null,
        2,
      )}\n`,
      0o600,
    );
    return { commandPath, receiptPath, changed: true, rollback };
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Managed PersonalMemory command update failed and rollback was incomplete",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

export async function validateManagedCommand(options) {
  const stateDirectory = path.resolve(options.stateDirectory);
  const binDirectory = path.resolve(options.binDirectory);
  const commandPath = path.join(binDirectory, "personalmemory");
  const receiptPath = path.join(stateDirectory, "command.json");
  const receipt = await readReceipt(receiptPath, commandPath);
  if (!receipt) {
    if (await pathInfo(commandPath))
      throw new Error(
        "Existing personalmemory command is not managed by this installation",
      );
    return { managed: false, commandPath, receiptPath };
  }
  const info = await pathInfo(commandPath);
  if (!info?.isFile() || info.isSymbolicLink())
    throw new Error("Managed personalmemory command is missing or unsafe");
  const current = await readFile(commandPath, "utf8");
  if (digest(current) !== receipt.digest)
    throw new Error("Managed personalmemory command was modified");
  return { managed: true, commandPath, receiptPath };
}

export async function uninstallManagedCommand(options) {
  const stateDirectory = path.resolve(options.stateDirectory);
  const binDirectory = path.resolve(options.binDirectory);
  const commandPath = path.join(binDirectory, "personalmemory");
  const receiptPath = path.join(stateDirectory, "command.json");
  const validation = await validateManagedCommand(options);
  if (!validation.managed) return { removed: false };
  await rm(commandPath);
  await rm(receiptPath);
  return { removed: true };
}
