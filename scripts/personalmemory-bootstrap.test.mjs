import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const bootstrap = path.join(root, "bootstrap-personalmemory.sh");

async function git(cwd, ...args) {
  return execFileAsync("git", args, { cwd });
}

async function createReleaseFixture(base) {
  const repository = path.join(base, "release-repository");
  await git(base, "init", repository);
  await git(repository, "config", "user.name", "PersonalMemory Test");
  await git(repository, "config", "user.email", "test@example.invalid");
  const installer = path.join(repository, "install-personalmemory.sh");
  await writeFile(
    installer,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$PERSONALMEMORY_BOOTSTRAP_CAPTURE"\n',
  );
  await chmod(installer, 0o755);
  await git(repository, "add", "install-personalmemory.sh");
  await git(repository, "commit", "-m", "test release");
  await git(repository, "tag", "-a", "personalmemory-v0.1.2", "-m", "test");
  return repository;
}

test("shows bootstrap parameters without accessing a repository", async () => {
  const { stdout } = await execFileAsync("sh", [bootstrap, "--help"]);
  assert.match(stdout, /--repo <url>/u);
  assert.match(stdout, /--version <tag>/u);
  assert.match(stdout, /--install-dir <path>/u);
  assert.match(stdout, /--agent <name>/u);
  assert.match(stdout, /--gateway-port <port>/u);
});

test("clones an exact tag and forwards repeatable Agent parameters", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "personalmemory-bootstrap-"));
  const repository = await createReleaseFixture(base);
  const installDirectory = path.join(base, "installed source");
  const capture = path.join(base, "arguments.txt");
  const args = [
    bootstrap,
    "--repo",
    repository,
    "--version",
    "personalmemory-v0.1.2",
    "--install-dir",
    installDirectory,
    "--agent",
    "claude-code",
    "--agent",
    "codex",
    "--gateway-port",
    "8788",
  ];
  const environment = {
    ...process.env,
    PERSONALMEMORY_BOOTSTRAP_CAPTURE: capture,
  };

  await execFileAsync("sh", args, { env: environment });
  assert.equal(
    await readFile(capture, "utf8"),
    "--agent\ncodex\n--agent\nclaude-code\n--upstream-port\n17173\n--gateway-port\n8788\n--web-port\n17177\n",
  );
  const { stdout: head } = await git(installDirectory, "rev-parse", "HEAD");
  const { stdout: tag } = await git(
    installDirectory,
    "rev-parse",
    "personalmemory-v0.1.2^{}",
  );
  assert.equal(head, tag);

  await execFileAsync("sh", args, { env: environment });
  assert.equal(
    await readFile(capture, "utf8"),
    "--agent\ncodex\n--agent\nclaude-code\n--upstream-port\n17173\n--gateway-port\n8788\n--web-port\n17177\n",
  );

  await writeFile(path.join(repository, "release-note.txt"), "replacement\n");
  await git(repository, "add", "release-note.txt");
  await git(repository, "commit", "-m", "replacement release");
  await git(
    repository,
    "tag",
    "-f",
    "-a",
    "personalmemory-v0.1.2",
    "-m",
    "replacement",
  );
  await assert.rejects(
    execFileAsync("sh", args, { env: environment }),
    /does not match remote tag/u,
  );
});

test("rejects ambiguous Agents and unsafe version or installation inputs", async () => {
  for (const args of [
    ["--agent", "all", "--agent", "codex"],
    ["--version", "main"],
    ["--version", "personalmemory-v1.foo.2"],
    ["--version", "personalmemory-v01.2.3"],
    ["--install-dir", "relative/path"],
    ["--gateway-port", "0"],
    ["--gateway-port", "17173"],
    ["--unknown"],
  ]) {
    await assert.rejects(
      execFileAsync("sh", [bootstrap, ...args]),
      (error) => error.code === 2,
    );
  }
});
