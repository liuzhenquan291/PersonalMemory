import { PERSONAL_MEMORY_SCHEMA_VERSION } from "@personalmemory/core";
export * from "./contract.js";
import { PERSONAL_MEMORY_MCP_CONTRACT_VERSION } from "./contract.js";

export const mcpServerIdentity = Object.freeze({
  name: "personalmemory-mcp-server",
  title: "PersonalMemory MCP Server",
  contractVersion: PERSONAL_MEMORY_MCP_CONTRACT_VERSION,
  schemaVersion: PERSONAL_MEMORY_SCHEMA_VERSION,
});
