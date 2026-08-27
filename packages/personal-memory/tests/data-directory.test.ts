import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigurationError, initializeDataDirectory } from "../src/index.js";

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(
    path.join(realpathSync(process.cwd()), ".personalmemory-data-test-"),
  );
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("initializeDataDirectory", () => {
  it("creates an idempotent user-private directory", () => {
    withTemporaryDirectory((directory) => {
      const target = path.join(directory, "nested", "data");
      expect(initializeDataDirectory(target)).toBe(target);
      expect(initializeDataDirectory(target)).toBe(target);
      expect(lstatSync(target).mode & 0o777).toBe(0o700);
    });
  });

  it("rejects an existing file without overwriting it", () => {
    withTemporaryDirectory((directory) => {
      const target = path.join(directory, "existing-file");
      writeFileSync(target, "preserve-me", "utf8");

      expect(() => initializeDataDirectory(target)).toThrow(
        /exists but is not a directory/,
      );
    });
  });

  it("does not change permissions on an unsafe existing directory", () => {
    withTemporaryDirectory((directory) => {
      const target = path.join(directory, "shared-directory");
      mkdirSync(target, { mode: 0o755 });

      expect(() => initializeDataDirectory(target)).toThrow(/private \(0700\)/);
      expect(lstatSync(target).mode & 0o777).toBe(0o755);
    });
  });

  it.each([0o600, 0o500])(
    "rejects an unusable existing directory mode %s",
    (mode) => {
      withTemporaryDirectory((directory) => {
        const target = path.join(directory, `mode-${mode.toString(8)}`);
        mkdirSync(target, { mode });

        expect(() => initializeDataDirectory(target)).toThrow(
          /private \(0700\)/,
        );
      });
    },
  );

  it("rejects a group-or-other writable nearest ancestor", () => {
    withTemporaryDirectory((directory) => {
      const writableAncestor = path.join(directory, "writable-ancestor");
      mkdirSync(writableAncestor, { mode: 0o777 });
      chmodSync(writableAncestor, 0o777);

      expect(() =>
        initializeDataDirectory(path.join(writableAncestor, "data")),
      ).toThrow(/ancestor chain must not be writable/);
    });
  });

  it("rejects a private child beneath a replaceable ancestor", () => {
    withTemporaryDirectory((directory) => {
      const writableAncestor = path.join(directory, "replaceable-parent");
      const privateChild = path.join(writableAncestor, "private-child");
      mkdirSync(privateChild, { recursive: true, mode: 0o700 });
      // chmod is test setup only: it models an attacker-controlled parent.
      chmodSync(writableAncestor, 0o777);

      expect(() =>
        initializeDataDirectory(path.join(privateChild, "data")),
      ).toThrow(/ancestor chain must not be writable/);
    });
  });

  it("rejects symbolic links before creating outside directories", () => {
    withTemporaryDirectory((directory) => {
      const outside = path.join(directory, "outside");
      const link = path.join(directory, "linked-parent");
      mkdirSync(outside);
      symlinkSync(outside, link, "dir");

      expect(() =>
        initializeDataDirectory(path.join(link, "must-not-exist")),
      ).toThrow(/must not contain symbolic links/);
      expect(() => lstatSync(path.join(outside, "must-not-exist"))).toThrow();
    });
  });

  it("rejects the filesystem root", () => {
    expect(() =>
      initializeDataDirectory(path.parse(process.cwd()).root),
    ).toThrow(ConfigurationError);
  });
});
