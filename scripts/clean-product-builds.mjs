import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.cwd());
const productBuildDirectories = [
  "apps/gateway/dist",
  "apps/web/dist",
  "packages/mcp-server/dist",
  "packages/personal-memory/dist",
];

for (const relative of productBuildDirectories) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep) || path.basename(target) !== "dist") {
    throw new Error(`Refusing to clean unexpected build path: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}

process.stdout.write("product build outputs: clean\n");
