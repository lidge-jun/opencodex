import { execFileSync, spawn } from "node:child_process";
import { resolveTrustedWindowsPowerShellExe, resolveTrustedWindowsTaskkillExe } from "../lib/windows-elevation";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { windowsProcessNative } from "./windows-process-native";

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

export interface WindowsTreeKillIdentity {
  /** Probe launch timestamp (epoch ms) captured before spawn. */
  launchedAtMs: number;
  /** Exact root creation time (epoch ms) from GetProcessTimes when available. */
  rootCreatedAtMs?: number | null;
  /** Non-null when the probe root has already exited before cleanup started. */
  rootExitedAtMs?: number | null;
}

export function windowsPowerShellTreeKillArgs(pid: number, identity?: WindowsTreeKillIdentity): string[] {
  const safePid = Math.trunc(pid);
  const rootExited = identity?.rootExitedAtMs != null;
  const minCreatedIso = identity
    ? new Date(Math.max(0, (identity.rootCreatedAtMs ?? identity.launchedAtMs) - 2_000)).toISOString()
    : null;
  const maxRootCreatedIso = identity?.rootCreatedAtMs != null
    ? new Date(identity.rootCreatedAtMs + 2_000).toISOString()
    : identity
      ? new Date(identity.launchedAtMs + 10_000).toISOString()
      : null;
  const maxChildCreatedIso = identity?.rootExitedAtMs != null
    ? new Date(identity.rootExitedAtMs + 2_000).toISOString()
    : null;

  const childPredicates = [
    "[int]$p.ParentProcessId -eq $root",
    "$p.CreationDate",
    ...(minCreatedIso ? ["$c -ge $minCreated"] : []),
    ...(maxChildCreatedIso ? ["$c -le $maxChildCreated"] : []),
    "(-not $rootCreated -or $c -lt $rootCreated)",
  ];
  const seedChildren = [
    "foreach ($p in $procs) {",
    "if ([int]$p.ParentProcessId -eq $root -and $p.CreationDate) {",
    "$c = ([DateTime]$p.CreationDate).ToUniversalTime();",
    `if (${childPredicates.slice(2).join(" -and ")} -and $seen.Add([int]$p.ProcessId)) { $queue.Enqueue([int]$p.ProcessId) }`,
    "}",
    "}",
  ].join(" ");

  const scriptParts: string[] = [
    `$root = ${safePid}`,
    "$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue",
    "$queue = [System.Collections.Generic.Queue[int]]::new()",
    "$seen = [System.Collections.Generic.HashSet[int]]::new()",
    "$rootProc = $procs | Where-Object { [int]$_.ProcessId -eq $root } | Select-Object -First 1",
    "$rootCreated = if ($rootProc -and $rootProc.CreationDate) { ([DateTime]$rootProc.CreationDate).ToUniversalTime() } else { $null }",
    ...(minCreatedIso ? [`$minCreated = [DateTimeOffset]::Parse('${minCreatedIso}').UtcDateTime`] : []),
    ...(maxRootCreatedIso ? [`$maxRootCreated = [DateTimeOffset]::Parse('${maxRootCreatedIso}').UtcDateTime`] : []),
    ...(maxChildCreatedIso ? [`$maxChildCreated = [DateTimeOffset]::Parse('${maxChildCreatedIso}').UtcDateTime`] : []),
  ];

  if (rootExited) {
    // Root already exited: NEVER kill $root (PID may be reused). Only reap children created
    // during our probe's lifetime and strictly before any reused $rootProc started.
    scriptParts.push(seedChildren);
  } else {
    const rootChecks = [
      "$rootProc -ne $null",
      "$rootCreated -ne $null",
      ...(minCreatedIso ? ["$rootCreated -ge $minCreated"] : []),
      ...(maxRootCreatedIso ? ["$rootCreated -le $maxRootCreated"] : []),
    ].join(" -and ");
    scriptParts.push(`if (${rootChecks}) { $queue.Enqueue($root); [void]$seen.Add($root) } else { ${seedChildren} }`);
  }

  scriptParts.push(
    "while ($queue.Count -gt 0) { $cur = $queue.Dequeue(); foreach ($p in $procs) { if ([int]$p.ParentProcessId -eq $cur -and $seen.Add([int]$p.ProcessId)) { $queue.Enqueue([int]$p.ProcessId) } } }",
    "foreach ($id in $seen) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }",
  );
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", scriptParts.join("; ")];
}

