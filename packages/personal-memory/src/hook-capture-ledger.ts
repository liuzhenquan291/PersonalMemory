import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HookCaptureRequest } from "./hook-contract.js";

export type HookCaptureResult = "captured" | "duplicate" | "conflict";
export const HOOK_CAPTURE_COMMITTED = Symbol("HOOK_CAPTURE_COMMITTED");

function payloadHash(request: HookCaptureRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contract_version: request.contract_version,
        event: request.event,
        authorization: request.authorization,
        source: request.source,
        messages: request.messages,
      }),
    )
    .digest("hex");
}

export class HookCaptureLedger {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  capture(
    request: HookCaptureRequest,
    write: (database: DatabaseSync) => typeof HOOK_CAPTURE_COMMITTED,
  ): HookCaptureResult {
    const hash = payloadHash(request);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database
        .prepare(
          `SELECT payload_hash FROM personalmemory_hook_captures
           WHERE idempotency_key = ?`,
        )
        .get(request.idempotency_key) as { payload_hash: string } | undefined;
      if (current) {
        this.database.exec("COMMIT");
        return current.payload_hash === hash ? "duplicate" : "conflict";
      }
      if (write(this.database) !== HOOK_CAPTURE_COMMITTED) {
        throw new Error("Hook capture sink did not commit synchronously");
      }
      const timestamp = this.now();
      this.database
        .prepare(
          `INSERT INTO personalmemory_hook_captures
           (idempotency_key, payload_hash, status, created_at, updated_at)
           VALUES (?, ?, 'captured', ?, ?)`,
        )
        .run(request.idempotency_key, hash, timestamp, timestamp);
      this.database.exec("COMMIT");
      return "captured";
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
