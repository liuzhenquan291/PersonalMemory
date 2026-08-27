import {
  PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
  UNTRUSTED_HOOK_MEMORY_WARNING,
  type HOOK_CAPTURE_COMMITTED,
  type HookCaptureLedger,
  type HookCaptureRequest,
  type HookCaptureResponse,
  type HookRecallRequest,
  type HookRecallResponse,
  type MemoryReviewLedger,
} from "@personalmemory/core";
import type { RecallItem, RecallService } from "./recall-service.js";
import type { DatabaseSync } from "node:sqlite";

export interface HookAuthorizationState {
  installationId: string;
  authorizationRevision: number;
  policyRevision: number;
  recallEnabled: boolean;
  captureEnabled: boolean;
}

export interface HookLifecyclePolicy {
  authorization(): HookAuthorizationState;
  allowsSource(input: {
    operation: "recall" | "capture";
    client: HookRecallRequest["event"]["client"];
    workingDirectory: string;
  }): boolean;
  sensitiveCategory?(text: string): string | undefined;
}

export interface HookCaptureSink {
  capture(
    request: HookCaptureRequest,
    requestId: string,
    transaction: DatabaseSync,
  ): typeof HOOK_CAPTURE_COMMITTED;
}

export class HookLifecycleCaptureError extends Error {
  constructor(options?: ErrorOptions) {
    super("The local hook capture sink is unavailable", options);
    this.name = "HookLifecycleCaptureError";
  }
}

function tokenUnits(character: string): number {
  return character.codePointAt(0)! <= 0x7f ? 1 : 8;
}

function buildAdditionalContext(
  items: readonly RecallItem[],
  maxChars: number,
  maxTokens: number,
): { text: string; itemCount: number; estimatedTokens: number } {
  let text = "";
  let units = 0;
  let itemCount = 0;
  const maxUnits = maxTokens * 4;
  for (const item of items) {
    const prefix = text ? "\n\n" : "";
    let addition = "";
    for (const character of `${prefix}${item.content}`) {
      const nextUnits = tokenUnits(character);
      if (
        text.length + addition.length + character.length > maxChars ||
        units + nextUnits > maxUnits
      ) {
        break;
      }
      addition += character;
      units += nextUnits;
    }
    if (!addition || addition === prefix) break;
    text += addition;
    itemCount += 1;
    if (addition.length < prefix.length + item.content.length) break;
  }
  return { text, itemCount, estimatedTokens: Math.ceil(units / 4) };
}

export class HookLifecycleService {
  constructor(
    private readonly recallService: RecallService,
    private readonly reviews: MemoryReviewLedger,
    private readonly captures: HookCaptureLedger,
    private readonly policy: HookLifecyclePolicy,
    private readonly captureSink?: HookCaptureSink,
  ) {}

  async recall(
    request: HookRecallRequest,
    requestId: string,
  ): Promise<HookRecallResponse> {
    const denied = this.denialReason(request, "recall");
    if (denied) {
      return this.skippedRecall(
        denied === "capture_not_authorized" ? "recall_not_authorized" : denied,
      );
    }
    const result = await this.recallService.recall(
      {
        query: request.prompt,
        levels: ["L1"],
        offset: 0,
        budget: request.budget,
      },
      requestId,
    );
    if (result.items.length === 0) {
      const failure = result.degradedLevels[0]?.code;
      if (failure) {
        return {
          ...this.recallBase(),
          outcome: "degraded",
          reason: failure === "TIMEOUT" ? "timeout" : "gateway_unavailable",
          item_count: 0,
          used_chars: 0,
          estimated_tokens: 0,
        };
      }
      return this.skippedRecall("no_match");
    }
    const approvedItems = result.items.filter((item) =>
      this.reviews.isApproved("L1", item.id),
    );
    if (approvedItems.length === 0) return this.skippedRecall("no_match");
    const context = buildAdditionalContext(
      approvedItems,
      request.budget.max_chars,
      request.budget.max_tokens,
    );
    return {
      ...this.recallBase(),
      outcome: "recalled",
      additional_context: context.text,
      item_count: context.itemCount,
      used_chars: context.text.length,
      estimated_tokens: context.estimatedTokens,
    };
  }

  async capture(
    request: HookCaptureRequest,
    requestId: string,
  ): Promise<HookCaptureResponse> {
    const denied = this.denialReason(request, "capture");
    if (denied) {
      return {
        contract_version: PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
        outcome: "skipped",
        reason:
          denied === "recall_not_authorized"
            ? "capture_not_authorized"
            : denied,
        retryable: false,
      };
    }
    if (
      this.policy.sensitiveCategory?.(
        request.messages.map(({ content }) => content).join("\n"),
      )
    ) {
      return {
        contract_version: PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
        outcome: "skipped",
        reason: "sensitive_content_excluded",
        retryable: false,
      };
    }
    if (!this.captureSink) {
      throw new HookLifecycleCaptureError();
    }
    let result;
    try {
      result = this.captures.capture(request, (transaction) =>
        this.captureSink!.capture(request, requestId, transaction),
      );
    } catch (error) {
      throw new HookLifecycleCaptureError({ cause: error });
    }
    if (result === "duplicate") {
      return {
        contract_version: PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
        outcome: "duplicate",
        retryable: false,
      };
    }
    if (result === "conflict") {
      return {
        contract_version: PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
        outcome: "conflict",
        reason: "idempotency_conflict",
        retryable: false,
      };
    }
    return {
      contract_version: PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
      outcome: "captured",
      retryable: false,
    };
  }

  private denialReason(
    request: HookRecallRequest | HookCaptureRequest,
    operation: "recall" | "capture",
  ):
    | "recall_not_authorized"
    | "capture_not_authorized"
    | "stale_authorization"
    | "stale_policy"
    | "policy_excluded"
    | undefined {
    const current = this.policy.authorization();
    if (
      request.authorization.installation_id !== current.installationId ||
      request.authorization.authorization_revision !==
        current.authorizationRevision
    ) {
      return "stale_authorization";
    }
    if (request.authorization.policy_revision !== current.policyRevision) {
      return "stale_policy";
    }
    if (operation === "recall" && !current.recallEnabled) {
      return "recall_not_authorized";
    }
    if (operation === "capture" && !current.captureEnabled) {
      return "capture_not_authorized";
    }
    if (
      !this.policy.allowsSource({
        operation,
        client: request.event.client,
        workingDirectory: request.source.working_directory,
      })
    ) {
      return "policy_excluded";
    }
    return undefined;
  }

  private recallBase() {
    return {
      contract_version: PERSONAL_MEMORY_HOOK_CONTRACT_VERSION,
      data_classification: "untrusted_memory_data" as const,
      usage_warning: UNTRUSTED_HOOK_MEMORY_WARNING,
    };
  }

  private skippedRecall(
    reason:
      | "no_match"
      | "recall_not_authorized"
      | "policy_excluded"
      | "stale_authorization"
      | "stale_policy",
  ): HookRecallResponse {
    return {
      ...this.recallBase(),
      outcome: "skipped",
      reason,
      item_count: 0,
      used_chars: 0,
      estimated_tokens: 0,
    };
  }
}
