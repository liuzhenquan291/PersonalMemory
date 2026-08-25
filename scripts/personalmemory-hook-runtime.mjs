import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { lstatSync, realpathSync } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import {
  PERSONAL_MEMORY_HOOK_CONTRACT_VERSION as VERSION,
  UNTRUSTED_HOOK_MEMORY_WARNING as WARNING,
  hookCaptureRequestSchema,
  hookCaptureResponseSchema,
  hookRecallBudgetSchema,
  hookRecallRequestSchema,
  hookRecallResponseSchema,
} from "@personalmemory/core/hook-contract";
import {
  buildCaptureRequest,
  buildRecallRequest,
  parseHookEvent,
} from "./personalmemory-hook-adapter.mjs";

const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;
const OUTBOX_CLAIM_MS = 30_000;
const MAX_OUTBOX_ENTRIES = 64;
const MAX_OUTBOX_ENTRY_BYTES = 256 * 1024;
const MAX_OUTBOX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [1000, 5000, 30_000, 60_000];
const MAX_RECALL_RESPONSE_BYTES = 16 * 1024;
const MAX_CAPTURE_RESPONSE_BYTES = 4 * 1024;
const MAX_AUTHORIZATION_RESPONSE_BYTES = 4 * 1024;
const MAX_RETENTION_RESPONSE_BYTES = 8 * 1024;

