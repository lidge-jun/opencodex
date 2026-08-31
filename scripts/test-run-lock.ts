import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { UserIdentity } from "../src/codex/convergence-types";
import {
  resolveEffectiveUserIdentity,
  resolveEffectiveUserRuntimeRoot,
} from "../src/codex/user-identity";
import { hardenSecretDir } from "../src/lib/windows-secret-acl";

export const TEST_RUN_ID_ENV = "OCX_TEST_RUN_ID";
export const TEST_RUN_LOCK_PATH_ENV = "OCX_TEST_RUN_LOCK_PATH";
export const TEST_RUN_LOCK_TOKEN_ENV = "OCX_TEST_RUN_LOCK_TOKEN";
export const TEST_RUN_NO_QUEUE_ENV = "OCX_TEST_NO_QUEUE";
const OWNER_FILE = "owner.json";
const MEMBERS_DIR = "members";
const INCOMPLETE_OWNER_GRACE_MS = 10_000;
const POSIX_PRIVATE_MODE = 0o700;

interface RuntimeDirectoryEntry {
  uid: number;
  mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface TestRunRuntimeFileSystem {
  lstatSync(path: string): RuntimeDirectoryEntry;
  mkdirSync(path: string, options: { mode?: number; recursive?: boolean }): void;
  accessSync(path: string, mode: number): void;
}

export interface ResolveDefaultTestRunLockPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  tempDir?: string;
  hostName?: string;
  fileSystem?: TestRunRuntimeFileSystem;
  resolveIdentity?: () => UserIdentity;
  resolveRuntimeRoot?: (identity: Extract<UserIdentity, { platform: "win32" }>) => string;
  hardenWindowsDirectory?: (path: string) => void;
}

const runtimeFileSystem: TestRunRuntimeFileSystem = {
  lstatSync,
  mkdirSync(path, options) { mkdirSync(path, options); },
  accessSync,
};

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
  validatedRuntimePath?: boolean;
  joinExistingOwnerToken?: string;
  pollMs?: number;
  maxWaitMs?: number;
  env?: NodeJS.ProcessEnv;
  onWait?: (owner: TestRunLockOwner | null) => void;
  onAcquiredAfterWait?: (elapsedMs: number) => void;
}

export interface ResolveInheritedTestRunLockOptions {
  wrappedRunId?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  hostName?: string;
}

export interface InheritedTestRunLock {
  lockPath: string;
  ownerToken: string;
}

export interface ResolveWrappedTestRunLockPathOptions {
  env?: NodeJS.ProcessEnv;
  resolve?: (options: ResolveDefaultTestRunLockPathOptions) => string;
}

export interface BareTestRunIdentity {
  ownerPid: number;
  runId: string;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "unknown error";
  return String((error as { code?: unknown }).code ?? "unknown error");
}

function inspectRuntimeDirectory(options: {
  path: string;
  fileSystem: TestRunRuntimeFileSystem;
  expectedUid?: number;
  requirePrivateMode?: boolean;
  allowMissing?: boolean;
}): string | null {
  let entry: RuntimeDirectoryEntry;
  try {
    entry = options.fileSystem.lstatSync(options.path);
  } catch (error) {
    if (options.allowMissing && errorCode(error) === "ENOENT") return null;
    return `cannot be inspected (${errorCode(error)})`;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) return "is not a real directory";
  if (options.expectedUid !== undefined && entry.uid !== options.expectedUid) {
    return "is not owned by the current uid";
  }
  if (options.requirePrivateMode && (entry.mode & 0o777) !== POSIX_PRIVATE_MODE) {
    return "does not have mode 0700";
  }
  try {
    options.fileSystem.accessSync(options.path, constants.W_OK | constants.X_OK);
  } catch (error) {
    return `is not writable/searchable (${errorCode(error)})`;
  }
  return null;
}

