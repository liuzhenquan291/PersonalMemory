import {
  DeletedMemoryCannotBeRestoredError,
  MemoryStateConflictError,
  type MemoryState,
  type MemoryStateLedger,
  type MemoryStateLevel,
} from "@personalmemory/core";
import { z } from "zod";
import type { UpstreamGatewayClient } from "./types.js";

export const editableMemoryLevelSchema = z.enum(["L1", "L2", "L3"]);
export type EditableMemoryLevel = z.infer<typeof editableMemoryLevelSchema>;

export const memoryUpdateSchema = z
  .object({
    content: z.string().min(1).max(100_000),
    expected_revision: z.number().int().min(0),
  })
  .strict();

export const memoryInvalidateSchema = z
  .object({
    reason: z.string().min(1).max(500),
    expected_revision: z.number().int().min(0),
  })
  .strict();

export const memoryDeleteSchema = z
  .object({
    confirmation: z.string().max(2_048),
    reason: z.string().min(1).max(500),
    expected_revision: z.number().int().min(0),
  })
  .strict();

export class MemoryMutationError extends Error {
  constructor(
    readonly code:
      | "CONFLICT"
      | "INVALIDATED_MEMORY"
      | "DELETED_MEMORY"
      | "CONFIRMATION_MISMATCH"
      | "UPSTREAM_REJECTED",
  ) {
    super(code);
    this.name = "MemoryMutationError";
  }
}

function assertEnvelope(body: unknown): void {
  const parsed = z.object({ code: z.number() }).parse(body);
  if (parsed.code !== 0) throw new MemoryMutationError("UPSTREAM_REJECTED");
}

export class MemoryMutationService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly states: MemoryStateLedger,
    private readonly upstream: UpstreamGatewayClient,
    private readonly timeoutMs: number,
  ) {}

  async update(
    level: EditableMemoryLevel,
    memoryId: string,
    content: string,
    expectedRevision: number,
    requestId: string,
  ): Promise<MemoryState> {
    return await this.withLock(`${level}:${memoryId}`, async () => {
      this.assertRevision(level, memoryId, expectedRevision, false);
      const operation =
        level === "L1"
          ? { path: "/v2/atomic/update", body: { id: memoryId, content } }
          : level === "L2"
            ? {
                path: "/v2/scenario/write",
                body: { path: memoryId, content },
              }
            : { path: "/v2/core/write", body: { content } };
      assertEnvelope(
        await this.call(operation.path, operation.body, requestId),
      );
      return this.setState(level, memoryId, "active", expectedRevision);
    });
  }

  async invalidate(
    level: EditableMemoryLevel,
    memoryId: string,
    reason: string,
    expectedRevision: number,
  ): Promise<MemoryState> {
    return await this.withLock(`${level}:${memoryId}`, async () => {
      this.assertRevision(level, memoryId, expectedRevision);
      return this.setState(
        level,
        memoryId,
        "invalidated",
        expectedRevision,
        reason,
      );
    });
  }

  async deleteL1(
    memoryId: string,
    confirmation: string,
    reason: string,
    expectedRevision: number,
    requestId: string,
  ): Promise<{ state: MemoryState; upstreamDeleted: boolean }> {
    if (confirmation !== `DELETE L1:${memoryId}`) {
      throw new MemoryMutationError("CONFIRMATION_MISMATCH");
    }
    return await this.withLock(`L1:${memoryId}`, async () => {
      const current = this.states.get("L1", memoryId);
      if ((current?.revision ?? 0) !== expectedRevision) {
        throw new MemoryMutationError("CONFLICT");
      }
      const state =
        current?.status === "deleted"
          ? current
          : this.setState("L1", memoryId, "deleted", expectedRevision, reason);
      try {
        assertEnvelope(
          await this.call("/v2/atomic/delete", { ids: [memoryId] }, requestId),
        );
        return { state, upstreamDeleted: true };
      } catch {
        return { state, upstreamDeleted: false };
      }
    });
  }

  private assertRevision(
    level: MemoryStateLevel,
    memoryId: string,
    expectedRevision: number,
    allowInvalidated = true,
  ): void {
    const current = this.states.get(level, memoryId);
    if ((current?.revision ?? 0) !== expectedRevision) {
      throw new MemoryMutationError("CONFLICT");
    }
    if (current?.status === "deleted") {
      throw new MemoryMutationError("DELETED_MEMORY");
    }
    if (!allowInvalidated && current?.status === "invalidated") {
      throw new MemoryMutationError("INVALIDATED_MEMORY");
    }
  }

  private setState(
    level: MemoryStateLevel,
    memoryId: string,
    status: "active" | "invalidated" | "deleted",
    expectedRevision: number,
    reason?: string,
  ): MemoryState {
    try {
      return this.states.set(level, memoryId, status, expectedRevision, reason);
    } catch (error) {
      if (error instanceof MemoryStateConflictError) {
        throw new MemoryMutationError("CONFLICT");
      }
      if (error instanceof DeletedMemoryCannotBeRestoredError) {
        throw new MemoryMutationError("DELETED_MEMORY");
      }
      throw error;
    }
  }

  private async call(
    path: string,
    body: unknown,
    requestId: string,
  ): Promise<unknown> {
    const result = await this.upstream.request({
      path,
      body,
      requestId,
      timeoutMs: this.timeoutMs,
    });
    if (result.status < 200 || result.status >= 300) {
      throw new MemoryMutationError("UPSTREAM_REJECTED");
    }
    return result.body;
  }

  private async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}
