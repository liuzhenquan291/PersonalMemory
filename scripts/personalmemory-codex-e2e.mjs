import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  acceptancePrompt,
  acceptanceSchema,
  runChild,
  startAcceptanceFixture,
} from "./personalmemory-client-e2e-fixture.mjs";
import { installCodexMcp, uninstallCodexMcp } from "./personalmemory-codex.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function run() {
  if (process.env.PERSONALMEMORY_RUN_REAL_CODEX_E2E !== "1") {
    process.stdout.write(
      "real Codex E2E skipped; set PERSONALMEMORY_RUN_REAL_CODEX_E2E=1\n",
    );
    return;
  }
  const gateway = await startAcceptanceFixture();
  const root = await mkdtemp(
    path.join(process.env.TMPDIR ?? "/tmp", "personalmemory-codex-e2e-"),
  );
  await chmod(root, 0o700);
  const codexHome = path.join(root, "codex-home");
  const configPath = path.join(codexHome, "config.toml");
  const outputPath = path.join(root, "last-message.json");
  const schemaPath = path.join(root, "output-schema.json");
  await writeFile(schemaPath, `${JSON.stringify(acceptanceSchema)}\n`, {
    mode: 0o600,
  });
  try {
    await installCodexMcp({
      configPath,
      projectRoot,
      serverEntry: path.join(
        projectRoot,
        "packages",
        "mcp-server",
        "dist",
        "cli.js",
      ),
      nodePath: process.execPath,
    });
    const configured = await runChild(
      "codex",
      ["mcp", "get", "personalmemory", "--json"],
      {
        cwd: root,
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
      10_000,
    );
    assert.equal(configured.code, 0, configured.stderr);
    const parsedConfig = JSON.parse(configured.stdout);
    assert.equal(parsedConfig.transport.type, "stdio");
    assert.equal(parsedConfig.transport.command, process.execPath);
    assert.ok(
      parsedConfig.transport.env_vars.includes("PERSONALMEMORY_AUTH_TOKEN"),
    );
    const mcpConfig = [
      ["command", JSON.stringify(process.execPath)],
      [
        "args",
        JSON.stringify([
          path.join(projectRoot, "packages", "mcp-server", "dist", "cli.js"),
        ]),
      ],
      ["cwd", JSON.stringify(projectRoot)],
      [
        "env_vars",
        JSON.stringify([
          "PERSONALMEMORY_AUTH_ENABLED",
          "PERSONALMEMORY_AUTH_TOKEN",
          "PERSONALMEMORY_HOST",
          "PERSONALMEMORY_PORT",
        ]),
      ],
      ["required", "false"],
      ["default_tools_approval_mode", JSON.stringify("auto")],
    ].flatMap(([key, value]) => [
      "-c",
      `mcp_servers.personalmemory.${key}=${value}`,
    ]);
    const executed = await runChild(
      "codex",
      [
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        "--skip-git-repo-check",
        "--strict-config",
        "--json",
        "--sandbox",
        "read-only",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        ...mcpConfig,
        acceptancePrompt,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PERSONALMEMORY_AUTH_ENABLED: "true",
          PERSONALMEMORY_AUTH_TOKEN: gateway.token,
          PERSONALMEMORY_HOST: "127.0.0.1",
          PERSONALMEMORY_PORT: String(gateway.port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
      300_000,
    );
    if (executed.code !== 0) {
      throw new Error(
        `Real Codex E2E failed (${executed.code}): ${executed.stderr.slice(-2_000)} ${executed.stdout.slice(-1_000)}`,
      );
    }
    gateway.assertComplete(JSON.parse(await readFile(outputPath, "utf8")));
    await uninstallCodexMcp({ configPath, projectRoot });
    process.stdout.write(
      "real Codex E2E passed: 5 PersonalMemory MCP tools exercised\n",
    );
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
}

await run();
