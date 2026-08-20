import { createHmac, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { lstatSync, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const VERSION = "1.0.0";
const MAX_TURNS = 128;
const TTL_MS = 60 * 60 * 1000;
const CLAIM_TTL_MS = 30_000;
const LOCK_INITIALIZATION_MS = 5_000;
const MAX_CLAIM_TOKEN_LENGTH = 64;

function requiredString(value, name, max = 32_768) {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error(`Invalid ${name}`);
  return value;
}

export function parseHookEvent(client, input) {
  if (
    !new Set(["codex", "claude-code"]).has(client) ||
    !input ||
    typeof input !== "object" ||
    input.agent_id
  )
    return { kind: "skip", reason: "invalid_event" };
  try {
    const eventName = input.hook_event_name;
    if (
      !new Set(["UserPromptSubmit", "Stop"]).has(eventName) ||
      input.stop_hook_active === true
    )
      return { kind: "skip", reason: "invalid_event" };
    const sessionId = requiredString(input.session_id, "session_id", 256);
    const cwd = requiredString(input.cwd, "cwd", 4096);
    const nativeTurn = client === "codex" ? input.turn_id : input.prompt_id;
    if (client === "codex" && !nativeTurn)
      return { kind: "skip", reason: "invalid_event" };
    const turnId = nativeTurn
      ? requiredString(nativeTurn, "turn_id", 256)
      : undefined;
    if (eventName === "UserPromptSubmit")
      return {
        kind: "prompt",
        client,
        sessionId,
        turnId,
        cwd,
        prompt: requiredString(input.prompt, "prompt"),
      };
    const assistant = input.last_assistant_message;
    if (typeof assistant !== "string" || assistant.length === 0)
      return { kind: "skip", reason: "empty_assistant_message" };
    return {
      kind: "stop",
      client,
      sessionId,
      turnId,
      cwd,
      assistant: requiredString(assistant, "last_assistant_message"),
    };
  } catch {
    return { kind: "skip", reason: "invalid_event" };
  }
}

function hmac(secret, values) {
  return createHmac("sha256", secret)
    .update(JSON.stringify(values))
    .digest("hex");
}

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
    if (parent === existing) throw new Error("No turn store ancestor exists");
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
        throw new Error("Turn store path contains a symlink");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function isProcessOwnerAlive(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return false;
  }
  return true;
}

export function createHookIdempotencyKey(secret, identity) {
  return `hook:v1:${hmac(secret, [VERSION, identity.client, identity.installationId, identity.sessionId, identity.turnId])}`;
}

export class PrivateTurnStore {
  constructor(directory, options = {}) {
    const requestedDirectory = path.resolve(directory);
    assertNoUserSymlinkPath(requestedDirectory);
    this.directory = canonicalizeFuturePath(requestedDirectory);
    this.file = path.join(this.directory, "turns.json");
    this.now = options.now ?? Date.now;
    this.random = options.random ?? (() => randomBytes(16).toString("hex"));
  }

  async remember(event, secret, options = {}) {
    return this.#locked(async () => {
      options.signal?.throwIfAborted();
      const records = await this.#read(options.signal);
      const fresh = this.#fresh(records);
      const existing = fresh.find((item) =>
        event.turnId
          ? item.client === event.client &&
            item.sessionId === event.sessionId &&
            item.turnId === event.turnId
          : item.client === event.client &&
            item.sessionId === event.sessionId &&
            item.turnId.startsWith("legacy:"),
      );
      if (existing) {
        await this.#write(fresh, options.signal);
        if (existing.prompt !== event.prompt || existing.cwd !== event.cwd)
          throw new Error("Turn payload conflicts with the staged prompt");
        return existing;
      }
      const turnId =
        event.turnId ??
        `legacy:${hmac(secret, [event.client, event.sessionId, this.random()])}`;
      const current = fresh.filter(
        (item) =>
          item.client !== event.client ||
          item.sessionId !== event.sessionId ||
          item.turnId !== turnId,
      );
      current.push({ ...event, turnId, expiresAt: this.now() + TTL_MS });
      await this.#write(
        this.#bounded(current, {
          client: event.client,
          sessionId: event.sessionId,
          turnId,
        }),
        options.signal,
      );
      return { ...event, turnId };
    }, options.signal);
  }

  async claim(event) {
    return this.#locked(async () => {
      const records = this.#fresh(await this.#read());
      const matches = records.filter(
        (item) =>
          item.client === event.client &&
          item.sessionId === event.sessionId &&
          (!event.turnId || item.turnId === event.turnId),
      );
      const selected =
        matches.length === 1 &&
        (!matches[0].claimToken || matches[0].claimExpiresAt <= this.now())
          ? matches[0]
          : undefined;
      const claimToken = selected
        ? requiredString(this.random(), "claim token", MAX_CLAIM_TOKEN_LENGTH)
        : undefined;
      await this.#write(
        records.map((item) =>
          item === selected
            ? {
                ...item,
                claimToken,
                claimExpiresAt: this.now() + CLAIM_TTL_MS,
              }
            : item,
        ),
      );
      return selected ? { record: selected, claimToken } : undefined;
    });
  }

  async acknowledge(claim) {
    return this.#locked(async () => {
      const records = this.#fresh(await this.#read());
      await this.#write(
        records.filter(
          (item) =>
            item.client !== claim.record.client ||
            item.sessionId !== claim.record.sessionId ||
            item.turnId !== claim.record.turnId ||
            item.claimToken !== claim.claimToken,
        ),
      );
    });
  }

  async release(claim) {
    return this.#locked(async () => {
      const records = this.#fresh(await this.#read());
      await this.#write(
        records.map((item) =>
          item.client === claim.record.client &&
          item.sessionId === claim.record.sessionId &&
          item.turnId === claim.record.turnId &&
          item.claimToken === claim.claimToken
            ? { ...item, claimToken: undefined, claimExpiresAt: undefined }
            : item,
        ),
      );
    });
  }

  async maintain(options = {}) {
    return this.#locked(async () => {
      options.signal?.throwIfAborted();
      const records = this.#fresh(await this.#read(options.signal));
      await this.#write(records, options.signal);
      return { retained: records.length };
    }, options.signal);
  }

  #fresh(records) {
    const now = this.now();
    return records
      .filter((item) => item.expiresAt > now)
      .map((item) =>
        item.claimToken && item.claimExpiresAt <= now
          ? { ...item, claimToken: undefined, claimExpiresAt: undefined }
          : item,
      );
  }

  #bounded(records, requiredTurn) {
    const now = this.now();
    const claimed = records.filter(
      (item) => item.claimToken && item.claimExpiresAt > now,
    );
    const available = records.filter(
      (item) => !item.claimToken || item.claimExpiresAt <= now,
    );
    const availableCapacity = MAX_TURNS - claimed.length;
    if (availableCapacity <= 0)
      throw new Error("Turn store capacity is held by active claims");
    let selected = [
      ...claimed,
      ...available.slice(-availableCapacity).map((item) => ({
        ...item,
        claimToken: undefined,
        claimExpiresAt: undefined,
      })),
    ];
    while (this.#reservedStorageBytes(selected) > 4 * 1024 * 1024) {
      const index = selected.findIndex(
        (item) => !item.claimToken && !this.#sameTurn(item, requiredTurn),
      );
      if (index < 0)
        throw new Error("Turn store capacity is held by active claims");
      selected.splice(index, 1);
    }
    if (!selected.some((item) => this.#sameTurn(item, requiredTurn)))
      throw new Error("Turn store has no capacity for the new turn");
    return selected;
  }

  #reservedStorageBytes(records) {
    const claimToken = "x".repeat(MAX_CLAIM_TOKEN_LENGTH);
    return Buffer.byteLength(
      `${JSON.stringify(
        records.map((item) => ({
          ...item,
          claimToken,
          claimExpiresAt: Number.MAX_SAFE_INTEGER,
        })),
      )}\n`,
    );
  }

  #sameTurn(item, identity) {
    return (
      item.client === identity.client &&
      item.sessionId === identity.sessionId &&
      item.turnId === identity.turnId
    );
  }

  async #read(signal) {
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0)
        throw new Error("Turn store is not private");
      if (stat.size > 4 * 1024 * 1024)
        throw new Error("Turn store is too large");
      const content = await readFile(this.file, { encoding: "utf8", signal });
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) throw new Error("Turn store is invalid");
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async #write(records, signal) {
    signal?.throwIfAborted();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(this.directory);
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0)
      throw new Error("Turn store directory is not private");
    const temporary = `${this.file}.${this.random()}.tmp`;
    const content = `${JSON.stringify(records)}\n`;
    if (Buffer.byteLength(content) > 4 * 1024 * 1024)
      throw new Error("Turn store is too large");
    try {
      await writeFile(temporary, content, {
        mode: 0o600,
        flag: "wx",
        signal,
      });
      signal?.throwIfAborted();
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #locked(run, signal) {
    signal?.throwIfAborted();
    await this.#assertNoSymlinkAncestors();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = path.join(this.directory, "turns.lock");
    const owner = JSON.stringify({
      pid: process.pid,
      token: this.random(),
    });
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      try {
        await writeFile(lock, owner, { mode: 0o600, flag: "wx" });
        break;
      } catch (error) {
        if (error?.code !== "EEXIST" || attempt >= 100) throw error;
        const observed = await readFile(lock, "utf8").catch(() => undefined);
        if (observed !== undefined)
          await this.#recoverAbandonedLock(lock, observed);
        await delay(10, undefined, { signal });
      }
    }
    try {
      return await run();
    } finally {
      const current = await readFile(lock, "utf8").catch(() => undefined);
      if (current === owner) await unlink(lock).catch(() => undefined);
    }
  }

  async #recoverAbandonedLock(lock, observed) {
    let recorded;
    try {
      recorded = JSON.parse(observed);
    } catch {
      const info = await lstat(lock).catch(() => undefined);
      if (!info || info.mtimeMs + LOCK_INITIALIZATION_MS > Date.now()) return;
      recorded = { pid: 0 };
    }
    if (isProcessOwnerAlive(recorded)) return;
    const recovery = `${lock}.recovery`;
    const recoveryOwner = JSON.stringify({
      pid: process.pid,
      token: this.random(),
    });
    try {
      await writeFile(recovery, recoveryOwner, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const currentRecovery = await readFile(recovery, "utf8").catch(
        () => undefined,
      );
      if (
        currentRecovery !== undefined &&
        (await this.#ownerIsAbandoned(recovery, currentRecovery)) &&
        (await readFile(recovery, "utf8").catch(() => undefined)) ===
          currentRecovery
      )
        await unlink(recovery).catch(() => undefined);
      return;
    }
    try {
      const current = await readFile(lock, "utf8").catch(() => undefined);
      if (current === observed && !isProcessOwnerAlive(recorded))
        await unlink(lock).catch(() => undefined);
    } finally {
      const current = await readFile(recovery, "utf8").catch(() => undefined);
      if (current === recoveryOwner)
        await unlink(recovery).catch(() => undefined);
    }
  }

  async #ownerIsAbandoned(file, content) {
    try {
      return !isProcessOwnerAlive(JSON.parse(content));
    } catch {
      const info = await lstat(file).catch(() => undefined);
      return Boolean(
        info && info.mtimeMs + LOCK_INITIALIZATION_MS <= Date.now(),
      );
    }
  }

  async #assertNoSymlinkAncestors() {
    let current = this.directory;
    let checkedPrivateRoot = false;
    for (;;) {
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink())
          throw new Error("Turn store path contains a symlink");
        if (!info.isDirectory())
          throw new Error("Turn store ancestor is not a directory");
        if (!checkedPrivateRoot && (info.mode & 0o077) !== 0)
          throw new Error("Turn store ancestor is not a private directory");
        checkedPrivateRoot = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
}

export function buildRecallRequest(event, authorization) {
  return {
    contract_version: VERSION,
    event: {
      client: event.client,
      session_id: event.sessionId,
      turn_id: event.turnId,
      subagent: false,
    },
    authorization,
    source: { kind: "agent_lifecycle", working_directory: event.cwd },
    prompt: event.prompt,
  };
}

export function buildCaptureRequest(prompt, stop, authorization, secret) {
  const identity = {
    client: stop.client,
    installationId: authorization.installation_id,
    sessionId: stop.sessionId,
    turnId: prompt.turnId,
  };
  return {
    contract_version: VERSION,
    event: {
      client: stop.client,
      session_id: stop.sessionId,
      turn_id: prompt.turnId,
      subagent: false,
    },
    authorization,
    source: { kind: "agent_lifecycle", working_directory: prompt.cwd },
    idempotency_key: createHookIdempotencyKey(secret, identity),
    messages: [
      { role: "user", content: prompt.prompt },
      { role: "assistant", content: stop.assistant },
    ],
  };
}
