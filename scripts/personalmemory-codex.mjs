import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "personalmemory";
const RECEIPT_VERSION = 1;
const START_MARKER = "# >>> PersonalMemory managed MCP configuration >>>";
const END_MARKER = "# <<< PersonalMemory managed MCP configuration <<<";
const RECEIPT_FILE = ".personalmemory-mcp-install.json";
const MAX_CONFIG_BYTES = 1_048_576;

export class CodexMcpConfigError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "CodexMcpConfigError";
    this.code = code;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tomlString(value) {
  return JSON.stringify(value);
}

function defaultProjectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function assertNoUnknownOptions(args) {
  const supported = new Set(["--config", "--node", "--server-entry"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--") || !supported.has(value) || !args[index + 1]) {
      throw new CodexMcpConfigError(
        "INVALID_ARGUMENT",
        `Unsupported or incomplete option: ${value}`,
      );
    }
    index += 1;
  }
}

function managedBlock(input) {
  const enabledTools = [
    "personalmemory_search",
    "personalmemory_read",
    "personalmemory_capture",
    "personalmemory_feedback",
    "personalmemory_prepare_forget",
  ];
  const forwardedEnvironment = [
    "PERSONALMEMORY_AUTH_ENABLED",
    "PERSONALMEMORY_AUTH_TOKEN",
    "PERSONALMEMORY_HOST",
    "PERSONALMEMORY_PORT",
    "PERSONALMEMORY_REQUEST_BODY_LIMIT_BYTES",
  ];
  return `${START_MARKER}
[mcp_servers.${SERVER_NAME}]
command = ${tomlString(input.nodePath)}
args = [${tomlString(input.serverEntry)}]
cwd = ${tomlString(input.projectRoot)}
env_vars = [${forwardedEnvironment.map(tomlString).join(", ")}]
enabled_tools = [${enabledTools.map(tomlString).join(", ")}]
startup_timeout_sec = 10
tool_timeout_sec = 35
required = false
default_tools_approval_mode = "prompt"

[mcp_servers.${SERVER_NAME}.tools.personalmemory_search]
approval_mode = "auto"

[mcp_servers.${SERVER_NAME}.tools.personalmemory_read]
approval_mode = "auto"
${END_MARKER}
`;
}

function hasServerConfiguration(content) {
  if (
    /^\s*(?:\[\s*mcp_servers\s*\.\s*(?:personalmemory|"personalmemory"|'personalmemory')(?:\s*\]|\s*\.)|mcp_servers\s*(?:=|\.\s*(?:personalmemory|"personalmemory"|'personalmemory')\s*(?:\.|=)))/mu.test(
      content,
    )
  ) {
    return true;
  }
  let inMcpServers = false;
  for (const line of content.split(/\r?\n/u)) {
    if (/^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$/u.test(line)) {
      inMcpServers = true;
      continue;
    }
    if (/^\s*\[/u.test(line)) inMcpServers = false;
    if (
      inMcpServers &&
      /^\s*(?:personalmemory|"personalmemory"|'personalmemory')\s*=/u.test(line)
    ) {
      return true;
    }
  }
  return false;
}

function parseReceipt(receiptFile, paths) {
  let receipt;
  try {
    receipt = JSON.parse(receiptFile.content);
  } catch (error) {
    throw new CodexMcpConfigError(
      "INVALID_RECEIPT",
      "PersonalMemory MCP installation receipt is invalid",
      { cause: error },
    );
  }
  const block = managedBlock(paths);
  const validAppends = new Set([block, `\n${block}`, `\n\n${block}`]);
  if (
    receipt.version !== RECEIPT_VERSION ||
    receipt.config_path !== paths.configPath ||
    typeof receipt.config_created !== "boolean" ||
    typeof receipt.original_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(receipt.original_sha256) ||
    receipt.block_sha256 !== sha256(block) ||
    typeof receipt.appended !== "string" ||
    !validAppends.has(receipt.appended)
  ) {
    throw new CodexMcpConfigError(
      "INVALID_RECEIPT",
      "PersonalMemory MCP installation receipt does not match this config",
    );
  }
  return receipt;
}

async function readOptional(file) {
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new CodexMcpConfigError(
        "UNSAFE_CONFIG_PATH",
        "Codex config must be a regular file, not a symlink",
      );
    }
    if (stat.size > MAX_CONFIG_BYTES) {
      throw new CodexMcpConfigError(
        "CONFIG_TOO_LARGE",
        "Codex config or installation receipt is too large",
      );
    }
    return { content: await readFile(file, "utf8"), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertLaunchFiles(paths) {
  const serverStat = await lstat(paths.serverEntry).catch((error) => {
    throw new CodexMcpConfigError(
      "SERVER_NOT_BUILT",
      "Build PersonalMemory before installing the Codex MCP entry",
      { cause: error },
    );
  });
  if (serverStat.isSymbolicLink() || !serverStat.isFile()) {
    throw new CodexMcpConfigError(
      "UNSAFE_SERVER_ENTRY",
      "The built MCP Server entry must be a regular file",
    );
  }
  await access(paths.nodePath, fsConstants.X_OK).catch((error) => {
    throw new CodexMcpConfigError(
      "NODE_NOT_EXECUTABLE",
      "The configured Node.js executable is unavailable",
      { cause: error },
    );
  });
}

async function atomicWrite(file, content, mode = 0o600) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new CodexMcpConfigError(
      "UNSAFE_CONFIG_PATH",
      "Codex config directory must be a real directory",
    );
  }
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, mode & 0o777);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function resolvePaths(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? defaultProjectRoot());
  return {
    projectRoot,
    configPath: path.resolve(
      options.configPath ?? path.join(os.homedir(), ".codex", "config.toml"),
    ),
    nodePath: path.resolve(options.nodePath ?? process.execPath),
    serverEntry: path.resolve(
      options.serverEntry ??
        path.join(projectRoot, "packages", "mcp-server", "dist", "cli.js"),
    ),
  };
}

