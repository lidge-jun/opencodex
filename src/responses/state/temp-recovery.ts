import { opendirSync, lstatSync, unlinkSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { getConfigDir, resolveWriteTarget } from "../../config";

const STALE_TEMP_GRACE_MS = 15 * 60 * 1_000;
const STALE_TEMP_MAX_ENTRIES = 4_096;
const STALE_TEMP_MAX_CLEANUPS = 512;
/** Absorbs `os.uptime()` granularity only. It is deliberately NOT the safety margin:
 *  the unconditional 15-minute grace above is (see the boot floor in the scan loop). */
const BOOT_FLOOR_SKEW_MS = 60 * 1_000;
/** Per-tick budget for the periodic reclaim. Smaller than the startup budget because the
 *  periodic pass runs synchronously on the serving process's event loop every 60 s. */
const PERIODIC_TEMP_MAX_ENTRIES = 512;
const PERIODIC_TEMP_MAX_CLEANUPS = 64;
/** Wall-clock ceiling for one periodic scan. An entry cap bounds syscalls, not time: on a
 *  network-mounted config dir each `lstat` can cost 10-20 ms, which would stall in-flight
 *  streams. Reclaim is idempotent, so a truncated tick simply resumes on the next one. */
const PERIODIC_TEMP_SCAN_DEADLINE_MS = 25;
const RESPONSE_STATE_TEMP_NAME = /^responses-state\.json\.ocx\.(\d+)\.(\d+)\.tmp$/;

export interface ResponseStateTempRecoveryResult {
  matched: number;
  removed: number;
  failed: number;
  bytesRemoved: number;
  /** Entries that passed EVERY gate and would be reclaimed. In a dry run nothing is
   *  unlinked, so this is the only honest count to show an operator: `matched` is
   *  incremented before the file-type, age, boot-floor, and liveness gates. */
  eligible: number;
  /** Total size of the `eligible` entries. */
  eligibleBytes: number;
  /** The scan stopped on a budget (entry cap, cleanup cap, or deadline) rather than reaching
   *  the end of the directory, so the counts below describe a prefix of the backlog and not
   *  the backlog. `eligible > removed + failed` cannot express this: outside a dry run every
   *  eligible entry is unlinked or failed on the same iteration, so the two are always equal
   *  and a comparison between them is dead code. */
  truncated: boolean;
}

interface ResponseStateTempRecoveryIO {
  now: () => number;
  /** Approximate epoch ms of the current boot; see the boot floor in the scan loop. */
  bootTime: () => number;
  list: (dir: string) => Iterable<string>;
  inspect: (path: string) => { isFile: boolean; mtimeMs: number; size: number };
  isProcessAlive: (pid: number) => boolean;
  unlink: (path: string) => void;
}

export type ResponseStateTempRecoveryOptions = Partial<ResponseStateTempRecoveryIO> & {
  maxEntries?: number;
  maxCleanups?: number;
  /** Wall-clock ceiling for the scan, or null/undefined for no deadline (startup path). */
  deadlineMs?: number | null;
  /** Report only: apply every gate, count what would be reclaimed, unlink nothing. */
  dryRun?: boolean;
};

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled. Unknown platform errors
    // are also protected; cleanup should prefer a false negative over touching a live writer.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const responseStateTempRecoveryIO: ResponseStateTempRecoveryIO = {
  now: Date.now,
  bootTime: () => Date.now() - uptime() * 1_000,
  list: function* list(dir) {
    const handle = opendirSync(dir);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) yield entry.name;
    } finally {
      handle.closeSync();
    }
  },
  inspect: path => {
    const stat = lstatSync(path);
    return { isFile: stat.isFile() && !stat.isSymbolicLink(), mtimeMs: stat.mtimeMs, size: stat.size };
  },
  isProcessAlive: processIsAlive,
  unlink: unlinkSync,
};

/**
 * Recover only abandoned response-state atomic-write files. The exact basename,
 * regular-file check, age gate, and PID liveness check protect unrelated/active files.
 * Cleanup is capped and best-effort because continuation state is only a cache. Removal
 * deliberately uses unlink only: path-based truncation could follow a replacement symlink.
 */
