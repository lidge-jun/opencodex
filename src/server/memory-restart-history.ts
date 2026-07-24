/**
 * Cross-process memory-restart history (best-effort).
 *
 * WHY: the watchdog's cooldown (minRestartIntervalMs) and cap (maxRestarts) live in process
 * memory, and a memory-driven restart ENDS the process — so without persistence every freshly
 * respawned proxy would start with a clean slate and the two guards could never bind across the
 * very restarts they exist to rate-limit. This module persists ONLY the restart decision
 * timestamps (epoch ms — no request data, no config values, no secrets) so a new process can
 * seed its cooldown clock and its restarts-in-window count.
 *
 * SAFETY MODEL:
 *   - Best-effort cache, never a source of truth: every read/write failure (missing file,
 *     corrupt JSON, wrong schema, permission error) is swallowed. Degradation is exactly the
 *     pre-persistence behavior — per-process guards plus whatever restart throttling the
 *     supervisor applies. History I/O must never block or fail a restart, or app startup.
 *   - Write is temp + renameAtomicFile (the vetted Windows EBUSY/EPERM-retry rename).
 *     atomicWriteFile is deliberately NOT reused: it NTFS-hardens with required:true (icacls),
 *     which exists for secret-bearing files and can stall for seconds on Windows — the wrong
 *     trade for a timestamps-only file written while memory is already critical.
 *   - Bounded: entries older than RESTART_HISTORY_WINDOW_MS (or in the future — a clock
 *     rollback must not pin the cooldown forever) are dropped on every read, and the file
 *     never holds more than HISTORY_MAX_ENTRIES entries.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir, renameAtomicFile } from "../config";

/**
 * Rolling window over which persisted restarts count toward maxRestarts. Six hours: with the
 * default 10-minute cooldown a pathological workload can burn maxRestarts (3) in ~30 minutes;
 * after that the watchdog degrades to warn-only until the oldest entry ages out, instead of
 * churning restarts all day. A leak that only re-crosses critical hours later still restarts.
 */
export const RESTART_HISTORY_WINDOW_MS = 6 * 3_600_000;

const HISTORY_MAX_ENTRIES = 20;
const HISTORY_VERSION = 1;

let pathOverride: string | null = null;

/** Test seam: redirect the history file. Pass null to restore the default location. */
export function setRestartHistoryPathForTests(path: string | null): void {
  pathOverride = path;
}

function historyPath(): string {
  return pathOverride ?? join(getConfigDir(), "memory-watchdog-restarts.json");
}

/** Read, validate, and prune the persisted timestamps. Any failure yields []. */
function readTimestamps(nowMs: number): number[] {
  try {
    const path = historyPath();
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; restarts?: unknown };
    if (raw.version !== HISTORY_VERSION || !Array.isArray(raw.restarts)) return [];
    return raw.restarts
      .filter((t): t is number => typeof t === "number" && Number.isFinite(t))
      .filter(t => t <= nowMs && t > nowMs - RESTART_HISTORY_WINDOW_MS)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export interface SeededRestartHistory {
  /** Newest persisted decision timestamp (seeds the cooldown clock), or 0 when none. */
  lastRestartAt: number;
  /** Persisted restarts inside the rolling window (seeds the maxRestarts count). */
  recentCount: number;
}

/** Seed values for a fresh process. Missing/corrupt history degrades to { 0, 0 }. */
export function loadMemoryRestartHistory(nowMs: number): SeededRestartHistory {
  const ts = readTimestamps(nowMs);
  return { lastRestartAt: ts.length > 0 ? ts[ts.length - 1]! : 0, recentCount: ts.length };
}

/** Append a restart decision timestamp. Best-effort: every failure is swallowed. */
export function recordMemoryRestart(atMs: number): void {
  try {
    const restarts = [...readTimestamps(atMs), atMs].slice(-HISTORY_MAX_ENTRIES);
    const path = historyPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: HISTORY_VERSION, restarts }), "utf-8");
      renameAtomicFile(tmp, path);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
      throw err;
    }
  } catch {
    /* best-effort: history must never block the restart itself */
  }
}
