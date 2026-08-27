import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DataLifecycleMutex } from "../src/data-lifecycle-mutex.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("DataLifecycleMutex", () => {
  it("serializes operations and permits token-based reentry", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pm-lifecycle-lock-"));
    roots.push(root);
    const state = path.join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    const mutex = new DataLifecycleMutex(state);

    const backup = mutex.acquire({ operation: "backup" });
    expect(backup).toBeDefined();
    expect(mutex.acquire({ operation: "retention" })).toBeUndefined();
    const nested = mutex.acquire({
      operation: "retention",
      token: backup!.token,
    });
    expect(nested).toBeDefined();
    expect(readFileSync(mutex.lockPath, "utf8")).not.toContain(backup!.token);

    nested!.release();
    expect(mutex.acquire({ operation: "retention" })).toBeUndefined();
    backup!.release();
    expect(mutex.acquire({ operation: "retention" })).toBeDefined();
  });
});
