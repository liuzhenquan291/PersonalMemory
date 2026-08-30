import { URL } from "node:url";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";

export const SUPPORTED_AGENTS = ["codex", "claude-code"];
export const DEFAULT_INSTALL_PORTS = {
  upstreamPort: 17173,
  gatewayPort: 17175,
  webPort: 17177,
};

function executableName(agent) {
  return agent === "claude-code" ? "claude" : agent;
}

async function executableExists(name, environment, accessImpl) {
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    try {
      await accessImpl(path.join(directory, name), constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

export function parseAgentArguments(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--agent")
      throw new Error(`Unknown installation option: ${args[index]}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error("--agent requires a value");
    values.push(value);
    index += 1;
  }
  if (values.length === 0) return undefined;
  const unknown = values.filter(
    (value) => ![...SUPPORTED_AGENTS, "all", "none"].includes(value),
  );
  if (unknown.length > 0)
    throw new Error(
      `Unsupported Agent: ${unknown[0]}. Supported values: ${SUPPORTED_AGENTS.join(", ")}, all, none`,
    );
  if (values.includes("none") && values.length > 1)
    throw new Error("--agent none cannot be combined with other Agent values");
  if (values.includes("all") && values.length > 1)
    throw new Error("--agent all cannot be combined with other Agent values");
  if (values[0] === "none") return [];
  if (values[0] === "all") return [...SUPPORTED_AGENTS];
  return SUPPORTED_AGENTS.filter((agent) => values.includes(agent));
}

function parsePort(option, value) {
  if (!value || !/^\d+$/u.test(value))
    throw new Error(`${option} requires an integer port`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${option} must be between 1 and 65535`);
  return port;
}

export function parseInstallArguments(args) {
  const agentArgs = [];
  const ports = {};
  const portOptions = new Map([
    ["--upstream-port", "upstreamPort"],
    ["--gateway-port", "gatewayPort"],
    ["--web-port", "webPort"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === "--agent") {
      if (!value || value.startsWith("--"))
        throw new Error("--agent requires a value");
      agentArgs.push(option, value);
      index += 1;
      continue;
    }
    const key = portOptions.get(option);
    if (!key) throw new Error(`Unknown installation option: ${option}`);
    if (ports[key] !== undefined)
      throw new Error(`${option} cannot be repeated`);
    ports[key] = parsePort(option, value);
    index += 1;
  }
  const effectivePorts = { ...DEFAULT_INSTALL_PORTS, ...ports };
  if (new Set(Object.values(effectivePorts)).size !== 3)
    throw new Error("PersonalMemory service ports must be distinct");
  return { agents: parseAgentArguments(agentArgs), ...ports };
}

export async function resolveInstallAgents(
  args,
  environment = process.env,
  accessImpl = access,
) {
  const explicit = parseAgentArguments(args);
  if (explicit) return explicit;
  const detected = [];
  for (const agent of SUPPORTED_AGENTS) {
    if (await executableExists(executableName(agent), environment, accessImpl))
      detected.push(agent);
  }
  return detected;
}

export async function resolveInstallOptions(
  args,
  environment = process.env,
  accessImpl = access,
) {
  const parsed = parseInstallArguments(args);
  return {
    ...parsed,
    agents:
      parsed.agents ??
      (await resolveInstallAgents([], environment, accessImpl)),
  };
}

export function readManagedPorts(receipt) {
  const ports = {};
  for (const [key, field] of [
    ["upstreamPort", "upstreamHealthUrl"],
    ["gatewayPort", "gatewayHealthUrl"],
    ["webPort", "webUrl"],
  ]) {
    if (receipt.version === 1 && receipt[field] === undefined) {
      ports[key] = DEFAULT_INSTALL_PORTS[key];
      continue;
    }
    let url;
    try {
      url = new URL(receipt[field]);
    } catch {
      throw new Error(`Invalid managed service URL: ${field}`);
    }
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password
    ) {
      throw new Error(`Invalid managed service URL: ${field}`);
    }
    ports[key] = Number(url.port || "80");
    if (!Number.isInteger(ports[key]) || ports[key] < 1 || ports[key] > 65535) {
      throw new Error(`Invalid managed service port: ${field}`);
    }
  }
  if (new Set(Object.values(ports)).size !== 3)
    throw new Error("Managed service ports must be distinct");
  return ports;
}
