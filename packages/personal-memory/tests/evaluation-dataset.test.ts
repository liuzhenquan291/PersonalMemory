import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Message = {
  id: string;
  role: "user" | "assistant";
  occurredAt: string;
  validUntil?: string;
  content: string;
};

type Sample = {
  id: string;
  category: string;
  locale: string;
  smoke: boolean;
  evaluationTime: string;
  messages: Message[];
  query: string;
  expected: {
    outcome: "answer" | "no_answer";
    answer: string | null;
    sourceMessageIds: string[];
  };
};

type Dataset = {
  schemaVersion: string;
  evaluationVersion: string;
  license: string;
  provenance: string;
  generatedAt: string;
  categories: Record<string, number>;
  samples: Sample[];
};

const datasetPath = fileURLToPath(
  new URL("./fixtures/evaluation-v1.json", import.meta.url),
);
const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as Dataset;
const requiredCategories = [
  "preference",
  "fact",
  "decision",
  "conflict",
  "expired",
  "no_answer",
];

describe("M2.1 golden evaluation dataset", () => {
  it("contains exactly 100 versioned, synthetic samples across every required category", () => {
    expect(dataset.schemaVersion).toBe("1.0.0");
    expect(dataset.evaluationVersion).toBe("m2.1-v1");
    expect(dataset.license).toBe("CC0-1.0");
    expect(dataset.provenance).toContain("Fully synthetic");
    expect(dataset.samples).toHaveLength(100);
    expect(new Set(dataset.samples.map(({ id }) => id)).size).toBe(100);

    const actualCounts = Object.fromEntries(
      requiredCategories.map((category) => [
        category,
        dataset.samples.filter((sample) => sample.category === category).length,
      ]),
    );
    expect(actualCounts).toEqual(dataset.categories);
    expect(Object.keys(dataset.categories).sort()).toEqual(
      [...requiredCategories].sort(),
    );
  });

  it("provides a deterministic smoke subset with both locales and all categories", () => {
    const smoke = dataset.samples.filter(({ smoke }) => smoke);
    expect(smoke).toHaveLength(12);
    expect(new Set(smoke.map(({ category }) => category))).toEqual(
      new Set(requiredCategories),
    );
    expect(new Set(smoke.map(({ locale }) => locale))).toEqual(
      new Set(["zh-CN", "en"]),
    );
    expect(smoke.map(({ id }) => id)).toEqual([
      "golden-001",
      "golden-002",
      "golden-019",
      "golden-020",
      "golden-037",
      "golden-038",
      "golden-053",
      "golden-054",
      "golden-069",
      "golden-070",
      "golden-085",
      "golden-086",
    ]);
  });

  it("keeps expected answers separate, traceable, and absent from queries and IDs", () => {
    for (const sample of dataset.samples) {
      expect(sample.messages.length).toBeGreaterThanOrEqual(2);
      expect(new Set(sample.messages.map(({ role }) => role))).toEqual(
        new Set(["user", "assistant"]),
      );
      expect(sample.query.trim()).not.toBe("");
      expect(Number.isNaN(Date.parse(sample.evaluationTime))).toBe(false);

      const messageIds = new Set(sample.messages.map(({ id }) => id));
      expect(messageIds.size).toBe(sample.messages.length);
      for (const sourceId of sample.expected.sourceMessageIds) {
        expect(messageIds.has(sourceId)).toBe(true);
      }

      if (sample.expected.outcome === "answer") {
        expect(sample.expected.answer).toBeTypeOf("string");
        expect(sample.expected.answer).not.toBe("");
        expect(sample.query).not.toContain(sample.expected.answer as string);
        expect(sample.id).not.toContain(sample.expected.answer as string);
        const sourceText = sample.messages
          .filter(({ id }) => sample.expected.sourceMessageIds.includes(id))
          .map(({ content }) => content)
          .join("\n");
        expect(sourceText).toContain(sample.expected.answer as string);
      } else {
        expect(sample.expected.answer).toBeNull();
        expect(sample.expected.sourceMessageIds).toEqual([]);
      }
    }
  });

  it("makes conflict, expiry, and no-answer failure paths explicit", () => {
    for (const sample of dataset.samples.filter(
      ({ category }) => category === "conflict",
    )) {
      expect(
        sample.messages.filter(({ role }) => role === "user"),
      ).toHaveLength(2);
      expect(sample.expected.sourceMessageIds).toHaveLength(2);
    }

    for (const sample of dataset.samples.filter(
      ({ category }) => category === "expired",
    )) {
      const expiringMessage = sample.messages.find(({ validUntil }) =>
        Boolean(validUntil),
      );
      expect(sample.expected.outcome).toBe("no_answer");
      expect(expiringMessage?.validUntil).toBeDefined();
      expect(
        Date.parse(expiringMessage!.validUntil!) <
          Date.parse(sample.evaluationTime),
      ).toBe(true);
    }

    for (const sample of dataset.samples.filter(
      ({ category }) => category === "no_answer",
    )) {
      expect(sample.expected.outcome).toBe("no_answer");
    }
  });
});
