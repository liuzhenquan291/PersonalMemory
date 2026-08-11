import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryStateLedger,
  acquireRuntimeMarker,
  assertDataDirectoryOffline,
  createPortableBackup,
  createReadableExport,
  defaultMigrations,
  migrateDatabase,
  restorePortableBackup,
  verifyPortableBackup,
} from "../src/index.js";

const sandboxes: string[] = [];

function sandbox(): string {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "personalmemory-portable-"),
  );
  sandboxes.push(directory);
  return directory;
}

function fixture(root: string, recordCount = 1): string {
  const data = join(root, "data");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  chmodSync(data, 0o700);
  const product = new DatabaseSync(join(data, "personalmemory.sqlite"));
  migrateDatabase(product, defaultMigrations);
  new MemoryStateLedger(product, () => "2026-08-12T00:00:00.000Z").set(
    "L1",
    "memory-1",
    "invalidated",
    0,
    "错误记忆",
  );
  product.close();
  const vectors = new DatabaseSync(join(data, "vectors.db"));
  vectors.exec(
    "CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL)",
  );
  vectors
    .prepare("INSERT INTO memories VALUES (?, ?)")
    .run("memory-1", "本地优先");
  vectors.close();
  mkdirSync(join(data, ".metadata"));
  writeFileSync(
    join(data, ".metadata", "manifest.json"),
    `${JSON.stringify({
      version: 1,
      createdAt: "2026-08-12T00:00:00.000Z",
      store: { type: "sqlite", sqlite: { path: "vectors.db" } },
      seed: null,
    })}\n`,
  );
  mkdirSync(join(data, "conversations"));
  writeFileSync(
    join(data, "conversations", "2026-08-12.jsonl"),
    `${JSON.stringify({ id: "message-1", role: "user", content: "记住本地优先" })}\n`,
  );
  mkdirSync(join(data, "records"));
  writeFileSync(
    join(data, "records", "2026-08-12.jsonl"),
    Array.from({ length: recordCount }, (_, index) =>
      JSON.stringify({
        id: `memory-${index + 1}`,
        content: `本地优先 ${index + 1}`,
        source_message_ids: ["message-1"],
      }),
    ).join("\n") + "\n",
  );
  mkdirSync(join(data, "scene_blocks"));
  writeFileSync(join(data, "scene_blocks", "work.md"), "# 工作\n\n本地优先\n");
  writeFileSync(join(data, "persona.md"), "# 核心画像\n\n重视隐私。\n");
  writeFileSync(join(data, "gateway.yaml"), "apiKey: must-not-be-backed-up\n");
  mkdirSync(join(data, "logs"));
  writeFileSync(join(data, "logs", "gateway.log"), "sensitive log\n");
  return data;
}

