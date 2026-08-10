import { PERSONAL_MEMORY_SCHEMA_VERSION } from "@personalmemory/core";

export { createGatewayApp } from "./app.js";
export { PersonalMemoryGatewayServer } from "./server.js";
export {
  FetchUpstreamGatewayClient,
  UpstreamGatewayError,
} from "./upstream-client.js";
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
