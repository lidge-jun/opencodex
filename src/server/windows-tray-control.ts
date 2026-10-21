import { execFile } from "node:child_process";
import { join } from "node:path";
import { durableBunChildEnv, durableBunPath } from "../lib/bun-runtime";
import type { WindowsTrayStatus } from "../tray/windows";

export type WindowsTrayAction = "install" | "start" | "stop" | "status" | "uninstall";

/** Run blocking registry/PowerShell waits outside the proxy event loop. */
export function runWindowsTrayAction(action: WindowsTrayAction): Promise<WindowsTrayStatus> {
  if (action === "status") {
    return import("../tray/windows").then(({ getWindowsTrayStatusAsync }) => getWindowsTrayStatusAsync());
  }
  const bun = durableBunPath();
  const cli = join(import.meta.dir, "..", "cli", "index.ts");
  return new Promise((resolve, reject) => {
    execFile(bun, [cli, "tray", action, "--json"], {
      encoding: "utf8",
      env: durableBunChildEnv(process.env),
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    }, (error, stdout, stderr) => {
      const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const parsed = JSON.parse(lines[index]) as WindowsTrayStatus | { error?: unknown };
          if ("supported" in parsed && typeof parsed.supported === "boolean") {
            resolve(parsed);
            return;
          }
          const failure = parsed as { error?: unknown };
          if (typeof failure.error === "string") {
            reject(new Error(failure.error));
            return;
          }
        } catch { /* scan earlier lines */ }
      }
      reject(new Error(error?.message || stderr.trim() || "Windows tray action returned no status"));
    });
  });
}
