import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
  PrivateTurnStore,
  buildCaptureRequest,
  buildRecallRequest,
  createHookIdempotencyKey,
  parseHookEvent,
} from "./personalmemory-hook-adapter.mjs";

const authorization = {
  installation_id: "install-1",
  authorization_revision: 2,
  policy_revision: 3,
};

test("parses Codex and Claude events without transcript fallback", () => {
  const codex = parseHookEvent("codex", {
    hook_event_name: "UserPromptSubmit",
    session_id: "s",
    turn_id: "t",
    cwd: "/p",
    prompt: "hello",
    transcript_path: "/ignored",
  });
  assert.equal(codex.kind, "prompt");
  assert.equal(buildRecallRequest(codex, authorization).event.turn_id, "t");
  assert.deepEqual(
    parseHookEvent("claude-code", {
      hook_event_name: "SubagentStop",
      session_id: "s",
      cwd: "/p",
    }),
    { kind: "skip", reason: "invalid_event" },
  );
  assert.deepEqual(
    parseHookEvent("claude-code", {
      hook_event_name: "Stop",
      session_id: "s",
      prompt_id: "p",
      cwd: "/p",
      last_assistant_message: "",
    }),
    { kind: "skip", reason: "empty_assistant_message" },
  );
});

test("pairs a legacy Claude turn privately and creates content-free stable HMAC", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-hook-"));
  try {
    const store = new PrivateTurnStore(root, {
      now: () => 100,
      random: () => "nonce",
    });
    const prompt = parseHookEvent("claude-code", {
      hook_event_name: "UserPromptSubmit",
      session_id: "s",
      cwd: "/p",
      prompt: "secret prompt",
    });
    const remembered = await store.remember(prompt, "installation-secret");
    const turnId = remembered.turnId;
    const stop = parseHookEvent("claude-code", {
      hook_event_name: "Stop",
      session_id: "s",
      cwd: "/p",
      last_assistant_message: "secret answer",
    });
    const claim = await store.claim(stop);
    assert.equal(claim.record.turnId, turnId);
    const request = buildCaptureRequest(
      claim.record,
      stop,
      authorization,
      "installation-secret",
    );
    assert.match(request.idempotency_key, /^hook:v1:[a-f0-9]{64}$/u);
    assert.equal(
      request.idempotency_key,
      createHookIdempotencyKey("installation-secret", {
        client: "claude-code",
        installationId: "install-1",
        sessionId: "s",
        turnId,
      }),
    );
    assert.doesNotMatch(request.idempotency_key, /secret/u);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(root, "turns.json"))).mode & 0o777,
      0o600,
    );
    await store.acknowledge(claim);
    assert.doesNotMatch(
      await readFile(path.join(root, "turns.json"), "utf8"),
      /secret/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent native turns, upserts retries and prunes expired text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-hook-concurrent-"));
  let now = 100;
  try {
    const store = new PrivateTurnStore(root, { now: () => now });
    const events = Array.from({ length: 20 }, (_, index) => ({
      kind: "prompt",
      client: "codex",
      sessionId: "s",
      turnId: `t-${index}`,
      cwd: "/p",
      prompt: `prompt-${index}`,
    }));
    await Promise.all(events.map((event) => store.remember(event, "secret")));
    await store.remember(events[0], "secret");
    for (const event of events) {
      const claim = await store.claim({ ...event, kind: "stop" });
      assert.equal(claim.record.prompt, event.prompt);
      await store.acknowledge(claim);
    }
    await store.remember(events[0], "secret");
    now += 60 * 60 * 1000 + 1;
    assert.equal(await store.claim({ ...events[0], kind: "stop" }), undefined);
    assert.doesNotMatch(
      await readFile(path.join(root, "turns.json"), "utf8"),
      /prompt/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails open on malformed and continued events and uses unambiguous HMAC tuples", () => {
  assert.deepEqual(parseHookEvent("codex", { hook_event_name: "Stop" }), {
    kind: "skip",
    reason: "invalid_event",
  });
  assert.deepEqual(
    parseHookEvent("codex", {
      hook_event_name: "Stop",
      session_id: "s",
      turn_id: "t",
      cwd: "/p",
      last_assistant_message: "partial",
      stop_hook_active: true,
    }),
    { kind: "skip", reason: "invalid_event" },
  );
  const first = createHookIdempotencyKey("secret", {
    client: "codex",
    installationId: "a\0b",
    sessionId: "c",
    turnId: "d",
  });
  const second = createHookIdempotencyKey("secret", {
    client: "codex",
    installationId: "a",
    sessionId: "b",
    turnId: "c\0d",
  });
  assert.notEqual(first, second);
});

test("reuses only the pending legacy turn and allocates a new id after acknowledgement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-hook-legacy-"));
  let nonce = 0;
  try {
    const store = new PrivateTurnStore(root, {
      now: () => 100,
      random: () => `nonce-${(nonce += 1)}`,
    });
    const prompt = {
      kind: "prompt",
      client: "claude-code",
      sessionId: "s",
      cwd: "/p",
      prompt: "first",
    };
    const first = await store.remember(prompt, "secret");
    const retry = await store.remember(prompt, "secret");
    assert.equal(retry.turnId, first.turnId);
    const firstClaim = await store.claim({ ...prompt, kind: "stop" });
    await store.acknowledge(firstClaim);
    const second = await store.remember(
      { ...prompt, prompt: "second" },
      "secret",
    );
    assert.notEqual(second.turnId, first.turnId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers expired claims and rejects stale acknowledgement tokens", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-hook-claim-"));
  let now = 100;
  let nonce = 0;
  try {
    const store = new PrivateTurnStore(root, {
      now: () => now,
      random: () => `nonce-${(nonce += 1)}`,
    });
    const prompt = {
      kind: "prompt",
      client: "codex",
      sessionId: "s",
      turnId: "t",
      cwd: "/p",
      prompt: "original",
    };
    await store.remember(prompt, "secret");
    const first = await store.claim({ ...prompt, kind: "stop" });
    assert.equal(await store.claim({ ...prompt, kind: "stop" }), undefined);
    now += 30_001;
    const recovered = await store.claim({ ...prompt, kind: "stop" });
    assert.notEqual(recovered.claimToken, first.claimToken);
    await store.acknowledge(first);
    await store.release(recovered);
    const released = await store.claim({ ...prompt, kind: "stop" });
    assert.equal(released.record.prompt, "original");
    await store.acknowledge(released);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves the original native payload when a retry conflicts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-hook-conflict-"));
  try {
    const store = new PrivateTurnStore(root);
    const prompt = {
      kind: "prompt",
      client: "codex",
      sessionId: "s",
      turnId: "t",
      cwd: "/p",
      prompt: "original",
    };
    await store.remember(prompt, "secret");
    await assert.rejects(
      store.remember({ ...prompt, prompt: "replacement" }, "secret"),
      /conflicts/u,
    );
    const claim = await store.claim({ ...prompt, kind: "stop" });
    assert.equal(claim.record.prompt, "original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers a stale process lock and enforces count and byte capacity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-hook-bounds-"));
  try {
    const lock = path.join(root, "turns.lock");
    await writeFile(
      lock,
      JSON.stringify({ pid: 2_147_483_647, token: "abandoned" }),
      { mode: 0o600 },
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const store = new PrivateTurnStore(root);
    const prompts = Array.from({ length: 129 }, (_, index) => ({
      kind: "prompt",
      client: "codex",
      sessionId: "s",
      turnId: `t-${index}`,
      cwd: "/p",
      prompt: `${index}-${"界".repeat(32_768 - String(index).length - 1)}`,
    }));
    for (const prompt of prompts) await store.remember(prompt, "secret");
    const file = path.join(root, "turns.json");
    const records = JSON.parse(await readFile(file, "utf8"));
    assert.ok(records.length <= 128);
    assert.ok((await stat(file)).size <= 4 * 1024 * 1024);
    assert.equal(records.at(-1).turnId, "t-128");
    const claim = await store.claim({ ...prompts.at(-1), kind: "stop" });
    assert.equal(claim.record.turnId, "t-128");
    assert.ok((await stat(file)).size <= 4 * 1024 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never steals a live owner lock even when its mtime is old", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-hook-live-lock-"));
  try {
    const lock = path.join(root, "turns.lock");
    const owner = JSON.stringify({ pid: process.pid, token: "live" });
    await writeFile(lock, owner, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const store = new PrivateTurnStore(root);
    await assert.rejects(
      store.remember(
        {
          kind: "prompt",
          client: "codex",
          sessionId: "s",
          turnId: "t",
          cwd: "/p",
          prompt: "prompt",
        },
        "secret",
      ),
      { code: "EEXIST" },
    );
    assert.equal(await readFile(lock, "utf8"), owner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers zero-byte lock markers left during process crashes", async () => {
  for (const recoveryMarker of [false, true]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-hook-empty-lock-"));
    try {
      const lock = path.join(root, "turns.lock");
      if (recoveryMarker)
        await writeFile(
          lock,
          JSON.stringify({ pid: 2_147_483_647, token: "abandoned" }),
          { mode: 0o600 },
        );
      else await writeFile(lock, "", { mode: 0o600 });
      const marker = recoveryMarker ? `${lock}.recovery` : lock;
      if (recoveryMarker) await writeFile(marker, "", { mode: 0o600 });
      const old = new Date(Date.now() - 60_000);
      await utimes(marker, old, old);
      const store = new PrivateTurnStore(root);
      const prompt = {
        kind: "prompt",
        client: "codex",
        sessionId: "s",
        turnId: recoveryMarker ? "recovery" : "lock",
        cwd: "/p",
        prompt: "prompt",
      };
      await store.remember(prompt, "secret");
      const claim = await store.claim({ ...prompt, kind: "stop" });
      assert.equal(claim.record.prompt, "prompt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects a user-controlled symlink anywhere above the turn store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-hook-symlink-"));
  try {
    const actual = path.join(root, "actual");
    await mkdir(path.join(actual, "state"), { recursive: true, mode: 0o700 });
    const linked = path.join(root, "linked");
    await symlink(actual, linked);
    assert.throws(
      () => new PrivateTurnStore(path.join(linked, "state")),
      /symlink/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active claims fail capacity closed and expired claims become evictable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-hook-claims-"));
  let now = 100;
  try {
    const store = new PrivateTurnStore(root, { now: () => now });
    const prompts = Array.from({ length: 128 }, (_, index) => ({
      kind: "prompt",
      client: "codex",
      sessionId: "s",
      turnId: `t-${index}`,
      cwd: "/p",
      prompt: `prompt-${index}`,
    }));
    for (const prompt of prompts) {
      await store.remember(prompt, "secret");
      await store.claim({ ...prompt, kind: "stop" });
    }
    const next = { ...prompts[0], turnId: "t-128", prompt: "next" };
    await assert.rejects(store.remember(next, "secret"), /active claims/u);
    now += 30_001;
    await store.remember(next, "secret");
    const records = JSON.parse(
      await readFile(path.join(root, "turns.json"), "utf8"),
    );
    assert.equal(records.length, 128);
    assert.ok(records.some((item) => item.turnId === "t-128"));
    assert.ok(records.every((item) => !item.claimToken));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lets the managed worker physically prune expired turns without a later Hook", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-hook-maintain-"));
  let now = 100;
  try {
    const store = new PrivateTurnStore(root, { now: () => now });
    await store.remember(
      {
        kind: "prompt",
        client: "codex",
        sessionId: "session",
        turnId: "turn",
        cwd: "/project",
        prompt: "private prompt",
      },
      "secret",
    );
    now += 60 * 60 * 1000 + 1;
    assert.deepEqual(await store.maintain(), { retained: 0 });
    assert.doesNotMatch(
      await readFile(path.join(root, "turns.json"), "utf8"),
      /private prompt/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
