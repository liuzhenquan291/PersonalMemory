import process from "node:process";
import { setTimeout } from "node:timers/promises";

import { runHookMaintenance } from "./personalmemory-hook-managed.mjs";
import { defaultStateRoot } from "./personalmemory-install-runtime.mjs";

const stateDirectory =
  process.env.PERSONALMEMORY_STATE_DIR ?? defaultStateRoot();
const workerGeneration = process.env.PERSONALMEMORY_HOOK_WORKER_GENERATION;
const intervalMs = 60_000;
let stopping = false;
const waitController = new globalThis.AbortController();

process.once("SIGINT", () => {
  stopping = true;
  waitController.abort();
});
process.once("SIGTERM", () => {
  stopping = true;
  waitController.abort();
});

{
  let nextMaintenanceAt = Date.now();
  while (!stopping) {
    await runHookMaintenance({
      stateDirectory,
      workerPid: process.pid,
      workerGeneration,
      maxEntries: 16,
    }).catch(() => undefined);
    nextMaintenanceAt += intervalMs;
    if (!stopping) {
      const delay = Math.max(0, nextMaintenanceAt - Date.now());
      await setTimeout(delay, undefined, {
        signal: waitController.signal,
      }).catch(() => undefined);
    }
  }
}
