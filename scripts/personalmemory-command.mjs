#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function defaultStateDirectory(environment = process.env) {
  if (process.platform === "darwin")
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "PersonalMemory Runtime",
    );
  return path.join(
    environment.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    "personalmemory",
  );
}

async function readPrivateFile(target) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error(`PersonalMemory private file is unsafe: ${target}`);
  return await readFile(target, "utf8");
}

async function readToken(stateDirectory) {
  const contents = await readPrivateFile(
    path.join(stateDirectory, "gateway.env"),
  );
  const values = new Map();
  for (const line of contents.trimEnd().split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0)
      throw new Error("PersonalMemory credential file is malformed");
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const token = values.get("PERSONALMEMORY_AUTH_TOKEN");
  if (!token || !TOKEN_PATTERN.test(token))
    throw new Error("PersonalMemory access token is missing or malformed");
  return token;
}

async function readInstalledWebUrl(stateDirectory) {
  const contents = await readPrivateFile(
    path.join(stateDirectory, "install.json"),
  );
  const receipt = JSON.parse(contents);
  const url = new URL(receipt.webUrl);
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("PersonalMemory installation contains an unsafe Web URL");
  }
  return new URL("/settings", url).href;
}

async function spawnCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} failed (${signal ?? code ?? "unknown"})`));
    });
  });
  return 0;
}

function usage() {
  return `Usage: personalmemory <command> [options]

Commands:
  status                         Show managed service and Hook status
  open                           Open the local Web settings page
  restart                        Restart managed services
  stop                           Stop managed services
  backup --output <directory>    Create and verify a full backup
  token show                     Reveal the local access token in a terminal
  help                           Show this help
`;
}

export async function runPersonalMemoryCommand(args, options = {}) {
  const stateDirectory = options.stateDirectory ?? defaultStateDirectory();
  const stdout = options.stdout ?? process.stdout;
  const sourceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const runLifecycle =
    options.runLifecycle ??
    ((lifecycleArgs) =>
      spawnCommand(process.execPath, [
        path.join(sourceRoot, "scripts", "personalmemory-lifecycle.mjs"),
        ...lifecycleArgs,
      ]));

  if (
    args.length === 0 ||
    args[0] === "help" ||
    args[0] === "--help" ||
    args[0] === "-h"
  ) {
    stdout.write(usage());
    return { command: "help" };
  }
  if (args[0] === "token" && args[1] === "show" && args.length === 2) {
    if (!stdout.isTTY)
      throw new Error("token show requires an interactive terminal");
    stdout.write(`${await readToken(stateDirectory)}\n`);
    return { command: "token.show" };
  }
  if (args[0] === "open" && args.length === 1) {
    const url = await (options.readInstalledWebUrl ?? readInstalledWebUrl)(
      stateDirectory,
    );
    if (options.openUrl) await options.openUrl(url);
    else
      await spawnCommand(process.platform === "darwin" ? "open" : "xdg-open", [
        url,
      ]);
    return { command: "open" };
  }
  if (["status", "restart", "stop"].includes(args[0]) && args.length === 1) {
    await runLifecycle([args[0]]);
    return { command: args[0] };
  }
  if (
    args[0] === "backup" &&
    args.length === 3 &&
    args[1] === "--output" &&
    args[2]
  ) {
    await runLifecycle(args);
    return { command: "backup" };
  }
  throw new Error(`Unknown or incomplete command.\n\n${usage()}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runPersonalMemoryCommand(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`PersonalMemory command failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
