import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectModuleSpecifiers,
  findDependencyCycle,
  verifyWorkspaceBoundaries,
} from "./verify-workspace-boundaries.mjs";

test("collects static, re-export, dynamic, require and import-equals specifiers", () => {
  const source = `
    import value from "static-import";
    import "side-effect";
    export { value } from "re-export";
    const dynamicValue = import("dynamic-import");
    const required = require("commonjs-require");
    import alias = require("import-equals");
  `;

  assert.deepEqual(
    new Set(collectModuleSpecifiers(source)),
    new Set([
      "static-import",
      "side-effect",
      "re-export",
      "dynamic-import",
      "commonjs-require",
      "import-equals",
    ]),
  );
});

test("detects dependency cycles", () => {
  const graph = new Map([
    ["core", new Set(["gateway"])],
    ["gateway", new Set(["mcp"])],
    ["mcp", new Set(["core"])],
  ]);

  assert.deepEqual(findDependencyCycle(graph), [
    "core",
    "gateway",
    "mcp",
    "core",
  ]);
  assert.equal(
    findDependencyCycle(
      new Map([
        ["core", new Set()],
        ["gateway", new Set(["core"])],
      ]),
    ),
    null,
  );
});

async function createWorkspaceFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "personalmemory-boundaries-"));
  const manifests = new Map([
    ["packages/personal-memory", { name: "@personalmemory/core" }],
    [
      "apps/gateway",
      {
        name: "@personalmemory/gateway",
        dependencies: { "@personalmemory/core": "0.0.0" },
      },
    ],
    [
      "packages/mcp-server",
      {
        name: "@personalmemory/mcp-server",
        dependencies: { "@personalmemory/core": "0.0.0" },
      },
    ],
    ["apps/web", { name: "@personalmemory/web" }],
  ]);
  await mkdir(path.join(root, "src"), { recursive: true });
  for (const [directory, manifest] of manifests) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(
      path.join(root, directory, "package.json"),
      JSON.stringify({ version: "0.0.0", ...manifest }),
    );
  }
  return root;
}

test("rejects an undisclosed workspace", async () => {
  const root = await createWorkspaceFixture();
  try {
    await mkdir(path.join(root, "apps/unknown"), { recursive: true });
    await writeFile(
      path.join(root, "apps/unknown/package.json"),
      JSON.stringify({ name: "@personalmemory/unknown", version: "0.0.0" }),
    );

    assert.ok(
      (await verifyWorkspaceBoundaries(root)).includes(
        "apps/unknown: workspace has no dependency policy",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("includes optional internal dependencies in policy and cycle checks", async () => {
  const root = await createWorkspaceFixture();
  try {
    await writeFile(
      path.join(root, "packages/personal-memory/package.json"),
      JSON.stringify({
        name: "@personalmemory/core",
        version: "0.0.0",
        optionalDependencies: { "@personalmemory/gateway": "0.0.0" },
      }),
    );

    const errors = await verifyWorkspaceBoundaries(root);
    assert.ok(
      errors.includes(
        "@personalmemory/core must not depend on @personalmemory/gateway",
      ),
    );
    assert.ok(
      errors.some((error) => error.startsWith("workspace dependency cycle:")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
