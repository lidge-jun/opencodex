import { spawn } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, stage, receipt] = process.argv.slice(2);
if (mode === "success") process.exit(0);
if (mode === "failure") process.exit(23);
if (mode === "leaf") {
  // A cwd in the stage makes premature Windows removal fail, even if a file
  // descriptor happens to permit FILE_SHARE_DELETE in the selected runtime.
  process.chdir(stage);
  openSync(join(stage, "held-file"), "w");
  process.send?.("ready");
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [process.argv[1], "leaf", stage, receipt], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.once("message", () => {
    writeFileSync(receipt, JSON.stringify({ pids: [process.ppid, process.pid, child.pid] }));
    if (mode === "orphan") process.exit(0);
  });
  setInterval(() => {}, 1000);
}
