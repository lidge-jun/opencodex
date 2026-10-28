import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import type { UserIdentity } from "../src/codex/convergence-types";
import {
  resolveEffectiveUserIdentity,
  resolveEffectiveUserRuntimeRoot,
} from "../src/codex/user-identity";
import { resolveTrustedWindowsPowerShellExe } from "../src/lib/windows-elevation";
import { hardenSecretDir } from "../src/lib/windows-secret-acl";
import { openTestRunLockGate, TEST_RUN_LOCK_RELEASE_WAIT_MS, withTestRunLockGate } from "./test-run-lock-gate";

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
  processStart?: string;
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
  /** Unreadable process identity preserves the conservative live-PID veto. */
  processStartBatch?: TestRunProcessStartReader;
}

/** Platform-tagged process-start identities; null means unreadable. */
export type TestRunProcessStartReader = (
  pids: readonly number[],
) => ReadonlyMap<number, string | null>;

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

function memberPath(lockPath: string, owner: TestRunLockOwner, pid: number, start?: string): string {
  // Old readers parseInt the prefix and match the token suffix. A separate path
  // prevents an old writer's append-empty registration retaining a stale identity.
  const prefix = start ? `${pid}.v2.${createHash("sha256").update(start).digest("hex")}` : String(pid);
  return join(lockPath, MEMBERS_DIR, `${prefix}-${owner.token}`);
}

function readOwner(lockPath: string): TestRunLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(ownerPath(lockPath), "utf8")) as Partial<TestRunLockOwner>;
    if (parsed.version !== 1 || typeof parsed.runId !== "string" || typeof parsed.token !== "string"
      || !Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0 || typeof parsed.acquiredAt !== "string") {
      return null;
    }
    // A malformed optional identity must not discard an otherwise live owner.
    const { processStart, ...owner } = parsed;
    return { ...owner, ...(validProcessStart(processStart) ? { processStart } : {}) } as TestRunLockOwner;
  } catch (error) {
    if (error instanceof SyntaxError || errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function processIsAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
  }
}

function validProcessStart(value: unknown): value is string {
  return typeof value === "string" && (
    /^linux:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9]\d*)$/.test(value)
    || (/^win32:[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value.slice(6))))
    || (/^darwin:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
      && Number.isFinite(Date.parse(value.slice(7)))
      && new Date(value.slice(7)).toISOString().replace(".000Z", "Z") === value.slice(7))
  );
}

/** No wall-clock conversion: btime shifts when the system clock is corrected. */
function linuxProcessStart(pid: number): string | null {
  try {
    return parseLinuxTestProcessStart(
      readFileSync(`/proc/${pid}/stat`, "utf8"),
      readFileSync("/proc/sys/kernel/random/boot_id", "utf8"),
    );
  } catch {
    return null;
  }
}

export function parseLinuxTestProcessStart(stat: string, bootId: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const ticks = stat.slice(close + 2).trim().split(/\s+/)[19];
  if (!ticks || !/^\d{1,20}$/.test(ticks)) return null;
  const identity = `linux:${bootId.trim().toLowerCase()}:${BigInt(ticks)}`;
  return validProcessStart(identity) ? identity : null;
}

/** Strict English ps tokens in UTC; never parse a locale-dependent local date. */
export function parseDarwinTestProcessStart(value: string): string | null {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) +(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) +(\d{2}):(\d{2}):(\d{2}) +(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[2]!);
  const parts = [Number(match[7]), month, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])] as const;
  const date = new Date(Date.UTC(...parts));
  if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== month
    || date.getUTCDate() !== parts[2] || date.getUTCHours() !== parts[3]
    || date.getUTCMinutes() !== parts[4] || date.getUTCSeconds() !== parts[5]
    || ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()] !== match[1]) return null;
  return `darwin:${date.toISOString().replace(".000Z", "Z")}`;
}

