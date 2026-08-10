import process from "node:process";

import {
  createDevRuntime,
  DevRuntimeStoppedError,
  parseDevPort,
} from "./dev-runtime.mjs";

let runtime;
let stopping = false;

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  try {
    await runtime?.stop();
    process.stdout.write(
      `PersonalMemory development services stopped (${signal})\n`,
    );
  } catch (error) {
    process.stderr.write(
      `PersonalMemory development cleanup failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}

async function main() {
  try {
    runtime = await createDevRuntime({
      gatewayPort: parseDevPort(
        process.env.PERSONALMEMORY_DEV_GATEWAY_PORT,
        8787,
        "PERSONALMEMORY_DEV_GATEWAY_PORT",
      ),
      webPort: parseDevPort(
        process.env.PERSONALMEMORY_DEV_WEB_PORT,
        4173,
        "PERSONALMEMORY_DEV_WEB_PORT",
      ),
      onUnexpectedExit() {
        process.exitCode = 1;
      },
    });

    process.on("SIGINT", () => void stop("SIGINT"));
    process.on("SIGTERM", () => void stop("SIGTERM"));

    const ready = await runtime.start();
    process.stdout.write("\nPersonalMemory development environment is ready\n");
    process.stdout.write(`Web:     ${ready.webUrl}\n`);
    process.stdout.write(`Gateway: ${ready.gatewayUrl}/health\n`);
    process.stdout.write(`Data:    ${ready.dataDirectory} (temporary)\n`);
    process.stdout.write("Press Ctrl+C to stop all services.\n\n");
  } catch (error) {
    if (stopping && error instanceof DevRuntimeStoppedError) return;
    process.stderr.write(
      `PersonalMemory development environment failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}

await main();