function machineDiscriminator(hostName: string): string {
  const normalized = hostName.trim().toLowerCase();
  if (!normalized) throw new Error("the OS hostname is empty");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Read a Windows-wrapper-provided lock path without repeating effective-user
 * discovery in every Bun worker. Bare and POSIX runs never trust this environment
 * value. Wrapped Windows paths are constrained to the exact host-specific lock
 * filename and namespace shape; the wrapper remains responsible for resolving
 * and validating the directory.
 */
export function resolveInheritedTestRunLock(
  options: ResolveInheritedTestRunLockOptions,
): InheritedTestRunLock | undefined {
  if (!options.wrappedRunId) return undefined;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  if (options.env?.[TEST_RUN_NO_QUEUE_ENV] === "1") return undefined;
  const candidate = options.env?.[TEST_RUN_LOCK_PATH_ENV]?.trim();
  const ownerToken = options.env?.[TEST_RUN_LOCK_TOKEN_ENV]?.trim();
  if (!candidate || !ownerToken) {
    throw new Error("The wrapped Bun test lock capability is incomplete; refusing inherited lock access.");
  }

  const expectedName = `opencodex-bun-test-${machineDiscriminator(options.hostName ?? hostname())}.lock`;
  if (
    !win32.isAbsolute(candidate)
    || win32.basename(candidate) !== expectedName
    || win32.basename(win32.dirname(candidate)) !== "bun-test-locks"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerToken)
  ) {
    throw new Error("The wrapped Bun test lock capability is invalid; refusing inherited lock access.");
  }
  return { lockPath: candidate, ownerToken };
}

/** Resolve once in the wrapper, preserving the no-queue escape hatch as a true no-op. */
export function resolveWrappedTestRunLockPath(
  options: ResolveWrappedTestRunLockPathOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  if (env[TEST_RUN_NO_QUEUE_ENV] === "1") return undefined;
  return (options.resolve ?? resolveDefaultTestRunLockPath)({ env });
}

/**
 * Resolve a user-scoped, machine-local default lock path without relying on HOME.
 *
 * Windows uses the effective-token SID and known-folder runtime root, then
 * hardens a dedicated child with the repository's required ACL policy.
 * POSIX XDG runtime directories are accepted only after an ownership and access
 * check, including exact mode 0700. The fallback is a private UID namespace
 * under the OS temp directory.
 * The hostname digest remains part of the lock name in either case: even if an
 * administrator redirects either root to shared storage, host-local PID liveness
 * checks can never reclaim or join another machine's lock.
 */
