import process from "node:process";
import { defaultStateRoot } from "./personalmemory-install-runtime.mjs";
import { managePersonalMemory } from "./personalmemory-lifecycle-runtime.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

try {
  const command = process.argv[2];
  const result = await managePersonalMemory(command, {
    stateDirectory: process.env.PERSONALMEMORY_STATE_DIR ?? defaultStateRoot(),
    output: option("--output"),
    input: option("--input"),
    purgeData: process.argv.includes("--purge-data"),
    confirm: option("--confirm"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `PersonalMemory lifecycle operation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
