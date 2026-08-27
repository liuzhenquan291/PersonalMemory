import { lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const MARKER = ".personalmemory-running";

export class DataDirectoryActiveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DataDirectoryActiveError";
  }
}

function markerPath(dataDirectory: string): string {
  return path.join(path.resolve(dataDirectory), MARKER);
}

function activePid(dataDirectory: string): number | undefined {
  const file = markerPath(dataDirectory);
  let pid: number;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("runtime marker is not a regular file");
    }
    pid = JSON.parse(readFileSync(file, "utf8")).pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new DataDirectoryActiveError("Runtime marker is invalid", {
      cause: error,
    });
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new DataDirectoryActiveError("Runtime marker PID is invalid");
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      unlinkSync(file);
      return undefined;
    }
    throw error;
  }
}

export function assertDataDirectoryOffline(dataDirectory: string): void {
  const pid = activePid(dataDirectory);
  if (pid !== undefined) {
    throw new DataDirectoryActiveError(
      `PersonalMemory Gateway is still running (PID ${pid}); stop it before export, backup, or restore`,
    );
  }
}

export function acquireRuntimeMarker(
  dataDirectory: string,
  pid = process.pid,
): () => void {
  assertDataDirectoryOffline(dataDirectory);
  const file = markerPath(dataDirectory);
  try {
    writeFileSync(file, `${JSON.stringify({ pid })}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    throw new DataDirectoryActiveError(
      "Could not acquire the Gateway runtime marker",
      {
        cause: error,
      },
    );
  }
  return () => {
    try {
      const current = JSON.parse(readFileSync(file, "utf8")).pid;
      if (current === pid) unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}
