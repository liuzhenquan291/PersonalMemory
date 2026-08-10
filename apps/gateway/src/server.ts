import { serve } from "@hono/node-server";
import type { PersonalMemoryConfig } from "@personalmemory/core";
import type { Hono } from "hono";
import type { Server } from "node:http";
import type { GatewayEnv } from "./app.js";

export class PersonalMemoryGatewayServer {
  #server: Server | undefined;
  #state: "idle" | "starting" | "running" | "stopping" = "idle";
  #startPromise: Promise<{ host: string; port: number }> | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor(
    private readonly app: Hono<GatewayEnv>,
    private readonly config: PersonalMemoryConfig,
  ) {}

  async start(): Promise<{ host: string; port: number }> {
    if (this.#state !== "idle")
      throw new Error("PersonalMemory Gateway is already running");
    this.#state = "starting";
    const startPromise = new Promise<{ host: string; port: number }>(
      (resolve, reject) => {
        const server = serve({
          fetch: this.app.fetch,
          hostname: this.config.server.host,
          port: this.config.server.port,
        }) as Server;
        this.#server = server;
        const onError = (error: Error) => {
          server.off("listening", onListening);
          this.#server = undefined;
          this.#state = "idle";
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            this.#server = undefined;
            this.#state = "idle";
            reject(new Error("Gateway did not bind to a TCP address"));
            return;
          }
          this.#state = "running";
          resolve({ host: address.address, port: address.port });
        };
        server.once("error", onError);
        server.once("listening", onListening);
      },
    );
    this.#startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.#startPromise === startPromise) this.#startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "idle") return;
    if (this.#state === "stopping") return await this.#stopPromise;
    if (this.#state === "starting") {
      try {
        await this.#startPromise;
      } catch {
        return;
      }
      return await this.stop();
    }
    const server = this.#server;
    if (!server) {
      this.#state = "idle";
      return;
    }
    this.#state = "stopping";
    const stopPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, 2_000);
      server.close((error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      });
      server.closeIdleConnections?.();
    });
    this.#stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      this.#server = undefined;
      this.#stopPromise = undefined;
      this.#state = "idle";
    }
  }
}
