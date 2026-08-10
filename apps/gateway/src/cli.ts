import { initializeDataDirectory, loadConfig } from "@personalmemory/core";
import process from "node:process";

import { createGatewayApp } from "./app.js";
import { PersonalMemoryGatewayServer } from "./server.js";
import { FetchUpstreamGatewayClient } from "./upstream-client.js";

let server: PersonalMemoryGatewayServer | undefined;
let stopping = false;

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await server?.stop();
    process.stdout.write(`PersonalMemory Gateway stopped (${signal})\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(
      `PersonalMemory Gateway failed to stop: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  try {
    const { config } = loadConfig();
    initializeDataDirectory(config.dataDirectory);
    const upstream = new FetchUpstreamGatewayClient(
      config.server.upstreamBaseUrl,
    );
    const app = createGatewayApp({ config, upstream });
    server = new PersonalMemoryGatewayServer(app, config);

    process.on("SIGINT", () => void stop("SIGINT"));
    process.on("SIGTERM", () => void stop("SIGTERM"));

    const address = await server.start();
    process.stdout.write(
      `PersonalMemory Gateway ready at http://${address.host}:${address.port}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `PersonalMemory Gateway failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
