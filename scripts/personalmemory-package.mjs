import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  readdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const productVersion = "0.1.1";
const archiveDirectory = `PersonalMemory-${productVersion}`;
const archiveName = `${archiveDirectory}-source.tar.gz`;

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function candidateFiles() {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "buffer" },
  );
  return stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .filter((relative) => !relative.startsWith("release/"))
    .sort();
}

async function copyCandidate(relative, destinationRoot) {
  const source = path.join(root, relative);
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Release candidate is not a regular file: ${relative}`);
  }
  const destination = path.join(destinationRoot, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, info.mode & 0o777);
}

function dependencyNotices(lock) {
  const verifiedLicenseOverrides = new Map([
    ["compute-gcd@1.2.1", "MIT"],
    ["compute-lcm@1.1.2", "MIT"],
    ["validate.io-function@1.0.2", "MIT"],
    ["validate.io-integer@1.0.5", "MIT"],
    ["validate.io-integer-array@1.0.0", "MIT"],
    ["validate.io-number@1.0.3", "MIT"],
  ]);
  const rows = new Map();
  for (const [location, metadata] of Object.entries(lock.packages ?? {})) {
    if (!location || !location.includes("node_modules/") || !metadata.version)
      continue;
    const name = location.slice(location.lastIndexOf("node_modules/") + 13);
    const key = `${name}@${metadata.version}`;
    const license = metadata.license ?? verifiedLicenseOverrides.get(key);
    if (!license) throw new Error(`License is not recorded for ${key}`);
    rows.set(key, license);
  }
  return [
    "PersonalMemory third-party dependency notices",
    "",
    "This source distribution retains the upstream LICENSE file. The list below is generated from package-lock.json; six legacy packages without lockfile license metadata were verified as MIT against the official npm registry. Package source and installed package metadata remain authoritative.",
    "",
    ...[...rows]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([dependency, license]) => `${dependency}\t${license}`),
    "",
  ].join("\n");
}

async function sha256(target) {
  const contents = await readFile(target);
  return createHash("sha256").update(contents).digest("hex");
}

async function normalizeTimestamps(directory) {
  const fixed = new Date("2026-08-12T00:00:00.000Z");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await normalizeTimestamps(target);
    await utimes(target, fixed, fixed);
  }
  await utimes(directory, fixed, fixed);
}

const outputDirectory = path.resolve(
  option("--output-dir") ?? path.join(root, "release"),
);
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "personalmemory-release-"),
);
const stagedRoot = path.join(temporaryRoot, archiveDirectory);

try {
  const files = await candidateFiles();
  if (!files.includes("install-personalmemory.sh")) {
    throw new Error("Release candidate is missing install-personalmemory.sh");
  }
  for (const relative of files) await copyCandidate(relative, stagedRoot);

  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json")));
  await writeFile(
    path.join(stagedRoot, "THIRD_PARTY_NOTICES.txt"),
    dependencyNotices(lock),
    { mode: 0o644 },
  );
  await writeFile(
    path.join(stagedRoot, "RELEASE-MANIFEST.json"),
    `${JSON.stringify(
      {
        product: "PersonalMemory",
        version: productVersion,
        format: "versioned-source-tarball",
        minimumNodeVersion: "22.19.0",
        supportedPlatforms: ["macOS arm64", "Linux arm64"],
        installCommand: "./install-personalmemory.sh",
        includedSourceFiles: files.length,
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );
  await normalizeTimestamps(stagedRoot);

  await mkdir(outputDirectory, { recursive: true });
  const archivePath = path.join(outputDirectory, archiveName);
  const tarPath = path.join(temporaryRoot, `${archiveDirectory}.tar`);
  await execFileAsync("tar", ["-cf", tarPath, archiveDirectory], {
    cwd: temporaryRoot,
  });
  const { stdout: compressed } = await execFileAsync(
    "gzip",
    ["-n", "-9", "-c", tarPath],
    {
      cwd: temporaryRoot,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  await writeFile(archivePath, compressed, { mode: 0o644 });
  const digest = await sha256(archivePath);
  const checksumPath = `${archivePath}.sha256`;
  await writeFile(checksumPath, `${digest}  ${archiveName}\n`, { mode: 0o644 });
  process.stdout.write(
    `${JSON.stringify({ archivePath, checksumPath, sha256: digest, sourceFiles: files.length })}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