interface ProbeKillerState {
  done: boolean;
  launchedAtMs: number;
  rootCreatedAtMs: number | null;
  rootExitedAtMs: number | null;
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
    // can still live in the detached process group `-pid` (which POSIX never reuses while live).
    try { process.kill(-pid, "SIGKILL"); return; } catch { /* fall back to the child */ }
    killChild();
    return;
  }
  const killDeadlineMs = deps.killDeadlineMs ?? KILL_DEADLINE_MS;
  const rootExited = child.exitCode !== null || child.signalCode !== null || state.rootExitedAtMs !== null;
  const psArgs = windowsPowerShellTreeKillArgs(pid, {
    launchedAtMs: state.launchedAtMs,
    rootCreatedAtMs: state.rootCreatedAtMs,
    rootExitedAtMs: rootExited ? (state.rootExitedAtMs ?? Date.now()) : null,
  });
  if (sync) {
    state.cancelAsync?.();
    state.cancelAsync = undefined;
    state.done = true;
    const execSync = deps.execKillSync ?? execFileSync;
    const syncOpts = { stdio: "ignore" as const, windowsHide: true, timeout: killDeadlineMs };
    let taskkillOk = false;
    // Never invoke bare-PID taskkill after the probe root has exited: Windows can reuse the PID.
    if (!rootExited) {
      try {
        const taskkill = (deps.resolveTaskkill ?? resolveTrustedWindowsTaskkillExe)();
        execSync(taskkill, ["/F", "/T", "/PID", String(pid)], syncOpts);
        taskkillOk = true;
      } catch { /* fall back to incarnation-checked PowerShell tree kill */ }
    }
    if (!taskkillOk) {
      try {
        const ps = (deps.resolvePowerShell ?? resolveTrustedWindowsPowerShellExe)();
        execSync(ps, psArgs, syncOpts);
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
  const clearActiveFor = (
    killer: ReturnType<typeof spawn>,
    timer: ReturnType<typeof setTimeout> | undefined,
  ) => {
    if (timer) clearTimeout(timer);
    if (activeTimer === timer) activeTimer = undefined;
    if (activeKiller === killer) activeKiller = undefined;
  };
  state.cancelAsync = () => {
    cancelled = true;
    if (activeTimer) { clearTimeout(activeTimer); activeTimer = undefined; }
    if (activeKiller) { try { activeKiller.kill("SIGKILL"); } catch { /* best effort */ } activeKiller = undefined; }
  };
  const finish = () => {
    if (activeTimer) { clearTimeout(activeTimer); activeTimer = undefined; }
    activeKiller = undefined;
    state.cancelAsync = undefined;
    state.done = true;
  };
  const fallbackTreeKill = () => {
    if (cancelled || fallbackStarted) return;
    fallbackStarted = true;
    try {
      const ps = (deps.resolvePowerShell ?? resolveTrustedWindowsPowerShellExe)();
      const psKill = spawnKill(ps, psArgs, { stdio: "ignore", windowsHide: true });
      let psHandled = false;
      activeKiller = psKill;
      const psTimer = setTimeout(() => {
        if (cancelled || psHandled) return;
        psHandled = true;
        clearActiveFor(psKill, psTimer);
        try { psKill.kill("SIGKILL"); } catch { /* best effort */ }
        killChild();
        finish();
      }, killDeadlineMs);
      activeTimer = psTimer;
      psTimer.unref();
      const completePs = () => {
        if (cancelled || psHandled) return;
        psHandled = true;
        clearActiveFor(psKill, psTimer);
        killChild();
        finish();
      };
      psKill.once("exit", completePs);
      psKill.once("error", completePs);
      psKill.unref();
    } catch {
      killChild();
      finish();
    }
  };
  if (rootExited) {
    // Root already exited: skip bare-PID taskkill and use incarnation-checked child cleanup.
    fallbackTreeKill();
    return;
  }
  // Terminate only the process tree this invocation spawned, never service PIDs.
  try {
    const taskkill = (deps.resolveTaskkill ?? resolveTrustedWindowsTaskkillExe)();
    const kill = spawnKill(taskkill, ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    let taskkillHandled = false;
    activeKiller = kill;
    const taskkillTimer = setTimeout(() => {
      if (cancelled || taskkillHandled) return;
      taskkillHandled = true;
      clearActiveFor(kill, taskkillTimer);
      try { kill.kill("SIGKILL"); } catch { /* best effort */ }
      fallbackTreeKill();
    }, killDeadlineMs);
    activeTimer = taskkillTimer;
    taskkillTimer.unref();
    kill.once("exit", code => {
      if (cancelled || taskkillHandled) return;
      taskkillHandled = true;
      clearActiveFor(kill, taskkillTimer);
      if (code === 0) finish();
      else fallbackTreeKill();
    });
    kill.once("error", () => {
      if (cancelled || taskkillHandled) return;
      taskkillHandled = true;
      clearActiveFor(kill, taskkillTimer);
      fallbackTreeKill();
    });
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
  const launchedAtMs = Date.now();
  let child: ReturnType<typeof spawn>;
  try {
    child = (deps.launch ?? (() => spawn(process.execPath, selfLaunchArgv([FOREGROUND_ADVISORY_ARG]), {
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    })))();
  } catch { return () => {}; }

  const rootCreatedAtMs = process.platform === "win32" && child.pid
    ? (() => { try { return windowsProcessNative()?.creationTime(child.pid) ?? null; } catch { return null; } })()
    : null;
  let settled = false;
  let bytes = 0;
  const chunks: Buffer[] = [];
  const killerState: ProbeKillerState = { done: false, launchedAtMs, rootCreatedAtMs, rootExitedAtMs: null };
  child.once("exit", () => { killerState.rootExitedAtMs ??= Date.now(); });
  const stop: StopForegroundAdvisory = (sync = false) => {
    settled = true;
    clearTimeout(timer);
    if (!killerState.done) stopProbe(child, deps, killerState, sync);
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
    if (settled) return;
    settled = true;
    killerState.done = true;
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