afterEach(() => {
  for (const directory of sandboxes.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("portable PersonalMemory data", () => {
  it("creates readable JSON and Markdown exports with sources and states", async () => {
    const root = sandbox();
    const data = fixture(root);
    const jsonPath = join(root, "export.json");
    const markdownPath = join(root, "export.md");
    const jsonResult = await createReadableExport(data, jsonPath, "json");
    await createReadableExport(data, markdownPath, "markdown");

    const exported = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(exported.memories[0]).toMatchObject({
      source_message_ids: ["message-1"],
    });
    expect(exported.states[0]).toMatchObject({
      memory_id: "memory-1",
      status: "invalidated",
    });
    expect(readFileSync(markdownPath, "utf8")).toContain(
      "PersonalMemory 状态与 tombstone",
    );
    expect(jsonResult.counts).toEqual({
      conversations: 1,
      memories: 1,
      scenarios: 1,
      core: 1,
      states: 1,
    });
  });

  it("handles empty and larger readable exports without omitting records", async () => {
    const emptyRoot = sandbox();
    const emptyData = fixture(emptyRoot, 0);
    writeFileSync(join(emptyData, "records", "2026-08-12.jsonl"), "");
    const emptyOutput = join(emptyRoot, "empty.json");
    await createReadableExport(emptyData, emptyOutput, "json");
    expect(JSON.parse(readFileSync(emptyOutput, "utf8")).memories).toEqual([]);

    const largeRoot = sandbox();
    const largeData = fixture(largeRoot, 2_000);
    const largeOutput = join(largeRoot, "large.json");
    const result = await createReadableExport(largeData, largeOutput, "json");
    expect(result.counts.memories).toBe(2_000);
  });

  it("backs up the explicit data inventory and atomically restores it", async () => {
    const root = sandbox();
    const data = fixture(root);
    const backup = join(root, "backup");
    const manifest = await createPortableBackup(
      data,
      backup,
      () => new Date("2026-08-12T00:00:00.000Z"),
    );
    expect(manifest.assets.map((asset) => asset.path)).toEqual(
      expect.arrayContaining([
        "personalmemory.sqlite",
        "vectors.db",
        "conversations/2026-08-12.jsonl",
        "records/2026-08-12.jsonl",
        "scene_blocks/work.md",
        "persona.md",
      ]),
    );
    expect(manifest.assets.map((asset) => asset.path)).not.toEqual(
      expect.arrayContaining(["gateway.yaml", "logs/gateway.log"]),
    );

    writeFileSync(join(data, "persona.md"), "changed");
    const restored = await restorePortableBackup(backup, data);
    expect(restored.rollbackDirectory).toBeDefined();
    expect(readFileSync(join(data, "persona.md"), "utf8")).toContain(
      "重视隐私",
    );
    expect(
      readFileSync(join(restored.rollbackDirectory!, "persona.md"), "utf8"),
    ).toBe("changed");
    const vectors = new DatabaseSync(join(data, "vectors.db"), {
      readOnly: true,
    });
    expect(
      vectors
        .prepare("SELECT content FROM memories WHERE id = ?")
        .get("memory-1"),
    ).toEqual({ content: "本地优先" });
    vectors.close();
  });

  it("rejects a damaged package before replacing current data", async () => {
    const root = sandbox();
    const data = fixture(root);
    const backup = join(root, "backup");
    await createPortableBackup(data, backup);
    writeFileSync(join(backup, "data", "persona.md"), "tampered");
    writeFileSync(join(data, "persona.md"), "current");
    await expect(restorePortableBackup(backup, data)).rejects.toMatchObject({
      code: "CHECKSUM_MISMATCH",
    });
    expect(readFileSync(join(data, "persona.md"), "utf8")).toBe("current");
  });

  it("rejects newer backup versions and unsafe destinations", async () => {
    const root = sandbox();
    const data = fixture(root);
    const backup = join(root, "backup");
    await createPortableBackup(data, backup);
    const manifestPath = join(backup, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.format_version = 99;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(verifyPortableBackup(backup)).rejects.toMatchObject({
      code: "INCOMPATIBLE_VERSION",
    });
    await expect(
      createPortableBackup(data, join(data, "backup")),
    ).rejects.toMatchObject({
      code: "UNSAFE_PATH",
    });
  });

  it("refuses inconsistent operations while the Gateway marker is active", async () => {
    const root = sandbox();
    const data = fixture(root);
    const release = acquireRuntimeMarker(data);
    expect(() => assertDataDirectoryOffline(data)).toThrow(/still running/u);
    await expect(
      createPortableBackup(data, join(root, "backup")),
    ).rejects.toThrow(/still running/u);
    release();
    expect(() => assertDataDirectoryOffline(data)).not.toThrow();
  });

  it("fails closed when the data inventory contains an unknown asset", async () => {
    const root = sandbox();
    const data = fixture(root);
    writeFileSync(join(data, "unknown.private"), "must be classified");
    await expect(
      createPortableBackup(data, join(root, "backup")),
    ).rejects.toMatchObject({
      code: "INVALID_DATA",
    });
  });

  it("rejects remote store manifests and manifest path traversal", async () => {
    const remoteRoot = sandbox();
    const remoteData = fixture(remoteRoot);
    writeFileSync(
      join(remoteData, ".metadata", "manifest.json"),
      JSON.stringify({ version: 1, store: { type: "tcvdb" }, seed: null }),
    );
    await expect(
      createPortableBackup(remoteData, join(remoteRoot, "backup")),
    ).rejects.toMatchObject({ code: "INVALID_DATA" });

    const root = sandbox();
    const data = fixture(root);
    const backup = join(root, "backup");
    await createPortableBackup(data, backup);
    const manifestPath = join(backup, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.assets[0].path = "../escape";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(verifyPortableBackup(backup)).rejects.toMatchObject({
      code: "INVALID_BACKUP",
    });
    await expect(
      createPortableBackup("/", join(root, "root-backup")),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });

  it("rejects backup files omitted from the manifest", async () => {
    const root = sandbox();
    const data = fixture(root);
    const backup = join(root, "backup");
    await createPortableBackup(data, backup);
    const manifestPath = join(backup, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.assets = manifest.assets.filter(
      (asset: { path: string }) => asset.path !== "persona.md",
    );
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(verifyPortableBackup(backup)).rejects.toMatchObject({
      code: "INVALID_BACKUP",
    });
  });
});