function canonicalizeFuturePath(target) {
  let existing = target;
  const suffix = [];
  for (;;) {
    try {
      lstatSync(existing);
      return path.join(realpathSync(existing), ...suffix);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(existing);
    if (parent === existing)
      throw new Error("No private outbox ancestor exists");
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
}

function assertNoUserSymlinkPath(target) {
  const allowedSystemAliases =
    process.platform === "darwin"
      ? new Set(["/etc", "/tmp", "/var"])
      : new Set();
  let current = target;
  for (;;) {
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() && !allowedSystemAliases.has(current))
        throw new Error("Hook outbox path contains a symlink");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function outboxSlot(fileName) {
  const match = /^outbox-(\d{2})\.json$/u.exec(fileName);
  return match ? Number(match[1]) : undefined;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function requireLoopbackBaseUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !new Set(["127.0.0.1", "[::1]", "::1"]).has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Hook Gateway URL must be an HTTP loopback origin");
  return url.origin;
}

function degradedRecall(reason) {
  return {
    contract_version: VERSION,
    data_classification: "untrusted_memory_data",
    usage_warning: WARNING,
    outcome: "degraded",
    reason,
    item_count: 0,
    used_chars: 0,
    estimated_tokens: 0,
  };
}

async function readJsonLimited(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error("Hook Gateway response is too large");
  if (!response.body) throw new Error("Hook Gateway response body is missing");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes)
        throw new Error("Hook Gateway response is too large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
}

function queuedCapture(reason) {
  return {
    contract_version: VERSION,
    outcome: "queued",
    reason,
    retryable: true,
  };
}

function boundRecallResponse(response, budget) {
  if (response.outcome !== "recalled") return response;
  if (response.item_count > budget.max_items)
    return degradedRecall("gateway_unavailable");
  const maxChars = Math.min(budget.max_chars, budget.max_tokens * 4);
  const prefix = `${WARNING}\n\n`;
  const additionalContext = `${prefix}${response.additional_context.slice(
    0,
    Math.max(0, maxChars - prefix.length),
  )}`;
  return {
    ...response,
    additional_context: additionalContext,
    used_chars: additionalContext.length,
    estimated_tokens: Math.ceil(additionalContext.length / 4),
  };
}

export class HookGatewayClient {
  constructor(options) {
    this.baseUrl = requireLoopbackBaseUrl(options.baseUrl);
    this.token = options.token;
    if (typeof this.token !== "string" || this.token.length < 1)
      throw new Error("Hook Gateway token is required");
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async authorization() {
    const response = await this.fetch(
      `${this.baseUrl}/api/v1/hooks/authorization`,
      {
        headers: { authorization: `Bearer ${this.token}` },
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(1000),
      },
    );
    if (!response.ok)
      throw new Error(
        `Hook Gateway rejected authorization status with ${response.status}`,
      );
    const body = await readJsonLimited(
      response,
      MAX_AUTHORIZATION_RESPONSE_BYTES,
    );
    const value = body?.authorization;
    if (
      typeof value?.installation_id !== "string" ||
      !Number.isInteger(value.authorization_revision) ||
      value.authorization_revision < 1 ||
      !Number.isInteger(value.policy_revision) ||
      value.policy_revision < 1 ||
      typeof value.recall_enabled !== "boolean" ||
      typeof value.capture_enabled !== "boolean" ||
      typeof value.changed_at !== "string"
    )
      throw new Error("Hook Gateway returned invalid authorization status");
    return value;
  }

  async retentionMaintenance(options = {}) {
    const response = await this.fetch(
      `${this.baseUrl}/api/v1/retention/maintenance`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...(options.lifecycleToken
            ? { lifecycle_token: options.lifecycleToken }
            : {}),
        }),
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(55_000),
      },
    );
    if (!response.ok)
      throw new Error(`Retention maintenance failed with ${response.status}`);
    const body = await readJsonLimited(response, MAX_RETENTION_RESPONSE_BYTES);
    if (
      !new Set([
        "disabled",
        "not_applicable",
        "draining",
        "drained",
        "partial",
      ]).has(body?.status)
    )
      throw new Error("Gateway returned invalid retention maintenance status");
    const run = body.run;
    if (
      body.authorization !== undefined &&
      !new Set(["authorized", "disabled", "revoked", "stale"]).has(
        body.authorization,
      )
    )
      throw new Error("Gateway returned invalid retention authorization");
    if (
      body.policy_revision !== undefined &&
      (!Number.isInteger(body.policy_revision) || body.policy_revision < 1)
    )
      throw new Error("Gateway returned invalid retention policy revision");
    if (
      body.authorization_revision !== undefined &&
      (!Number.isInteger(body.authorization_revision) ||
        body.authorization_revision < 0)
    )
      throw new Error("Gateway returned invalid retention authorization revision");
    if (run !== undefined) {
      for (const key of [
        "plannedL0",
        "plannedL1",
        "deletedL0",
        "deletedL1",
        "remainingL0",
        "remainingL1",
        "deletedArtifacts",
        "anomalyCount",
      ]) {
        if (!Number.isInteger(run[key]) || run[key] < 0)
          throw new Error("Gateway returned invalid retention statistics");
      }
    }
    return {
      status: body.status,
      ...(body.skipped === true ? { skipped: true } : {}),
      ...(body.authorization
        ? { authorization: body.authorization }
        : {}),
      ...(body.policy_revision
        ? { policyRevision: body.policy_revision }
        : {}),
      ...(body.authorization_revision !== undefined
        ? { authorizationRevision: body.authorization_revision }
        : {}),
      ...(run
        ? {
            plannedL0: run.plannedL0,
            plannedL1: run.plannedL1,
            deletedL0: run.deletedL0,
            deletedL1: run.deletedL1,
            remainingL0: run.remainingL0,
            remainingL1: run.remainingL1,
            deletedArtifacts: run.deletedArtifacts,
            anomalyCount: run.anomalyCount,
            errorCode: run.errorCode ?? null,
            ...(run.cutoffL0 === null || typeof run.cutoffL0 === "string"
              ? { cutoffL0: run.cutoffL0 }
              : {}),
            ...(run.cutoffL1 === null || typeof run.cutoffL1 === "string"
              ? { cutoffL1: run.cutoffL1 }
              : {}),
            ...(typeof run.startedAt === "string"
              ? { lastStartedAt: run.startedAt }
              : {}),
            ...(run.completedAt === null ||
            typeof run.completedAt === "string"
              ? { lastCompletedAt: run.completedAt }
              : {}),
          }
        : {}),
    };
  }

  async recall(request, options = {}) {
    try {
      const parsedRequest = hookRecallRequestSchema.parse(request);
      const response = await this.fetch(`${this.baseUrl}/api/v1/hooks/recall`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(parsedRequest),
        redirect: "manual",
        signal: globalThis.AbortSignal.any([
          globalThis.AbortSignal.timeout(parsedRequest.budget.timeout_ms),
          ...(options.signal ? [options.signal] : []),
        ]),
      });
      if (!response.ok) return degradedRecall("gateway_unavailable");
      const body = await readJsonLimited(response, MAX_RECALL_RESPONSE_BYTES);
      const parsedResponse = hookRecallResponseSchema.safeParse(body);
      return parsedResponse.success
        ? boundRecallResponse(parsedResponse.data, parsedRequest.budget)
        : degradedRecall("gateway_unavailable");
    } catch (error) {
      return degradedRecall(
        error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "timeout"
          : "gateway_unavailable",
      );
    }
  }

  async capture(request) {
    const parsedRequest = hookCaptureRequestSchema.parse(request);
    try {
      const response = await this.fetch(
        `${this.baseUrl}/api/v1/hooks/capture`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(parsedRequest),
          redirect: "manual",
          signal: globalThis.AbortSignal.timeout(1000),
        },
      );
      if (new Set([502, 503, 504]).has(response.status))
        return queuedCapture("gateway_unavailable");
      if (!response.ok)
        throw new Error(
          `Hook Gateway rejected capture with ${response.status}`,
        );
      const body = await readJsonLimited(response, MAX_CAPTURE_RESPONSE_BYTES);
      const parsedResponse = hookCaptureResponseSchema.safeParse(body);
      if (!parsedResponse.success)
        throw new Error("Hook Gateway returned an invalid capture response");
      return parsedResponse.data;
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError")
        return queuedCapture("timeout");
      if (error instanceof TypeError)
        return queuedCapture("gateway_unavailable");
      throw error;
    }
  }
}

