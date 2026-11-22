import { spawn } from "node:child_process";
import { resolveTrustedWindowsTaskkillExe } from "../lib/windows-elevation";
import { selfLaunchArgv } from "../lib/self-launch-argv";

export const FOREGROUND_ADVISORY_ARG = "__foreground-service-advisory";
const TIMEOUT_MS = 3_000;
const MAX_BYTES = 8_192;

function stopProbe(child: ReturnType<typeof spawn>): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* fall back to the child */ }
  } else {
    // Terminate only the process tree this invocation spawned, never service PIDs.
    try {
      const taskkill = resolveTrustedWindowsTaskkillExe();
      const kill = spawn(taskkill, ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
      const killChild = () => { try { child.kill("SIGKILL"); } catch { /* best effort */ } };
      const deadline = setTimeout(() => {
        try { kill.kill("SIGKILL"); } catch { /* best effort */ }
        killChild();
      }, 1_000);
      deadline.unref();
      kill.once("exit", code => { clearTimeout(deadline); if (code !== 0) killChild(); });
      kill.once("error", () => { clearTimeout(deadline); killChild(); });
      kill.unref();
      return;
    } catch { /* fall back to the child */ }
  }
  try { child.kill("SIGKILL"); } catch { /* best effort */ }
}

/** Run an optional OS diagnostic without blocking the listener or keeping the CLI alive. */
export function startForegroundAdvisory(
  warn: (line: string) => void,
  deps: { launch?: () => ReturnType<typeof spawn>; timeoutMs?: number } = {},
): () => void {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const expires = performance.now() + timeoutMs;
  let child: ReturnType<typeof spawn>;
  try {
    child = (deps.launch ?? (() => spawn(process.execPath, selfLaunchArgv([FOREGROUND_ADVISORY_ARG]), {
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    })))();
  } catch { return () => {}; }

  let settled = false;
  let bytes = 0;
  const chunks: Buffer[] = [];
  const stop = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    stopProbe(child);
    child.stdout?.destroy();
  };
  const timer = setTimeout(stop, timeoutMs);
  timer.unref();
  child.once("error", stop);
  child.stdout?.once("error", stop);
  child.stdout?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) { stop(); return; }
    if (!settled) chunks.push(chunk);
  });
  child.once("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code !== 0 || performance.now() >= expires) return;
    try {
      const lines: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(lines) || lines.length > 2 || !lines.every(line => typeof line === "string")) return;
      for (const line of lines) warn(line);
    } catch { /* optional output */ }
  });
  child.unref();
  // Node's pipe handle has unref(); its public Readable type doesn't expose it.
  (child.stdout as (typeof child.stdout & { unref?(): void }))?.unref?.();
  return stop;
}
