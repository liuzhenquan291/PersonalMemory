import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const workspacePolicies = new Map([
  [
    "packages/personal-memory",
    { name: "@personalmemory/core", allowed: new Set() },
  ],
  [
    "apps/gateway",
    {
      name: "@personalmemory/gateway",
      allowed: new Set(["@personalmemory/core"]),
    },
  ],
  [
    "packages/mcp-server",
    {
      name: "@personalmemory/mcp-server",
      allowed: new Set(["@personalmemory/core"]),
    },
  ],
  ["apps/web", { name: "@personalmemory/web", allowed: new Set() }],
]);

export function collectModuleSpecifiers(source, filename = "source.ts") {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers = [];

  function addLiteral(node) {
    if (
      node &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ) {
      specifiers.push(node.text);
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        addLiteral(node.arguments[0]);
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      )
        addLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

export function findDependencyCycle(graph) {
  const visited = new Set();
  const active = new Set();
  const stack = [];

  function visit(node) {
    if (active.has(node)) {
      const start = stack.indexOf(node);
      return [...stack.slice(start), node];
    }
    if (visited.has(node)) return null;
    visited.add(node);
    active.add(node);
    stack.push(node);
    for (const dependency of graph.get(node) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(node);
    return null;
  }

  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["dist", "node_modules"].includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sourceFiles(fullPath)));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) result.push(fullPath);
  }
  return result;
}

async function discoverWorkspaceDirectories(root) {
  const directories = [];
  for (const base of ["apps", "packages"]) {
    for (const entry of await readdir(path.join(root, base), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const relative = path.join(base, entry.name);
      if (existsSync(path.join(root, relative, "package.json")))
        directories.push(relative);
    }
  }
  return directories.sort();
}

export async function verifyWorkspaceBoundaries(root) {
  const errors = [];
  const directories = await discoverWorkspaceDirectories(root);
  const manifests = new Map();

  for (const directory of directories) {
    const policy = workspacePolicies.get(directory);
    if (!policy) {
      errors.push(`${directory}: workspace has no dependency policy`);
      continue;
    }
    const manifest = JSON.parse(
      await readFile(path.join(root, directory, "package.json"), "utf8"),
    );
    if (manifest.name !== policy.name) {
      errors.push(
        `${directory}: expected package name ${policy.name}, got ${manifest.name ?? "(missing)"}`,
      );
    }
    manifests.set(manifest.name, { directory, manifest, policy });
  }

  for (const directory of workspacePolicies.keys()) {
    if (!directories.includes(directory))
      errors.push(`${directory}: declared workspace policy has no package`);
  }

  const graph = new Map([...manifests.keys()].map((name) => [name, new Set()]));
  for (const [name, { manifest, policy }] of manifests) {
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    for (const dependency of Object.keys(declared)) {
      if (!dependency.startsWith("@personalmemory/")) continue;
      if (!manifests.has(dependency)) {
        errors.push(`${name}: unknown internal dependency ${dependency}`);
        continue;
      }
      graph.get(name)?.add(dependency);
      if (!policy.allowed.has(dependency))
        errors.push(`${name} must not depend on ${dependency}`);
    }
  }

  const cycle = findDependencyCycle(graph);
  if (cycle) errors.push(`workspace dependency cycle: ${cycle.join(" -> ")}`);

  for (const file of await sourceFiles(path.join(root, "src"))) {
    const source = await readFile(file, "utf8");
    for (const specifier of collectModuleSpecifiers(source, file)) {
      if (specifier.startsWith("@personalmemory/")) {
        errors.push(
          `${path.relative(root, file)}: upstream core must not import ${specifier}`,
        );
      }
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), specifier);
        if (
          resolved.startsWith(path.join(root, "apps") + path.sep) ||
          resolved.startsWith(path.join(root, "packages") + path.sep)
        ) {
          errors.push(
            `${path.relative(root, file)}: upstream core must not reach into ${specifier}`,
          );
        }
      }
    }
  }

  const upstreamSourceRoot = path.join(root, "src") + path.sep;
  for (const directory of ["apps", "packages"]) {
    for (const file of await sourceFiles(path.join(root, directory))) {
      const source = await readFile(file, "utf8");
      for (const specifier of collectModuleSpecifiers(source, file)) {
        if (!specifier.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        if (
          resolved === path.join(root, "src") ||
          resolved.startsWith(upstreamSourceRoot)
        ) {
          errors.push(
            `${path.relative(root, file)}: product code must not reach into upstream src via ${specifier}`,
          );
        }
      }
    }
  }

  return errors;
}

async function main() {
  const errors = await verifyWorkspaceBoundaries(process.cwd());
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("workspace boundaries: ok\n");
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