function darwinProcessStartBatch(pids: readonly number[]): Map<number, string | null> {
  const out = new Map<number, string | null>(pids.map(pid => [pid, null]));
  if (pids.length === 0) return out;
  try {
    const stdout = execFileSync("/bin/ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
    for (const raw of stdout.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(raw);
      if (!match) continue;
      const pid = Number(match[1]);
      if (out.has(pid)) out.set(pid, parseDarwinTestProcessStart(match[2]!));
    }
  } catch {
    /* Unreadable identity keeps the live veto. */
  }
  return out;
}

const WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** FILETIME ticks are 100 ns units since 1601-01-01; this is its epoch offset in ms. */
const WINDOWS_FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;

interface Kernel32ProcessQuery {
  OpenProcess(access: number, inherit: number, pid: number): bigint;
  GetProcessTimes(
    handle: bigint,
    creation: BigUint64Array,
    exit: BigUint64Array,
    kernel: BigUint64Array,
    user: BigUint64Array,
  ): number;
  CloseHandle(handle: bigint): number;
}

let kernel32ProcessQuery: Kernel32ProcessQuery | null | undefined;

function windowsKernel32ProcessQuery(): Kernel32ProcessQuery | null {
  if (kernel32ProcessQuery !== undefined) return kernel32ProcessQuery;
  try {
    // HANDLEs travel as u64 (bigint), never as a JS number: pointer-width values
    // do not all fit, and a truncated handle would name a different object.
    kernel32ProcessQuery = dlopen("kernel32.dll", {
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
      GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    }).symbols as Kernel32ProcessQuery;
  } catch {
    kernel32ProcessQuery = null;
  }
  return kernel32ProcessQuery;
}

/**
 * Spawn-free process start identity: OpenProcess + GetProcessTimes costs
 * microseconds per pid, where a powershell.exe probe costs hundreds of
 * milliseconds — and the lock is evaluated once per isolated test file.
 * PROCESS_QUERY_LIMITED_INFORMATION is enough for same-user processes; a
 * process we cannot open yields null, never a false identity.
 */
function kernel32ProcessStart(pid: number): string | null {
  const k32 = windowsKernel32ProcessQuery();
  if (k32 === null) return null;
  let handle = 0n;
  try {
    handle = BigInt(k32.OpenProcess(WINDOWS_PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
    if (handle === 0n) return null;
    const times = new BigUint64Array(4);
    if (k32.GetProcessTimes(
      handle,
      times.subarray(0, 1),
      times.subarray(1, 2),
      times.subarray(2, 3),
      times.subarray(3, 4),
    ) === 0) {
      return null;
    }
    if (times[0] === 0n) return null;
    return `win32:${Number(times[0]! / 10_000n) - WINDOWS_FILETIME_EPOCH_OFFSET_MS}`;
  } catch {
    return null;
  } finally {
    try {
      if (handle !== 0n) k32.CloseHandle(handle);
    } catch {
      /* already closed */
    }
  }
}

function windowsCimProcessStartBatch(pids: readonly number[]): Map<number, string | null> {
  const out = new Map<number, string | null>(pids.map(pid => [pid, null]));
  if (pids.length === 0) return out;
  try {
    // One CIM query covers every candidate — serializing per-process PowerShell
    // launches is what made an unbatched probe shape expensive.
    const filter = pids.map(pid => `ProcessId=${pid}`).join(" OR ");
    const stdout = execFileSync(resolveTrustedWindowsPowerShellExe(), [
      "-NoProfile",
      "-NoLogo",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { [string]$_.ProcessId + [char]9 + ([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() }`,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) {
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      const pid = Number(line.slice(0, tab));
      const identity = `win32:${line.slice(tab + 1).trim()}`;
      if (out.has(pid) && validProcessStart(identity)) out.set(pid, identity);
    }
  } catch {
    /* Unreadable identity keeps the live veto. */
  }
  return out;
}

function windowsProcessStartBatch(pids: readonly number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  const unprobed: number[] = [];
  for (const pid of new Set(pids)) {
    const start = kernel32ProcessStart(pid);
    if (start === null) unprobed.push(pid);
    else out.set(pid, start);
  }
  // One CIM query covers only what OpenProcess could not read (for example a
  // process the caller lacks access to), so the spawn never runs at all in the
  // common same-user case.
  for (const [pid, start] of windowsCimProcessStartBatch(unprobed)) out.set(pid, start);
  return out;
}

let ownProcessStart: string | undefined;

/**
 * Start identity of the process currently holding each PID, in one platform call
 * where the platform offers it: a single powershell.exe spawn or `ps` invocation
 * covers whatever kernel reads could not resolve, while Linux and the Windows
 * FFI path stay spawn-free. Only the caller's own start is memoized — it cannot
 * change while this process lives. Foreign pids are re-probed every call because
 * a cached start is exactly the evidence a recycled PID would falsify. Entries
 * stay null when the platform source is unreadable — the caller turns that into
 * the live veto, so a probe failure can only ever keep waiting, never reclaim a
 * live run's lock.
 */
export function readTestRunProcessStartBatch(pids: readonly number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  const foreign: number[] = [];
  for (const pid of new Set(pids)) {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffff_ffff) out.set(pid, null);
    else if (pid === process.pid && ownProcessStart !== undefined) out.set(pid, ownProcessStart);
    else foreign.push(pid);
  }
  const probed = process.platform === "win32"
    ? windowsProcessStartBatch(foreign)
    : process.platform === "darwin"
      ? darwinProcessStartBatch(foreign)
      : process.platform === "linux"
        ? new Map(foreign.map(pid => [pid, linuxProcessStart(pid)]))
        : new Map(foreign.map(pid => [pid, null]));
  for (const [pid, start] of probed) {
    out.set(pid, start);
    if (pid === process.pid && start !== null) ownProcessStart = start;
  }
  return out;
}

interface LockLivenessEvidence {
  startBatch: TestRunProcessStartReader;
}

function readStart(evidence: LockLivenessEvidence, pid: number): string | undefined {
  try {
    const start = evidence.startBatch([pid]).get(pid);
    return validProcessStart(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

/** Only two valid, comparable identities can prove PID reuse. */
function identitiesMayMatch(
  recorded: string | undefined,
  current: string | undefined,
): boolean {
  return !recorded || !current || recorded.split(":", 1)[0] !== current.split(":", 1)[0]
    || recorded === current;
}

function ownerRecordIsLive(
  owner: TestRunLockOwner,
  evidence: LockLivenessEvidence,
): boolean {
  const alive = processIsAlive(owner.pid);
  if (alive !== true) return alive !== false;
  return !owner.processStart || identitiesMayMatch(owner.processStart, readStart(evidence, owner.pid));
}

function liveMemberExists(
  lockPath: string,
  owner: TestRunLockOwner,
  evidence: LockLivenessEvidence,
): boolean {
  const membersDir = join(lockPath, MEMBERS_DIR);
  let files: string[];
  try {
    files = readdirSync(membersDir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  const suffix = `-${owner.token}`;
  const candidates: { pid: number; start: string }[] = [];
  for (const file of files) {
    if (!file.endsWith(suffix)) continue;
    const pid = Number.parseInt(file.slice(0, -suffix.length), 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const alive = processIsAlive(pid);
    if (alive === false) continue;
    if (alive === null) return true;
    // Legacy and unreadable/malformed modern markers always veto on a live PID.
    // Never interpret content in a PID-only path: an old writer appends empty.
    if (!/^\d+\.v2\.[0-9a-f]{64}$/.test(file.slice(0, -suffix.length))) return true;
    try {
      const start: unknown = JSON.parse(readFileSync(join(membersDir, file), "utf8"));
      if (!validProcessStart(start) || memberPath(lockPath, owner, pid, start) !== join(membersDir, file)) return true;
      candidates.push({ pid, start });
    } catch {
      return true;
    }
  }
  if (candidates.length === 0) return false;
  // One batched probe per evaluation bounds the spawn cost to a single platform
  // call regardless of how many member records survived the liveness gate.
  try {
    const starts = evidence.startBatch([...new Set(candidates.map(candidate => candidate.pid))]);
    return candidates.some(candidate => {
      const current = starts.get(candidate.pid);
      return identitiesMayMatch(candidate.start, validProcessStart(current) ? current : undefined);
    });
  } catch {
    return true;
  }
}

function lockIsLive(lockPath: string, owner: TestRunLockOwner, evidence: LockLivenessEvidence): boolean {
  return ownerRecordIsLive(owner, evidence) || liveMemberExists(lockPath, owner, evidence);
}

function registerMember(lockPath: string, owner: TestRunLockOwner, pid: number, evidence: LockLivenessEvidence): boolean {
  const generation = readGeneration(lockPath);
  if (!generation || !ownsLock(lockPath, owner)) return false;
  const membersPath = join(lockPath, MEMBERS_DIR);
  const start = readStart(evidence, pid);
  const path = memberPath(lockPath, owner, pid, start);
  try {
    mkdirSync(membersPath, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, start ? JSON.stringify(start) : "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (sameGeneration(lockPath, generation) && ownsLock(lockPath, owner)) return true;
  // A nonparticipating old executable may replace the canonical directory.
  // Do not unlink through that changed path, even to roll back a marker.
  return false;
}

function incompleteOwnerIsRecent(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs < INCOMPLETE_OWNER_GRACE_MS;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

interface LockGeneration { dev: bigint; ino: bigint; ownerText: string | null }

function readGeneration(lockPath: string): LockGeneration | null {
  try {
    const entry = lstatSync(lockPath, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe Bun test lock directory.");
    let ownerText: string | null = null;
    try { ownerText = readFileSync(ownerPath(lockPath), "utf8"); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    return { dev: entry.dev, ino: entry.ino, ownerText };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function sameGeneration(lockPath: string, expected: LockGeneration): boolean {
  const current = readGeneration(lockPath);
  return current?.dev === expected.dev && current.ino === expected.ino && current.ownerText === expected.ownerText;
}

function reclaimStaleLock(lockPath: string, expected: LockGeneration): boolean {
  if (!sameGeneration(lockPath, expected)) return false;
  const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  if (!sameGeneration(stalePath, expected)) {
    // Cannot undo an old in-flight actor's pathname race. Preserve the displaced
    // object rather than deleting it or overwriting a newer canonical owner.
    throw new Error("Bun test lock changed during retirement; the displaced directory was preserved.");
  }
  rmSync(stalePath, { recursive: true });
  return true;
}

function ownsLock(lockPath: string, owner: TestRunLockOwner): boolean {
  const current = readOwner(lockPath);
  return current?.runId === owner.runId && current.token === owner.token && current.pid === owner.pid;
}

/**
 * Acquire the user-scoped, machine-local OpenCodex Bun-test lock.
 *
 * A stable SQLite sibling serializes updated runners' generation transitions.
 * The owner PID makes a lock left by
 * SIGKILL recoverable, while the run ID lets every worker belonging to one bare
 * `bun test --parallel` invocation join the same lock without blocking its siblings.
 * Joiners register their own PIDs so a worker-owned lock remains live if its first
 * worker exits before the rest of the pool. PID liveness is bound to process
 * identity when available. Legacy records and unreadable identities retain the
 * live-PID veto. Old in-flight executables ignore the gate: complete them before
 * upgrading to obtain the updated-runner guarantee.
 */
export async function acquireTestRunLock(options: AcquireTestRunLockOptions): Promise<TestRunLock> {
  const env = options.env ?? process.env;
  if (env[TEST_RUN_NO_QUEUE_ENV] === "1") {
    return { acquired: false, owner: null, release() {} };
  }

  const usesDefaultLockPath = options.lockPath === undefined || options.validatedRuntimePath === true;
  const lockPath = options.lockPath ?? resolveDefaultTestRunLockPath({ env });
  const ownerPid = options.ownerPid ?? process.pid;
  const evidence: LockLivenessEvidence = {
    startBatch: options.processStartBatch ?? readTestRunProcessStartBatch,
  };
  const pollMs = Math.max(1, options.pollMs ?? 5_000);
  const maxWaitMs = Math.max(pollMs, options.maxWaitMs ?? 45 * 60 * 1000);
  // Required path/ACL setup is outside the queue-wait budget, just like default
  // runtime resolution. Keep one SQLite connection across asynchronous polls.
  const gate = openTestRunLockGate(lockPath);
  const startedAt = Date.now();
  let announced = false;

  const tryAcquire = (canRetire = true): TestRunLock | "retry" | null => {
    if (options.joinExistingOwnerToken !== undefined) {
      const current = readOwner(lockPath);
      if (
        current?.runId === options.runId
        && current.token === options.joinExistingOwnerToken
        && lockIsLive(lockPath, current, evidence)
        && registerMember(lockPath, current, process.pid, evidence)
      ) {
        return { acquired: false, owner: current, release() {} };
      }
      throw new Error(
        "Cannot join the wrapper-owned Bun test lock because its exact live owner no longer matches; "
          + "refusing to create or reclaim an inherited path.",
      );
    }

    const owner: TestRunLockOwner = {
      version: 1,
      runId: options.runId,
      token: randomUUID(),
      pid: ownerPid,
      acquiredAt: new Date().toISOString(),
    };
    try {
      if (readGeneration(lockPath)) throw Object.assign(new Error("Lock already exists."), { code: "EEXIST" });
      const processStart = processIsAlive(ownerPid) === true ? readStart(evidence, ownerPid) : undefined;
      if (processStart) owner.processStart = processStart;
      mkdirSync(lockPath, { mode: 0o700 });
      const created = readGeneration(lockPath);
      try {
        writeFileSync(ownerPath(lockPath), `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        // No recursive deletion through the current path after publication fails.
        if (created && sameGeneration(lockPath, created)) {
          try { rmdirSync(lockPath); }
          catch (cleanupError) {
            if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errorCode(cleanupError))) throw cleanupError;
          }
        }
        throw error;
      }
      const acquiredGeneration = readGeneration(lockPath);
      if (!created || !acquiredGeneration || created.dev !== acquiredGeneration.dev
        || created.ino !== acquiredGeneration.ino || !ownsLock(lockPath, owner)) {
        throw new Error("Bun test lock generation changed during owner publication.");
      }
      return {
        acquired: true,
        owner,
        release() {
          const released = withTestRunLockGate(lockPath, () => {
            if (!ownsLock(lockPath, owner)) return;
            reclaimStaleLock(lockPath, acquiredGeneration);
          }, TEST_RUN_LOCK_RELEASE_WAIT_MS);
          if (!released) throw new Error("Timed out entering the Bun test lock generation gate during release.");
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

    const generation = readGeneration(lockPath);
    const current = readOwner(lockPath);
    const currentIsLive = current === null
      ? incompleteOwnerIsRecent(lockPath)
      : lockIsLive(lockPath, current, evidence);
    if (current?.runId === options.runId && currentIsLive) {
      if (registerMember(lockPath, current, process.pid, evidence)) {
        return { acquired: false, owner: current, release() {} };
      }
      return "retry";
    }
    if (!currentIsLive && generation) {
      if (!canRetire) throw new Error("Bun test lock changed between retirement and owner publication.");
      if (reclaimStaleLock(lockPath, generation)) return tryAcquire(false);
    }
    return null;
  };

  try {
    for (;;) {
      const attempt = gate.run(tryAcquire);
      if (attempt?.value === "retry" && Date.now() - startedAt < maxWaitMs) continue;
      if (attempt?.value && attempt.value !== "retry") {
        if (attempt.value.acquired && announced) options.onAcquiredAfterWait?.(Date.now() - startedAt);
        return attempt.value;
      }
      const current = readOwner(lockPath);
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
  } finally { gate.close(); }
}