export function recoverStaleResponseStateTemps(
  dir = getConfigDir(),
  options: ResponseStateTempRecoveryOptions = {},
): ResponseStateTempRecoveryResult {
  const {
    maxEntries = STALE_TEMP_MAX_ENTRIES,
    maxCleanups = STALE_TEMP_MAX_CLEANUPS,
    deadlineMs = null,
    dryRun = false,
    ...overrides
  } = options;
  const io = { ...responseStateTempRecoveryIO, ...overrides };
  const result: ResponseStateTempRecoveryResult = {
    matched: 0,
    removed: 0,
    failed: 0,
    bytesRemoved: 0,
    eligible: 0,
    eligibleBytes: 0,
    truncated: false,
  };
  const startedAt = io.now();
  // One probe per scan, not one per entry. A non-finite or future-dated boot is anomalous, and
  // clamping it to "now" would be the WORST response: the floor would then retire the liveness
  // probe for every file older than the skew, which is every file past the grace. Disable it
  // instead -- an absent floor only costs a missed reclaim, never a wrong one.
  const rawBoot = io.bootTime();
  const bootMs = Number.isFinite(rawBoot) && rawBoot <= startedAt ? rawBoot : Number.NEGATIVE_INFINITY;
  let names: Iterable<string>;
  try { names = io.list(dir); } catch { return result; }
  let iterator: Iterator<string>;
  try { iterator = names[Symbol.iterator](); } catch { return result; }
  let scanned = 0;
  // Every early exit runs through this. The production `list` is a generator that closes its
  // directory handle in a `finally`, and a `finally` does NOT run when the consumer simply
  // stops calling `next()` -- only `return()` resumes the generator to completion. Breaking
  // out of the loop directly therefore leaked one directory handle per truncated scan, and the
  // periodic reclaim truncates on purpose (entry cap, cleanup cap, deadline), so on a slow
  // filesystem that is a leak per tick, forever.
  const stopScan = (): ResponseStateTempRecoveryResult => {
    try { iterator.return?.(); } catch { /* closing is best-effort; never fail a reclaim on it */ }
    return result;
  };
  for (;;) {
    let next: IteratorResult<string>;
    try { next = iterator.next(); } catch { return result; }
    if (next.done) break;
    const name = next.value;
    scanned += 1;
    // A dry run performs no cleanups, so bounding it by the cleanup budget would truncate
    // the very report an operator uses to size the problem.
    if (scanned > maxEntries) { result.truncated = true; return stopScan(); }
    if (!dryRun && result.removed + result.failed >= maxCleanups) { result.truncated = true; return stopScan(); }
    if (deadlineMs !== null && io.now() - startedAt > deadlineMs) { result.truncated = true; return stopScan(); }
    const match = RESPONSE_STATE_TEMP_NAME.exec(name);
    if (!match) continue;
    result.matched += 1;
    const pid = Number(match[1]);
    const sequence = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(sequence) || sequence <= 0) continue;
    const path = join(dir, name);
    let file: ReturnType<ResponseStateTempRecoveryIO["inspect"]>;
    try { file = io.inspect(path); } catch { continue; }
    if (!file.isFile || io.now() - file.mtimeMs < STALE_TEMP_GRACE_MS) continue;
    // Boot floor. After a reboot the original writer's pid is routinely reused, which makes
    // the liveness skip PERMANENT: the 15-minute grace above is a lower bound and never
    // expires it, so the file is skipped on every future pass forever. A temp older than
    // this boot cannot be owned by the pid we would probe, so the probe is vacuous and we
    // retire it. This does NOT claim the file is provably dead: under a shared-volume
    // container, suspend-excluding uptime, or a network config dir the computed boot can
    // land after the real one. The unconditional 15-minute grace above remains the safety
    // floor, and this process's own temps are never touched.
    const predatesBoot = file.mtimeMs < bootMs - BOOT_FLOOR_SKEW_MS;
    if (pid === process.pid) continue;
    if (!predatesBoot && io.isProcessAlive(pid)) continue;

    result.eligible += 1;
    result.eligibleBytes += file.size;
    if (dryRun) continue;

    try {
      io.unlink(path);
      result.removed += 1;
      result.bytesRemoved += file.size;
    } catch (error) {
      // Another proxy sharing this config dir may have won the race. A file that is already
      // gone is reclaimed, not a failure -- reporting it as one would surface "in use or
      // locked" to an operator for a file nobody holds.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        result.removed += 1;
        continue;
      }
      // Locked files remain for a later startup. Do not truncate by path: a same-user
      // replacement could turn that fallback into an arbitrary symlink-target write.
      result.failed += 1;
    }
  }
  return result;
}

/**
 * Literal config dir plus the snapshot's resolved dir. Atomic writes place their temp beside
 * the RESOLVED target, so a symlinked snapshot (dotfiles-managed config dir) strands temps in
 * the link's real directory where a scan of the literal dir would never see them. The two
 * collapse to one when nothing is symlinked.
 */
function responseStateSweepDirectories(): Set<string> {
  const path = join(getConfigDir(), "responses-state.json");
  let resolvedDir = dirname(path);
  try {
    resolvedDir = dirname(resolveWriteTarget(path));
  } catch {
    /* unresolvable link: sweep the literal dir only */
  }
  return new Set([dirname(path), resolvedDir]);
}

export function reclaimAbandonedResponseStateTemps(
  options: ResponseStateTempRecoveryOptions = {},
): ResponseStateTempRecoveryResult {
  const total: ResponseStateTempRecoveryResult = {
    matched: 0, removed: 0, failed: 0, bytesRemoved: 0, eligible: 0, eligibleBytes: 0, truncated: false,
  };
  // The try encloses responseStateSweepDirectories() deliberately: recoverStaleResponseStateTemps
  // already swallows its own enumeration failures, so a catch around only that call would be
  // unreachable. snapshotPath()/getConfigDir() are the paths that can genuinely throw.
  try {
    for (const dir of responseStateSweepDirectories()) {
      const result = recoverStaleResponseStateTemps(dir, options);
      total.matched += result.matched;
      total.removed += result.removed;
      total.failed += result.failed;
      total.bytesRemoved += result.bytesRemoved;
      total.eligible += result.eligible;
      total.eligibleBytes += result.eligibleBytes;
      // Truncation anywhere makes the whole total a prefix.
      total.truncated ||= result.truncated;
    }
  } catch {
    /* best-effort: disk reclaim must never destabilize the caller */
  }
  return total;
}

/**
 * Report-only counterpart for `ocx doctor`: applies every selection gate and unlinks
 * nothing. It runs the SAME predicate as the reclaim, so the report and the subsequent
 * removal cannot disagree about which files are reclaimable.
 */
export function inspectAbandonedResponseStateTemps(): ResponseStateTempRecoveryResult {
  return reclaimAbandonedResponseStateTemps({ dryRun: true });
}

/** Sweeper adapter: narrows the reclaim to the `() => number` the liveness tick expects. */
export function sweepAbandonedResponseStateTemps(): number {
  return reclaimAbandonedResponseStateTemps({
    maxEntries: PERIODIC_TEMP_MAX_ENTRIES,
    maxCleanups: PERIODIC_TEMP_MAX_CLEANUPS,
    deadlineMs: PERIODIC_TEMP_SCAN_DEADLINE_MS,
  }).removed;
}
