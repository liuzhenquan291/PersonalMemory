import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { recordConversation } from "./l0-recorder.js";

describe("recordConversation", () => {
  let dataDirectory: string | undefined;

  afterEach(async () => {
    if (dataDirectory)
      await rm(dataDirectory, { recursive: true, force: true });
    dataDirectory = undefined;
  });

  it("keeps an entire timestamp-less turn newer than the initial cursor", async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "l0-recorder-test-"));
    const cursor = Date.now();

    const messages = await recordConversation({
      sessionKey: "same-millisecond-session",
      rawMessages: [
        { role: "user", content: "remember same-millisecond marker" },
        { role: "assistant", content: "acknowledged same-millisecond marker" },
      ],
      baseDir: dataDirectory,
      afterTimestamp: cursor,
    });

    expect(messages).toHaveLength(2);
    expect(messages.every((message) => message.timestamp > cursor)).toBe(true);
    expect(new Set(messages.map((message) => message.timestamp)).size).toBe(1);
  });
});
