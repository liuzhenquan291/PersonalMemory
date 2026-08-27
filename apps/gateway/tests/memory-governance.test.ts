import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryGovernanceLedger,
  defaultMigrations,
  migrateDatabase,
} from "@personalmemory/core";
import {
  MemoryGovernanceService,
  memoryRelationSchema,
  memoryValiditySchema,
} from "../src/memory-governance.js";
import type { MemoryGovernanceServiceError } from "../src/memory-governance.js";

function harness() {
  const database = new DatabaseSync(":memory:");
  migrateDatabase(database, defaultMigrations);
  const ledger = new MemoryGovernanceLedger(
    database,
    () => "2026-08-12T00:00:00.000Z",
  );
  const upstream = {
    request: vi.fn(async () => ({ status: 200, body: { code: 0 } })),
  };
  let sequence = 0;
  return {
    database,
    ledger,
    upstream,
    service: new MemoryGovernanceService(
      ledger,
      upstream,
      1_000,
      () => `relation-${++sequence}`,
    ),
  };
}

describe("MemoryGovernanceService", () => {
  it("never converts similarity into a conflict without an explicit action", () => {
    const { database, service } = harness();
    try {
      expect(service.get("L1", "one")).toMatchObject({
        recallable: true,
        relations: [],
      });
    } finally {
      database.close();
    }
  });

  it("pauses both memories after the user confirms a conflict", async () => {
    const { database, service } = harness();
    try {
      const relation = await service.addRelation(
        memoryRelationSchema.parse({
          level: "L1",
          kind: "conflicts_with",
          source_id: "one",
          target_id: "two",
          reason: "用户确认内容互相矛盾",
        }),
        "request-1",
      );
      expect(relation).toMatchObject({ kind: "conflicts_with" });
      expect(service.get("L1", "one").recallable).toBe(false);
      expect(service.get("L1", "two").recallable).toBe(false);
    } finally {
      database.close();
    }
  });

  it("updates merged content before creating a reversible supersedes relation", async () => {
    const { database, service, upstream } = harness();
    try {
      const relation = await service.addRelation(
        memoryRelationSchema.parse({
          level: "L1",
          kind: "supersedes",
          source_id: "canonical",
          target_id: "old",
          reason: "用户人工合并",
          merged_content: "合并后的准确事实",
        }),
        "request-1",
      );
      expect(upstream.request).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { id: "canonical", content: "合并后的准确事实" },
        }),
      );
      expect(service.get("L1", "old").recallable).toBe(false);
      await expect(
        service.addRelation(
          memoryRelationSchema.parse({
            level: "L1",
            kind: "supersedes",
            source_id: "canonical",
            target_id: "old",
            reason: "用户人工合并",
            merged_content: "合并后的准确事实",
          }),
          "request-retry",
        ),
      ).resolves.toMatchObject({ id: relation.id });
      await expect(
        service.addRelation(
          memoryRelationSchema.parse({
            level: "L1",
            kind: "supersedes",
            source_id: "canonical",
            target_id: "old",
            reason: "用户人工合并",
            merged_content: "不同的合并事实",
          }),
          "request-conflict",
        ),
      ).rejects.toMatchObject<MemoryGovernanceServiceError>({
        code: "CONFLICT",
      });
      expect(upstream.request).toHaveBeenCalledTimes(1);
      expect(service.revoke(relation.id, 1)).toMatchObject({
        status: "revoked",
      });
      expect(service.get("L1", "old").recallable).toBe(true);
    } finally {
      database.close();
    }
  });

  it("does not create a relation when merged content is rejected", async () => {
    const { database, service, upstream } = harness();
    try {
      upstream.request.mockResolvedValueOnce({ status: 503, body: {} });
      await expect(
        service.addRelation(
          memoryRelationSchema.parse({
            level: "L1",
            kind: "supersedes",
            source_id: "canonical",
            target_id: "old",
            reason: "merge",
            merged_content: "content",
          }),
          "request-1",
        ),
      ).rejects.toMatchObject<MemoryGovernanceServiceError>({
        code: "UPSTREAM_REJECTED",
      });
      expect(service.get("L1", "old").relations).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects a cyclic merge before changing upstream content", async () => {
    const { database, service, upstream } = harness();
    try {
      await service.addRelation(
        memoryRelationSchema.parse({
          level: "L1",
          kind: "supersedes",
          source_id: "one",
          target_id: "two",
          reason: "first",
        }),
        "request-1",
      );
      await expect(
        service.addRelation(
          memoryRelationSchema.parse({
            level: "L1",
            kind: "supersedes",
            source_id: "two",
            target_id: "one",
            reason: "cycle",
            merged_content: "must not be written",
          }),
          "request-2",
        ),
      ).rejects.toMatchObject<MemoryGovernanceServiceError>({ code: "CYCLE" });
      expect(upstream.request).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("validates and stores an explicit expiry window", () => {
    const { database, service } = harness();
    try {
      const validity = service.setValidity(
        "L1",
        "seasonal",
        memoryValiditySchema.parse({
          valid_from: null,
          expires_at: "2026-09-01T00:00:00.000Z",
          expected_revision: 0,
        }),
      );
      expect(validity).toMatchObject({
        expiresAt: "2026-09-01T00:00:00.000Z",
        revision: 1,
      });
    } finally {
      database.close();
    }
  });
});
