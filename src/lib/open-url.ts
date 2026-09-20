import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function windowsRundll32(): string {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const candidate = join(windowsRoot, "System32", "rundll32.exe");
  return existsSync(candidate) ? candidate : "rundll32";
}

/**
 * Whether the OS launcher actually started. `started` does not prove a browser rendered the
 * page — nothing observable from here can — but it does separate "we handed the URL off" from
 * "there was nothing to hand it to", which is the distinction a caller needs (#5261).
 */
export type OpenUrlResult =
  | { status: "started" }
  | { status: "failed"; reason: "invalid-url" | "spawn-error" };

/**
 * Never rejects. A browser that would not open is an inconvenience, not a login failure: the
 * URL is still a valid thing to open by hand, so the caller decides what to say about it.
 * Callers that genuinely do not care use `void openUrl(...)`.
 */
export function openUrl(url: string): Promise<OpenUrlResult> {
  if (!/^https?:\/\//i.test(url)) return Promise.resolve({ status: "failed", reason: "invalid-url" });
  const cmd =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? windowsRundll32()
    : "xdg-open";
  const args = process.platform === "win32"
    ? ["url.dll,FileProtocolHandler", url]
    : [url];
  return new Promise<OpenUrlResult>(resolve => {
    let settled = false;
    const settle = (result: OpenUrlResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", shell: false });
    // Headless hosts (no xdg-open) emit ENOENT as an async 'error' event; without a
    // listener that is an uncaught exception that kills the whole proxy/login flow.
    // It is also the signal itself: on Windows this is how a missing rundll32 arrives.
    child.on("error", () => settle({ status: "failed", reason: "spawn-error" }));
    child.on("spawn", () => settle({ status: "started" }));
    child.unref();
  });
}
