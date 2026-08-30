import {
  HookCaptureLedger,
  HOOK_CAPTURE_COMMITTED,
  MemoryGovernanceLedger,
  MemoryReviewLedger,
  MemoryStateLedger,
  PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
  defaultMigrations,
  migrateDatabase,
  type HookCaptureRequest,
  type HookRecallRequest,
} from "@personalmemory/core";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  HookLifecycleCaptureError,
  HookLifecycleService,
  RecallService,
  type HookLifecyclePolicy,
  type HookCaptureCommittedObserver,
} from "../src/index.js";
import type { UpstreamGatewayClient } from "../src/types.js";

const authorization = {
  installation_id: "installation-1",
  authorization_revision: 2,
  policy_revision: 3,
};
const event = {
  client: "codex" as const,
  session_id: "session-1",
  turn_id: "turn-1",
  subagent: false as const,
};
const source = {
  kind: "agent_lifecycle" as const,
  working_directory: "/project",
};
const recallRequest: HookRecallRequest = {
  contract_version: PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
  event,
  authorization,
  source,
  prompt: "local memory",
  budget: {
    max_items: 5,
    max_chars: 4_000,
    max_tokens: 1_000,
    timeout_ms: 1_000,
  },
};
const captureRequest: HookCaptureRequest = {
  contract_version: PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
  event,
  authorization,
  source,
  idempotency_key: `hook:v1:${"b".repeat(64)}`,
  messages: [
    { role: "user", content: "Remember local-first" },
    { role: "assistant", content: "Saved locally." },
  ],
};

function createService(options: {
  recallEnabled?: boolean;
  captureEnabled?: boolean;
  allowsSource?: boolean;
  capture?: () => void;
  sensitiveCategory?: string;
  observer?: HookCaptureCommittedObserver;
}) {
  const database = new DatabaseSync(":memory:");
  migrateDatabase(database, defaultMigrations);
  const reviews = new MemoryReviewLedger(database);
  reviews.set("L1", "approved", "approved", 0);
  const states = new MemoryStateLedger(database);
  const governance = new MemoryGovernanceLedger(database);
  const upstream: UpstreamGatewayClient = {
    request: vi.fn(async ({ path }) => {
      expect(path).toBe("/v2/atomic/search");
      return {
        status: 200,
        body: {
          code: 0,
          data: {
            items: [
              { id: "pending", content: "pending", score: 1 },
              { id: "approved", content: "approved memory", score: 0.9 },
            ],
          },
        },
      };
    }),
  };
  const policy: HookLifecyclePolicy = {
    authorization: () => ({
      installationId: "installation-1",
      authorizationRevision: 2,
      policyRevision: 3,
      recallEnabled: options.recallEnabled ?? true,
      captureEnabled: options.captureEnabled ?? true,
    }),
    allowsSource: () => options.allowsSource ?? true,
    sensitiveCategory: () => options.sensitiveCategory,
  };
  return {
    database,
    states,
    governance,
    service: new HookLifecycleService(
      new RecallService(upstream, 1_000, states, reviews, governance),
      reviews,
      new HookCaptureLedger(database),
      policy,
      options.capture ? { capture: options.capture } : undefined,
      options.observer,
    ),
  };
}

describe("HookLifecycleService", () => {
  it("recalls only approved L1 through the bounded untrusted response", async () => {
    const { database, service } = createService({});
    await expect(
      service.recall(recallRequest, "request-1"),
    ).resolves.toMatchObject({
      outcome: "recalled",
      additional_context: "approved memory",
      item_count: 1,
      used_chars: 15,
    });
    database.close();
  });

  it("enforces server authorization revisions and source policy", async () => {
    const disabled = createService({ recallEnabled: false });
    await expect(
      disabled.service.recall(recallRequest, "request-1"),
    ).resolves.toMatchObject({
      outcome: "skipped",
      reason: "recall_not_authorized",
    });
    disabled.database.close();

    const excluded = createService({ allowsSource: false });
    await expect(
      excluded.service.capture(captureRequest, "request-1"),
    ).resolves.toMatchObject({ outcome: "skipped", reason: "policy_excluded" });
    excluded.database.close();
  });

  it("excludes sensitive capture before the sink or idempotency ledger", async () => {
    const capture = vi.fn();
    const blocked = createService({
      capture,
      sensitiveCategory: "credentials",
    });
    await expect(
      blocked.service.capture(captureRequest, "request-1"),
    ).resolves.toMatchObject({
      outcome: "skipped",
      reason: "sensitive_content_excluded",
      retryable: false,
    });
    expect(capture).not.toHaveBeenCalled();
    expect(
      blocked.database
        .prepare("SELECT COUNT(*) AS count FROM personalmemory_hook_captures")
        .get(),
    ).toEqual({ count: 0 });
    blocked.database.close();
  });

  it("never recalls an approved memory suppressed by product governance", async () => {
    const { database, service, states } = createService({});
    states.set("L1", "approved", "invalidated", 0, "obsolete");
    await expect(
      service.recall(recallRequest, "request-1"),
    ).resolves.toMatchObject({
      outcome: "skipped",
      reason: "no_match",
    });
    database.close();
  });

  it("persists capture idempotency and detects payload conflicts", async () => {
    const capture = vi.fn(() => HOOK_CAPTURE_COMMITTED);
    const { database, service } = createService({ capture });
    await expect(
      service.capture(captureRequest, "request-1"),
    ).resolves.toMatchObject({
      outcome: "captured",
    });
    await expect(
      service.capture(captureRequest, "request-2"),
    ).resolves.toMatchObject({
      outcome: "duplicate",
    });
    await expect(
      service.capture(
        {
          ...captureRequest,
          messages: [
            captureRequest.messages[0],
            { role: "assistant", content: "different" },
          ],
        },
        "request-3",
      ),
    ).resolves.toMatchObject({ outcome: "conflict" });
    expect(capture).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("does not claim success when the local capture sink fails", async () => {
    const { database, service } = createService({
      capture: () => {
        throw new Error("local failure");
      },
    });
    await expect(
      service.capture(captureRequest, "request-1"),
    ).rejects.toBeInstanceOf(HookLifecycleCaptureError);
    database.close();
  });

  it("notifies extraction only after a new L0 capture commits", async () => {
    const notify = vi.fn(async () => undefined);
    const { database, service } = createService({
      capture: () => HOOK_CAPTURE_COMMITTED,
      observer: { notify },
    });
    await expect(
      service.capture(captureRequest, "request-1"),
    ).resolves.toMatchObject({
      outcome: "captured",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledOnce();

    await service.capture(captureRequest, "request-2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledOnce();
    database.close();
  });

  it("treats an enabled but missing local sink as unavailable", async () => {
    const { database, service } = createService({});
    await expect(
      service.capture(captureRequest, "request-1"),
    ).rejects.toBeInstanceOf(HookLifecycleCaptureError);
    database.close();
  });
});
