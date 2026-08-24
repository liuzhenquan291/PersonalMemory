import type {
  AuditLedger,
  HookCaptureLedger,
  MemoryGovernanceLedger,
  ModelAuthorizationLedger,
  MemoryReviewLedger,
  MemoryStateLedger,
  PersonalMemoryConfig,
} from "@personalmemory/core";
import type { ConversationImportManager } from "./import-manager.js";
import type { PrivacyDeletionService } from "./privacy-deletions.js";
import type { HookCaptureSink, HookLifecyclePolicy } from "./hook-lifecycle.js";

export interface GatewayErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export interface GatewayLogger {
  info(event: GatewayLogEvent): void;
  error(event: GatewayLogEvent): void;
}

export interface GatewayLogEvent {
  event: "request.completed" | "request.failed" | "hook.lifecycle";
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  code?: string;
  operation?: "recall" | "capture";
  client?: "codex" | "claude-code";
  outcome?: string;
  itemCount?: number;
  usedChars?: number;
  estimatedTokens?: number;
  idempotencyRef?: string;
}

export interface UpstreamGatewayClient {
  request(input: {
    path: string;
    body: unknown;
    requestId: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: unknown }>;
}

export interface GatewayAppOptions {
  config: PersonalMemoryConfig;
  upstream: UpstreamGatewayClient;
  importManager?: ConversationImportManager;
  memoryStates?: MemoryStateLedger;
  memoryReviews?: MemoryReviewLedger;
  memoryGovernance?: MemoryGovernanceLedger;
  privacyDeletions?: PrivacyDeletionService;
  audit?: AuditLedger;
  hookCaptures?: HookCaptureLedger;
  modelAuthorizations?: ModelAuthorizationLedger;
  hookPolicy?: HookLifecyclePolicy;
  hookCaptureSink?: HookCaptureSink;
  logger?: GatewayLogger;
  now?: () => number;
  randomId?: () => string;
}
