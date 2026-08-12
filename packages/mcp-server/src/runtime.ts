import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import { createPersonalMemoryMcpServer } from "./server.js";
import type { PersonalMemoryMcpService } from "./service.js";

export interface PersonalMemoryMcpRuntime {
  closed: Promise<void>;
  close(): Promise<void>;
}

export async function startPersonalMemoryMcpStdio(input: {
  service: PersonalMemoryMcpService;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  maxBufferSize: number;
}): Promise<PersonalMemoryMcpRuntime> {
  await input.service.preflight();
  const server = createPersonalMemoryMcpServer(input.service);
  const transport = new StdioServerTransport(input.stdin, input.stdout, {
    maxBufferSize: input.maxBufferSize,
  });
  await server.connect(transport);
  let closePromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const detach = () => {
    input.stdin.off("end", onInputEnd);
    input.stdin.off("close", onInputEnd);
  };
  const close = async (): Promise<void> => {
    closePromise ??= Promise.resolve().then(async () => {
      detach();
      try {
        await server.close();
      } finally {
        resolveClosed();
      }
    });
    await closePromise;
  };
  const onInputEnd = () => void close();
  input.stdin.once("end", onInputEnd);
  input.stdin.once("close", onInputEnd);
  const onTransportClose = transport.onclose;
  transport.onclose = () => {
    onTransportClose?.();
    detach();
    void close();
  };
  input.stderr.write("PersonalMemory MCP Server ready on stdio\n");
  return { closed, close };
}