export async function installCodexMcp(options = {}) {
  const paths = resolvePaths(options);
  await assertLaunchFiles(paths);
  const receiptPath = path.join(path.dirname(paths.configPath), RECEIPT_FILE);
  const existingReceipt = await readOptional(receiptPath);
  const existingConfig = await readOptional(paths.configPath);
  const original = existingConfig?.content ?? "";
  const block = managedBlock(paths);
  if (existingReceipt) {
    const receipt = parseReceipt(existingReceipt, paths);
    if (original.split(receipt.appended).length - 1 === 1) {
      return { changed: false, configPath: paths.configPath };
    }
    throw new CodexMcpConfigError(
      "INSTALL_CONFLICT",
      "A different PersonalMemory MCP installation receipt already exists",
    );
  }
  if (
    original.includes(START_MARKER) ||
    original.includes(END_MARKER) ||
    hasServerConfiguration(original)
  ) {
    throw new CodexMcpConfigError(
      "INSTALL_CONFLICT",
      "Codex already contains a PersonalMemory MCP entry not managed by this installation",
    );
  }
  const separator =
    original.length === 0 ? "" : original.endsWith("\n") ? "\n" : "\n\n";
  const appended = `${separator}${block}`;
  const nextConfig = `${original}${appended}`;
  await atomicWrite(
    paths.configPath,
    nextConfig,
    existingConfig?.mode ?? 0o600,
  );
  const receipt = {
    version: RECEIPT_VERSION,
    config_path: paths.configPath,
    config_created: !existingConfig,
    original_sha256: sha256(original),
    block_sha256: sha256(block),
    appended,
  };
  try {
    await atomicWrite(
      receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
      0o600,
    );
  } catch (error) {
    if (existingConfig) {
      await atomicWrite(paths.configPath, original, existingConfig.mode);
    } else {
      await rm(paths.configPath, { force: true });
    }
    throw error;
  }
  return { changed: true, configPath: paths.configPath };
}

export async function uninstallCodexMcp(options = {}) {
  const paths = resolvePaths(options);
  const receiptPath = path.join(path.dirname(paths.configPath), RECEIPT_FILE);
  const receiptFile = await readOptional(receiptPath);
  if (!receiptFile) return { changed: false, configPath: paths.configPath };
  const receipt = parseReceipt(receiptFile, paths);
  const configFile = await readOptional(paths.configPath);
  const managedOccurrences = configFile
    ? configFile.content.split(receipt.appended).length - 1
    : 0;
  if (!configFile || managedOccurrences !== 1) {
    throw new CodexMcpConfigError(
      "CONFIG_CHANGED",
      "Managed PersonalMemory MCP configuration changed; refusing destructive cleanup",
    );
  }
  const nextConfig = configFile.content.replace(receipt.appended, "");
  if (receipt.config_created && nextConfig === "") {
    await rm(paths.configPath);
  } else {
    await atomicWrite(paths.configPath, nextConfig, configFile.mode);
  }
  try {
    await rm(receiptPath);
  } catch (error) {
    await atomicWrite(paths.configPath, configFile.content, configFile.mode);
    throw error;
  }
  return { changed: true, configPath: paths.configPath };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "install" && command !== "uninstall") {
    throw new CodexMcpConfigError(
      "INVALID_ARGUMENT",
      "Usage: node scripts/personalmemory-codex.mjs <install|uninstall> [--config <path>] [--node <path>] [--server-entry <path>]",
    );
  }
  assertNoUnknownOptions(args);
  const options = {
    ...(option(args, "--config")
      ? { configPath: option(args, "--config") }
      : {}),
    ...(option(args, "--node") ? { nodePath: option(args, "--node") } : {}),
    ...(option(args, "--server-entry")
      ? { serverEntry: option(args, "--server-entry") }
      : {}),
  };
  const result =
    command === "install"
      ? await installCodexMcp(options)
      : await uninstallCodexMcp(options);
  process.stdout.write(
    `${result.changed ? (command === "install" ? "installed" : "uninstalled") : "unchanged"}: ${result.configPath}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main().catch((error) => {
    process.stderr.write(
      `PersonalMemory Codex MCP configuration failed (${error?.code ?? "UNKNOWN"})\n`,
    );
    process.exitCode = 1;
  });
}
