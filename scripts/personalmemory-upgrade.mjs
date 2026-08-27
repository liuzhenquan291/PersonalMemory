import process from "node:process";
import {
  defaultInstallRoot,
  defaultStateRoot,
} from "./personalmemory-install-runtime.mjs";
import { upgradePersonalMemory } from "./personalmemory-upgrade-runtime.mjs";

try {
  const result = await upgradePersonalMemory({
    dataDirectory: process.env.PERSONALMEMORY_DATA_DIR ?? defaultInstallRoot(),
    stateDirectory: process.env.PERSONALMEMORY_STATE_DIR ?? defaultStateRoot(),
  });
  process.stdout.write(
    `${result.changed ? "PersonalMemory upgraded" : "PersonalMemory is already current"}\n`,
  );
} catch (error) {
  process.stderr.write(
    `PersonalMemory upgrade failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