export function resolveDefaultTestRunLockPath(
  options: ResolveDefaultTestRunLockPathOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const tempDir = options.tempDir ?? tmpdir();
  const fileSystem = options.fileSystem ?? runtimeFileSystem;
  let discriminator: string;
  try {
    discriminator = machineDiscriminator(options.hostName ?? hostname());
  } catch (cause) {
    throw new Error(
      "Cannot resolve a safe user-scoped Bun test lock: the machine identity is unavailable.",
      { cause },
    );
  }

  if (platform === "win32") {
    let identity: UserIdentity;
    try {
      identity = (options.resolveIdentity ?? resolveEffectiveUserIdentity)();
    } catch (cause) {
      throw new Error(
        "Cannot resolve a safe user-scoped Bun test lock: the Windows effective identity is unavailable.",
        { cause },
      );
    }
    if (identity.platform !== "win32") {
      throw new Error(
        "Cannot resolve a safe user-scoped Bun test lock: the effective identity does not match Windows.",
      );
    }

    let runtimeRoot: string;
    try {
      runtimeRoot = (options.resolveRuntimeRoot ?? resolveEffectiveUserRuntimeRoot)(identity);
    } catch (cause) {
      throw new Error(
        "Cannot resolve a safe user-scoped Bun test lock: the Windows effective-user runtime is unavailable.",
        { cause },
      );
    }
    if (!win32.isAbsolute(runtimeRoot)) {
      throw new Error(
        "Cannot resolve a safe user-scoped Bun test lock: the Windows effective-user runtime path is not absolute.",
      );
    }

    const lockRoot = win32.join(runtimeRoot, "bun-test-locks");
    const issueBeforeCreate = inspectRuntimeDirectory({
      path: lockRoot,
      fileSystem,
      allowMissing: true,
    });
    if (issueBeforeCreate) {
      throw new Error(
        `Cannot resolve a safe user-scoped Bun test lock: the Windows lock directory ${issueBeforeCreate}.`,
      );
    }

    try {
      fileSystem.mkdirSync(lockRoot, { recursive: true });
    } catch (cause) {
      throw new Error(
        "Cannot resolve a safe user-scoped Bun test lock: the Windows lock directory cannot be created.",
        { cause },
      );
    }
    const issueBeforeHardening = inspectRuntimeDirectory({ path: lockRoot, fileSystem });
    if (issueBeforeHardening) {
      throw new Error(
        `Cannot resolve a safe user-scoped Bun test lock: the Windows lock directory ${issueBeforeHardening}.`,
      );
    }
    try {
      const harden = options.hardenWindowsDirectory
        ?? ((path: string) => {
          if (!hardenSecretDir(path, { required: true }).ok) {
            throw new Error("required ACL hardening did not complete");
          }
        });
      harden(lockRoot);
    } catch (cause) {
      throw new Error(
        "Cannot resolve a safe user-scoped Bun test lock: the Windows lock directory cannot be secured.",
        { cause },
      );
    }

    const issueAfterHardening = inspectRuntimeDirectory({ path: lockRoot, fileSystem });
    if (issueAfterHardening) {
      throw new Error(
        `Cannot resolve a safe user-scoped Bun test lock: the Windows lock directory ${issueAfterHardening}.`,
      );
    }
    return win32.join(lockRoot, `opencodex-bun-test-${discriminator}.lock`);
  }

  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (!Number.isInteger(uid) || (uid ?? -1) < 0) {
    throw new Error(
      "Cannot resolve a safe user-scoped Bun test lock: the current POSIX uid is unavailable.",
    );
  }

  const failures: string[] = [];
  const xdgRuntimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (xdgRuntimeDir) {
    if (!posix.isAbsolute(xdgRuntimeDir)) {
      failures.push("XDG_RUNTIME_DIR is not absolute");
    } else {
      const issue = inspectRuntimeDirectory({
        path: xdgRuntimeDir,
        fileSystem,
        expectedUid: uid,
        requirePrivateMode: true,
      });
      if (!issue) return posix.join(xdgRuntimeDir, `opencodex-bun-test-${discriminator}.lock`);
      failures.push(`XDG_RUNTIME_DIR ${issue}`);
    }
  }

  if (!posix.isAbsolute(tempDir)) {
    failures.push("the OS temporary directory is not absolute");
  } else {
    const fallback = posix.join(tempDir, `opencodex-test-runtime-${uid}`);
    try {
      fileSystem.mkdirSync(fallback, { mode: POSIX_PRIVATE_MODE });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        failures.push(`the temporary UID runtime directory cannot be created (${errorCode(error)})`);
      }
    }
    if (!failures.some(failure => failure.startsWith("the temporary UID runtime directory cannot be created"))) {
      const issue = inspectRuntimeDirectory({
        path: fallback,
        fileSystem,
        expectedUid: uid,
        requirePrivateMode: true,
      });
      if (!issue) return posix.join(fallback, `opencodex-bun-test-${discriminator}.lock`);
      failures.push(`the temporary UID runtime directory ${issue}`);
    }
  }

  throw new Error(
    "Cannot resolve a safe user-scoped Bun test lock. "
      + "Ensure XDG_RUNTIME_DIR is an existing writable mode-0700 directory owned by the current uid, "
      + `or make the OS temporary directory usable for a mode-0700 UID runtime (${failures.join("; ")}).`,
  );
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
 * Acquire the user-scoped, machine-local OpenCodex Bun-test lock.
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

  const usesDefaultLockPath = options.lockPath === undefined || options.validatedRuntimePath === true;
  const lockPath = options.lockPath ?? resolveDefaultTestRunLockPath({ env });
  const ownerPid = options.ownerPid ?? process.pid;
  const pollMs = Math.max(1, options.pollMs ?? 5_000);
  const maxWaitMs = Math.max(pollMs, options.maxWaitMs ?? 45 * 60 * 1000);
  const startedAt = Date.now();
  let announced = false;

  if (options.joinExistingOwnerToken !== undefined) {
    const current = readOwner(lockPath);
    if (
      current?.runId === options.runId
      && current.token === options.joinExistingOwnerToken
      && lockIsLive(lockPath, current)
      && registerMember(lockPath, current, process.pid)
    ) {
      return { acquired: false, owner: current, release() {} };
    }
    throw new Error(
      "Cannot join the wrapper-owned Bun test lock because its exact live owner no longer matches; "
        + "refusing to create or reclaim an inherited path.",
    );
  }

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
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (usesDefaultLockPath && ["EACCES", "ENOENT", "EPERM", "EROFS"].includes(code ?? "")) {
          throw new Error(
            "Cannot acquire the user-scoped Bun test lock because its validated runtime directory "
              + "became unavailable or unwritable. Check the effective-user runtime directory and its permissions.",
            { cause: error },
          );
        }
        throw error;
      }
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
