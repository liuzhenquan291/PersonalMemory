import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const gatewayPort = process.env.PERSONALMEMORY_DEV_GATEWAY_PORT ?? "8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${gatewayPort}`,
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
