import {
  McpServer,
  type CallToolResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  PERSONAL_MEMORY_MCP_CONTRACT_VERSION,
  captureExchangeInputSchema,
  captureExchangeOutputSchema,
  mcpToolErrorSchema,
  personalMemoryMcpTools,
  prepareForgetInputSchema,
  prepareForgetOutputSchema,
  readMemoryInputSchema,
  readMemoryOutputSchema,
  searchMemoriesInputSchema,
  searchMemoriesOutputSchema,
  submitFeedbackInputSchema,
  submitFeedbackOutputSchema,
  type McpToolError,
} from "./contract.js";
import { GatewayClientError } from "./gateway-client.js";
import type { PersonalMemoryMcpService } from "./service.js";

export const MAX_CONCURRENT_TOOLS = 8;

function contract(name: string) {
  const value = personalMemoryMcpTools.find((tool) => tool.name === name);
  if (!value) throw new Error(`Missing MCP contract for ${name}`);
  return value;
}

function toolSuccess(output: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function errorDefinition(error: unknown): McpToolError["error"] {
  const code =
    error instanceof GatewayClientError ? error.code : "INTERNAL_ERROR";
  const definitions: Record<string, McpToolError["error"]> = {
    INVALID_ARGUMENT: {
      code: "INVALID_ARGUMENT",
      message: "The tool arguments or cursor are invalid.",
      retryable: false,
      user_action: "Correct the arguments or start a new search.",
    },
    INVALID_REQUEST: {
      code: "INVALID_ARGUMENT",
      message: "The tool arguments are invalid.",
      retryable: false,
      user_action: "Correct the arguments and retry.",
    },
    UNAUTHORIZED: {
      code: "UNAUTHORIZED",
      message: "PersonalMemory Gateway authentication failed.",
      retryable: false,
      user_action:
        "Configure the same Gateway bearer token for the MCP process.",
    },
    AUTH_SETUP_REQUIRED: {
      code: "UNAUTHORIZED",
      message: "PersonalMemory Gateway authentication is not configured.",
      retryable: false,
      user_action: "Enable Gateway authentication before using MCP.",
    },
    RATE_LIMITED: {
      code: "RATE_LIMITED",
      message: "PersonalMemory is handling too many requests.",
      retryable: true,
      user_action: "Wait briefly and retry once.",
    },
    DELETION_PLAN_LIMIT: {
      code: "RATE_LIMITED",
      message: "Too many deletion previews are active.",
      retryable: true,
      user_action: "Finish or let an existing preview expire before retrying.",
    },
    DELETION_HANDOFF_LIMIT: {
      code: "RATE_LIMITED",
      message: "Too many deletion handoffs are active.",
      retryable: true,
      user_action: "Finish or let an existing handoff expire before retrying.",
    },
    MEMORY_NOT_FOUND: {
      code: "MEMORY_NOT_FOUND",
      message: "The requested memory was not found.",
      retryable: false,
      user_action: "Search again and select an existing memory ID.",
    },
    MEMORY_CONFLICT: {
      code: "MEMORY_CONFLICT",
      message: "The memory changed after it was read.",
      retryable: true,
      user_action: "Read the memory again, then repeat the user's decision.",
    },
    MODEL_OUTBOUND_CONSENT_REQUIRED: {
      code: "MODEL_OUTBOUND_CONSENT_REQUIRED",
      message: "Capture requires model-outbound consent in PersonalMemory Web.",
      retryable: false,
      user_action: "Review the provider disclosure in Web before capturing.",
    },
    DELETION_HANDOFF_EXPIRED: {
      code: "DELETION_HANDOFF_EXPIRED",
      message: "The deletion handoff expired.",
      retryable: true,
      user_action: "Prepare a new forget handoff.",
    },
    TIMEOUT: {
      code: "TIMEOUT",
      message: "The PersonalMemory operation timed out.",
      retryable: true,
      user_action: "Retry with a smaller page or budget.",
    },
    UPSTREAM_UNAVAILABLE: {
      code: "UPSTREAM_UNAVAILABLE",
      message:
        "PersonalMemory Gateway or the local memory kernel is unavailable.",
      retryable: true,
      user_action: "Check that PersonalMemory is running, then retry.",
    },
    INVALID_UPSTREAM_RESPONSE: {
      code: "UPSTREAM_UNAVAILABLE",
      message: "PersonalMemory Gateway returned an incompatible response.",
      retryable: false,
      user_action: "Restart compatible PersonalMemory components.",
    },
  };
  return (
    definitions[code] ?? {
      code: "INTERNAL_ERROR",
      message: "PersonalMemory could not complete the operation.",
      retryable: false,
      user_action:
        "Check the local diagnostic log without sharing memory content.",
    }
  );
}

function toolFailure(error: unknown): CallToolResult {
  const output = mcpToolErrorSchema.parse({
    contract_version: PERSONAL_MEMORY_MCP_CONTRACT_VERSION,
    error: errorDefinition(error),
  });
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

class ConcurrencyGate {
  #active = 0;

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= MAX_CONCURRENT_TOOLS) {
      throw new GatewayClientError(
        429,
        "RATE_LIMITED",
        "MCP concurrency limit reached",
      );
    }
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
    }
  }
}

