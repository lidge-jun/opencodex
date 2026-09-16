import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const TEST_TEMP_OWNER_FILE = ".opencodex-test-owner.json";
export const TEST_TEMP_RECOVERY_AGE_MS = 48 * 60 * 60 * 1000;

const TEST_TEMP_OWNER_VERSION = 1;
const TEST_TEMP_OWNER_KIND = "opencodex-test-root";
const WRAPPED_TEST_ROOT = /^opencodex-test-[A-Za-z0-9]{6}$/;
const TRANSIENT_REMOVE_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
const DEFAULT_MAX_CANDIDATES = 10_000;
const DEFAULT_MAX_TREE_ENTRIES = 250_000;
const DEFAULT_MAX_DURATION_MS = 30_000;

/** The first wait after a transient failure. Most release races clear on the first retry. */
export const REMOVE_RETRY_BASE_DELAY_MS = 50;
/** The ceiling for a single wait, so a long tail never becomes a long stall between attempts. */
export const REMOVE_RETRY_MAX_DELAY_MS = 250;
/** The total time the schedule may spend waiting on one tree. */
export const REMOVE_RETRY_BUDGET_MS = 15_000;
/** Reclaiming a stale root is opportunistic: a root that resists briefly is left for a later run. */
export const RECOVERY_REMOVE_BUDGET_MS = 150;

interface TestTempOwner {
  schemaVersion: 1;
  kind: typeof TEST_TEMP_OWNER_KIND;
  root: string;
  createdAtMs: number;
  pid: number;
  runId?: string;
}

export interface TestTempRecoveryResult {
  scanned: number;
  removed: number;
  skipped: number;
  errors: number;
  truncated: boolean;
}

type RemoveTreeOptions = Readonly<{
  budgetMs?: number;
  delays?: readonly number[];
  remove?: (path: string) => void;
  sleep?: (milliseconds: number) => void;
}>;

type RecoveryOptions = Readonly<{
  tempRoot?: string;
  platform?: NodeJS.Platform;
  nowMs?: number;
  minimumAgeMs?: number;
  maxCandidates?: number;
  maxTreeEntries?: number;
  maxDurationMs?: number;
  /** Liveness seam. A recovery test must not depend on which pids the host happens to have. */
  processIsAlive?: (pid: number) => boolean;
}>;

let automaticRecoveryAttempted = false;

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * The only name shape a reclaimable root can have.
 *
 * A broader `ocx-*` class was considered and dropped: those directories never carried an
 * ownership marker, so under the marker requirement below they could only ever be scanned and
 * skipped, and the regex wide enough to catch them was also wide enough to put an unrelated
 * tool's directory on the candidate list.
 */
function isTestTempName(name: string): boolean {
  return WRAPPED_TEST_ROOT.test(name);
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function parseOwner(path: string): TestTempOwner | null | undefined {
  const markerPath = join(path, TEST_TEMP_OWNER_FILE);
  if (!existsSync(markerPath)) return undefined;
  try {
    const marker = lstatSync(markerPath);
    if (!marker.isFile() || marker.isSymbolicLink()) return null;
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<TestTempOwner>;
    if (
      parsed.schemaVersion !== TEST_TEMP_OWNER_VERSION
      || parsed.kind !== TEST_TEMP_OWNER_KIND
      || typeof parsed.root !== "string"
      || typeof parsed.createdAtMs !== "number"
      || !Number.isFinite(parsed.createdAtMs)
      || typeof parsed.pid !== "number"
      || !Number.isSafeInteger(parsed.pid)
      || parsed.pid <= 0
      || (parsed.runId !== undefined && typeof parsed.runId !== "string")
    ) return null;
    return parsed as TestTempOwner;
  } catch {
    return null;
  }
}

function inspectTree(
  root: string,
  budget: { entries: number; deadlineMs: number; now: () => number },
): { safe: boolean; latestMtimeMs: number } {
  const pending = [root];
  let latestMtimeMs = 0;
  while (pending.length > 0) {
    if (budget.entries <= 0 || budget.now() > budget.deadlineMs) {
      return { safe: false, latestMtimeMs };
    }
    const current = pending.pop()!;
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(current);
    } catch {
      return { safe: false, latestMtimeMs };
    }
    budget.entries -= 1;
    latestMtimeMs = Math.max(latestMtimeMs, entry.mtimeMs);
    if (entry.isSymbolicLink()) return { safe: false, latestMtimeMs };
    if (!entry.isDirectory()) continue;
    let children: string[];
    try {
      children = readdirSync(current);
    } catch {
      return { safe: false, latestMtimeMs };
    }
    for (const child of children) pending.push(join(current, child));
  }
  return { safe: true, latestMtimeMs };
}

/**
 * The waits between removal attempts: exponential from the base delay, capped, bounded by budget.
 *
 * The predecessor was flat -- 50 attempts at 50ms, so 2.5 seconds total. That budget was tuned on
 * a lightly loaded machine and six concurrent Windows shards exceed it, at which point the helper
 * rethrows the EPERM it exists to absorb and fails a test that had already finished asserting
 * (#4789). Growing the wait instead of the attempt count is what buys a long tail without paying
 * for it in the common case: the first retry still lands at 50ms, and a removal that succeeds on
 * its first attempt never sleeps at all, so nothing on the passing path gets slower.
 */
export function removeRetrySchedule(budgetMs: number = REMOVE_RETRY_BUDGET_MS): number[] {
  const delays: number[] = [];
  let spent = 0;
  let delay = REMOVE_RETRY_BASE_DELAY_MS;
  while (spent + delay <= budgetMs) {
    delays.push(delay);
    spent += delay;
    delay = Math.min(delay * 2, REMOVE_RETRY_MAX_DELAY_MS);
  }
  return delays;
}

