/**
 * Lock owner for the Windows nested live-lock regression (issue #4991).
 *
 * The regression in tests/ci-workflows/test-runner.test.ts proves that a nested Bun test
 * inherits the live test-run lock exactly and refuses an incomplete capability. It used
 * to read that capability out of its own environment, so it could only run while the
 * outer process already held a lock — and the hosted Windows batch leg sets
 * OCX_TEST_NO_QUEUE=1 precisely so that it does not. The case was therefore skipped on
 * the only platform it applies to, and the coverage existed on paper only.
 *
 * This controller supplies the missing holder instead of borrowing the lane's. It runs as
 * a plain "bun <file>" child with exactly one environment change — the no-queue opt-out
 * removed for this process and its descendants — resolves the user-scoped lock through
 * the ordinary safe path, and acquires it for its own run id. When a wrapped or bare
 * Windows run has already published a complete capability it joins that owner instead,
 * because a second owner for one path is the clobber this suite exists to prevent.
 * Nothing here writes an owner file by hand: a fabricated capability would only prove
 * that a child trusts what it is told, which is the inverse of the contract under test.
 *
 * Three things about how it is launched are load-bearing. It must be spawned with a cwd
 * OUTSIDE the repository so Bun loads no bunfig preload into the holder itself; a
 * preloaded controller would take the same lock in tests/preload.ts and then wait on
 * itself. It must be handed a temporary root it may write into, because every fixture it
 * generates and the foreign-owner probe it plants live there. And it must be handed both
 * a deadline and the caller's spawn options: the nominal per-child timeout belongs to the
 * case that owns these children, and the controller only narrows it to what is left of
 * the deadline minus a cleanup reserve, so the controller always reaches its own teardown
 * rather than being killed inside a spawn with the lock still held.
 *
 * Everything below runs only as an entry point. The test file imports the receipt key
 * from here, and an import must not acquire a lock or spawn anything.
 *
 * Output is one JSON line of booleans plus diagnostics with every UUID-shaped substring
 * removed. Child output is parsed, never echoed.
 */
import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import {
  acquireTestRunLock,
  resolveWrappedTestRunLockPath,
  TEST_RUN_ID_ENV,
  TEST_RUN_LOCK_PATH_ENV,
  TEST_RUN_LOCK_TOKEN_ENV,
  TEST_RUN_NO_QUEUE_ENV,
  type TestRunLock,
} from "../../scripts/test-run-lock";
import { repoPath } from "./repo-root";

/** Shape the caller asserts on; every field must be true for the case to pass. */
export interface NestedLiveLockReceipt {
  lockHeld: boolean;
  healthyChildExited: boolean;
  healthyReceiptComplete: boolean;
  missingTokenRefused: boolean;
  wrongTokenRefused: boolean;
  wrongPathRefused: boolean;
  foreignOwnerTimedOut: boolean;
  foreignOwnerUntouched: boolean;
  ownerContentUnchanged: boolean;
  childrenReaped: boolean;
  releasedOnlyOwnLock: boolean;
  receiptRedacted: boolean;
}

export const NESTED_LIVE_LOCK_RECEIPT_KEY = "nestedLiveLockReceipt";
const CHILD_MARKER = '{"nestedLockReceipt":';
const CHILD_RECEIPT_KEYS = ["samePath", "sameRun", "sameToken", "member", "preloadRan", "guardArmed"] as const;
/** Healthy, missing token, foreign token, foreign path. A short count means one was skipped. */
const EXPECTED_CHILD_SPAWNS = 4;
const ACQUIRE_POLL_MS = 250;
const ACQUIRE_MAX_WAIT_MS = 10_000;
const FOREIGN_POLL_MS = 100;
const FOREIGN_MAX_WAIT_MS = 300;
/** Time kept back from every child so teardown runs before the caller's hard kill. */
const CLEANUP_RESERVE_MS = 4_000;
const MINIMUM_CHILD_ALLOWANCE_MS = 1_000;
/**
 * Any UUID, not merely the token this process knows about. Several errors in
 * scripts/test-run-lock.ts can carry a member filename, and one of them is reachable
 * before acquire returns, so a redactor keyed on our own token would be blind exactly
 * where a leak is possible. Built fresh per call because a global regex carries
 * lastIndex between a replace and a test.
 */
