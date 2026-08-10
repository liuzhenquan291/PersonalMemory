import type { PersonalMemoryConfig } from "@personalmemory/core";
import type { ConversationImportManager } from "./import-manager.js";

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
  event: "request.completed" | "request.failed";
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  code?: string;
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
  logger?: GatewayLogger;
  now?: () => number;
  randomId?: () => string;
}
