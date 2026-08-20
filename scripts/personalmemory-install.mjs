import process from "node:process";

import { installPersonalMemory } from "./personalmemory-install-runtime.mjs";

try {
  const result = await installPersonalMemory();
  process.stdout.write(
    `${result.changed ? "PersonalMemory installed and started" : "PersonalMemory is already installed and running"}\n` +
      `Web: ${result.webUrl}\nHealth: ${result.gatewayHealthUrl}\n` +
      `Codex Hooks: ${result.codexHookStatus} (review the exact definitions with /hooks before trusting)\n` +
      `Claude Code Hooks: ${result.claudeHookStatus}\n` +
      `Data: ${result.dataDirectory}\nLog: ${result.logPath}\n`,
  );
} catch (error) {
  process.stderr.write(
    `PersonalMemory installation failed: ${error instanceof Error ? error.message : "unknown error"}\n` +
      "Existing memory data was not removed. Resolve the problem and run the command again.\n",
  );
  process.exitCode = 1;
}
