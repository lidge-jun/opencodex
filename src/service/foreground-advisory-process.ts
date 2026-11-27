import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { resolveTrustedWindowsPowerShellExe, resolveTrustedWindowsSystemDirectory } from "../lib/windows-elevation";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { windowsProcessNative, type WindowsProcessNativeApi } from "./windows-process-native";

export const FOREGROUND_ADVISORY_ARG = "__foreground-service-advisory";
const TIMEOUT_MS = 3_000;
const KILL_DEADLINE_MS = 1_000;
const MAX_BYTES = 8_192;
const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x0010_0000;
const WAIT_TIMEOUT = 0x102;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const JOB_EXTENDED_LIMIT_BYTES = 144;
const JOB_LIMIT_FLAGS_OFFSET = 16;
const FILETIME_DOTNET_EPOCH = 504_911_232_000_000_000n;
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const EPOCH_MS_TO_DOTNET_TICKS_OFFSET = 621_355_968_000_000_000n;

export interface ForegroundAdvisoryEligibility {
  cleaned: boolean;
  shuttingDown: boolean;
  siblingStart: boolean;
  ownerLive: boolean;
  supervisedServiceChild: boolean;
  restartParentPid: number | null;
  stderrIsTTY: boolean | undefined;
}

export interface WindowsAdvisoryJob {
  /** Atomically terminate all processes in the job and close the job handle. */
  terminateAndClose(): boolean;
  /** Release the job handle without forcing termination first. */
  close(): void;
}

export interface WindowsProcessSnapshotRow {
  pid: number;
  parentPid: number;
  /** UTC creation time in .NET ticks at CIM precision (matching `sameUserIdentity`). */
  ticks: bigint;
}

export interface ForegroundAdvisoryDeps {
  launch?: () => ReturnType<typeof spawn>;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  resolvePowerShell?: () => string;
  spawnSnapshot?: typeof spawn;
  execSnapshotSync?: typeof execFileSync;
  windowsNative?: () => Pick<WindowsProcessNativeApi, "sameUserIdentity" | "terminate"> | null;
  attachWindowsJob?: (pid: number, expectedTicks: bigint) => WindowsAdvisoryJob | null;
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

/** Read-only CIM snapshot of `(ProcessId, ParentProcessId, CreationDateTicks)`. Never kills by PID. */
export function windowsProcessSnapshotArgs(): string[] {
  const script = [
    "$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue",
    'foreach ($p in $procs) { if ($p.CreationDate) { $t = ([DateTime]$p.CreationDate).ToUniversalTime().Ticks; Write-Output ("{0},{1},{2}" -f [int]$p.ProcessId, [int]$p.ParentProcessId, $t) } }',
  ].join("; ");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
}

/** Parse output produced by {@link windowsProcessSnapshotArgs}. */
export function parseWindowsProcessSnapshot(raw: string): WindowsProcessSnapshotRow[] {
  const rows: WindowsProcessSnapshotRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(\d+),(\d+),(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0) continue;
    try {
      const ticks = BigInt(match[3]!);
      if (ticks > 0n) rows.push({ pid, parentPid, ticks });
    } catch { /* ignore malformed row */ }
  }
  return rows;
}

/**
 * Select living descendants of our probe root from a process snapshot without including the root
 * itself (root termination is bound separately) and without crossing into a reused PID's subtree.
 */
