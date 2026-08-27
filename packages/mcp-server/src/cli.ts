import { loadConfig } from "@personalmemory/core";
import process from "node:process";
import { PersonalMemoryGatewayClient } from "./gateway-client.js";
import {
  startPersonalMemoryMcpStdio,
  type PersonalMemoryMcpRuntime,
} from "./runtime.js";
import { PersonalMemoryMcpService } from "./service.js";

let runtime: PersonalMemoryMcpRuntime | undefined;
let stopping = false;

function gatewayUrl(host: string, port: number): URL {
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  return new URL(`http://${formattedHost}:${port}/`);
}

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await runtime?.close();
    process.stderr.write(`PersonalMemory MCP Server stopped (${signal})\n`);
    process.exitCode = 0;
  } catch {
    process.stderr.write("PersonalMemory MCP Server failed to stop cleanly\n");
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  try {
    const { config } = loadConfig();
    if (!config.server.authenticationToken) {
      throw new Error("Gateway bearer authentication must be configured");
    }
    const gateway = new PersonalMemoryGatewayClient({
      baseUrl: gatewayUrl(config.server.host, config.server.port),
      token: config.server.authenticationToken.reveal(),
    });
    const service = new PersonalMemoryMcpService(gateway);
    const startedRuntime = await startPersonalMemoryMcpStdio({
      service,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      maxBufferSize: config.server.requestBodyLimitBytes,
    });
    runtime = startedRuntime;
    process.once("SIGINT", () => void stop("SIGINT"));
    process.once("SIGTERM", () => void stop("SIGTERM"));
    await startedRuntime.closed;
  } catch {
    process.stderr.write(
      "PersonalMemory MCP Server failed to start; check local Gateway and authentication configuration\n",
    );
    process.exitCode = 1;
  }
}

await main();