export function encodeRecallOutput(client, response) {
  if (!new Set(["codex", "claude-code"]).has(client))
    throw new Error("Unsupported Hook client");
  if (response.outcome !== "recalled") return {};
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: response.additional_context,
    },
  };
}

export class PrivateHookOutbox {
  constructor(directory, options = {}) {
    const requestedDirectory = path.resolve(directory);
    assertNoUserSymlinkPath(requestedDirectory);
    this.directory = canonicalizeFuturePath(requestedDirectory);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? (() => randomBytes(16).toString("hex"));
    this.maxEntries = MAX_OUTBOX_ENTRIES;
  }

  async enqueue(request, reason) {
    const parsedRequest = hookCaptureRequestSchema.parse(request);
    if (!new Set(["gateway_unavailable", "timeout"]).has(reason))
      throw new Error("Only retryable capture failures may enter the outbox");
    await this.#prepare();
    await this.#pruneAndRecover();
    const records = await this.#records();
    const duplicate = records.find(
      ({ entry }) =>
        entry.request.idempotency_key === parsedRequest.idempotency_key,
    );
    if (duplicate) {
      if (
        JSON.stringify(duplicate.entry.request) !==
        JSON.stringify(parsedRequest)
      )
        throw new Error("Outbox idempotency payload conflicts");
      return { outcome: "queued", backlog: records.length };
    }
    const entry = {
      version: 1,
      request: parsedRequest,
      createdAt: this.now(),
      expiresAt: this.now() + OUTBOX_TTL_MS,
      attempts: 0,
      nextAttemptAt: this.now(),
      state: "queued",
      lastError: reason,
    };
    const content = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(content) > MAX_OUTBOX_ENTRY_BYTES)
      throw new Error("Hook outbox entry is too large");
    const preferredSlot =
      Number.parseInt(parsedRequest.idempotency_key.slice(-2), 16) %
      this.maxEntries;
    for (let offset = 0; offset < this.maxEntries; offset += 1) {
      const slot = (preferredSlot + offset) % this.maxEntries;
      const temporary = path.join(
        this.directory,
        `outbox-${String(slot).padStart(2, "0")}.${this.#token()}.tmp`,
      );
      try {
        await writeFile(temporary, content, {
          mode: 0o600,
          flag: "wx",
        });
        await link(temporary, this.#baseFile(slot));
        return { outcome: "queued", backlog: (await this.#records()).length };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const concurrent = (await this.#records()).find(
          ({ entry: candidate }) =>
            candidate.request.idempotency_key === parsedRequest.idempotency_key,
        );
        if (!concurrent) continue;
        if (
          JSON.stringify(concurrent.entry.request) !==
          JSON.stringify(parsedRequest)
        )
          throw new Error("Outbox idempotency payload conflicts", {
            cause: error,
          });
        return {
          outcome: "queued",
          backlog: (await this.#records()).length,
        };
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    }
    throw new Error("Hook outbox capacity is full");
  }

  async status() {
    await this.#prepare();
    await this.#pruneAndRecover();
    const records = await this.#records();
    const failed = records.filter(
      ({ entry }) => entry.state === "failed",
    ).length;
    return {
      queued: records.length - failed,
      failed,
      total: records.length,
    };
  }

  async flush(gateway, options = {}) {
    await this.#prepare();
    await this.#pruneAndRecover();
    const result = { attempted: 0, delivered: 0, deferred: 0, failed: 0 };
    for (const { slot, entry } of await this.#records()) {
      if (result.attempted >= (options.maxEntries ?? 64)) break;
      if (entry.state === "failed" || entry.nextAttemptAt > this.now())
        continue;
      const claim = this.#claimFile(slot);
      const claimToken = this.#token();
      try {
        await writeFile(
          claim,
          `${JSON.stringify({
            expiresAt: this.now() + OUTBOX_CLAIM_MS,
            token: claimToken,
            pid: process.pid,
          })}\n`,
          { mode: 0o600, flag: "wx" },
        );
      } catch (error) {
        if (error?.code === "EEXIST") continue;
        throw error;
      }
      result.attempted += 1;
      let response;
      try {
        response = await gateway.capture(entry.request);
      } catch {
        await this.#fail(slot, claim, claimToken, entry, "protocol_error");
        result.failed += 1;
        continue;
      }
      if (response.retryable) {
        if (await this.#defer(slot, claim, claimToken, entry, response.reason))
          result.failed += 1;
        else result.deferred += 1;
      } else {
        if (!(await this.#ownsClaim(claim, claimToken))) continue;
        await unlink(this.#baseFile(slot));
        await unlink(claim).catch(() => undefined);
        result.delivered += 1;
      }
    }
    return result;
  }

  async #defer(slot, claim, claimToken, entry, reason) {
    const attempts = entry.attempts + 1;
    if (attempts >= MAX_OUTBOX_ATTEMPTS) {
      return await this.#rewrite(slot, claim, claimToken, {
        ...entry,
        attempts,
        state: "failed",
        lastError: reason,
      });
    }
    const rewritten = await this.#rewrite(slot, claim, claimToken, {
      ...entry,
      attempts,
      nextAttemptAt: this.now() + RETRY_DELAYS_MS[attempts - 1],
      lastError: reason,
    });
    return rewritten ? false : undefined;
  }

  async #fail(slot, claim, claimToken, entry, reason) {
    await this.#rewrite(slot, claim, claimToken, {
      ...entry,
      attempts: entry.attempts + 1,
      state: "failed",
      lastError: reason,
    });
  }

  async #rewrite(slot, claim, claimToken, entry) {
    if (!(await this.#ownsClaim(claim, claimToken))) return false;
    const temporary = path.join(
      this.directory,
      `outbox-${String(slot).padStart(2, "0")}.${this.#token()}.tmp`,
    );
    try {
      await writeFile(temporary, `${JSON.stringify(entry)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.#baseFile(slot));
      await unlink(claim).catch(() => undefined);
      return true;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #pruneAndRecover() {
    for (const { file, entry } of await this.#records()) {
      if (entry.expiresAt <= this.now()) {
        await unlink(file).catch(() => undefined);
      }
    }
    for (const item of await readdir(this.directory, { withFileTypes: true })) {
      const target = path.join(this.directory, item.name);
      if (/^outbox-\d{2}\.[a-z0-9-]+\.tmp$/u.test(item.name)) {
        const info = await lstat(target);
        if (info.mtimeMs + OUTBOX_CLAIM_MS <= this.now())
          await unlink(target).catch(() => undefined);
        continue;
      }
      const match = /^outbox-(\d{2})\.claim$/u.exec(item.name);
      if (!match) continue;
      const info = await lstat(target);
      if (!item.isFile() || !info.isFile() || (info.mode & 0o077) !== 0)
        throw new Error("Hook outbox claim is not a private regular file");
      let expired = info.mtimeMs + OUTBOX_CLAIM_MS <= this.now();
      try {
        const claim = JSON.parse(await readFile(target, "utf8"));
        expired =
          !Number.isFinite(claim.expiresAt) ||
          !Number.isInteger(claim.pid) ||
          (claim.expiresAt <= this.now() && !isProcessAlive(claim.pid));
      } catch {
        // A partially written claim is recoverable after the initialization window.
      }
      const slot = Number(match[1]);
      const baseExists = await lstat(this.#baseFile(slot))
        .then(() => true)
        .catch((error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        });
      if (expired || !baseExists) await unlink(target).catch(() => undefined);
    }
  }

  async #records() {
    const records = [];
    for (const item of await readdir(this.directory, { withFileTypes: true })) {
      const slot = outboxSlot(item.name);
      if (slot === undefined || slot >= this.maxEntries) continue;
      const file = path.join(this.directory, item.name);
      const info = await lstat(file);
      if (!item.isFile() || !info.isFile() || (info.mode & 0o077) !== 0)
        throw new Error("Hook outbox entry is not a private regular file");
      if (info.size > MAX_OUTBOX_ENTRY_BYTES)
        throw new Error("Hook outbox entry is too large");
      const entry = JSON.parse(await readFile(file, "utf8"));
      const parsedRequest = hookCaptureRequestSchema.safeParse(entry?.request);
      if (
        entry?.version !== 1 ||
        !parsedRequest.success ||
        !Number.isFinite(entry.createdAt) ||
        !Number.isFinite(entry.expiresAt) ||
        !Number.isInteger(entry.attempts) ||
        !Number.isFinite(entry.nextAttemptAt) ||
        !new Set(["queued", "failed"]).has(entry.state)
      )
        throw new Error("Hook outbox entry is invalid");
      entry.request = parsedRequest.data;
      records.push({ slot, file, entry });
    }
    return records.sort(
      (left, right) =>
        left.entry.createdAt - right.entry.createdAt || left.slot - right.slot,
    );
  }

  async #prepare() {
    assertNoUserSymlinkPath(this.directory);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0)
      throw new Error("Hook outbox directory is not private");
  }

  #baseFile(slot) {
    return path.join(
      this.directory,
      `outbox-${String(slot).padStart(2, "0")}.json`,
    );
  }

  #claimFile(slot) {
    return path.join(
      this.directory,
      `outbox-${String(slot).padStart(2, "0")}.claim`,
    );
  }

  async #ownsClaim(claimFile, token) {
    try {
      const claim = JSON.parse(await readFile(claimFile, "utf8"));
      return claim.token === token && claim.pid === process.pid;
    } catch {
      return false;
    }
  }

  #token() {
    const token = this.random();
    if (typeof token !== "string" || !/^[a-z0-9-]{1,64}$/u.test(token))
      throw new Error("Hook outbox random token is invalid");
    return token;
  }
}

export class HookLifecycleRuntime {
  constructor(options) {
    this.gateway = options.gateway;
    this.turns = options.turns;
    this.outbox = options.outbox;
    this.authorization = options.authorization;
    this.secret = options.secret;
    this.telemetry = options.telemetry ?? (() => undefined);
    this.promptTimeoutMs = Math.min(options.promptTimeoutMs ?? 1000, 1000);
    if (!Number.isInteger(this.promptTimeoutMs) || this.promptTimeoutMs < 50)
      throw new Error(
        "Hook prompt timeout must be an integer from 50 to 1000 ms",
      );
    this.recallBudget = hookRecallBudgetSchema.parse({
      max_items: Math.min(options.recallBudget?.max_items ?? 5, 5),
      max_chars: Math.min(options.recallBudget?.max_chars ?? 4000, 4000),
      max_tokens: Math.min(options.recallBudget?.max_tokens ?? 1000, 1000),
      timeout_ms: Math.min(options.recallBudget?.timeout_ms ?? 1000, 1000),
    });
  }

  async handle(event) {
    try {
      if (!event || event.kind === "skip") return {};
      if (event.kind === "prompt") {
        const deadline = Date.now() + this.promptTimeoutMs;
        return await this.#withinPromptDeadline(
          (signal) => this.#prompt(event, deadline, signal),
          deadline,
        );
      }
      if (event.kind === "stop") return await this.#stop(event);
      return {};
    } catch {
      this.#record("runtime", event?.client, "failed_open");
      return {};
    }
  }

  async maintain(client, options = {}) {
    await this.#flushOutbox(client, options);
  }

  async #prompt(event, deadline, signal) {
    const startedAt = Date.now();
    let remembered;
    try {
      remembered = await this.turns.remember(event, this.secret, { signal });
    } catch {
      this.#record(
        "recall",
        event.client,
        signal.aborted ? "timeout" : "turn_store_unavailable",
        {
          durationMs: Date.now() - startedAt,
        },
      );
      return {};
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs < 50) {
      this.#record("recall", event.client, "timeout", {
        durationMs: Date.now() - startedAt,
      });
      return {};
    }
    const response = await this.gateway.recall(
      {
        ...buildRecallRequest(remembered, this.authorization),
        budget: {
          ...this.recallBudget,
          timeout_ms: Math.min(this.recallBudget.timeout_ms, remainingMs),
        },
      },
      { signal },
    );
    this.#record("recall", event.client, response.outcome, {
      itemCount: response.item_count,
      usedChars: response.used_chars,
      estimatedTokens: response.estimated_tokens,
      durationMs: Date.now() - startedAt,
      ...(response.reason ? { reason: response.reason } : {}),
    });
    return encodeRecallOutput(event.client, response);
  }

  async #stop(event) {
    const startedAt = Date.now();
    let claim;
    try {
      claim = await this.turns.claim(event);
    } catch {
      this.#record("capture", event.client, "turn_store_unavailable", {
        durationMs: Date.now() - startedAt,
      });
      return {};
    }
    if (!claim) {
      this.#record("capture", event.client, "skipped", {
        reason: "missing_prompt",
        durationMs: Date.now() - startedAt,
      });
      return {};
    }
    const request = buildCaptureRequest(
      claim.record,
      event,
      this.authorization,
      this.secret,
    );
    let response;
    try {
      response = await this.gateway.capture(request);
    } catch {
      await this.turns.acknowledge(claim).catch(() => undefined);
      this.#record("capture", event.client, "protocol_error", {
        durationMs: Date.now() - startedAt,
      });
      return {};
    }
    if (response.retryable) {
      try {
        const queued = await this.outbox.enqueue(request, response.reason);
        await this.turns.acknowledge(claim);
        this.#record("capture", event.client, "queued", {
          reason: response.reason,
          backlog: queued.backlog,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        await this.turns.release(claim).catch(() => undefined);
        this.#record("capture", event.client, "outbox_unavailable", {
          reason: response.reason,
          durationMs: Date.now() - startedAt,
        });
      }
      return {};
    }
    await this.turns.acknowledge(claim);
    this.#record("capture", event.client, response.outcome, {
      ...(response.reason ? { reason: response.reason } : {}),
      durationMs: Date.now() - startedAt,
    });
    return {};
  }

  async #flushOutbox(client, options) {
    const startedAt = Date.now();
    try {
      const result = await this.outbox.flush(this.gateway, options);
      if (result.attempted > 0)
        this.#record("outbox", client, "flushed", {
          ...result,
          durationMs: Date.now() - startedAt,
        });
    } catch (error) {
      this.#record("outbox", client, "maintenance_error", {
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  async #withinPromptDeadline(operation, deadline) {
    const controller = new globalThis.AbortController();
    let timer;
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise((resolve) => {
          timer = globalThis.setTimeout(
            () => {
              controller.abort();
              resolve({});
            },
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  #record(operation, client, outcome, details = {}) {
    try {
      this.telemetry({ operation, client, outcome, ...details });
    } catch {
      // Telemetry must never change Hook behavior.
    }
  }
}

export async function runHookInvocation(client, input, runtime) {
  try {
    return await runtime.handle(parseHookEvent(client, input));
  } catch {
    return {};
  }
}
