/**
 * Portable process + system memory snapshot for the memory watchdog.
 *
 * WHY: OpenCodex on Bun can hit the "committed memory >> working set" signature (field report:
 * bun.exe private/committed ~79 GB while the working set stayed ~5.8 GB, freezing the box once the
 * system commit charge was exhausted). The Bun/mimalloc native allocator retains committed memory
 * the JS heap has already released — proven locally by the return-to-OS stress harness and mirrored
 * upstream by Claude Code #36132. A watchdog that only reads RSS would MISS that case entirely, so
 * we read the platform's private/committed counter where it is cheaply available and fall back to
 * RSS elsewhere. The same field incident showed the SYSTEM commit charge (~97% of the commit
 * limit) mattered more than any single process's share of physical RAM, so the Windows probe also
 * collects the system-wide Committed Bytes / Commit Limit for a separate observe-and-warn axis.
 *
 * SAFETY: the Windows probe runs a child PowerShell process ASYNCHRONOUSLY (Bun.spawn, array
 * arguments, no shell string, hidden window) — it never blocks the event loop; a slow probe only
 * delays its own completion. On timeout the child is killed and the caller receives an RSS
 * fallback snapshot; a late result after the timeout already resolved is dropped
 * (first-resolution-wins). Linux reads /proc synchronously (no spawn); every other platform uses
 * the in-process RSS fallback. All process-pressure thresholds are relative to physical RAM so the
 * same code behaves identically on a 16 GB laptop and a 128 GB worker.
 */

import { readFileSync } from "node:fs";
import { platform as osPlatform, totalmem } from "node:os";

/** Where the process-pressure value came from (always present — the value itself never is null). */
export type ProcessPressureSource = "windows-private" | "proc-status" | "rss-fallback";

export interface MemorySnapshot {
  /** Resident set size (physically mapped) in bytes. */
  rssBytes: number;
  /** V8/JSC heap in use, bytes. */
  heapUsedBytes: number;
  /** Off-heap native allocations tracked by the runtime, bytes. */
  externalBytes: number;
  /** Total physical RAM, bytes — the denominator for the process-pressure thresholds. */
  physicalMemoryBytes: number;

  /** Actual Windows Private Bytes for this PID; null on every other platform / probe failure. */
  processPrivateBytes: number | null;
  /**
   * The bytes the watchdog treats as process pressure. Windows: Private Bytes; Linux: VmRSS+VmSwap
   * from /proc; otherwise (and on probe failure): RSS. Always present — no null fallback needed.
   */
  processPressureBytes: number;
  /** Which of the above sources filled processPressureBytes. */
  processSource: ProcessPressureSource;

  /** System-wide commit charge (bytes); Windows-only in v1, null elsewhere / on failure. */
  systemCommittedBytes: number | null;
  /** System commit limit (RAM + page file, bytes); null when not measured. */
  systemCommitLimitBytes: number | null;
  /** True only when BOTH system commit values above were freshly measured. */
  systemCommitAvailable: boolean;
  /** Available physical memory (bytes) — auxiliary diagnostics only. */
  availablePhysicalBytes: number | null;

  /** Caller's clock when the capture BEGAN (the watchdog stamps probe completion separately). */
  capturedAt: number;
  /** Sanitized probe failure code (never raw command output — may echo paths/usernames). */
  probeError?: string;
}

/**
 * Async budget for the Windows probe. Generous compared to the old 2s synchronous cap: the async
 * probe cannot block the event loop, so the only cost of a longer budget is a later evaluation —
 * while a tight budget would spuriously degrade slow machines to the RSS fallback. Measured on a
 * Windows 11 box: cold powershell.exe spawn + one CIM query = 4.0–5.9s per run, so 15s gives
 * ~2.5x headroom over the worst observation while staying well inside the 60s sampling interval.
 */
const WINDOWS_PROBE_TIMEOUT_MS = 15_000;

type PlatformOverride = string | null;
let platformOverride: PlatformOverride = null;

/** Test seam: force the platform gate (e.g. "linux") so probe selection is deterministic. */
export function setMemoryPlatformForTests(value: PlatformOverride): void {
  platformOverride = value;
}

function effectivePlatform(): string {
  return platformOverride ?? osPlatform();
}

// ---------------------------------------------------------------------------
// Windows probe (async, guarded child process)
// ---------------------------------------------------------------------------