/** Remove a test-owned tree while tolerating only transient Windows release races. */
export function removeTestTempTree(path: string, options: RemoveTreeOptions = {}): void {
  const delays = options.delays ?? removeRetrySchedule(options.budgetMs);
  const remove = options.remove ?? (target => rmSync(target, { recursive: true, force: true }));
  const sleep = options.sleep ?? Bun.sleepSync;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      remove(path);
      return;
    } catch (error) {
      if (!TRANSIENT_REMOVE_CODES.has(errorCode(error)) || attempt === delays.length) throw error;
      sleep(delays[attempt]!);
    }
  }
}

/** Stamp a newly created root so future runs can prove its OpenCodex test ownership. */
export function writeTestTempOwner(root: string, runId?: string): void {
  const owner: TestTempOwner = {
    schemaVersion: TEST_TEMP_OWNER_VERSION,
    kind: TEST_TEMP_OWNER_KIND,
    root: realpathSync(root),
    createdAtMs: Date.now(),
    pid: process.pid,
    ...(runId ? { runId } : {}),
  };
  const temporary = join(root, `.${TEST_TEMP_OWNER_FILE}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(owner) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, join(root, TEST_TEMP_OWNER_FILE));
}

/**
 * Reclaim stale Windows test roots this tool can PROVE it owns.
 *
 * Ownership is the marker, not the name. A directory that merely looks like ours is scanned and
 * skipped: the accumulation already on a user's machine was written by versions that stamped
 * nothing, and deleting it on a name match would be this tool cleaning a TEMP tree it cannot
 * show it created. This release therefore changes future runs -- a root stamped by the code
 * below is reclaimable, everything older is left alone.
 *
 * On top of the marker: an exact mkdtemp-shaped name, a 48-hour grace period, direct-parent
 * containment, a dead owning pid, and a full no-link walk are all required before removal.
 * Invalid ownership metadata fails closed.
 */
export function recoverStaleTestTempArtifacts(options: RecoveryOptions = {}): TestTempRecoveryResult {
  const result: TestTempRecoveryResult = {
    scanned: 0,
    removed: 0,
    skipped: 0,
    errors: 0,
    truncated: false,
  };
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return result;

  const nowMs = options.nowMs ?? Date.now();
  const isAlive = options.processIsAlive ?? processIsAlive;
  const minimumAgeMs = options.minimumAgeMs ?? TEST_TEMP_RECOVERY_AGE_MS;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const deadlineMs = Date.now() + (options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
  const budget = {
    entries: options.maxTreeEntries ?? DEFAULT_MAX_TREE_ENTRIES,
    deadlineMs,
    now: Date.now,
  };

  let tempRoot: string;
  try {
    tempRoot = realpathSync(options.tempRoot ?? tmpdir());
  } catch {
    result.errors += 1;
    return result;
  }

  let names: string[];
  try {
    names = readdirSync(tempRoot).sort();
  } catch {
    result.errors += 1;
    return result;
  }

  for (const name of names) {
    if (!isTestTempName(name)) continue;
    if (result.scanned >= maxCandidates || Date.now() > deadlineMs || budget.entries <= 0) {
      result.truncated = true;
      break;
    }
    result.scanned += 1;
    const candidate = join(tempRoot, name);
    try {
      const rootEntry = lstatSync(candidate);
      if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
        result.skipped += 1;
        continue;
      }
      const canonicalCandidate = realpathSync(candidate);
      if (!samePath(dirname(canonicalCandidate), tempRoot, platform)) {
        result.skipped += 1;
        continue;
      }

      // An absent marker is as disqualifying as a corrupt one. `undefined` used to mean "no
      // evidence either way, proceed on the name", which is exactly the name match this must not
      // be.
      const owner = parseOwner(candidate);
      if (!owner || !samePath(owner.root, canonicalCandidate, platform)) {
        result.skipped += 1;
        continue;
      }
      if (isAlive(owner.pid)) {
        result.skipped += 1;
        continue;
      }
      const rootActivityMs = Math.max(statSync(candidate).mtimeMs, owner.createdAtMs);
      if (nowMs - rootActivityMs < minimumAgeMs) {
        result.skipped += 1;
        continue;
      }
      const tree = inspectTree(candidate, budget);
      if (!tree.safe) {
        result.skipped += 1;
        if (Date.now() > deadlineMs || budget.entries <= 0) result.truncated = true;
        continue;
      }
      if (nowMs - Math.max(rootActivityMs, tree.latestMtimeMs) < minimumAgeMs) {
        result.skipped += 1;
        continue;
      }

      removeTestTempTree(candidate, { budgetMs: RECOVERY_REMOVE_BUDGET_MS });
      result.removed += 1;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") result.errors += 1;
    }
  }

  return result;
}

/** Run automatic recovery once per process, before the process creates its own test root. */
export function recoverStaleTestTempArtifactsOnce(
  options: RecoveryOptions = {},
): TestTempRecoveryResult | null {
  if (automaticRecoveryAttempted) return null;
  automaticRecoveryAttempted = true;
  return recoverStaleTestTempArtifacts(options);
}

/** Create the contained temp subtree used by every os.tmpdir() call in the child test process. */
export function createContainedTestTemp(root: string): string {
  const contained = join(root, "tmp");
  mkdirSync(contained, { recursive: true });
  return contained;
}
