import { describe, expect, it } from "vitest";

import { extractWords } from "./text-utils.js";

describe("extractWords", () => {
  it("normalizes Latin words and ignores single characters", () => {
    expect([...extractWords("AI Memory a B2")].sort()).toEqual([
      "ai",
      "b2",
      "memory",
    ]);
  });

  it("indexes CJK characters and adjacent bigrams", () => {
    expect(extractWords("个人记忆")).toEqual(
      new Set(["个", "人", "记", "忆", "个人", "人记", "记忆"]),
    );
  });

  it("returns an empty set for text without indexable words", () => {
    expect(extractWords("a ! ?")).toEqual(new Set());
  });
});
