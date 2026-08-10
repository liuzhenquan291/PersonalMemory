import type { PersonalMemoryConfig } from "@personalmemory/core";

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
  }): Promise<{ status: number; body: unknown }>;
}

export interface GatewayAppOptions {
  config: PersonalMemoryConfig;
  upstream: UpstreamGatewayClient;
  logger?: GatewayLogger;
  now?: () => number;
  randomId?: () => string;
}
