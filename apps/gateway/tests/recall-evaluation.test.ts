import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface GoldenSample {
  category: string;
  evaluationTime: string;
  messages: Array<{ content: string; validUntil?: string }>;
  query: string;
  expected: { outcome: "answer" | "no_answer"; answer: string | null };
}

const fixturePath = fileURLToPath(
  new URL(
    "../../../packages/personal-memory/tests/fixtures/evaluation-v1.json",
    import.meta.url,
  ),
);
const samples = (
  JSON.parse(readFileSync(fixturePath, "utf8")) as {
    samples: GoldenSample[];
  }
).samples;

function bigrams(input: string): Set<string> {
  const normalized = input.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

function lexicalScore(query: string, content: string): number {
  const queryTerms = bigrams(query);
  const contentTerms = bigrams(content);
  let matches = 0;
  for (const term of queryTerms) if (contentTerms.has(term)) matches += 1;
  return queryTerms.size === 0 ? 0 : matches / queryTerms.size;
}

function recall(sample: GoldenSample) {
  return sample.messages
    .filter(
      ({ validUntil }) =>
        !validUntil ||
        Date.parse(validUntil) >= Date.parse(sample.evaluationTime),
    )
    .map((message, index) => ({
      message,
      index,
      score: lexicalScore(sample.query, message.content),
    }))
    .filter(({ score }) => score >= 0.5)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, 5);
}

describe("M2.3 versioned recall evaluation", () => {
  it("records the deterministic lexical smoke baseline over all 100 samples", () => {
    let answerSamples = 0;
    let recalledAnswers = 0;
    let noAnswerSamples = 0;
    let refusedNoAnswer = 0;
    let expiredSamples = 0;
    let expiredHits = 0;
    let unsupportedAnswers = 0;
    const latencies: number[] = [];

    for (const sample of samples) {
      const startedAt = performance.now();
      const results = recall(sample);
      latencies.push(performance.now() - startedAt);
      if (sample.expected.outcome === "answer") {
        answerSamples += 1;
        if (
          results.some(({ message }) =>
            message.content.includes(sample.expected.answer!),
          )
        ) {
          recalledAnswers += 1;
        }
      } else {
        noAnswerSamples += 1;
        if (results.length === 0) refusedNoAnswer += 1;
        else unsupportedAnswers += 1;
      }
      if (sample.category === "expired") {
        expiredSamples += 1;
        if (results.length > 0) expiredHits += 1;
      }
    }
    latencies.sort((left, right) => left - right);
    const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!;

    expect(samples).toHaveLength(100);
    expect(recalledAnswers / answerSamples).toBe(1);
    expect(unsupportedAnswers / noAnswerSamples).toBe(0);
    expect(expiredHits / expiredSamples).toBe(0);
    expect(refusedNoAnswer / noAnswerSamples).toBe(1);
    expect(p95).toBeLessThan(10);
  });
});
