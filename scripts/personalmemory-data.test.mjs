import assert from "node:assert/strict";
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
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  defaultMigrations,
  migrateDatabase,
} from "../packages/personal-memory/dist/index.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const command = path.join(projectRoot, "scripts", "personalmemory-data.ts");

function run(dataDirectory, ...args) {
  return execFileSync(process.execPath, ["--import", "tsx", command, ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PERSONALMEMORY_DATA_DIR: dataDirectory,
      PERSONALMEMORY_AUTH_ENABLED: "false",
      PERSONALMEMORY_UPSTREAM_BASE_URL: "http://127.0.0.1:65534",
    },
    encoding: "utf8",
  });
}

test("data CLI exports, backs up, verifies and restores an offline data root", () => {
  const root = mkdtempSync(
    path.join(realpathSync(tmpdir()), "personalmemory-data-cli-"),
  );
  const data = path.join(root, "data");
  const output = path.join(root, "export.json");
  const backup = path.join(root, "backup");
  try {
    chmodSync(root, 0o700);
    mkdirSync(data, { mode: 0o700 });
    const product = new DatabaseSync(path.join(data, "personalmemory.sqlite"));
    migrateDatabase(product, defaultMigrations);
    product.close();
    const vectors = new DatabaseSync(path.join(data, "vectors.db"));
    vectors.exec("CREATE TABLE search_fixture (content TEXT NOT NULL)");
    vectors.prepare("INSERT INTO search_fixture VALUES (?)").run("original");
    vectors.close();
    mkdirSync(path.join(data, ".metadata"));
    writeFileSync(
      path.join(data, ".metadata", "manifest.json"),
      `${JSON.stringify({
        version: 1,
        createdAt: "2026-08-12T00:00:00.000Z",
        store: { type: "sqlite", sqlite: { path: "vectors.db" } },
        seed: null,
      })}\n`,
    );
    writeFileSync(path.join(data, "persona.md"), "original", { mode: 0o600 });

    const exported = JSON.parse(
      run(data, "export", "--format", "json", "--output", output),
    );
    assert.match(exported.sha256, /^[a-f0-9]{64}$/u);
    assert.match(exported.warning, /personalmemory-export/u);
    const backedUp = JSON.parse(run(data, "backup", "--output", backup));
    assert.ok(backedUp.assets >= 3);
    assert.match(backedUp.warning, /personalmemory-backup/u);
    assert.deepEqual(JSON.parse(run(data, "verify", "--input", backup)), {
      valid: true,
      assets: backedUp.assets,
    });

    writeFileSync(path.join(data, "persona.md"), "changed");
    const restored = JSON.parse(
      run(data, "restore", "--input", backup, "--confirm", `RESTORE ${data}`),
    );
    assert.equal(restored.restored, true);
    assert.equal(
      readFileSync(path.join(data, "persona.md"), "utf8"),
      "original",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