const uuidPattern = (): RegExp => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

interface ChildSpawnOptions {
  timeout: number;
}

async function runNestedLiveLockController(
  tempRoot: string | undefined,
  deadlineAt: number,
  childSpawn: ChildSpawnOptions | undefined,
): Promise<void> {
  const receipt: NestedLiveLockReceipt = {
    lockHeld: false,
    healthyChildExited: false,
    healthyReceiptComplete: false,
    missingTokenRefused: false,
    wrongTokenRefused: false,
    wrongPathRefused: false,
    foreignOwnerTimedOut: false,
    foreignOwnerUntouched: false,
    ownerContentUnchanged: false,
    childrenReaped: false,
    releasedOnlyOwnLock: false,
    receiptRedacted: false,
  };
  const diagnostics: string[] = [];
  const note = (message: string): void => { diagnostics.push(message); };
  const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  const budgetLeftMs = (): number => deadlineAt - Date.now() - CLEANUP_RESERVE_MS;
  let lock: TestRunLock | undefined;
  let ownerFile: string | undefined;
  let ownerBefore: string | undefined;
  let ownerToken: string | undefined;
  let foreignOwnerFile: string | undefined;
  let foreignOwner: string | undefined;
  // Whether each spawned child was waited on, which is what reaping means for spawnSync.
  const settledChildren: boolean[] = [];

  try {
    if (process.platform !== "win32") throw new Error("the nested live-lock controller is Windows-only");
    if (!tempRoot) throw new Error("the nested live-lock controller needs a temporary root argument");
    if (!Number.isFinite(deadlineAt)) throw new Error("the nested live-lock controller needs a deadline argument");
    if (!childSpawn || !Number.isFinite(childSpawn.timeout) || childSpawn.timeout <= 0) {
      throw new Error("the nested live-lock controller needs the caller's child spawn options");
    }
    if (process.env[TEST_RUN_NO_QUEUE_ENV] !== undefined) {
      throw new Error("the controller environment must have the no-queue opt-out removed");
    }

    // A wrapped or bare Windows run already holds this lock and handed us its complete
    // capability, so join it. The hosted no-queue lane has no such holder, and there we
    // resolve and acquire one of our own.
    const inheritedPath = process.env[TEST_RUN_LOCK_PATH_ENV]?.trim();
    const inheritedToken = process.env[TEST_RUN_LOCK_TOKEN_ENV]?.trim();
    const inheritedRunId = process.env[TEST_RUN_ID_ENV]?.trim();
    const joining = Boolean(inheritedPath && inheritedToken && inheritedRunId);
    // Known before the join can fail, so a failure inside registerMember cannot reach the
    // diagnostics with a live token the redactor has not been told about.
    if (joining) ownerToken = inheritedToken;
    const resolved = joining ? inheritedPath : resolveWrappedTestRunLockPath({ env: process.env });
    if (!resolved) throw new Error("the user-scoped Bun test lock path did not resolve");
    const lockPath = resolved;
    const runId = joining && inheritedRunId ? inheritedRunId : "nested-live-lock-" + randomUUID();

    lock = await acquireTestRunLock({
      runId,
      lockPath,
      validatedRuntimePath: true,
      env: process.env,
      joinExistingOwnerToken: joining ? inheritedToken : undefined,
      pollMs: ACQUIRE_POLL_MS,
      maxWaitMs: Math.max(ACQUIRE_POLL_MS, Math.min(ACQUIRE_MAX_WAIT_MS, budgetLeftMs())),
    });
    const owner = lock.owner;
    if (!owner) throw new Error("the run lock produced no owner record");
    ownerToken = owner.token;
    receipt.lockHeld = true;

    // Publish the capability into our own environment so the children below inherit it the
    // way any descendant of a real run does, rather than being handed a constructed one.
    process.env[TEST_RUN_ID_ENV] = runId;
    process.env[TEST_RUN_LOCK_PATH_ENV] = lockPath;
    process.env[TEST_RUN_LOCK_TOKEN_ENV] = owner.token;

    const activeOwnerFile = join(lockPath, "owner.json");
    const activeOwnerBefore = readFileSync(activeOwnerFile, "utf8");
    ownerFile = activeOwnerFile;
    ownerBefore = activeOwnerBefore;
    receipt.ownerContentUnchanged = true;
    const confirmOwnerUnchanged = (): void => {
      const current = existsSync(activeOwnerFile) ? readFileSync(activeOwnerFile, "utf8") : null;
      if (current === activeOwnerBefore) return;
      receipt.ownerContentUnchanged = false;
      note("the owner receipt changed while a nested child ran");
    };

    const fixture = join(tempRoot, "nested-live-lock.test.ts");
    writeFileSync(fixture, [
      'import { test } from "bun:test";',
      'import { existsSync, readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'test("nested lock receipt", () => {',
      '  const path = process.env.OCX_TEST_RUN_LOCK_PATH ?? "";',
      '  const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));',
      "  console.log(JSON.stringify({ nestedLockReceipt: {",
      "    samePath: path === " + JSON.stringify(lockPath) + ",",
      "    sameRun: owner.runId === " + JSON.stringify(runId)
        + " && process.env.OCX_TEST_RUN_ID === " + JSON.stringify(runId) + ",",
      "    sameToken: owner.token === process.env.OCX_TEST_RUN_LOCK_TOKEN,",
      '    member: existsSync(join(path, "members", process.pid + "-" + owner.token)),',
      "    preloadRan: process.env.OCX_TEST_PRELOAD_PID === String(process.pid),",
      '    guardArmed: process.env.OCX_TEST_HOME_GUARD === "1",',
      "  } }));",
      "});",
      "",
    ].join("\n"));

    const args = ["test", "--preload", repoPath("tests", "preload.ts"), fixture];
    const runChild = (label: string, mutate?: (env: NodeJS.ProcessEnv) => void): SpawnSyncReturns<string> => {
      const allowance = Math.min(childSpawn.timeout, budgetLeftMs());
      if (allowance < MINIMUM_CHILD_ALLOWANCE_MS) {
        throw new Error("the controller ran out of budget before spawning " + label);
      }
      const env = { ...process.env };
      // Drop the two receipts the child is supposed to produce for itself. Inherited, they
      // would report a preload that never ran and a guard nobody armed.
      delete env.OCX_TEST_PRELOAD_PID;
      delete env.OCX_TEST_HOME_GUARD;
      mutate?.(env);
      const result = spawnSync(process.execPath, args, {
        cwd: tempRoot, env, encoding: "utf8", timeout: Math.floor(allowance),
      });
      // spawnSync returns only after the child has been waited on, so a settled status or
      // signal IS the reap. A liveness probe on the pid would be a race against pid reuse.
      settledChildren.push(result.status !== null || result.signal !== null);
      return result;
    };
    const refusal = (result: SpawnSyncReturns<string>, needle: string, label: string): boolean => {
      const refused = result.status !== 0
        && (result.stderr ?? "").includes(needle)
        && !(result.stdout ?? "").includes(CHILD_MARKER);
      if (!refused) note(label + " was not refused (status " + String(result.status) + ")");
      return refused;
    };

    const healthy = runChild("the healthy child");
    receipt.healthyChildExited = healthy.status === 0;
    if (!receipt.healthyChildExited) {
      note("the healthy child exited with status " + String(healthy.status) + " signal " + String(healthy.signal));
    }
    const marker = (healthy.stdout ?? "").split("\n").find(line => line.startsWith(CHILD_MARKER));
    const nested = marker
      ? (JSON.parse(marker) as { nestedLockReceipt?: Record<string, unknown> }).nestedLockReceipt
      : undefined;
    receipt.healthyReceiptComplete = nested !== undefined
      && CHILD_RECEIPT_KEYS.every(key => nested[key] === true);
    if (!receipt.healthyReceiptComplete) note("nested receipt: " + JSON.stringify(nested ?? null));
    confirmOwnerUnchanged();

    receipt.missingTokenRefused = refusal(
      runChild("the tokenless child", env => { delete env[TEST_RUN_LOCK_TOKEN_ENV]; }),
      "capability is incomplete",
      "a child holding no token",
    );
    confirmOwnerUnchanged();

    receipt.wrongTokenRefused = refusal(
      runChild("the foreign-token child", env => { env[TEST_RUN_LOCK_TOKEN_ENV] = randomUUID(); }),
      "exact live owner no longer matches",
      "a child holding a foreign token",
    );
    confirmOwnerUnchanged();

    receipt.wrongPathRefused = refusal(
      runChild("the foreign-path child", env => {
        env[TEST_RUN_LOCK_PATH_ENV] = win32.join(win32.dirname(lockPath), "opencodex-bun-test-not-this-host.lock");
      }),
      "refusing inherited lock access",
      "a child holding a foreign lock path",
    );
    confirmOwnerUnchanged();

    // The acquire path must wait out a live owner it does not own and then give up rather
    // than reclaim it. Planted under the temporary root so the probe can never reach the
    // real lock, and owned by this very pid so its liveness is a fact, not a fixture.
    const foreignLock = join(tempRoot, "foreign-owner.lock");
    mkdirSync(foreignLock, { recursive: true, mode: 0o700 });
    const plantedFile = join(foreignLock, "owner.json");
    const planted = JSON.stringify({
      version: 1,
      runId: "foreign-" + randomUUID(),
      token: randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }) + "\n";
    writeFileSync(plantedFile, planted, { encoding: "utf8", mode: 0o600 });
    foreignOwnerFile = plantedFile;
    foreignOwner = planted;
    const probeStartedAt = Date.now();
    try {
      await acquireTestRunLock({
        runId: "timeout-probe-" + randomUUID(),
        lockPath: foreignLock,
        env: process.env,
        pollMs: FOREIGN_POLL_MS,
        maxWaitMs: FOREIGN_MAX_WAIT_MS,
      });
      note("the controller took a lock a live foreign owner still held");
    } catch (error) {
      // The elapsed floor is the point: an immediate refusal would satisfy the message
      // alone while proving nothing about waiting for the holder.
      receipt.foreignOwnerTimedOut = describeError(error).includes("timed out after")
        && Date.now() - probeStartedAt >= FOREIGN_MAX_WAIT_MS;
      if (!receipt.foreignOwnerTimedOut) note("unexpected foreign-owner failure: " + describeError(error));
    }
    receipt.foreignOwnerUntouched = existsSync(plantedFile)
      && readFileSync(plantedFile, "utf8") === planted;
    confirmOwnerUnchanged();
  } catch (error) {
    note("controller failure: " + describeError(error));
  } finally {
    receipt.childrenReaped = settledChildren.length === EXPECTED_CHILD_SPAWNS
      && settledChildren.every(Boolean);
    try {
      // Releasing must remove our own lock and nothing else, so the planted foreign owner
      // is re-read afterwards rather than only before.
      const foreignIntact = foreignOwnerFile === undefined
        || (existsSync(foreignOwnerFile) && readFileSync(foreignOwnerFile, "utf8") === foreignOwner);
      if (lock?.acquired) {
        lock.release();
        receipt.releasedOnlyOwnLock = ownerFile !== undefined && !existsSync(ownerFile) && foreignIntact;
      } else if (lock && ownerFile !== undefined && ownerBefore !== undefined) {
        // Joined rather than acquired: leaving the other holder exactly as found IS the claim.
        receipt.releasedOnlyOwnLock = existsSync(ownerFile)
          && readFileSync(ownerFile, "utf8") === ownerBefore
          && foreignIntact;
      }
    } catch (error) {
      note("release failure: " + describeError(error));
    }

    const body = {
      [NESTED_LIVE_LOCK_RECEIPT_KEY]: receipt,
      diagnostics: diagnostics.map(entry => entry.replace(uuidPattern(), "<redacted>")),
    };
    receipt.receiptRedacted = !uuidPattern().test(JSON.stringify(body));
    process.stdout.write(JSON.stringify(body) + "\n");
    process.exitCode = diagnostics.length === 0 && Object.values(receipt).every(Boolean) ? 0 : 1;
  }
}

if (import.meta.main) {
  const spawnOptions = process.argv[4]
    ? JSON.parse(process.argv[4]) as ChildSpawnOptions
    : undefined;
  await runNestedLiveLockController(process.argv[2], Number(process.argv[3]), spawnOptions);
}
