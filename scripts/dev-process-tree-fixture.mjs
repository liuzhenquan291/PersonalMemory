import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import process from "node:process";

const pidFile = process.argv[2];
if (!pidFile) throw new Error("pid file is required");

const grandchild = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
  { stdio: "ignore" },
);
if (!grandchild.pid) throw new Error("grandchild did not start");
grandchild.unref();
await writeFile(pidFile, String(grandchild.pid), "utf8");