export interface WindowsProbeResult {
  privateBytes: number | null;
  systemCommittedBytes: number | null;
  systemCommitLimitBytes: number | null;
  availablePhysicalBytes: number | null;
  timedOut: boolean;
  /** Sanitized failure code ("timeout" | "spawn-failed" | "probe-exit-N" | "parse-failed" | ...). */
  error?: string;
}

type WindowsProbeRunner = (pid: number, timeoutMs: number, signal?: AbortSignal) => Promise<WindowsProbeResult>;

const EMPTY_PROBE: Omit<WindowsProbeResult, "timedOut" | "error"> = {
  privateBytes: null,
  systemCommittedBytes: null,
  systemCommitLimitBytes: null,
  availablePhysicalBytes: null,
};

interface SpawnedProbe {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  exitCode: number | null;
  kill(): void;
}

/**
 * One PowerShell spawn per probe collecting four numbers, one per line:
 * this PID's Private Bytes, then the system's CommittedBytes / CommitLimit / AvailableBytes.
 * Win32_PerfRawData_PerfOS_Memory mirrors the \Memory\Committed Bytes & Commit Limit performance
 * counters and reports ALL THREE system values in bytes (verified on Windows 11) — no unit
 * normalization needed. Arguments are an array (no shell string; the PID comes from process.pid),
 * the window is hidden, and the profile is skipped, matching the icacls runner's hardening.
 */
