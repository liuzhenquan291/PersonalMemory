import { Buffer } from "node:buffer";
import process from "node:process";

import { parseHookEvent } from "./personalmemory-hook-adapter.mjs";
import {
  createManagedHookRuntime,
  recordFirstHookEvent,
} from "./personalmemory-hook-managed.mjs";
import { defaultStateRoot } from "./personalmemory-install-runtime.mjs";

const MAX_INPUT_BYTES = 128 * 1024;

async function readInput() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) throw new Error("Hook input is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
}

async function main() {
  const client = process.argv[2];
  const stateArgument = process.argv.indexOf("--state-directory");
  const definitionArgument = process.argv.indexOf("--definition-id");
  const stateDirectory =
    (stateArgument >= 0 ? process.argv[stateArgument + 1] : undefined) ??
    process.env.PERSONALMEMORY_STATE_DIR ??
    defaultStateRoot();
  const input = await readInput();
  const event = parseHookEvent(client, input);
  if (event.kind === "skip") return {};
  await recordFirstHookEvent({
    stateDirectory,
    client,
    event: input.hook_event_name,
    definitionId:
      definitionArgument >= 0
        ? process.argv[definitionArgument + 1]
        : undefined,
  });
  const managed = await createManagedHookRuntime({ stateDirectory });
  return await managed.runtime.handle(event);
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch {
  process.stdout.write("{}\n");
}
