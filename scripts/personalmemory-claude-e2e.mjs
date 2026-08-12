import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  acceptancePrompt,
  acceptanceSchema,
  runChild,
  startAcceptanceFixture,
} from "./personalmemory-client-e2e-fixture.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const toolNames = [
  "personalmemory_search",
  "personalmemory_read",
  "personalmemory_capture",
  "personalmemory_feedback",
  "personalmemory_prepare_forget",
];
const toolSteps = [
  {
    name: "personalmemory_search",
    input: { query: "中文回答偏好", page_size: 1 },
    assertResult(value) {
      assert.equal(value.items[0].id, "m-approved");
      assert.equal(value.items[0].source.reference_count, 1);
      assert.equal(value.items[0].source.message_ids, undefined);
      assert.equal(value.budget.estimated_tokens, 20);
      assert.equal(value.page.count, 1);
    },
  },
  {
    name: "personalmemory_read",
    input: { level: "L1", memory_id: "m-approved", max_chars: 6_000 },
    assertResult(value) {
      assert.equal(value.memory.id, "m-approved");
      assert.deepEqual(value.memory.source.message_ids, ["source-1"]);
      assert.equal(value.memory.review.status, "approved");
    },
  },
  {
    name: "personalmemory_capture",
    input: {
      idempotency_key: "cross-client-capture-0001",
      session_key: "cross-client-session",
      messages: [
        { role: "user", content: "请记住我正在做跨客户端验收。" },
        {
          role: "assistant",
          content: "我会把这条信息作为用户数据保存。",
        },
      ],
    },
    assertResult(value) {
      assert.equal(value.status, "completed");
      assert.equal(value.duplicate, false);
    },
  },
  {
    name: "personalmemory_feedback",
    input: {
      memory_id: "m-pending",
      action: "approve",
      expected_review_revision: 0,
    },
    assertResult(value) {
      assert.equal(value.status, "approved");
      assert.equal(value.review_revision, 1);
    },
  },
  {
    name: "personalmemory_prepare_forget",
    input: { memory_id: "m-approved" },
    assertResult(value) {
      assert.equal(value.handoff_id, "handoff-client-e2e");
      assert.equal(value.web_confirmation_required, true);
      assert.equal(value.destructive_action_performed, false);
    },
  },
];

export function createClaudeMcpConfig({ port, token }) {
  return {
    mcpServers: {
      personalmemory: {
        type: "stdio",
        command: process.execPath,
        args: [
          path.join(projectRoot, "packages", "mcp-server", "dist", "cli.js"),
        ],
        env: {
          PERSONALMEMORY_AUTH_ENABLED: "true",
          PERSONALMEMORY_AUTH_TOKEN: token,
          PERSONALMEMORY_HOST: "127.0.0.1",
          PERSONALMEMORY_PORT: String(port),
        },
      },
    },
  };
}

export function claudeToolNames() {
  return toolNames.map((name) => `mcp__personalmemory__${name}`);
}

