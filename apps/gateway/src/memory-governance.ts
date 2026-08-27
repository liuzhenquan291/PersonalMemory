import {
  MemoryGovernanceConflictError,
  MemoryGovernanceCycleError,
  type GovernedMemoryLevel,
  type MemoryGovernanceLedger,
  type MemoryRelation,
  type MemoryValidity,
} from "@personalmemory/core";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { UpstreamGatewayClient } from "./types.js";

const optionalDateTime = z.string().datetime({ offset: true }).nullable();

export const memoryValiditySchema = z
  .object({
    valid_from: optionalDateTime,
    expires_at: optionalDateTime,
    expected_revision: z.number().int().min(0),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.valid_from &&
      input.expires_at &&
      input.valid_from >= input.expires_at
    ) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "expires_at must be later than valid_from",
      });
    }
  });

export const memoryRelationSchema = z
  .object({
    level: z.enum(["L1", "L2", "L3"]),
    kind: z.enum(["conflicts_with", "supersedes"]),
    source_id: z.string().min(1).max(2_048),
    target_id: z.string().min(1).max(2_048),
    reason: z.string().min(1).max(500),
    merged_content: z.string().min(1).max(100_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.source_id === input.target_id) {
      context.addIssue({
        code: "custom",
        path: ["target_id"],
        message: "A memory cannot relate to itself",
      });
    }
    if (input.kind === "conflicts_with" && input.merged_content) {
      context.addIssue({
        code: "custom",
        path: ["merged_content"],
        message: "Conflict markers cannot update content",
      });
    }
    if (input.level !== "L1" && input.merged_content) {
      context.addIssue({
        code: "custom",
        path: ["merged_content"],
        message: "Merged content is currently supported only for L1",
      });
    }
  });

export const relationRevokeSchema = z
  .object({ expected_revision: z.number().int().min(1) })
  .strict();

export class MemoryGovernanceServiceError extends Error {
  constructor(readonly code: "CONFLICT" | "CYCLE" | "UPSTREAM_REJECTED") {
    super(code);
    this.name = "MemoryGovernanceServiceError";
  }
}

export class MemoryGovernanceService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly governance: MemoryGovernanceLedger,
    private readonly upstream: UpstreamGatewayClient,
    private readonly timeoutMs: number,
    private readonly randomId: () => string,
  ) {}

  get(
    level: GovernedMemoryLevel,
    memoryId: string,
  ): {
    validity: MemoryValidity;
    relations: MemoryRelation[];
    recallable: boolean;
  } {
    return {
      validity: this.governance.getValidity(level, memoryId),
      relations: this.governance.listRelations(level, memoryId),
      recallable: this.governance.isRecallable(level, memoryId),
    };
  }

  setValidity(
    level: GovernedMemoryLevel,
    memoryId: string,
    input: z.infer<typeof memoryValiditySchema>,
  ): MemoryValidity {
    try {
      return this.governance.setValidity(
        level,
        memoryId,
        input.valid_from ?? undefined,
        input.expires_at ?? undefined,
        input.expected_revision,
      );
    } catch (error) {
      if (error instanceof MemoryGovernanceConflictError) {
        throw new MemoryGovernanceServiceError("CONFLICT");
      }
      throw error;
    }
  }

  async addRelation(
    input: z.infer<typeof memoryRelationSchema>,
    requestId: string,
  ): Promise<MemoryRelation> {
    return await this.withLock(`relations:${input.level}`, async () => {
      const relationInput = {
        id: this.randomId(),
        level: input.level,
        kind: input.kind,
        sourceMemoryId: input.source_id,
        targetMemoryId: input.target_id,
        reason: input.reason,
        ...(input.merged_content
          ? {
              mergedContentHash: createHash("sha256")
                .update(input.merged_content)
                .digest("hex"),
            }
          : {}),
      };
      try {
        const existing = this.governance.validateRelation(relationInput);
        if (existing) return existing;
      } catch (error) {
        if (error instanceof MemoryGovernanceCycleError) {
          throw new MemoryGovernanceServiceError("CYCLE");
        }
        if (error instanceof MemoryGovernanceConflictError) {
          throw new MemoryGovernanceServiceError("CONFLICT");
        }
        throw error;
      }
      if (input.kind === "supersedes" && input.merged_content) {
        const result = await this.upstream
          .request({
            path: "/v2/atomic/update",
            body: { id: input.source_id, content: input.merged_content },
            requestId,
            timeoutMs: this.timeoutMs,
          })
          .catch(() => undefined);
        const envelope = z.object({ code: z.number() }).safeParse(result?.body);
        if (
          !result ||
          result.status < 200 ||
          result.status >= 300 ||
          !envelope.success ||
          envelope.data.code !== 0
        ) {
          throw new MemoryGovernanceServiceError("UPSTREAM_REJECTED");
        }
      }
      try {
        return this.governance.addRelation(relationInput);
      } catch (error) {
        if (error instanceof MemoryGovernanceCycleError) {
          throw new MemoryGovernanceServiceError("CYCLE");
        }
        if (error instanceof MemoryGovernanceConflictError) {
          throw new MemoryGovernanceServiceError("CONFLICT");
        }
        throw error;
      }
    });
  }

  revoke(id: string, expectedRevision: number): MemoryRelation {
    try {
      return this.governance.revokeRelation(id, expectedRevision);
    } catch (error) {
      if (error instanceof MemoryGovernanceConflictError) {
        throw new MemoryGovernanceServiceError("CONFLICT");
      }
      throw error;
    }
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
