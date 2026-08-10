import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:4173",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node tests/e2e/gateway-stub.mjs",
      url: "http://127.0.0.1:8787/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev",
      url: "http://127.0.0.1:4173/memories",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
