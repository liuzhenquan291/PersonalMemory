import { PERSONAL_MEMORY_SCHEMA_VERSION } from "@personalmemory/core";

export { createGatewayApp } from "./app.js";
export type { RetentionDeletionResult } from "./privacy-deletions.js";
export {
  PrivacyDeletionError,
  PrivacyDeletionService,
  privacyDeletionExecuteSchema,
  privacyDeletionPreviewSchema,
  type PrivacyDeletionPreview,
  type PrivacyDeletionResult,
  type PrivacyDeletionStep,
} from "./privacy-deletions.js";
export { PersonalMemoryGatewayServer } from "./server.js";
export {
  FetchUpstreamGatewayClient,
  UpstreamGatewayError,
} from "./upstream-client.js";
export { ConversationImportManager } from "./import-manager.js";
export {
  MemoryMutationError,
  MemoryMutationService,
  editableMemoryLevelSchema,
  memoryDeleteSchema,
  memoryInvalidateSchema,
  memoryUpdateSchema,
  type EditableMemoryLevel,
} from "./memory-mutations.js";
export {
  MemoryReviewService,
  memoryReviewBatchSchema,
  type MemoryReviewResult,
} from "./memory-reviews.js";
export {
  MemoryGovernanceService,
  MemoryGovernanceServiceError,
  memoryRelationSchema,
  memoryValiditySchema,
  relationRevokeSchema,
} from "./memory-governance.js";
export {
  MemoryBrowser,
  memoryBrowseQuerySchema,
  memoryLayerSchema,
  type BrowsedMemory,
  type MemoryBrowseResult,
  type MemoryLayer,
} from "./memory-browser.js";
export {
  RecallService,
  recallLevelSchema,
  unifiedRecallRequestSchema,
  type RecallItem,
  type RecallLevel,
  type UnifiedRecallResult,
} from "./recall-service.js";
export {
  HookLifecycleCaptureError,
  HookLifecycleService,
  type HookAuthorizationState,
  type HookCaptureSink,
  type HookLifecyclePolicy,
} from "./hook-lifecycle.js";
export {
  createLocalL0HookCaptureSink,
  createProductionHookCapture,
  initializeLocalL0HookCaptureDatabase,
} from "./local-l0-hook-capture.js";
export type {
  UpstreamTransport,
  UpstreamTransportResponse,
} from "./upstream-client.js";
export type {
  GatewayAppOptions,
  GatewayErrorEnvelope,
  GatewayLogEvent,
  GatewayLogger,
  UpstreamGatewayClient,
} from "./types.js";

export const gatewayIdentity = Object.freeze({
  name: "PersonalMemory Gateway",
  schemaVersion: PERSONAL_MEMORY_SCHEMA_VERSION,
});
