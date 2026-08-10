import { createHash, randomUUID } from "node:crypto";
import {
  ImportIdempotencyConflictError,
  type ImportJobView,
  type ImportLedger,
  type ImportRoundPayload,
} from "@personalmemory/core";
import type { UpstreamGatewayClient } from "./types.js";
import { UpstreamGatewayError } from "./upstream-client.js";

export class ConversationImportManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly ledger: ImportLedger,
    private readonly upstream: UpstreamGatewayClient,
    private readonly timeoutMs: number,
    private readonly randomId: () => string = randomUUID,
  ) {}

  submit(input: {
    idempotencyKey: string;
    rounds: readonly ImportRoundPayload[];
  }): { job: ImportJobView; created: boolean } {
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(input.rounds))
      .digest("hex");
    const result = this.ledger.create({
      id: this.randomId(),
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      rounds: input.rounds,
    });
    if (result.created || result.job.status === "pending") {
      this.schedule(result.job.id);
    }
    return result;
  }

  get(id: string): ImportJobView | undefined {
    return this.ledger.get(id);
  }

  retry(id: string): ImportJobView | undefined {
    const job = this.ledger.retry(id);
    if (job?.status === "pending") this.schedule(id);
    return job;
  }

  cancel(id: string): ImportJobView | undefined {
    const job = this.ledger.requestCancel(id);
    this.controllers.get(id)?.abort();
    return job;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const id of this.running.keys()) this.ledger.requestCancel(id);
    for (const [id, controller] of this.controllers) {
      this.ledger.requestCancel(id);
      controller.abort();
    }
    await Promise.allSettled(this.running.values());
  }

  private schedule(id: string): void {
    if (this.shuttingDown) {
      this.ledger.requestCancel(id);
      return;
    }
    if (this.running.has(id)) return;
    const run = new Promise<void>((resolve) => {
      queueMicrotask(() => void this.run(id).then(resolve, resolve));
    });
    this.running.set(id, run);
  }

  private async run(id: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      for (;;) {
        const item = this.ledger.next(id);
        if (!item) break;
        try {
          const result = await this.upstream.request({
            path: "/capture",
            body: {
              user_content: item.payload.userContent,
              assistant_content: item.payload.assistantContent,
              session_key: item.payload.sessionKey,
              ...(item.payload.sessionId
                ? { session_id: item.payload.sessionId }
                : {}),
              messages: item.payload.messages,
            },
            requestId: `${id}:${item.itemIndex}`,
            timeoutMs: this.timeoutMs,
            signal: controller.signal,
          });
          if (result.status < 200 || result.status >= 300) {
            this.ledger.fail(item, "UPSTREAM_REJECTED");
          } else {
            this.ledger.complete(item);
          }
        } catch (error) {
          if (controller.signal.aborted) {
            this.ledger.cancel(item);
            break;
          }
          const code =
            error instanceof UpstreamGatewayError
              ? error.code
              : "UPSTREAM_UNAVAILABLE";
          this.ledger.fail(item, code);
        }
      }
    } finally {
      this.controllers.delete(id);
      this.running.delete(id);
    }
  }
}

export { ImportIdempotencyConflictError };
