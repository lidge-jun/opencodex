import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TEST_RUN_ID_ENV = "OCX_TEST_RUN_ID";
export const TEST_RUN_NO_QUEUE_ENV = "OCX_TEST_NO_QUEUE";
const OWNER_FILE = "owner.json";
const MEMBERS_DIR = "members";
const INCOMPLETE_OWNER_GRACE_MS = 10_000;

export interface TestRunLockOwner {
  version: 1;
  runId: string;
  token: string;
  pid: number;
  acquiredAt: string;
}

export interface TestRunLock {
  acquired: boolean;
  owner: TestRunLockOwner | null;
  release(): void;
}

export interface AcquireTestRunLockOptions {
  runId: string;
  ownerPid?: number;
  lockPath?: string;
  pollMs?: number;
  maxWaitMs?: number;
  env?: NodeJS.ProcessEnv;
  onWait?: (owner: TestRunLockOwner | null) => void;
  onAcquiredAfterWait?: (elapsedMs: number) => void;
}

export interface BareTestRunIdentity {
  ownerPid: number;
  runId: string;
}

/**
 * Resolve the default lock path inside the current OS user's home.
 *
 * The lock previously lived in `tmpdir()`, which on a multi-user host is shared and
 * world-writable. Any local account could pre-create the lock directory and hold it,
 * stalling every other user's test run for the full 45-minute wait, or plant an
 * unremovable owner file. Serializing test runs is only ever needed per user, so the
 * home directory expresses the real scope and removes the cross-user surface.
 */
export function resolveDefaultTestRunLockPath(home = homedir()): string {
  return join(home, ".opencodex-bun-test.lock");
}

/**
 * Give one bare Bun invocation a stable identity without conflating sibling commands.
 *
 * Without `--parallel`, the preload runs in the test-runner process itself and its
 * parent may be a long-lived shell or agent host shared by many unrelated commands.
 * Bun parallel workers expose `BUN_TEST_WORKER_ID` and share one short-lived parent
 * controller, so only that case may safely rendezvous on the parent PID.
 */
export function resolveBareTestRunIdentity(options: {
  pid: number;
  ppid: number;
  workerId?: string;
}): BareTestRunIdentity {
  const coordinatorPid = options.workerId ? options.ppid : options.pid;
  return { ownerPid: options.pid, runId: `bare-${coordinatorPid}` };
}

function ownerPath(lockPath: string): string {
  return join(lockPath, OWNER_FILE);
}

function memberPath(lockPath: string, owner: TestRunLockOwner, pid: number): string {
  return join(lockPath, MEMBERS_DIR, `${pid}-${owner.token}`);
}

function readOwner(lockPath: string): TestRunLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(ownerPath(lockPath), "utf8")) as Partial<TestRunLockOwner>;
    if (parsed.version !== 1 || typeof parsed.runId !== "string" || typeof parsed.token !== "string"
      || !Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0 || typeof parsed.acquiredAt !== "string") {
      return null;
    }
    return parsed as TestRunLockOwner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function liveMemberExists(lockPath: string, owner: TestRunLockOwner): boolean {
  try {
    return readdirSync(join(lockPath, MEMBERS_DIR)).some(file => {
      const suffix = `-${owner.token}`;
      if (!file.endsWith(suffix)) return false;
      const pid = Number.parseInt(file.slice(0, -suffix.length), 10);
      return Number.isInteger(pid) && pid > 0 && processIsAlive(pid);
    });
  } catch {
    return false;
  }
}

function lockIsLive(lockPath: string, owner: TestRunLockOwner): boolean {
  return processIsAlive(owner.pid) || liveMemberExists(lockPath, owner);
}

function registerMember(lockPath: string, owner: TestRunLockOwner, pid: number): boolean {
  const membersPath = join(lockPath, MEMBERS_DIR);
  try {
    mkdirSync(membersPath, { recursive: true, mode: 0o700 });
    writeFileSync(memberPath(lockPath, owner, pid), "", { flag: "a", mode: 0o600 });
  } catch {
    return false;
  }
  if (ownsLock(lockPath, owner)) return true;
  rmSync(memberPath(lockPath, owner, pid), { force: true });
  return false;
}

function incompleteOwnerIsRecent(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs < INCOMPLETE_OWNER_GRACE_MS;
  } catch {
    return false;
  }
}

function reclaimStaleLock(lockPath: string): boolean {
  const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  rmSync(stalePath, { recursive: true, force: true });
  return true;
}

function ownsLock(lockPath: string, owner: TestRunLockOwner): boolean {
  const current = readOwner(lockPath);
  return current?.runId === owner.runId && current.token === owner.token && current.pid === owner.pid;
}

/**
 * Acquire the user-scoped OpenCodex Bun-test lock.
 *
 * `mkdir` is the cross-platform atomic primitive. The owner PID makes a lock left by
 * SIGKILL recoverable, while the run ID lets every worker belonging to one bare
 * `bun test --parallel` invocation join the same lock without blocking its siblings.
 * Joiners register their own PIDs so a worker-owned lock remains live if its first
 * worker exits before the rest of the pool.
 */
export async function acquireTestRunLock(options: AcquireTestRunLockOptions): Promise<TestRunLock> {
  const env = options.env ?? process.env;
  if (env[TEST_RUN_NO_QUEUE_ENV] === "1") {
    return { acquired: false, owner: null, release() {} };
  }

  const lockPath = options.lockPath ?? resolveDefaultTestRunLockPath();
  const ownerPid = options.ownerPid ?? process.pid;
  const pollMs = Math.max(1, options.pollMs ?? 5_000);
  const maxWaitMs = Math.max(pollMs, options.maxWaitMs ?? 45 * 60 * 1000);
  const startedAt = Date.now();
  let announced = false;

  for (;;) {
    const owner: TestRunLockOwner = {
      version: 1,
      runId: options.runId,
      token: randomUUID(),
      pid: ownerPid,
      acquiredAt: new Date().toISOString(),
    };
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(ownerPath(lockPath), `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      if (announced) options.onAcquiredAfterWait?.(Date.now() - startedAt);
      return {
        acquired: true,
        owner,
        release() {
          if (!ownsLock(lockPath, owner)) return;
          reclaimStaleLock(lockPath);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const current = readOwner(lockPath);
    if (current?.runId === options.runId && lockIsLive(lockPath, current)) {
      if (registerMember(lockPath, current, process.pid)) {
        return { acquired: false, owner: current, release() {} };
      }
      continue;
    }
    const ownerIsLive = current ? lockIsLive(lockPath, current) : incompleteOwnerIsRecent(lockPath);
    if (!ownerIsLive && reclaimStaleLock(lockPath)) continue;

    if (!announced) {
      announced = true;
      options.onWait?.(current);
    }
    if (Date.now() - startedAt >= maxWaitMs) {
      const holder = current ? `pid ${current.pid} (run ${current.runId})` : "an initializing runner";
      throw new Error(
        `timed out after ${Math.round(maxWaitMs / 1000)}s waiting for ${holder} to release ${lockPath}; `
        + `set ${TEST_RUN_NO_QUEUE_ENV}=1 only when overlapping test runners are intentional`,
      );
    }
    await Bun.sleep(pollMs);
  }
}
