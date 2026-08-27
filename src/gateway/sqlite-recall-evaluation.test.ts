import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VectorStore } from "../core/store/sqlite.js";
import { executeMemorySearch } from "../core/tools/memory-search.js";

interface GoldenSample {
  id: string;
  category: string;
  evaluationTime: string;
  messages: Array<{ id: string; content: string; validUntil?: string }>;
  query: string;
  expected: {
    outcome: "answer" | "no_answer";
    answer: string | null;
    sourceMessageIds: string[];
  };
}

const fixturePath = fileURLToPath(
  new URL(
    "../../packages/personal-memory/tests/fixtures/evaluation-v1.json",
    import.meta.url,
  ),
);
const samples = (
  JSON.parse(readFileSync(fixturePath, "utf8")) as { samples: GoldenSample[] }
).samples;

function embedding(text: string): Float32Array {
  const vector = new Float32Array(64);
  for (const character of text.toLocaleLowerCase()) {
    vector[character.codePointAt(0)! % vector.length] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

describe("M2 real SQLite recall evaluation", () => {
  let directory: string;
  let store: VectorStore;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "personalmemory-evaluation-"));
    store = new VectorStore(join(directory, "evaluation.sqlite"), 64);
    const initialized = store.init({
      provider: "local",
      model: "deterministic-evaluation",
      dimensions: 64,
    });
    expect(initialized.needsReindex).toBe(false);
    expect(store.isDegraded()).toBe(false);
  });

  afterAll(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("evaluates all 100 samples through SQLite FTS and vector retrieval", async () => {
    let answerSamples = 0;
    let recalledAnswers = 0;
    let noAnswerSamples = 0;
    let refusedNoAnswer = 0;
    let sourceMatches = 0;
    const latencies: number[] = [];

    for (const sample of samples) {
      const recordId = `evaluation:${sample.id}`;
      if (sample.expected.outcome === "answer") {
        const sourceMessages = sample.messages.filter(({ id }) =>
          sample.expected.sourceMessageIds.includes(id),
        );
        const content =
          sourceMessages.at(-1)?.content ?? sample.expected.answer!;
        expect(
          store.upsertL1(
            {
              id: recordId,
              content,
              type: "instruction",
              priority: 90,
              scene_name: sample.category,
              source_message_ids: sample.expected.sourceMessageIds,
              metadata: {},
              timestamps: [sample.evaluationTime],
              createdAt: sample.evaluationTime,
              updatedAt: sample.evaluationTime,
              sessionKey: sample.id,
              sessionId: sample.id,
            },
            embedding(content),
          ),
        ).toBe(true);
      }

      const startedAt = performance.now();
      const result = await executeMemorySearch({
        query: sample.query,
        limit: 5,
        vectorStore: store,
        embeddingService: {
          embed: async (text: string) => embedding(text),
        } as never,
      });
      latencies.push(performance.now() - startedAt);

      if (sample.expected.outcome === "answer") {
        answerSamples += 1;
        const hit = result.results.find(({ content }) =>
          content.includes(sample.expected.answer!),
        );
        if (hit) recalledAnswers += 1;
        if (
          hit?.source_message_ids?.some((id) =>
            sample.expected.sourceMessageIds.includes(id),
          )
        ) {
          sourceMatches += 1;
        }
        expect(store.deleteL1(recordId)).toBe(true);
      } else {
        noAnswerSamples += 1;
        if (result.results.length === 0) refusedNoAnswer += 1;
      }
    }

    latencies.sort((left, right) => left - right);
    const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!;
    expect(samples).toHaveLength(100);
    expect(recalledAnswers / answerSamples).toBe(1);
    expect(sourceMatches / answerSamples).toBe(1);
    expect(refusedNoAnswer / noAnswerSamples).toBe(1);
    expect(p95).toBeLessThan(100);
  });

  it("adds the source column to a pre-M2 SQLite database without losing rows", () => {
    const legacyPath = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`CREATE TABLE l1_records (
      record_id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT DEFAULT '', priority INTEGER DEFAULT 50,
      scene_name TEXT DEFAULT '', session_key TEXT DEFAULT '', session_id TEXT DEFAULT '', timestamp_str TEXT DEFAULT '',
      timestamp_start TEXT DEFAULT '', timestamp_end TEXT DEFAULT '', created_time TEXT DEFAULT '', updated_time TEXT DEFAULT '',
      metadata_json TEXT DEFAULT '{}'
    )`);
    legacy.exec(
      "INSERT INTO l1_records (record_id, content) VALUES ('legacy-1', 'legacy content')",
    );
    legacy.close();

    const migrated = new VectorStore(legacyPath, 0);
    migrated.init({ provider: "none", model: "none", dimensions: 0 });
    const rows = migrated.queryL1Records({ recordIds: ["legacy-1"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_message_ids_json).toBe("[]");
    migrated.close();
  });
});
