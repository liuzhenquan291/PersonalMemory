import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseConfig } from "../config.js";
import type { IMemoryStore } from "../core/store/types.js";
import { CheckpointManager } from "./checkpoint.js";
import { createL1Runner } from "./pipeline-factory.js";

describe("L1 pipeline failure checkpointing", () => {
  it("does not advance the L0 cursor when the model call fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pm-l1-failure-"));
    try {
      const sessionKey = "hook:codex:install:test-session";
      const vectorStore = {
        isDegraded: () => false,
        queryL0GroupedBySessionId: () => [
          {
            sessionId: "test-session",
            messages: [
              {
                id: "l0-user",
                role: "user",
                content: "Please remember that I prefer concise answers.",
                timestamp: 100,
                recordedAtMs: 100,
              },
              {
                id: "l0-assistant",
                role: "assistant",
                content: "I will keep future answers concise.",
                timestamp: 200,
                recordedAtMs: 200,
              },
            ],
          },
        ],
      } as unknown as IMemoryStore;
      const logger = {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      };
      const runL1 = createL1Runner({
        pluginDataDir: root,
        cfg: parseConfig({}),
        openclawConfig: undefined,
        vectorStore,
        embeddingService: undefined,
        logger,
        llmRunner: {
          run: async () => {
            throw new Error("model unavailable");
          },
        },
      });

      await expect(runL1({ sessionKey })).rejects.toThrow(
        "L1 extraction failed",
      );
      const checkpoint = new CheckpointManager(root, logger);
      expect(
        checkpoint.getRunnerState(await checkpoint.read(), sessionKey)
          .last_l1_cursor,
      ).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