function sse(response, events) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function assistantEvents(contentBlock, stopReason) {
  return [
    {
      type: "message_start",
      message: {
        id: `msg_fixture_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: "claude-fixture",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: contentBlock.start,
    },
    { type: "content_block_delta", index: 0, delta: contentBlock.delta },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
}

function toolResults(messages) {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "tool_result")
      : [],
  );
}

function resultValue(result) {
  let value = result.content;
  if (Array.isArray(value) && value.length === 1 && value[0]?.type === "text") {
    value = value[0].text;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export async function startClaudeModelFixture() {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url?.split("?")[0], "/v1/messages");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(input.stream, true);
      const advertised = new Set((input.tools ?? []).map(({ name }) => name));
      assert.deepEqual(
        [...advertised]
          .filter((name) => name.startsWith("mcp__personalmemory__"))
          .sort(),
        [...claudeToolNames()].sort(),
      );
      assert.deepEqual(
        [...advertised].filter(
          (name) => !name.startsWith("mcp__personalmemory__"),
        ),
        ["StructuredOutput"],
      );
      const results = toolResults(input.messages ?? []);
      assert.equal(results.length, Math.min(requests.length, toolSteps.length));
      if (results.length > 0) {
        const previous = toolSteps[results.length - 1];
        const result = results.at(-1);
        assert.notEqual(result.is_error, true);
        previous.assertResult(resultValue(result));
      }
      requests.push(input);
      const step = toolSteps[results.length];
      if (step) {
        sse(
          response,
          assistantEvents(
            {
              start: {
                type: "tool_use",
                id: `toolu_fixture_${results.length + 1}`,
                name: `mcp__personalmemory__${step.name}`,
                input: {},
              },
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify(step.input),
              },
            },
            "tool_use",
          ),
        );
        return;
      }
      sse(
        response,
        assistantEvents(
          {
            start: { type: "text", text: "" },
            delta: {
              type: "text_delta",
              text: JSON.stringify({
                search_id: "m-approved",
                read_ok: true,
                capture_status: "completed",
                feedback_status: "approved",
                handoff_id: "handoff-client-e2e",
                prompt_injection_followed: false,
                deletion_claimed: false,
              }),
            },
          },
          "end_turn",
        ),
      );
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: error.message },
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    assertComplete() {
      assert.ok(
        requests.length === toolSteps.length + 1 ||
          requests.length === toolSteps.length + 2,
      );
    },
    close: async () =>
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function extractResult(stdout) {
  const envelope = JSON.parse(stdout);
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new Error(
      `Real Claude Code E2E failed: ${String(envelope.result ?? "unknown error").slice(-2_000)}`,
    );
  }
  if (envelope.structured_output) return envelope.structured_output;
  if (typeof envelope.result !== "string") {
    throw new Error("Claude Code did not return structured acceptance output");
  }
  return JSON.parse(envelope.result);
}

export async function runClaudeE2e() {
  if (process.env.PERSONALMEMORY_RUN_REAL_CLAUDE_E2E !== "1") {
    process.stdout.write(
      "real Claude Code E2E skipped; set PERSONALMEMORY_RUN_REAL_CLAUDE_E2E=1\n",
    );
    return;
  }
  const claudeBin = process.env.PERSONALMEMORY_CLAUDE_BIN;
  if (!claudeBin || !path.isAbsolute(claudeBin)) {
    throw new Error("PERSONALMEMORY_CLAUDE_BIN must be an absolute path");
  }
  const stat = await lstat(claudeBin);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  await access(claudeBin, fsConstants.X_OK);
  let gateway;
  let model;
  let root;
  let runError;
  let cleanupErrors;
  try {
    gateway = await startAcceptanceFixture();
    model = await startClaudeModelFixture();
    root = await mkdtemp(
      path.join(process.env.TMPDIR ?? "/tmp", "personalmemory-claude-e2e-"),
    );
    await chmod(root, 0o700);
    const configPath = path.join(root, "mcp.json");
    const config = createClaudeMcpConfig(gateway);
    await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const allowedTools = claudeToolNames();
    const clientEnv = {
      ...process.env,
      ANTHROPIC_API_KEY: "personalmemory-local-model-fixture",
      ANTHROPIC_BASE_URL: model.baseUrl,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CONFIG_DIR: path.join(root, "claude-config"),
      HOME: root,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
    for (const name of [
      "ALL_PROXY",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "all_proxy",
      "https_proxy",
      "http_proxy",
      "ANTHROPIC_AUTH_TOKEN",
    ]) {
      delete clientEnv[name];
    }
    const version = await runChild(
      claudeBin,
      ["--version"],
      { cwd: root, env: clientEnv, stdio: ["ignore", "pipe", "pipe"] },
      10_000,
    );
    assert.equal(version.code, 0, version.stderr);
    assert.match(version.stdout, /^2\.1\.228 \(Claude Code\)/u);
    const executed = await runChild(
      claudeBin,
      [
        "--bare",
        "--print",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        configPath,
        "--permission-mode",
        "dontAsk",
        "--tools",
        allowedTools.join(","),
        "--allowedTools",
        allowedTools.join(","),
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(acceptanceSchema),
        acceptancePrompt,
      ],
      {
        cwd: root,
        env: clientEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
      300_000,
    );
    if (executed.code !== 0) {
      throw new Error(
        `Real Claude Code E2E failed (${executed.code}): ${executed.stderr.slice(-2_000)} ${executed.stdout.slice(-2_000)}`,
      );
    }
    gateway.assertComplete(extractResult(executed.stdout));
    model.assertComplete();
    process.stdout.write(
      "real Claude Code E2E passed: 5 PersonalMemory MCP tools exercised\n",
    );
  } catch (error) {
    runError = error;
  } finally {
    const cleanup = await Promise.allSettled([
      ...(gateway ? [gateway.close()] : []),
      ...(model ? [model.close()] : []),
      ...(root ? [rm(root, { recursive: true, force: true })] : []),
    ]);
    cleanupErrors = cleanup
      .filter(({ status }) => status === "rejected")
      .map(({ reason }) => reason);
  }
  if (runError && cleanupErrors.length > 0) {
    throw new AggregateError([runError, ...cleanupErrors], runError.message);
  }
  if (runError) throw runError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Claude Code E2E cleanup failed");
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runClaudeE2e();
}
