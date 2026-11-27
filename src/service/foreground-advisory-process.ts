import { execFileSync, spawn } from "node:child_process";
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
  execKillSync?: typeof execFileSync;
  killDeadlineMs?: number;
}

export type StopForegroundAdvisory = (sync?: boolean) => void;

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
): StopForegroundAdvisory | undefined {
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

interface ProbeKillerState {
  done: boolean;
  cancelAsync?: () => void;
}

function stopProbe(
  child: ReturnType<typeof spawn>,
  deps: ForegroundAdvisoryDeps,
  state: ProbeKillerState,
  sync: boolean,
): void {
  if (state.done) return;
  const pid = child.pid;
  if (!pid || !Number.isInteger(pid) || pid <= 0) { state.done = true; return; }
  const platform = deps.platform ?? process.platform;
  const killChild = () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
    }
  };
  if (platform !== "win32") {
    state.done = true;
    // Do not return early when the root already exited: a descendant that inherited stdout
    // can still live in the detached process group `-pid`.
    try { process.kill(-pid, "SIGKILL"); return; } catch { /* fall back to the child */ }
    killChild();
    return;
  }
  const killDeadlineMs = deps.killDeadlineMs ?? KILL_DEADLINE_MS;
  if (sync) {
    state.cancelAsync?.();
    state.cancelAsync = undefined;
    state.done = true;
    const execSync = deps.execKillSync ?? execFileSync;
    const syncOpts = { stdio: "ignore" as const, windowsHide: true, timeout: killDeadlineMs };
    let taskkillOk = false;
    try {
      const taskkill = (deps.resolveTaskkill ?? resolveTrustedWindowsTaskkillExe)();
      execSync(taskkill, ["/F", "/T", "/PID", String(pid)], syncOpts);
      taskkillOk = true;
    } catch { /* fall back to PowerShell tree kill */ }
    if (!taskkillOk) {
      try {
        const ps = (deps.resolvePowerShell ?? resolveTrustedWindowsPowerShellExe)();
        execSync(ps, windowsPowerShellTreeKillArgs(pid), syncOpts);
      } catch { /* fall back to child kill */ }
    }
    killChild();
    return;
  }
  if (state.cancelAsync) return;
  const spawnKill = deps.spawnKill ?? spawn;
  let activeKiller: ReturnType<typeof spawn> | undefined;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let fallbackStarted = false;
  const clearActive = () => {
    if (activeTimer) { clearTimeout(activeTimer); activeTimer = undefined; }
    activeKiller = undefined;
  };
  state.cancelAsync = () => {
    cancelled = true;
    if (activeTimer) { clearTimeout(activeTimer); activeTimer = undefined; }
    if (activeKiller) { try { activeKiller.kill("SIGKILL"); } catch { /* best effort */ } activeKiller = undefined; }
  };
  const finish = () => { clearActive(); state.cancelAsync = undefined; state.done = true; };
  const fallbackTreeKill = () => {
    if (cancelled || fallbackStarted) return;
    fallbackStarted = true;
    try {
      const ps = (deps.resolvePowerShell ?? resolveTrustedWindowsPowerShellExe)();
      const psKill = spawnKill(ps, windowsPowerShellTreeKillArgs(pid), { stdio: "ignore", windowsHide: true });
      activeKiller = psKill;
      activeTimer = setTimeout(() => {
        try { psKill.kill("SIGKILL"); } catch { /* best effort */ }
        killChild();
        finish();
      }, killDeadlineMs);
      activeTimer.unref();
      psKill.once("exit", () => { if (!cancelled) { killChild(); finish(); } });
      psKill.once("error", () => { if (!cancelled) { killChild(); finish(); } });
      psKill.unref();
    } catch {
      killChild();
      finish();
    }
  };
  // Terminate only the process tree this invocation spawned, never service PIDs.
  try {
    const taskkill = (deps.resolveTaskkill ?? resolveTrustedWindowsTaskkillExe)();
    const kill = spawnKill(taskkill, ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    activeKiller = kill;
    activeTimer = setTimeout(() => {
      try { kill.kill("SIGKILL"); } catch { /* best effort */ }
      fallbackTreeKill();
    }, killDeadlineMs);
    activeTimer.unref();
    kill.once("exit", code => {
      if (cancelled) return;
      clearActive();
      if (code === 0) finish();
      else fallbackTreeKill();
    });
    kill.once("error", () => { if (!cancelled) { clearActive(); fallbackTreeKill(); } });
    kill.unref();
  } catch {
    fallbackTreeKill();
  }
}

/** Run an optional OS diagnostic without blocking the listener or keeping the CLI alive. */
export function startForegroundAdvisory(
  warn: (line: string) => void,
  deps: ForegroundAdvisoryDeps = {},
): StopForegroundAdvisory {
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const expires = performance.now() + timeoutMs;
  let child: ReturnType<typeof spawn>;
  try {
    child = (deps.launch ?? (() => spawn(process.execPath, selfLaunchArgv([FOREGROUND_ADVISORY_ARG]), {
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    })))();
  } catch { return () => {}; }

  let settled = false;
  let closed = false;
  let bytes = 0;
  const chunks: Buffer[] = [];
  const killerState: ProbeKillerState = { done: false };
  const stop: StopForegroundAdvisory = (sync = false) => {
    settled = true;
    clearTimeout(timer);
    if (!closed) stopProbe(child, deps, killerState, sync);
    child.stdout?.destroy();
  };
  const timer = setTimeout(() => stop(false), timeoutMs);
  timer.unref();
  child.once("error", () => stop(false));
  child.stdout?.once("error", () => stop(false));
  child.stdout?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) { stop(false); return; }
    if (!settled) chunks.push(chunk);
  });
  child.once("close", (code) => {
    closed = true;
    killerState.cancelAsync?.();
    killerState.done = true;
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