export function selectOwnedWindowsDescendants(
  rows: readonly WindowsProcessSnapshotRow[],
  rootPid: number,
  rootTicks: bigint,
  rootExitedTicks: bigint | null,
): WindowsProcessSnapshotRow[] {
  const rootRow = rows.find(row => row.pid === rootPid);
  const rootStillOwned = rootExitedTicks === null && rootRow !== undefined && rootRow.ticks === rootTicks;
  const reusedRootTicks = rootRow && rootRow.ticks !== rootTicks ? rootRow.ticks : null;

  const byParent = new Map<number, WindowsProcessSnapshotRow[]>();
  for (const row of rows) {
    if (row.pid === rootPid) continue;
    const list = byParent.get(row.parentPid);
    if (list) list.push(row);
    else byParent.set(row.parentPid, [row]);
  }

  const selected: WindowsProcessSnapshotRow[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: WindowsProcessSnapshotRow[] = [];

  for (const child of byParent.get(rootPid) ?? []) {
    if (child.ticks < rootTicks) continue;
    if (!rootStillOwned) {
      if (rootExitedTicks !== null && child.ticks > rootExitedTicks) continue;
      if (reusedRootTicks !== null && child.ticks >= reusedRootTicks) continue;
    }
    if (seen.add(child.pid)) {
      selected.push(child);
      queue.push(child);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of byParent.get(current.pid) ?? []) {
      if (child.ticks < current.ticks) continue;
      if (seen.add(child.pid)) {
        selected.push(child);
        queue.push(child);
      }
    }
  }
  return selected;
}

function epochMsToDotNetTicksEndOfMs(ms: number): bigint {
  return BigInt(Math.trunc(ms)) * 10_000n + EPOCH_MS_TO_DOTNET_TICKS_OFFSET + 9_990n;
}

type WinJobKernel = {
  OpenProcess: (access: number, inherit: number, pid: number) => number | bigint;
  CloseHandle: (handle: number | bigint) => number;
  GetProcessTimes: (handle: number | bigint, c: number, e: number, k: number, u: number) => number;
  WaitForSingleObject: (handle: number | bigint, ms: number) => number;
  CreateJobObjectW: (attr: null, name: null) => number | bigint;
  SetInformationJobObject: (job: number | bigint, cls: number, info: number, len: number) => number;
  AssignProcessToJobObject: (job: number | bigint, proc: number | bigint) => number;
  TerminateJobObject: (job: number | bigint, code: number) => number;
};

let winJobSymbols: { k: WinJobKernel; ptr: typeof import("bun:ffi").ptr } | null | undefined;

function loadWinJobSymbols(): { k: WinJobKernel; ptr: typeof import("bun:ffi").ptr } | null {
  if (winJobSymbols !== undefined) return winJobSymbols;
  winJobSymbols = null;
  if (process.platform !== "win32" || process.arch !== "x64") return null;
  try {
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const systemDirectory = resolveTrustedWindowsSystemDirectory();
    const k = ffi.dlopen(join(systemDirectory, "kernel32.dll"), {
      OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
      CloseHandle: { args: ["u64"], returns: "i32" },
      GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
      WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
      CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
      SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
      AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
      TerminateJobObject: { args: ["u64", "u32"], returns: "i32" },
    }).symbols as unknown as WinJobKernel;
    winJobSymbols = { k, ptr: ffi.ptr };
  } catch { /* native job object unavailable on this host */ }
  return winJobSymbols;
}

/**
 * Attach a newly spawned probe process to an unnamed kill-on-close Job Object after verifying
 * its exact kernel creation ticks on the SAME OS handle passed to `AssignProcessToJobObject`.
 */
function attachWindowsAdvisoryJob(pid: number, expectedTicks: bigint): WindowsAdvisoryJob | null {
  const api = loadWinJobSymbols();
  if (!api) return null;
  const { k, ptr } = api;
  const proc = k.OpenProcess(
    PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
    0,
    pid,
  );
  if (!proc) return null;
  let job: number | bigint = 0;
  try {
    const times = new BigUint64Array(4);
    const base = ptr(times) as number;
    if (!k.GetProcessTimes(proc, base, base + 8, base + 16, base + 24)) return null;
    const createdFileTime = times[0]!;
    if (createdFileTime <= FILETIME_UNIX_EPOCH) return null;
    const cimTicks = (createdFileTime + FILETIME_DOTNET_EPOCH) / 10n * 10n;
    if (cimTicks !== expectedTicks) return null;
    if ((Number(k.WaitForSingleObject(proc, 0)) >>> 0) !== WAIT_TIMEOUT) return null;

    job = k.CreateJobObjectW(null, null);
    if (!job) return null;
    const limitInfo = new Uint8Array(JOB_EXTENDED_LIMIT_BYTES);
    new DataView(limitInfo.buffer).setUint32(JOB_LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
    if (!k.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(limitInfo), JOB_EXTENDED_LIMIT_BYTES)) {
      k.CloseHandle(job);
      job = 0;
      return null;
    }
    if (!k.AssignProcessToJobObject(job, proc)) {
      k.CloseHandle(job);
      job = 0;
      return null;
    }
    const ownedJob = job;
    job = 0;
    let closed = false;
    return {
      terminateAndClose(): boolean {
        if (closed) return true;
        closed = true;
        const ok = Boolean(k.TerminateJobObject(ownedJob, 1));
        k.CloseHandle(ownedJob);
        return ok;
      },
      close(): void {
        if (closed) return;
        closed = true;
        k.CloseHandle(ownedJob);
      },
    };
  } catch {
    if (job) k.CloseHandle(job);
    return null;
  } finally {
    k.CloseHandle(proc);
  }
}

interface ProbeKillerState {
  done: boolean;
  rootTicks: bigint | null;
  rootExitedAtMs: number | null;
  windowsJob: WindowsAdvisoryJob | null;
  cancelAsync?: () => void;
}

function terminateWindowsDescendants(
  rawSnapshot: string,
  rootPid: number,
  rootTicks: bigint,
  rootExitedTicks: bigint | null,
  native: Pick<WindowsProcessNativeApi, "terminate">,
): void {
  const rows = parseWindowsProcessSnapshot(rawSnapshot);
  const descendants = selectOwnedWindowsDescendants(rows, rootPid, rootTicks, rootExitedTicks);
  for (const desc of descendants) {
    // Handle-bound termination: verifies exact creation ticks and same-user SID on the same
    // OS handle passed to TerminateProcess, so a reused PID is never touched.
    try { native.terminate(desc.pid, desc.ticks); } catch { /* best effort per descendant */ }
  }
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

  // Primary Windows path: kernel-owned Job Object terminates root + every descendant atomically
  // with zero PID-reuse races, synchronously on both async timeout and process exit.
  if (state.windowsJob) {
    const job = state.windowsJob;
    state.windowsJob = null;
    if (job.terminateAndClose()) {
      state.cancelAsync?.();
      state.cancelAsync = undefined;
      state.done = true;
      killChild();
      return;
    }
  }

  const native = deps.windowsNative ? deps.windowsNative() : windowsProcessNative();
  const rootTicks = state.rootTicks;
  if (!native || rootTicks === null) {
    // Native handle-bound termination is unavailable (e.g. Windows ARM64 or uncaptured identity):
    // never attempt unchecked PID-only termination (taskkill / Stop-Process). Only signal the
    // open ChildProcess handle while the root is still alive.
    state.cancelAsync?.();
    state.cancelAsync = undefined;
    state.done = true;
    killChild();
    return;
  }

  const rootExitedTicks = () => (child.exitCode !== null || child.signalCode !== null || state.rootExitedAtMs !== null)
    ? epochMsToDotNetTicksEndOfMs(state.rootExitedAtMs ?? Date.now())
    : null;
  const terminateRootBound = () => {
    try { native.terminate(pid, rootTicks); } catch { /* best effort handle-bound root kill */ }
    killChild();
  };
  const killDeadlineMs = deps.killDeadlineMs ?? KILL_DEADLINE_MS;

  if (sync) {
    state.cancelAsync?.();
    state.cancelAsync = undefined;
    state.done = true;
    let rawSnapshot = "";
    try {
      const ps = (deps.resolvePowerShell ?? resolveTrustedWindowsPowerShellExe)();
      const execSync = deps.execSnapshotSync ?? execFileSync;
      const out = execSync(ps, windowsProcessSnapshotArgs(), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: killDeadlineMs,
        maxBuffer: SNAPSHOT_MAX_BYTES,
      });
      rawSnapshot = String(out);
    } catch { /* snapshot unavailable; still run handle-bound root termination */ }
    if (rawSnapshot) {
      terminateWindowsDescendants(rawSnapshot, pid, rootTicks, rootExitedTicks(), native);
    }
    terminateRootBound();
    return;
  }

  if (state.cancelAsync) return;
  const spawnSnapshot = deps.spawnSnapshot ?? spawn;
  let activeSnapshot: ReturnType<typeof spawn> | undefined;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let handled = false;
  const clearActive = () => {
    if (activeTimer) { clearTimeout(activeTimer); activeTimer = undefined; }
    activeSnapshot = undefined;
  };
  state.cancelAsync = () => {
    cancelled = true;
    if (activeTimer) { clearTimeout(activeTimer); activeTimer = undefined; }
    if (activeSnapshot) {
      try { activeSnapshot.kill("SIGKILL"); } catch { /* best effort */ }
      activeSnapshot = undefined;
    }
  };
  const finish = (rawSnapshot: string) => {
    if (cancelled || handled) return;
    handled = true;
    clearActive();
    state.cancelAsync = undefined;
    state.done = true;
    if (rawSnapshot) {
      terminateWindowsDescendants(rawSnapshot, pid, rootTicks, rootExitedTicks(), native);
    }
    terminateRootBound();
  };

  try {
    const ps = (deps.resolvePowerShell ?? resolveTrustedWindowsPowerShellExe)();
    const snap = spawnSnapshot(ps, windowsProcessSnapshotArgs(), {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    activeSnapshot = snap;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    snap.stdout?.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= SNAPSHOT_MAX_BYTES) chunks.push(chunk);
    });
    activeTimer = setTimeout(() => {
      try { snap.kill("SIGKILL"); } catch { /* best effort */ }
      finish(Buffer.concat(chunks).toString("utf8"));
    }, killDeadlineMs);
    activeTimer.unref();
    snap.once("close", () => finish(Buffer.concat(chunks).toString("utf8")));
    snap.once("error", () => finish(""));
    snap.unref();
    (snap.stdout as (typeof snap.stdout & { unref?(): void }))?.unref?.();
  } catch {
    finish("");
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
  } catch { return () => { /* launch failed; nothing to clean up */ }; }

  const platform = deps.platform ?? process.platform;
  const native = platform === "win32"
    ? (deps.windowsNative ? deps.windowsNative() : windowsProcessNative())
    : null;
  const rootTicks = platform === "win32" && native && child.pid
    ? (() => {
      try { return native.sameUserIdentity(child.pid)?.ticks ?? null; }
      catch { return null; }
    })()
    : null;
  const windowsJob = platform === "win32" && rootTicks !== null && child.pid
    ? (() => {
      try { return (deps.attachWindowsJob ?? attachWindowsAdvisoryJob)(child.pid, rootTicks); }
      catch { return null; }
    })()
    : null;

  let settled = false;
  let bytes = 0;
  const chunks: Buffer[] = [];
  const killerState: ProbeKillerState = { done: false, rootTicks, rootExitedAtMs: null, windowsJob };
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
    if (killerState.windowsJob) {
      try { killerState.windowsJob.close(); } catch { /* best effort handle release */ }
      killerState.windowsJob = null;
    }
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