export function createPersonalMemoryMcpServer(
  service: PersonalMemoryMcpService,
): McpServer {
  const server = new McpServer({
    name: "personalmemory-mcp-server",
    version: PERSONAL_MEMORY_MCP_CONTRACT_VERSION,
  });
  const gate = new ConcurrencyGate();
  const execute = async <T extends Record<string, unknown>>(
    context: ServerContext,
    operation: () => Promise<T>,
  ): Promise<CallToolResult> => {
    try {
      return toolSuccess(await gate.run(operation));
    } catch (error) {
      if (context.mcpReq.signal.aborted) {
        return toolFailure(
          new GatewayClientError(408, "TIMEOUT", "Request cancelled"),
        );
      }
      return toolFailure(error);
    }
  };

  const search = contract("personalmemory_search");
  server.registerTool(
    search.name,
    {
      title: search.title,
      description: search.description,
      inputSchema: searchMemoriesInputSchema,
      outputSchema: searchMemoriesOutputSchema,
      annotations: search.annotations,
    },
    async (input, context) =>
      await execute(
        context,
        async () => await service.search(input, context.mcpReq.signal),
      ),
  );

  const read = contract("personalmemory_read");
  server.registerTool(
    read.name,
    {
      title: read.title,
      description: read.description,
      inputSchema: readMemoryInputSchema,
      outputSchema: readMemoryOutputSchema,
      annotations: read.annotations,
    },
    async (input, context) =>
      await execute(
        context,
        async () => await service.read(input, context.mcpReq.signal),
      ),
  );

  const capture = contract("personalmemory_capture");
  server.registerTool(
    capture.name,
    {
      title: capture.title,
      description: capture.description,
      inputSchema: captureExchangeInputSchema,
      outputSchema: captureExchangeOutputSchema,
      annotations: capture.annotations,
    },
    async (input, context) =>
      await execute(
        context,
        async () => await service.capture(input, context.mcpReq.signal),
      ),
  );

  const feedback = contract("personalmemory_feedback");
  server.registerTool(
    feedback.name,
    {
      title: feedback.title,
      description: feedback.description,
      inputSchema: submitFeedbackInputSchema,
      outputSchema: submitFeedbackOutputSchema,
      annotations: feedback.annotations,
    },
    async (input, context) =>
      await execute(
        context,
        async () => await service.feedback(input, context.mcpReq.signal),
      ),
  );

  const forget = contract("personalmemory_prepare_forget");
  server.registerTool(
    forget.name,
    {
      title: forget.title,
      description: forget.description,
      inputSchema: prepareForgetInputSchema,
      outputSchema: prepareForgetOutputSchema,
      annotations: forget.annotations,
    },
    async (input, context) =>
      await execute(
        context,
        async () => await service.prepareForget(input, context.mcpReq.signal),
      ),
  );
  return server;
}
