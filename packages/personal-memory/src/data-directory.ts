import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ConfigurationError } from "./config.js";

function existingPathChain(target: string): string[] {
  const chain: string[] = [];
  let cursor = path.resolve(target);
  for (;;) {
    chain.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return chain.reverse();
}

function rejectUnsafeComponents(target: string): void {
  for (const component of existingPathChain(target)) {
    try {
      const stat = lstatSync(component);
      if (stat.isSymbolicLink()) {
        throw new ConfigurationError(
          `Data directory path must not contain symbolic links: ${component}`,
        );
      }
      if (component === target && !stat.isDirectory()) {
        throw new ConfigurationError(
          `Data directory path exists but is not a directory: ${target}`,
        );
      }
    } catch (error) {
      if (
        error instanceof ConfigurationError ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
}

function findTrustedAncestor(target: string): string {
  let cursor = target;
  for (;;) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ConfigurationError(
          `Data directory ancestor must be a real directory: ${cursor}`,
        );
      }
      return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new ConfigurationError(
          `No trusted existing ancestor found for data directory: ${target}`,
        );
      }
      cursor = parent;
    }
  }
}

function validateStableAncestorChain(ancestor: string): void {
  const effectiveUserId = process.geteuid?.();
  for (const component of existingPathChain(ancestor)) {
    const stat = lstatSync(component);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ConfigurationError(
        `Data directory ancestor chain must contain real directories: ${component}`,
      );
    }
    if (
      effectiveUserId !== undefined &&
      stat.uid !== 0 &&
      stat.uid !== effectiveUserId
    ) {
      throw new ConfigurationError(
        `Data directory ancestor chain must be owned by root or the current user: ${component}`,
      );
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new ConfigurationError(
        `Data directory ancestor chain must not be writable by other users: ${component}`,
      );
    }
  }
}

export function initializeDataDirectory(target: string): string {
  const resolved = path.resolve(target);
  if (resolved === path.parse(resolved).root) {
    throw new ConfigurationError(
      "The filesystem root cannot be a data directory",
    );
  }
  rejectUnsafeComponents(resolved);
  validateStableAncestorChain(findTrustedAncestor(resolved));
  try {
    const existing = lstatSync(resolved);
    if ((existing.mode & 0o777) !== 0o700) {
      throw new ConfigurationError(
        `Existing data directory permissions must be private (0700): ${resolved}`,
      );
    }
  } catch (error) {
    if (
      error instanceof ConfigurationError ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  rejectUnsafeComponents(resolved);
  const created = lstatSync(resolved);
  if ((created.mode & 0o777) !== 0o700) {
    throw new ConfigurationError(
      `Data directory was not created with private 0700 permissions: ${resolved}`,
    );
  }
  return resolved;
}
