import { spawn } from "node:child_process";
import { resolveTrustedWindowsPowerShellExe, resolveTrustedWindowsTaskkillExe } from "../lib/windows-elevation";
import { selfLaunchArgv } from "../lib/self-launch-argv";

export const FOREGROUND_ADVISORY_ARG = "__foreground-service-advisory";
const TIMEOUT_MS = 3_000;
const KILL_DEADLINE_MS = 1_000;
const MAX_BYTES = 8_192;

export interface ForegroundAdvisoryEligibility {
  cleaned: boolean;
  shuttingDown: boolean;
  siblingStart: boolean;
  ownerLive: boolean;
  supervisedServiceChild: boolean;
  restartParentPid: number | null;
  stderrIsTTY: boolean | undefined;
}

export interface ForegroundAdvisoryDeps {
  launch?: () => ReturnType<typeof spawn>;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  resolveTaskkill?: () => string;
  resolvePowerShell?: () => string;
  spawnKill?: typeof spawn;
  killDeadlineMs?: number;
}

/** True only for an eligible interactive foreground owner after readiness. */
export function shouldStartForegroundAdvisory(state: ForegroundAdvisoryEligibility): boolean {
  return !state.cleaned
    && !state.shuttingDown
    && !state.siblingStart
    && !state.ownerLive
    && !state.supervisedServiceChild
    && state.restartParentPid === null
    && Boolean(state.stderrIsTTY);
}

/** Start the background advisory probe only when foreground eligibility holds. */
export function maybeStartForegroundAdvisory(
  state: ForegroundAdvisoryEligibility,
  warn: (line: string) => void,
  deps?: ForegroundAdvisoryDeps,
): (() => void) | undefined {
  if (!shouldStartForegroundAdvisory(state)) return undefined;
  return startForegroundAdvisory(warn, deps);
}

/** Private child entrypoint executed by `startForegroundAdvisory`. */
export async function runForegroundAdvisoryEntrypoint(): Promise<number> {
  const { diagnoseService, foregroundStartServiceAdvisoryLines } = await import("./diagnostics");
  let lines: readonly string[] = [];
  try { lines = foregroundStartServiceAdvisoryLines(diagnoseService()); } catch { /* best effort */ }
  // Await the write, so an explicit CLI exit cannot truncate the pipe.
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(lines), error => error ? reject(error) : resolve()),
  );
  return 0;
}

export function windowsPowerShellTreeKillArgs(pid: number): string[] {
  const safePid = Math.trunc(pid);
  const script = [
    `$root = ${safePid}`,
    "$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue",
    "$queue = [System.Collections.Generic.Queue[int]]::new()",
    "$seen = [System.Collections.Generic.HashSet[int]]::new()",
    "$queue.Enqueue($root); [void]$seen.Add($root)",
    "while ($queue.Count -gt 0) {",
    "  $cur = $queue.Dequeue()",
    "  foreach ($p in $procs) {",
    "    if ([int]$p.ParentProcessId -eq $cur -and $seen.Add([int]$p.ProcessId)) { $queue.Enqueue([int]$p.ProcessId) }",
    "  }",
    "}",
    "foreach ($id in $seen) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
}

function stopProbe(child: ReturnType<typeof spawn>, deps: ForegroundAdvisoryDeps = {}): void {
  const pid = child.pid;
  if (!pid || !Number.isInteger(pid) || pid <= 0 || child.exitCode !== null || child.signalCode !== null) return;
  const platform = deps.platform ?? process.platform;
  const killChild = () => { try { child.kill("SIGKILL"); } catch { /* best effort */ } };
  if (platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); return; } catch { /* fall back to the child */ }
    killChild();
    return;
  }
  const spawnKill = deps.spawnKill ?? spawn;
  const killDeadlineMs = deps.killDeadlineMs ?? KILL_DEADLINE_MS;
  let fallbackStarted = false;
  const fallbackTreeKill = () => {
    if (fallbackStarted) return;
    fallbackStarted = true;
    try {
      const ps = (deps.resolvePowerShell ?? resolveTrustedWindowsPowerShellExe)();
      const psKill = spawnKill(ps, windowsPowerShellTreeKillArgs(pid), { stdio: "ignore", windowsHide: true });
      const psDeadline = setTimeout(() => {
        try { psKill.kill("SIGKILL"); } catch { /* best effort */ }
        killChild();
      }, killDeadlineMs);
      psDeadline.unref();
      psKill.once("exit", () => { clearTimeout(psDeadline); killChild(); });
      psKill.once("error", () => { clearTimeout(psDeadline); killChild(); });
      psKill.unref();
    } catch {
      killChild();
    }
  };
  // Terminate only the process tree this invocation spawned, never service PIDs.
  try {
    const taskkill = (deps.resolveTaskkill ?? resolveTrustedWindowsTaskkillExe)();
    const kill = spawnKill(taskkill, ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    const deadline = setTimeout(() => {
      try { kill.kill("SIGKILL"); } catch { /* best effort */ }
      fallbackTreeKill();
    }, killDeadlineMs);
    deadline.unref();
    kill.once("exit", code => { clearTimeout(deadline); if (code !== 0) fallbackTreeKill(); });
    kill.once("error", () => { clearTimeout(deadline); fallbackTreeKill(); });
    kill.unref();
  } catch {
    fallbackTreeKill();
  }
}

/** Run an optional OS diagnostic without blocking the listener or keeping the CLI alive. */
export function startForegroundAdvisory(
  warn: (line: string) => void,
  deps: ForegroundAdvisoryDeps = {},
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
    stopProbe(child, deps);
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
