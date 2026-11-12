import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { isLocalAttestationSecret } from "../lib/local-management-attestation";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import {
  resolveTrustedWindowsPowerShellExe,
  resolveTrustedWindowsSystemDirectory,
} from "../lib/windows-elevation";
import { atomicWriteFile } from "./atomic-write";
import { readWindowsProcessCommandLineNative } from "./windows-process-command-line";
import { getConfigDir, hardenConfigDir } from "./paths";
import { registerOwnHome, unregisterOwnerRegistryHome } from "./owner-registry";

export function getPidPath(): string {
  return join(getConfigDir(), "ocx.pid");
}

export function getRuntimePortPath(): string {
  return join(getConfigDir(), "runtime-port.json");
}

function ensureProcessStateDir(): void {
  const dir = getConfigDir();
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else hardenConfigDir();
}

/**
 * Whether this process has written `ocx.pid` or `runtime-port.json` in its own lifetime (#8552).
 *
 * Set before the write, deliberately even when the write then throws, and never cleared: a record
 * this process wrote (or may have written) and later removed still means its PID once named a live
 * owner of this home, so it can never be told apart from an earlier lifetime of the same PID number.
 * Moving the assignment after the write would let a failed write fail open.
 */
let publishedOwnershipRecords = false;

export function hasPublishedOwnershipRecords(): boolean {
  return publishedOwnershipRecords;
}

/**
 * Where the owner of a runtime record ran, as digests that store none of their inputs (#8552).
 *
 * Every container runs the proxy as PID 1, so a PID alone cannot say whether a record came from
 * this container's previous run or from another container serving the same state volume. The
 * `host` name must match, and on Linux at least one of two stronger facts as well
 * ({@link sameRuntimeOwnerScope}):
 *
 * - `network` with `boot`, the network namespace within one boot: a container restarted inside
 *   its Kubernetes pod keeps it, because the pod sandbox owns it. Namespace inode numbers repeat
 *   across machines and boots, so the boot id has to match too;
 * - `container`, the writable layer of the overlay mounted at `/` (its `upperdir`), counted only
 *   when its path carries a random 64-hex layer id (Docker's `overlay2` driver, containers/storage
 *   for Podman and CRI-O): a container started again keeps it, across a host reboot as well, and
 *   no other container ever mounts it, not even one sharing its network (`--network container:`)
 *   or its pod. A layer named by a sequence number (containerd's overlayfs snapshotter, which
 *   nodes built alike hand out identically) or a host whose own root is an overlay proves nothing
 *   beyond one machine, so it is not used; nor is a container id, which a container joined to
 *   another's network sees in mountinfo.
 *
 * A replacement pod, a second container with a fixed `hostname`, or another node matches neither.
 * Processes that share one network namespace (host networking, pod sidecars, WSL distros, which
 * share one VM) can match on `network`; for them the loopback probe still finds a listening owner.
 * Elsewhere the PID space is the whole machine and the host name suffices. Linux evidence that
 * cannot be read yields a per-process value that matches no other lifetime, so the self-record
 * proof fails closed.
 */
export interface RuntimeOwnerScope {
  host: string;
  boot?: string;
  network?: string;
  container?: string;
}

let cachedRuntimeOwnerScope: RuntimeOwnerScope | undefined;

export function runtimeOwnerScope(): RuntimeOwnerScope {
  cachedRuntimeOwnerScope ??= computeRuntimeOwnerScope();
  return cachedRuntimeOwnerScope;
}

function scopeDigest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

/**
 * The `upperdir` of the overlay mounted at `/` when it names a randomly identified writable layer
 * (a `/<64 hex>/` path segment): a container's own layer, unique across machines. The last root
 * mount wins, as it is the one visible. Any other root filesystem (bare host, btrfs/zfs/vfs drivers,
 * fuse-overlayfs, an overlay host root, containerd's sequence-numbered snapshots) yields nothing.
 */
export function rootOverlayUpperdirFromMountinfo(mountinfo: string): string | undefined {
  let upperdir: string | undefined;
  for (const line of mountinfo.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const fields = line.slice(0, separator).split(" ");
    if (fields[4] !== "/") continue;
    const [fstype, , superOptions = ""] = line.slice(separator + 3).split(" ");
    const match = fstype === "overlay" ? /(?:^|,)upperdir=([^,]+)/.exec(superOptions) : null;
    upperdir = match && /\/[0-9a-f]{64}\//.test(match[1]) ? match[1] : undefined;
  }
  return upperdir;
}