async function defaultWindowsProbeRunner(pid: number, timeoutMs: number, signal?: AbortSignal): Promise<WindowsProbeResult> {
  const bun = (globalThis as { Bun?: { spawn?: (cmd: string[], opts: Record<string, unknown>) => SpawnedProbe } }).Bun;
  if (!bun?.spawn) return { ...EMPTY_PROBE, timedOut: false, error: "spawn-unavailable" };
  if (signal?.aborted) return { ...EMPTY_PROBE, timedOut: false, error: "aborted" };

  let proc: SpawnedProbe;
  try {
    proc = bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // Labeled output: a $null value would render as an empty line that trim() removes, shifting
        // positional indexes — labels make the parse order-independent and loss-explicit.
        `$p=(Get-Process -Id ${pid}).PrivateMemorySize64; `
        + `$m=Get-CimInstance Win32_PerfRawData_PerfOS_Memory; `
        + `Write-Output "P=$p" "C=$($m.CommittedBytes)" "L=$($m.CommitLimit)" "A=$($m.AvailableBytes)"`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true },
    );
  } catch {
    return { ...EMPTY_PROBE, timedOut: false, error: "spawn-failed" };
  }

  // First-resolution-wins: the timeout (or an abort from stopMemoryWatchdog) kills the child and
  // resolves the fallback; a late read completion after that is dropped (the spec's
  // probeId/consumed invariant, expressed as a race).
  let settled = false;
  return new Promise<WindowsProbeResult>(resolve => {
    const finish = (result: WindowsProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      try { proc.kill(); } catch { /* already gone */ }
      finish({ ...EMPTY_PROBE, timedOut: false, error: "aborted" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      finish({ ...EMPTY_PROBE, timedOut: true, error: "timeout" });
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    void (async () => {
      try {
        const text = await new Response(proc.stdout).text();
        await proc.exited;
        if (proc.exitCode !== 0) {
          finish({ ...EMPTY_PROBE, timedOut: false, error: `probe-exit-${proc.exitCode ?? "unknown"}` });
          return;
        }
        finish(parseWindowsProbeOutput(text));
      } catch {
        finish({ ...EMPTY_PROBE, timedOut: false, error: "probe-failed" });
      }
    })();
  });
}

/**
 * Parse the labeled probe output (`P=` private, `C=` committed, `L=` limit, `A=` available).
 * Order-independent and tolerant of missing/blank labels — a value PowerShell rendered as empty
 * (`P=`) parses to NaN and degrades to null instead of shifting the other fields. Exported as a
 * pure function so the parse path is unit-testable without spawning a child.
 */
export function parseWindowsProbeOutput(text: string): WindowsProbeResult {
  const fields = new Map<string, number>();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([PCLA])=(.*)$/.exec(line.trim());
    if (match) fields.set(match[1]!, Number(match[2]));
  }
  const val = (n: number | undefined): number | null =>
    n !== undefined && Number.isFinite(n) && n > 0 ? n : null;
  const result: WindowsProbeResult = {
    privateBytes: val(fields.get("P")),
    systemCommittedBytes: val(fields.get("C")),
    systemCommitLimitBytes: val(fields.get("L")),
    availablePhysicalBytes: val(fields.get("A")),
    timedOut: false,
  };
  if (result.privateBytes === null && result.systemCommittedBytes === null) result.error = "parse-failed";
  return result;
}

let windowsProbeRunner: WindowsProbeRunner = defaultWindowsProbeRunner;

/** Test seam: replace the Windows probe runner. Pass null to restore the default. */
export function setWindowsProbeRunnerForTests(runner: WindowsProbeRunner | null): void {
  windowsProbeRunner = runner ?? defaultWindowsProbeRunner;
}

// ---------------------------------------------------------------------------
// Linux /proc probe (no spawn)
// ---------------------------------------------------------------------------

type ProcStatusReader = () => string | null;

function defaultProcStatusReader(): string | null {
  try {
    return readFileSync("/proc/self/status", "utf8");
  } catch {
    return null;
  }
}

let procStatusReader: ProcStatusReader = defaultProcStatusReader;

/** Test seam: replace the /proc/self/status reader. Pass null to restore the default. */
export function setProcStatusReaderForTests(reader: ProcStatusReader | null): void {
  procStatusReader = reader ?? defaultProcStatusReader;
}

/** Parse VmRSS + VmSwap (kB) out of /proc/self/status → private committed bytes, or null. */
export function parseProcStatusCommitted(text: string): number | null {
  const field = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s*(\\d+)\\s*kB`, "m").exec(text);
    return match ? Number(match[1]) * 1024 : null;
  };
  const rss = field("VmRSS");
  if (rss === null) return null;
  const swap = field("VmSwap") ?? 0;
  return rss + swap;
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

function baseSnapshot(capturedAt: number): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    physicalMemoryBytes: totalmem(),
    processPrivateBytes: null,
    processPressureBytes: usage.rss,
    processSource: "rss-fallback",
    systemCommittedBytes: null,
    systemCommitLimitBytes: null,
    systemCommitAvailable: false,
    availablePhysicalBytes: null,
    capturedAt,
  };
}

/**
 * RSS-fallback snapshot for callers that must evaluate SOMETHING even when capture itself failed.
 * captureMemorySnapshot is contractually non-throwing, but the probe loop uses this as a safety
 * net so an unexpected runtime exception never silences a whole evaluation cycle (audit #2).
 * probeError takes sanitized codes only — never raw command output or exception text.
 */
export function rssFallbackSnapshot(nowMs: number = Date.now(), probeError?: string): MemorySnapshot {
  const snapshot = baseSnapshot(nowMs);
  if (probeError !== undefined) snapshot.probeError = probeError;
  return snapshot;
}

/**
 * Capture one memory snapshot. ASYNC because the Windows path awaits a child-process probe; it
 * never throws and never blocks the event loop. Probe failures degrade to the RSS fallback with a
 * sanitized probeError code — degraded, but always evaluable.
 */
export async function captureMemorySnapshot(nowMs: number = Date.now(), signal?: AbortSignal): Promise<MemorySnapshot> {
  const plat = effectivePlatform();

  if (plat === "win32") {
    let probe: WindowsProbeResult;
    try {
      probe = await windowsProbeRunner(process.pid, WINDOWS_PROBE_TIMEOUT_MS, signal);
    } catch {
      probe = { ...EMPTY_PROBE, timedOut: false, error: "probe-failed" };
    }
    const snapshot = baseSnapshot(nowMs);
    if (probe.privateBytes !== null) {
      snapshot.processPrivateBytes = probe.privateBytes;
      snapshot.processPressureBytes = probe.privateBytes;
      snapshot.processSource = "windows-private";
    }
    snapshot.systemCommittedBytes = probe.systemCommittedBytes;
    snapshot.systemCommitLimitBytes = probe.systemCommitLimitBytes;
    snapshot.systemCommitAvailable = probe.systemCommittedBytes !== null && probe.systemCommitLimitBytes !== null;
    snapshot.availablePhysicalBytes = probe.availablePhysicalBytes;
    if (probe.error) snapshot.probeError = probe.error;
    return snapshot;
  }

  if (plat === "linux") {
    const snapshot = baseSnapshot(nowMs);
    const text = procStatusReader();
    const committed = text ? parseProcStatusCommitted(text) : null;
    if (committed !== null) {
      snapshot.processPressureBytes = committed;
      snapshot.processSource = "proc-status";
    } else {
      snapshot.probeError = "proc-status-unavailable";
    }
    // v1: system commit collection is Windows-only. Linux could read /proc/meminfo
    // Committed_AS/CommitLimit (no spawn) later; systemCommitAvailable=false covers it null-safely.
    return snapshot;
  }

  return baseSnapshot(nowMs);
}
