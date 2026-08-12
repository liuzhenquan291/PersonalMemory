import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const failures = [];
const execFileAsync = promisify(execFile);

async function requireFile(relative) {
  const target = path.join(root, relative);
  const info = await stat(target).catch(() => undefined);
  if (!info?.isFile()) failures.push(`missing required file: ${relative}`);
  return info ? readFile(target, "utf8") : "";
}

const license = await requireFile("LICENSE");
if (
  !/licensed under the MIT/u.test(license) ||
  !/Permission is hereby granted, free of charge/u.test(license)
) {
  failures.push("LICENSE does not contain the upstream MIT terms");
}

const packageJson = JSON.parse(await requireFile("package.json"));
if (packageJson.license !== "MIT")
  failures.push("package.json license must be MIT");
for (const script of [
  "install:product",
  "upgrade:product",
  "lifecycle:product",
  "release:package",
  "verify",
]) {
  if (!packageJson.scripts?.[script])
    failures.push(`missing script: ${script}`);
}

const installer = await requireFile("install-personalmemory.sh");
if (
  !installer.includes("npm ci") ||
  !installer.includes("npm run install:product")
) {
  failures.push("source distribution installer is incomplete");
}

const packageLock = JSON.parse(await requireFile("package-lock.json"));
const supportedNativePackages = [
  "@node-rs/jieba-darwin-arm64",
  "@node-rs/jieba-darwin-x64",
  "@node-rs/jieba-linux-arm64-gnu",
  "@node-rs/jieba-linux-x64-gnu",
  "@esbuild/darwin-arm64",
  "@esbuild/darwin-x64",
  "@esbuild/linux-arm64",
  "@esbuild/linux-x64",
  "@rolldown/binding-darwin-arm64",
  "@rolldown/binding-darwin-x64",
  "@rolldown/binding-linux-arm64-gnu",
  "@rolldown/binding-linux-x64-gnu",
  "lightningcss-darwin-arm64",
  "lightningcss-darwin-x64",
  "lightningcss-linux-arm64-gnu",
  "lightningcss-linux-x64-gnu",
  "sqlite-vec-darwin-arm64",
  "sqlite-vec-darwin-x64",
  "sqlite-vec-linux-arm64",
  "sqlite-vec-linux-x64",
];
for (const dependency of supportedNativePackages) {
  if (!packageLock.packages?.[`node_modules/${dependency}`]) {
    failures.push(`package-lock.json is missing ${dependency}`);
  }
}

const configuration = await requireFile(
  "packages/personal-memory/src/config.ts",
);
if (!configuration.includes("file.model?.enabled ??\n    false")) {
  failures.push("model access is not visibly default-off");
}
if (!configuration.includes("file.telemetryEnabled ??\n      false")) {
  failures.push("telemetry is not visibly default-off");
}
if (!configuration.includes('file.server?.host ?? "127.0.0.1"')) {
  failures.push("Gateway is not visibly loopback by default");
}

const excludedDirectories = new Set([
  ".git",
  ".personalmemory",
  "coverage",
  "dist",
  "node_modules",
]);

async function walk(relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name))
        files.push(...(await walk(child)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

async function releaseFiles() {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "buffer" },
    );
    return {
      files: stdout.toString().split("\0").filter(Boolean),
      source: "git",
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { files: await walk(), source: "filesystem" };
  }
}

const scanned = await releaseFiles();
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bghp_[A-Za-z0-9]{30,}\b/u,
  /\bsk-[A-Za-z0-9]{32,}\b/u,
];
for (const relative of scanned.files) {
  const contents = await readFile(path.join(root, relative), "utf8").catch(
    () => undefined,
  );
  if (contents === undefined) continue;
  for (const pattern of secretPatterns) {
    if (pattern.test(contents)) failures.push(`possible secret in ${relative}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({ ok: true, scannedFiles: scanned.files.length, scanSource: scanned.source, license: "MIT", nativePackages: supportedNativePackages.length, secretPatterns: secretPatterns.length })}\n`,
  );
}