function readOptional(read: () => string): string | undefined {
  try { return read(); } catch { return undefined; }
}

function computeRuntimeOwnerScope(): RuntimeOwnerScope {
  if (process.platform !== "linux") return { host: scopeDigest(process.platform, hostname()) };
  const boot = readOptional(() => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
  const network = readOptional(() => readlinkSync("/proc/self/ns/net"));
  const container = readOptional(() => rootOverlayUpperdirFromMountinfo(readFileSync("/proc/self/mountinfo", "utf8")) ?? "");
  const scope: RuntimeOwnerScope = { host: scopeDigest("linux", hostname()) };
  if (boot && /^[0-9a-f-]{36}$/.test(boot) && network && /^net:\[\d+\]$/.test(network)) {
    scope.boot = scopeDigest("boot", boot);
    scope.network = scopeDigest("net", network);
  }
  if (container) scope.container = scopeDigest("container", container);
  if (!scope.network && !scope.container) return { host: scopeDigest("unverifiable", randomUUID()) };
  return scope;
}

/**
 * Whether a recorded owner scope proves the record was written where this process runs. Only an
 * exact, well-formed match counts; anything else (absent, malformed, partial) is "no".
 */
export function sameRuntimeOwnerScope(recorded: unknown, own: RuntimeOwnerScope): boolean {
  if (!recorded || typeof recorded !== "object" || Array.isArray(recorded)) return false;
  const record = recorded as Record<string, unknown>;
  if (typeof record.host !== "string" || record.host !== own.host) return false;
  if (own.network === undefined && own.container === undefined) {
    return record.boot === undefined && record.network === undefined && record.container === undefined;
  }
  return (own.network !== undefined && record.network === own.network && own.boot !== undefined && record.boot === own.boot)
    || (own.container !== undefined && record.container === own.container);
}

export function writePid(pid: number): void {
  ensureProcessStateDir();
  publishedOwnershipRecords = true;
  atomicWriteFile(getPidPath(), String(pid));
}

export type RuntimePortState = {
  pid: number;
  port: number;
  hostname?: string;
  /** Absolute relaunch prefix written by runtimes that identify their serving install. */
  command?: string[];
  /** Per-process proof key; protected by the config directory and never served. */
  attestationSecret?: string;
  /** A Link runtime is draining; new and in-flight sync commits must stand down. */
  clientStopping?: true;
  /**
   * The owner a client runtime classified from positive evidence (src/client/runtime-restart.ts
   * restartOwnerEvidence: desktop, service-manager or none). Absent for a bare OCX_SERVICE=1 and for
   * runtimes older than this field; `ocx disconnect` restarts only a runtime whose record states a
   * value it recognises. Any string is accepted here so a later value never invalidates the record.
   */
  restartOwner?: string;
  /**
   * The live proxy's port when this runtime is a sibling instance started beside it
   * (`src/codex/sibling-start.ts`). `ocx stop` reads it to leave shared client routing alone.
   * Absent for every other runtime.
   */
  siblingOfPort?: number;
  /**
   * {@link runtimeOwnerScope} of the owner, stamped by {@link writeRuntimePort} when this process
   * writes its own record. Not validated here: a malformed value must not hide a live owner from
   * status, stop or liveness, and the one reader that uses it (`observeProxyLiveness`) accepts
   * only an exact match ({@link sameRuntimeOwnerScope}).
   */
  ownerScope?: RuntimeOwnerScope;
};

export function isValidRuntimePortState(value: unknown): value is RuntimePortState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  const hostnameOk = state.hostname === undefined || typeof state.hostname === "string";
  const attestationOk = state.attestationSecret === undefined || isLocalAttestationSecret(state.attestationSecret);
  const siblingOk = state.siblingOfPort === undefined
    || (Number.isInteger(state.siblingOfPort) && Number(state.siblingOfPort) > 0 && Number(state.siblingOfPort) <= 65535);
  return Number.isSafeInteger(state.pid)
    && Number(state.pid) > 0
    && Number.isInteger(state.port)
    && Number(state.port) > 0
    && Number(state.port) <= 65535
    && hostnameOk
    && attestationOk
    && (state.clientStopping === undefined || state.clientStopping === true)
    && (state.restartOwner === undefined || (typeof state.restartOwner === "string" && state.restartOwner.length <= 64))
    && siblingOk;
}

