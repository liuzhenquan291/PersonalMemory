import { loadConfig } from "@personalmemory/core";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { PersonalMemoryGatewayServer } from "../src/server.js";

describe("PersonalMemoryGatewayServer", () => {
  it("starts on an ephemeral loopback port and shuts down idempotently", async () => {
    const { config } = loadConfig({ environment: {} });
    const testConfig = {
      ...config,
      server: { ...config.server, port: 0 },
    };
    const app = createGatewayApp({
      config: testConfig,
      upstream: {
        async request() {
          return { status: 200, body: {} };
        },
      },
      logger: { info() {}, error() {} },
    });
    const server = new PersonalMemoryGatewayServer(app, testConfig);
    const address = await server.start();
    expect(address.port).toBeGreaterThan(0);
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(health.status).toBe(200);
    await server.stop();
    await server.stop();
    await expect(
      fetch(`http://127.0.0.1:${address.port}/health`),
    ).rejects.toThrow();
  });

  it("reports an occupied port and can retry after it is released", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", resolve),
    );
    const address = blocker.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");
    const { config } = loadConfig({ environment: {} });
    const testConfig = {
      ...config,
      server: { ...config.server, port: address.port },
    };
    const app = createGatewayApp({
      config: testConfig,
      upstream: {
        async request() {
          return { status: 200, body: {} };
        },
      },
      logger: { info() {}, error() {} },
    });
    const gateway = new PersonalMemoryGatewayServer(app, testConfig);
    await expect(gateway.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    await new Promise<void>((resolve, reject) =>
      blocker.close((error) => (error ? reject(error) : resolve())),
    );
    await expect(gateway.start()).resolves.toMatchObject({
      port: address.port,
    });
    await gateway.stop();
  });

  it("settles an immediate stop during start and can restart", async () => {
    const { config } = loadConfig({ environment: {} });
    const testConfig = {
      ...config,
      server: { ...config.server, port: 0 },
    };
    const app = createGatewayApp({
      config: testConfig,
      upstream: {
        async request() {
          return { status: 200, body: {} };
        },
      },
      logger: { info() {}, error() {} },
    });
    const gateway = new PersonalMemoryGatewayServer(app, testConfig);
    const start = gateway.start();
    const firstStop = gateway.stop();
    const secondStop = gateway.stop();
    await expect(
      Promise.race([
        Promise.all([start, firstStop, secondStop]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("lifecycle timed out")), 2_000),
        ),
      ]),
    ).resolves.toBeDefined();

    const restarted = await gateway.start();
    expect(restarted.port).toBeGreaterThan(0);
    await gateway.stop();
  });
});
