import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

interface LockRecord {
  version: 1;
  pid: number;
  operation: string;
  owner_hash: string;
  created_at: string;
}

export interface DataLifecycleLease {
  token: string;
  release(): void;
}

function ownerHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class DataLifecycleMutex {
  readonly lockPath: string;
  readonly guardPath: string;

  constructor(stateDirectory: string) {
    const resolved = path.resolve(stateDirectory);
    const info = lstatSync(resolved);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error(
        "Data lifecycle state directory must be private and real",
      );
    this.lockPath = path.join(resolved, "data-lifecycle.lock");
    this.guardPath = path.join(resolved, "data-lifecycle.guard");
  }

  acquire(input: {
    operation: string;
    token?: string;
  }): DataLifecycleLease | undefined {
    let guard: number;
    try {
      guard = openSync(this.guardPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw error;
    }
    try {
      return this.acquireUnderGuard(input);
    } finally {
      closeSync(guard);
      unlinkSync(this.guardPath);
    }
  }

  private acquireUnderGuard(input: {
    operation: string;
    token?: string;
  }): DataLifecycleLease | undefined {
    const token = input.token ?? randomBytes(32).toString("base64url");
    const hash = ownerHash(token);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = openSync(this.lockPath, "wx", 0o600);
        try {
          const record: LockRecord = {
            version: 1,
            pid: process.pid,
            operation: input.operation,
            owner_hash: hash,
            created_at: new Date().toISOString(),
          };
          writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
        } finally {
          closeSync(descriptor);
        }
        return this.lease(token, hash, false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const record = this.readRecord();
      if (record.owner_hash === hash) return this.lease(token, hash, true);
      if (!this.processExists(record.pid)) {
        unlinkSync(this.lockPath);
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  private readRecord(): LockRecord {
    const info = lstatSync(this.lockPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error("Data lifecycle lock must be a private regular file");
    const value = JSON.parse(readFileSync(this.lockPath, "utf8")) as LockRecord;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 1 ||
      typeof value.operation !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.owner_hash) ||
      typeof value.created_at !== "string"
    )
      throw new Error("Data lifecycle lock is invalid");
    return value;
  }

  private processExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      return true;
    }
  }

  private lease(
    token: string,
    hash: string,
    reentrant: boolean,
  ): DataLifecycleLease {
    let released = false;
    return {
      token,
      release: () => {
        if (released || reentrant) return;
        released = true;
        try {
          if (this.readRecord().owner_hash === hash) unlinkSync(this.lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
    };
  }
}