export function writeRuntimePort(state: RuntimePortState): void {
  ensureProcessStateDir();
  publishedOwnershipRecords = true;
  // Only the owner can say where it runs; a record written on another process's behalf keeps
  // whatever identity it already carried.
  const ownerScope = state.pid === process.pid ? runtimeOwnerScope() : state.ownerScope;
  const record = { ...state, ...(ownerScope === undefined ? {} : { ownerScope }) };
  atomicWriteFile(getRuntimePortPath(), JSON.stringify(record, null, 2) + "\n");
  // The record proves this home's owner only to a reader that knows where it lives.
  // One pointer in the shared registry makes the record findable from every home;
  // it is best-effort because ownership never depends on the registry write landing.
  registerOwnHome();
}

export function parsePidFile(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function readPidFileValue(): number | null {
  try {
    return parsePidFile(readFileSync(getPidPath(), "utf-8"));
  } catch {
    return null;
  }
}

export function readRuntimePort(expectedPid?: number): RuntimePortState | null {
  try {
    const parsed = JSON.parse(readFileSync(getRuntimePortPath(), "utf-8"));
    if (!isValidRuntimePortState(parsed)) return null;
    if (expectedPid !== undefined && parsed.pid !== expectedPid) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function removePid(expectedPid?: number, beforeMutation?: () => void): void {
  if (expectedPid !== undefined && readPidFileValue() !== expectedPid) return;
  const path = getPidPath();
  beforeMutation?.();
  try { unlinkSync(path); } catch { /* ignore */ }
}

export function removeRuntimePort(expectedPid?: number, beforeMutation?: () => void): void {
  if (expectedPid !== undefined && readRuntimePort(expectedPid) === null) return;
  const path = getRuntimePortPath();
  beforeMutation?.();
  try { unlinkSync(path); } catch { /* ignore */ }
  // The record is gone, so the registry pointer names a dead home. Retire it
  // beside the record or stale pointers accumulate toward the reader's cap.
  unregisterOwnerRegistryHome(getConfigDir(), beforeMutation);
}

/**
 * Snapshot-guarded stale-state purge. A replacement `ocx start` can publish a
 * fresh record while a liveness probe is in flight, so deletion is authorized
 * only by the exact value observed before that probe.
 */
export function removePidIfValueIs(snapshot: number | null): void {
  if (!existsSync(getPidPath())) return;
  if (readPidFileValue() !== snapshot) return;
  try { unlinkSync(getPidPath()); } catch { /* ignore */ }
}

export function removeRuntimePortIfPidIs(snapshotPid: number | null): void {
  const current = readRuntimePort();
  if ((current?.pid ?? null) !== snapshotPid) return;
  try { unlinkSync(getRuntimePortPath()); } catch { /* ignore */ }
}

/**
 * Does this command line belong to an opencodex process at all, whatever it is doing?
 *
 * {@link isOcxStartCommandLine} answers the narrower question the pidfile needs — "is this
 * the proxy?" — by additionally requiring the `start` verb. Ownership of a pending-teardown
 * receipt is the broader question: the owner is whichever invocation claimed it, which is an
 * `ocx stop` or the `ocx update` worker that drove it, never an `ocx start`. Asking the
 * start-shaped question there would call every real owner foreign.
 */
export function isOcxCommandLine(commandLine: string): boolean {
  const normalized = commandLine.toLowerCase().replace(/\\/g, "/");
  // Keep legacy source launches and npm's in-place Windows rename recognizable:
  // a service wrapper may respawn from `.opencodex-*` during a global update.
  return normalized.includes("src/cli.ts")
    || normalized.includes("src/cli/index.ts")
    || normalized.includes("@bitkyc08/opencodex")
    || /@bitkyc08\/\.opencodex-/.test(normalized)
    || /(?:^|[\s/"'])(?:ocx|opencodex)(?:\.cmd|\.exe)?(?:$|[\s"'])/.test(normalized);
}

export function isOcxStartCommandLine(commandLine: string): boolean {
  const normalized = commandLine.toLowerCase().replace(/\\/g, "/");
  return isOcxCommandLine(commandLine) && /(?:^|[\s"'])start(?:$|[\s"'])/.test(normalized);
}

/** Avoid spawning WMIC/PowerShell on every short liveness poll. */
const ocxStartProcessCache = new Map<number, boolean>();
let ocxStartProcessSweepCursor = 0;
let ocxStartProcessProbe: (pid: number) => void = pid => { process.kill(pid, 0); };

export function setOcxStartProcessProbeForTests(probe: ((pid: number) => void) | null): void {
  ocxStartProcessProbe = probe ?? (pid => { process.kill(pid, 0); });
}

export function setOcxStartProcessCacheForTests(entries: Iterable<readonly [number, boolean]>): void {
  ocxStartProcessCache.clear();
  for (const [pid, value] of entries) ocxStartProcessCache.set(pid, value);
  ocxStartProcessSweepCursor = 0;
}

export function sweepDeadOcxStartProcessCache(maxProbes = 64): number {
  const pids: number[] = [];
  let removed = 0;
  for (const pid of ocxStartProcessCache.keys()) {
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
    else if (ocxStartProcessCache.delete(pid)) removed += 1;
  }
  if (pids.length === 0 || maxProbes <= 0) {
    ocxStartProcessSweepCursor = 0;
    return removed;
  }
  const probeCount = Math.min(Math.floor(maxProbes), pids.length);
  const start = ocxStartProcessSweepCursor % pids.length;
  for (let offset = 0; offset < probeCount; offset += 1) {
    const pid = pids[(start + offset) % pids.length]!;
    try {
      ocxStartProcessProbe(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      if (ocxStartProcessCache.delete(pid)) removed += 1;
    }
  }
  ocxStartProcessSweepCursor = (start + probeCount) % pids.length;
  return removed;
}

export function ocxStartProcessCacheSizeForTests(): number {
  return ocxStartProcessCache.size;
}

/**
 * One observation of whether a candidate PID is an `ocx start` process.
 *
 * `readPid()` and `verifyPidIdentity()` ask this on every short liveness poll, and the
 * read-only tracked-record inspection in `tracked-runtime-inspection.ts` asks it once per
 * guarded stop, so all of them share this single cache-backed answer rather than probe
 * twice: a hit performs no native command at all, and a miss performs exactly one
 * {@link readProcessCommandLine} probe. Only a definite answer is cached; an unreadable
 * command line is reported as `"unverifiable"`, left uncached, and re-probed on the next
 * ask. `"unverifiable"` is not evidence of a permission boundary, a foreign process, or a
 * different account or elevation — only that the probe could not answer this time.
 */
export type OcxStartIdentityObservation = "match" | "mismatch" | "unverifiable";

export function inspectOcxStartProcessIdentity(pid: number): OcxStartIdentityObservation {
  const cached = ocxStartProcessCache.get(pid);
  if (cached !== undefined) return cached ? "match" : "mismatch";
  const commandLine = readProcessCommandLine(pid);
  if (commandLine === undefined) return "unverifiable";
  const ok = isOcxStartCommandLine(commandLine);
  ocxStartProcessCache.set(pid, ok);
  return ok ? "match" : "mismatch";
}

function isLikelyOcxStartProcess(pid: number): boolean {
  return inspectOcxStartProcessIdentity(pid) === "match";
}

export function readPid(): number | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = parsePidFile(raw);
    if (pid === null) return null;
    try {
      process.kill(pid, 0);
      return isLikelyOcxStartProcess(pid) ? pid : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return isLikelyOcxStartProcess(pid) ? pid : null;
      }
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Cheap non-destructive liveness check. Destructive callers must additionally
 * call `verifyPidIdentity()` before acting on the returned PID.
 */
export function readAlivePid(): number | null {
  const pid = readPidFileValue();
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return pid;
    return null;
  }
}

/**
 * Full identity check for a known candidate. The returned PID must equal the
 * candidate, preventing a pidfile rewrite from swapping in another process.
 */
export function verifyPidIdentity(candidatePid: number): number | null {
  try {
    process.kill(candidatePid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return null;
  }
  return isLikelyOcxStartProcess(candidatePid) ? candidatePid : null;
}

/**
 * Is this PID an opencodex process, rather than merely a live one?
 *
 * `process.kill(pid, 0)` answers "does this number name a process", which is not the same
 * question. PIDs are reused, so a recorded owner that exited can have its number handed to
 * an unrelated process, and bare liveness then reports the owner as still running forever.
 *
 * Deliberately uncached, unlike {@link isLikelyOcxStartProcess}. That cache exists because
 * liveness polling asks about the same PID many times a second; this is asked once per
 * outstanding teardown receipt in a short-lived `ocx stop`, so the cache would only add an
 * unswept map. The Windows WMIC/PowerShell probe cost is the point rather than a regression:
 * the runtime contract requires the identity check, not the cheap one, before acting on
 * stale state.
 */
export function isLikelyOcxProcess(pid: number): boolean {
  const commandLine = readProcessCommandLine(pid);
  if (commandLine === undefined) return false;
  return isOcxCommandLine(commandLine);
}

type ProcessCommandLineExec = (
  executable: string,
  args: string[],
  options: {
    encoding: BufferEncoding;
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    windowsHide: boolean;
  },
) => string;

const defaultProcessCommandLineExec: ProcessCommandLineExec = (executable, args, options) =>
  execFileSync(executable, args, options);
let processCommandLineExec = defaultProcessCommandLineExec;
let processCommandLinePlatformForTests: NodeJS.Platform | null = null;

export function setProcessCommandLineExecForTests(next: ProcessCommandLineExec | null): void {
  processCommandLineExec = next ?? defaultProcessCommandLineExec;
}

export function setProcessCommandLinePlatformForTests(next: NodeJS.Platform | null): void {
  processCommandLinePlatformForTests = next;
}

type ProcessCommandLineNative = (pid: number) => string | undefined;
let processCommandLineNativeForTests: ProcessCommandLineNative | null = null;

/** Replace the in-process Windows command-line read; null restores the real one. */
export function setProcessCommandLineNativeForTests(next: ProcessCommandLineNative | null): void {
  processCommandLineNativeForTests = next;
}

/** The in-process Windows read, or undefined so the spawned probes take their turn. */
function readNativeWindowsCommandLine(pid: number): string | undefined {
  try {
    if (processCommandLineNativeForTests) return processCommandLineNativeForTests(pid);
    // A platform override means a test drives the spawned probes with fakes; the real native
    // read would answer about this machine's process instead and bypass them.
    if (processCommandLinePlatformForTests !== null) return undefined;
    return readWindowsProcessCommandLineNative(pid);
  } catch {
    // A failed native read must leave the spawned probes their turn, not end the lookup.
    return undefined;
  }
}

export function readProcessCommandLine(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const platform = processCommandLinePlatformForTests ?? process.platform;
  try {
    if (platform === "linux") {
      try {
        const output = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
        const value = output.replace(/\0/g, " ").trim();
        if (value) return value;
      } catch {
        /* procfs unavailable — use the fixed ps fallback below */
      }
    }
    if (platform === "win32") {
      // The in-process read answers in milliseconds. Get-CimInstance Win32_Process has been
      // measured at 3.6-5.3 s on a busy machine, past the 3 s bound below, so without it a
      // live runtime reads as unverified wherever WMIC is gone.
      const native = readNativeWindowsCommandLine(pid);
      if (native) return native;
      // WMIC is the next path. Newer Windows images may omit it, so fall back to
      // the trusted fixed PowerShell binary without consulting PATH or env roots.
      const wmic = join(resolveTrustedWindowsSystemDirectory(), "wbem", "WMIC.exe");
      try {
        const output = processCommandLineExec(wmic, [
          "process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/VALUE",
        ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true });
        const match = /^CommandLine=(.*)$/m.exec(output.replace(/\r/g, ""));
        const value = match?.[1]?.trim();
        if (value) return value;
      } catch {
        /* WMIC missing or failed — fall through */
      }
      // One bounded retry: a transient CIM timeout answers "unreadable" for an
      // unchanged process and turns a guarded stop into a false approval-changed.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const output = processCommandLineExec(resolveTrustedWindowsPowerShellExe(), [
            "-NoProfile",
            "-NoLogo",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
          ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true });
          return output.trim() || undefined;
        } catch {
          /* timed out or CIM unavailable — try once more, then unreadable */
        }
      }
      return undefined;
    }
    for (const ps of ["/bin/ps", "/usr/bin/ps"]) {
      try {
        const output = processCommandLineExec(ps, ["-p", String(pid), "-o", "command="], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1000,
          windowsHide: true,
        });
        const value = output.trim();
        if (value) return value;
      } catch {
        /* try the other fixed system path */
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
