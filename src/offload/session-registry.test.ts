import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SessionRegistry } from "./session-registry.js";

describe("SessionRegistry internal memory sessions", () => {
  it("rejects raw and framework-prefixed pipeline sessions without creating state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-session-registry-"));
    try {
      const registry = new SessionRegistry(root);

      await expect(
        registry.resolveIfAllowed("memory-task-session-123"),
      ).resolves.toBeNull();
      await expect(
        registry.resolveIfAllowed(
          "agent:main:explicit:memory-task-session-123",
        ),
      ).resolves.toBeNull();
      expect(registry.size).toBe(0);

      await expect(
        registry.resolveIfAllowed("agent:main:ordinary-session"),
      ).resolves.not.toBeNull();
      expect(registry.size).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
