/**
 * Portable process-memory snapshot for the memory watchdog.
 *
 * WHY: OpenCodex on Bun can hit the "committed memory >> working set" signature (field report:
 * bun.exe private/committed ~79 GB while the working set stayed ~5.8 GB, freezing the box once the
 * system commit charge was exhausted). The Bun/mimalloc native allocator retains committed memory
 * the JS heap has already released — proven locally by the return-to-OS stress harness and mirrored
 * upstream by Claude Code #36132. A watchdog that only reads RSS would MISS that case entirely, so
 * we read the platform's private/committed counter where it is cheaply available and fall back to
 * RSS elsewhere.
 *
 * SAFETY: the only platform that needs a child process to read committed bytes is Windows; that
 * probe is guarded exactly like the icacls hardening path (hard timeout, soft-fail, no shell
 * string) so a slow/hung query can never block the proxy. Linux reads /proc (no spawn); every other
 * platform uses the in-process RSS fallback. All thresholds that consume this snapshot are relative
 * to totalSystemBytes so the same code behaves identically on a 16 GB laptop and a 128 GB worker.
 */

import { readFileSync } from "node:fs";
import { platform as osPlatform, totalmem } from "node:os";

export type CommittedSource = "windows-private" | "proc-status" | "rss-fallback" | "none";

export interface MemorySnapshot {
  /** Resident set size (physically mapped) in bytes. */
  rssBytes: number;
  /** V8/JSC heap in use, bytes. */
  heapUsedBytes: number;
  /** Off-heap native allocations tracked by the runtime, bytes. */
  externalBytes: number;
  /**
   * Private/committed bytes — the counter that actually blows up in the field case. `null` when the
   * platform has no cheap probe (callers fall back to rssBytes for pressure math).
   */
  committedBytes: number | null;
  /** Where committedBytes came from (diagnostics; "none" when unavailable). */
  committedSource: CommittedSource;
  /** Total physical RAM, bytes — the denominator for relative pressure thresholds. */
  totalSystemBytes: number;
}

/** Total icacls-style budget for the Windows committed probe. A slow query soft-fails to RSS. */
const WINDOWS_PROBE_TIMEOUT_MS = 2_000;

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
// Windows private-bytes probe (guarded child process)
// ---------------------------------------------------------------------------

export interface WindowsProbeResult {
  privateBytes: number | null;
  timedOut: boolean;
}

type WindowsProbeRunner = (pid: number, timeoutMs: number) => WindowsProbeResult;

function defaultWindowsProbeRunner(pid: number, timeoutMs: number): WindowsProbeResult {
  // .NET Process.PrivateMemorySize64 == Windows private (committed) bytes for this PID. Arguments
  // are passed as an array (no shell string) and the window is hidden, matching the icacls runner.
  const spawnSync = (globalThis as { Bun?: { spawnSync?: typeof import("bun").spawnSync } }).Bun?.spawnSync;
  if (!spawnSync) return { privateBytes: null, timedOut: false };
  const result = spawnSync(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid}).PrivateMemorySize64`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs, windowsHide: true },
  );
  if (result.exitedDueToTimeout) return { privateBytes: null, timedOut: true };
  if (!result.success) return { privateBytes: null, timedOut: false };
  const text = result.stdout ? result.stdout.toString().trim() : "";
  const value = Number(text);
  return { privateBytes: Number.isFinite(value) && value > 0 ? value : null, timedOut: false };
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

function committedForPlatform(): { bytes: number | null; source: CommittedSource } {
  const plat = effectivePlatform();
  if (plat === "win32") {
    const result = windowsProbeRunner(process.pid, WINDOWS_PROBE_TIMEOUT_MS);
    if (result.privateBytes !== null) return { bytes: result.privateBytes, source: "windows-private" };
    return { bytes: null, source: "none" };
  }
  if (plat === "linux") {
    const text = procStatusReader();
    const committed = text ? parseProcStatusCommitted(text) : null;
    if (committed !== null) return { bytes: committed, source: "proc-status" };
    return { bytes: null, source: "none" };
  }
  return { bytes: null, source: "none" };
}

/**
 * Read a single portable memory snapshot. Never throws: probe failures degrade to committedBytes
 * = null so the caller falls back to RSS.
 */
export function readMemorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();
  const committed = committedForPlatform();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    committedBytes: committed.bytes,
    committedSource: committed.source,
    totalSystemBytes: totalmem(),
  };
}

/** The bytes the watchdog treats as memory pressure: committed where known, else RSS. */
export function pressureBytes(snapshot: MemorySnapshot): number {
  return snapshot.committedBytes ?? snapshot.rssBytes;
}

/** The source label after the RSS fallback is applied (for diagnostics). */
export function pressureSource(snapshot: MemorySnapshot): CommittedSource {
  return snapshot.committedBytes !== null ? snapshot.committedSource : "rss-fallback";
}
