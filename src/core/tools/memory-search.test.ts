import { describe, expect, it, vi } from "vitest";
import { executeMemorySearch } from "./memory-search.js";
import type { EmbeddingService } from "../store/embedding.js";
import type {
  IMemoryStore,
  L1FtsResult,
  L1SearchResult,
} from "../store/types.js";

function result(id: string, score: number): L1SearchResult {
  return {
    record_id: id,
    content: `memory ${id}`,
    type: "fact",
    priority: 1,
    scene_name: "",
    score,
    timestamp_str: "",
    timestamp_start: "2026-01-01T00:00:00Z",
    timestamp_end: "2026-01-01T00:00:00Z",
    session_key: "session",
    session_id: "session",
    metadata_json: "{}",
  };
}

function store(options: {
  fts: boolean;
  ftsResults?: L1FtsResult[];
  vectorResults?: L1SearchResult[];
}): IMemoryStore {
  return {
    isFtsAvailable: () => options.fts,
    getCapabilities: () => ({
      vectorSearch: true,
      ftsSearch: options.fts,
      nativeHybridSearch: false,
      sparseVectors: false,
    }),
    searchL1Fts: vi.fn(async () => options.ftsResults ?? []),
    searchL1Vector: vi.fn(async () => options.vectorResults ?? []),
  } as unknown as IMemoryStore;
}

const embedding = {
  embed: vi.fn(async () => new Float32Array([1, 0])),
} as unknown as EmbeddingService;

describe("executeMemorySearch strategy selection", () => {
  it("uses keyword FTS when embeddings are unavailable", async () => {
    const search = store({ fts: true, ftsResults: [result("fts", 0.8)] });
    const response = await executeMemorySearch({
      query: "local memory",
      limit: 5,
      vectorStore: search,
    });
    expect(response.strategy).toBe("fts");
    expect(response.results.map(({ id }) => id)).toEqual(["fts"]);
  });

  it("uses semantic embedding search when FTS is unavailable", async () => {
    const search = store({
      fts: false,
      vectorResults: [result("vector", 0.9)],
    });
    const response = await executeMemorySearch({
      query: "local memory",
      limit: 5,
      vectorStore: search,
      embeddingService: embedding,
    });
    expect(response.strategy).toBe("embedding");
    expect(response.results.map(({ id }) => id)).toEqual(["vector"]);
  });

  it("merges keyword and semantic results with deterministic hybrid ranking", async () => {
    const search = store({
      fts: true,
      ftsResults: [result("shared", 0.8), result("fts", 0.7)],
      vectorResults: [result("shared", 0.9), result("vector", 0.8)],
    });
    const response = await executeMemorySearch({
      query: "local memory",
      limit: 5,
      vectorStore: search,
      embeddingService: embedding,
    });
    expect(response.strategy).toBe("hybrid");
    expect(response.results.map(({ id }) => id)).toEqual([
      "shared",
      "fts",
      "vector",
    ]);
  });
});
