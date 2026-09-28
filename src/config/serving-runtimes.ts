/**
 * Serving-runtime census: which installations have served this home, newest known.
 *
 * The reported failure shape: the desktop app self-updates its bundled runtime while the
 * npm/mise install the Task Scheduler wrapper was baked against stays behind. When the
 * desktop session ends, the wrapper relaunches its pinned Bun + CLI pair and the machine
 * silently downgrades to the older package — features the operator just gained stop
 * existing, with nothing in the log saying why. The same hazard runs in reverse whenever
 * the packaged install is the stale half.
 *
 * The fix is a small census, not a resolution oracle. Every `ocx start` that reaches the
 * bind boundary records the command that would relaunch it (`argv`-shaped absolute
 * paths) plus its package version. A service child — the path where a fixed definition
 * picks the runtime, instead of the operator's shell — then asks whether a strictly newer
 * recorded install still exists on disk, re-verifies it with a bounded `--version` probe,
 * and hands the serve to it. Because only strictly newer candidates defer, the newest
 * available install converges in one hop and can never ping-pong.
 *
 * Everything here is fail-open toward the recorded install's own runtime: a missing file,
 * a malformed record, or a dead probe means "serve this install", never "stay down". The
 * registry is information a serving proxy wrote about itself; it authorizes relaunching a
 * binary the same installation already ran, nothing more.
 */
import { spawn, spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { durableBunRuntime } from "../lib/bun-runtime";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { compareStrictSemver, parseStrictSemver } from "../lib/strict-semver";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { atomicWriteFile } from "./atomic-write";
import { getConfigDir } from "./paths";
import { ConfigMutationLockError, withConfigMutationLockSync } from "./mutation-lock";
import { SERVICE_MANAGED_ENV } from "../service/state";
import { WINDOWS_WRAPPER_PROTOCOL_ENV } from "../service/windows-wrapper-exit";

export function servingRuntimesPath(dir: string = getConfigDir()): string {
  return join(dir, "serving-runtimes.json");
}

/**
 * The argv prefix that relaunches THIS install's proxy: `[exe]` for a compiled
 * standalone binary, `[bun, cli/index.ts]` for a package install. Lives here because
 * the census is its only consumer.
 */
export function currentServingCommand(): string[] {
  return [durableBunRuntime().path, ...selfLaunchArgv([])]
    .map(part => (isAbsolute(part) ? part : join(process.cwd(), part)));
}

/** One installation's relaunch command and the version it last served. */
export interface ServedRuntimeRecord {
  /**
   * The argv prefix that relaunches this install's proxy: `[exe]` for a compiled
   * standalone binary, `[bun, cli/index.ts]` for a package install. Absolute paths only.
   */
  readonly command: readonly string[];
  readonly version: string;
  readonly servedAt: string;
}

/** Bound on retained installs; the file is operator-facing state, not a log. */
const MAX_SERVING_RUNTIME_RECORDS = 16;

/**
 * Probe budget for re-verifying a recorded binary. Runs once per service-child start,
 * so a short ceiling keeps a wedged sibling binary from delaying every relaunch.
 */
const RUNTIME_VERSION_PROBE_TIMEOUT_MS = 3_000;

/**
 * Bound on candidate probes per service-child start. The census can retain up to
 * MAX_SERVING_RUNTIME_RECORDS installs and each probe carries its own timeout, so
 * without a cap a registry full of dead records would stall every relaunch by
 * RECORDS × the probe timeout.
 */
const MAX_VERSION_PROBE_ATTEMPTS = 4;

function canonicalPath(path: string): string {
  let resolved = path;
  try { resolved = realpathSync(path); } catch { /* keep the literal path */ }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Identity of a relaunch command. Two spellings of one binary (junction, mapped drive,
 * case fold) must collide; different installs must not.
 */
export function servingRuntimeCommandKey(command: readonly string[]): string {
  return command.map(canonicalPath).join("\u0000");
}

function isValidRecord(value: unknown): value is ServedRuntimeRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.command) || record.command.length === 0) return false;
  if (!record.command.every(part => typeof part === "string" && isAbsolute(part))) return false;
  if (typeof record.version !== "string" || parseStrictSemver(record.version) === null) return false;
  return typeof record.servedAt === "string";
}

/** Read the census. Malformed entries are dropped; a malformed file reads as empty. */
export function readServingRuntimes(dir: string = getConfigDir()): ServedRuntimeRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(servingRuntimesPath(dir), "utf-8"));
    const runtimes = (parsed as Record<string, unknown>)?.runtimes;
    if (!Array.isArray(runtimes)) return [];
    return runtimes.filter(isValidRecord);
  } catch {
    return [];
  }
}

/**
 * Record that this install served this home. Runs only after the bind boundary
 * succeeded: a start that never reached serving must not register a runtime that
 * never actually ran. Best-effort after the entry shape is validated — a census
 * write failure must never take down a healthy start.
 */
export function recordServingRuntime(
  record: ServedRuntimeRecord,
  dir: string = getConfigDir(),
): void {
  if (!isValidRecord(record)) return;
  try {
    assertNotRealHomeUnderTest(dir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The complete read/merge/replace is one cross-process transaction. Briefly retry
    // SQLITE_BUSY because this best-effort startup write must not drop a concurrent serve.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        withConfigMutationLockSync(() => {
          const key = servingRuntimeCommandKey(record.command);
          const merged = [record, ...readServingRuntimes(dir).filter(entry => servingRuntimeCommandKey(entry.command) !== key)];
          atomicWriteFile(servingRuntimesPath(dir), JSON.stringify({ runtimes: merged.slice(0, MAX_SERVING_RUNTIME_RECORDS) }, null, 2) + "\n");
        }, dir);
        break;
      } catch (error) {
        if (!(error instanceof ConfigMutationLockError) || attempt === 19) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } catch { /* census loss must never fail a start */ }
}

export interface SyncRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

type SyncRunner = (file: string, args: readonly string[]) => SyncRunResult;

function bufferedSyncRunner(file: string, args: readonly string[]): SyncRunResult {
  const result = spawnSync(file, [...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: RUNTIME_VERSION_PROBE_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/**
 * Extract the strict semver a binary reports for `--version`, or null when it cannot be
 * asked. The probe is the re-verification step: a census record survives the binary it
 * described (a rollback, a partial uninstall), so the version on record alone never
 * authorizes a handoff.
 */
export function probeServedRuntimeVersion(
  command: readonly string[],
  run: SyncRunner = bufferedSyncRunner,
): string | null {
  if (command.length === 0) return null;
  let result: SyncRunResult;
  try {
    result = run(command[0]!, [...command.slice(1), "--version"]);
  } catch {
    return null;
  }
  if (result.status !== 0) return null;
  // printVersion() emits "opencodex X.Y.Z"; accept the strict-semver token wherever it lands.
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(result.stdout);
  if (!match) return null;
  return parseStrictSemver(match[1])?.raw ?? null;
}

/** Reject a substituted launch target from home-local census state. */
function trustedRecordedPath(path: string): boolean {
  try {
    if (!isAbsolute(path)) return false;
    const info = statSync(realpathSync(path));
    if (!info.isFile()) return false;
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) return false;
      if ((info.mode & 0o022) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface NewerServingRuntimeDeps {
  readonly dir?: string;
  readonly exists?: (path: string) => boolean;
  readonly run?: SyncRunner;
}

/**
 * The newest recorded install that can actually replace this one, or null.
 *
 * "Recorded" alone never suffices: the probe re-asks the binary for its version, so a
 * record left behind by a replaced or partially removed install demotes itself instead of
 * handing the port to a stale executable. Candidates probe best-recorded-version first
 * and a dead or demoting candidate falls through to the next one — a rolled-back top
 * record must not keep a good install beneath it from serving. Self is excluded by
 * command identity, not by version, so an equal-version sibling is never a candidate.
 */
export function selectNewerServingRuntime(
  selfVersion: string,
  selfCommand: readonly string[],
  deps: NewerServingRuntimeDeps = {},
): ServedRuntimeRecord | null {
  const self = parseStrictSemver(selfVersion);
  if (self === null) return null;
  const exists = deps.exists ?? existsSync;
  const selfKey = servingRuntimeCommandKey(selfCommand);
  const candidates = readServingRuntimes(deps.dir ?? getConfigDir())
    .filter(record => servingRuntimeCommandKey(record.command) !== selfKey)
    .filter(record => {
      const recorded = parseStrictSemver(record.version);
      return recorded !== null && compareStrictSemver(recorded, self) > 0;
    })
    .filter(record => record.command.every(part => exists(part) && trustedRecordedPath(part)))
    .sort((left, right) => compareStrictSemver(parseStrictSemver(right.version)!, parseStrictSemver(left.version)!));
  // Probe the bounded candidate set and pick the greatest VERIFIED version. The recorded
  // version only orders the probes: a record claiming 2.70 that now answers 2.68 must not win
  // over a sibling that records and answers 2.69, and the one-hop marker means the delegate
  // could never correct that choice itself.
  let best: { record: ServedRuntimeRecord; version: string; semver: NonNullable<ReturnType<typeof parseStrictSemver>> } | null = null;
  for (const record of candidates.slice(0, MAX_VERSION_PROBE_ATTEMPTS)) {
    const probed = probeServedRuntimeVersion(record.command, deps.run);
    const probedSemver = probed === null ? null : parseStrictSemver(probed);
    if (probedSemver === null || compareStrictSemver(probedSemver, self) <= 0) continue;
    if (best === null || compareStrictSemver(probedSemver, best.semver) > 0) best = { record, version: probed!, semver: probedSemver };
  }
  return best === null ? null : { ...best.record, version: best.version };
}

export interface DeferToNewerRuntimeDeps extends NewerServingRuntimeDeps {
  readonly runInherited?: (command: readonly string[], args: readonly string[]) => Promise<DelegatedExit>;
  readonly log?: (line: string) => void;
  /** Environment the service manager gave this child; decides its stay-out exit code. */
  readonly env?: NodeJS.ProcessEnv;
}

interface DelegatedExit { readonly exitCode: number; readonly ready: boolean }
const DELEGATED_ONCE_ENV = "OCX_DELEGATED_ONCE";
const DELEGATED_READY_ENV = "OCX_DELEGATED_READY_NONCE";
const READY_NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function readyMarkerPath(nonce: string): string {
  return join(getConfigDir(), `.delegated-ready-${nonce}`);
}

/** Child publishes bind completion for its waiting service parent. */
export function markDelegatedServiceReady(): void {
  const nonce = process.env[DELEGATED_READY_ENV];
  if (process.env[DELEGATED_ONCE_ENV] !== "1" || !nonce || !READY_NONCE_RE.test(nonce)) return;
  try { writeFileSync(readyMarkerPath(nonce), String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch { /* parent will conservatively treat an early failed child as unready */ }
}

/**
 * Time a delegated child gets to finish shutting down after this parent takes a
 * termination signal, before escalation to SIGKILL. The parent waits for the child
 * to exit; repeated signals share one timer, which is cleared when that wait ends.
 */
const DELEGATED_SIGNAL_GRACE_MS = 5_000;

/**
 * Run the delegated install in the foreground and wait for its exit.
 *
 * The service manager tracks THIS process, so termination must reach the child:
 * signals are forwarded, and a parent exit (including a manager kill that never
 * signals the child) still terminates it through the exit hook. A manager that
 * force-kills the parent without a signal remains the one uncovered case — the
 * port-holding child then outlives the registration, which the next service start
 * sees through the usual live-owner path.
 */
async function inheritedRunner(command: readonly string[], args: readonly string[]): Promise<DelegatedExit> {
  const nonce = randomUUID();
  const marker = readyMarkerPath(nonce);
  const child = spawn(command[0]!, [...command.slice(1), ...args], {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, [DELEGATED_ONCE_ENV]: "1", [DELEGATED_READY_ENV]: nonce },
  });
  const terminateChild = () => { try { child.kill(); } catch { /* already gone */ } };
  const forceKillChild = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let terminationRequested = false;
  const forward = (signal: NodeJS.Signals) => () => {
    terminationRequested = true;
    try { child.kill(signal); } catch { /* already gone */ }
    escalation ??= setTimeout(forceKillChild, DELEGATED_SIGNAL_GRACE_MS);
    escalation.unref();
  };
  const onSigint = forward("SIGINT");
  const onSigterm = forward("SIGTERM");
  const onSighup = forward("SIGHUP");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  process.on("exit", terminateChild);
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(
        signal === null ? (code ?? 1) : 128 + (osConstants.signals[signal] ?? 1),
      ));
    });
    let ready = terminationRequested;
    try { ready ||= readFileSync(marker, "utf8") === String(child.pid); } catch { /* pre-bind exit */ }
    return { exitCode, ready };
  } finally {
    try { unlinkSync(marker); } catch { /* absent marker */ }
    if (escalation) clearTimeout(escalation);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
    process.off("exit", terminateChild);
  }
}

/**
 * Hand this service child's serve to a strictly newer recorded install.
 *
 * Resolves to the delegated child's exit code when a handoff happened, null when this
 * process should serve itself. The foreground wait keeps the service contract intact:
 * the wrapper sees the real child's exit (including the stay-out code) and restart
 * ownership stays exactly where the manager put it. Only called on the `OCX_SERVICE`
 * path — an interactive `ocx start` already picked its binary on PATH.
 */
export async function deferToNewerServiceRuntime(
  selfVersion: string,
  selfCommand: readonly string[],
  port: number | undefined,
  deps: DeferToNewerRuntimeDeps = {},
): Promise<number | null> {
  const log = deps.log ?? (line => console.log(line));
  const candidate = selectNewerServingRuntime(selfVersion, selfCommand, deps);
  if (candidate === null) return null;
  const startArgs = ["start"];
  if (port !== undefined && Number.isFinite(port) && port > 0 && port <= 65535) {
    startArgs.push("--port", String(Math.trunc(port)));
  }
  const run = deps.runInherited ?? inheritedRunner;
  log(
    `⚠️  This install (${selfVersion}) is older than the runtime that last served this home (${candidate.version}). `
    + `Deferring to ${candidate.command.join(" ")} so the service does not silently downgrade.`,
  );
  try {
    const result = await run(candidate.command, startArgs);
    // Any exit before the delegate published its bind, whatever the code, falls back to this
    // installation. Propagating a pre-bind exit 0 (or the stay-out code) would end the service
    // with nothing serving. Falling back cannot override a deliberate stand-down: this process
    // continues through the same start path, whose lease-held bind fence re-applies every
    // stay-out condition (a live proxy, a foreign recorded owner) before it binds anything.
    if (!result.ready) {
      log(`⚠️  Newer runtime exited before bind (status ${result.exitCode}); serving this install instead.`);
      return null;
    }
    return result.exitCode;
  } catch (error) {
    log(`⚠️  Newer runtime failed to launch (${error instanceof Error ? error.message : String(error)}); serving this install instead.`);
    return null;
  }
}

/**
 * The `handleStart` gate: only a service child defers, and only before it binds.
 * A sibling owns nothing shared, and an interactive start picked its binary on PATH —
 * the manager's baked definition is the one place "which install serves" can drift.
 */
export async function deferServiceChildToNewerRuntime(options: {
  readonly sibling: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly selfVersion: string;
  readonly selfCommand: readonly string[];
  readonly port?: number;
  readonly deps?: DeferToNewerRuntimeDeps;
}): Promise<number | null> {
  if (options.sibling || !isManagedServiceEnvironment(options.env) || options.env[DELEGATED_ONCE_ENV] === "1") return null;
  return deferToNewerServiceRuntime(options.selfVersion, options.selfCommand, options.port, { env: options.env, ...options.deps });
}

/**
 * A child a service manager started, as its environment proves it. launchd, systemd, and
 * current or repaired WinSW definitions write `OCX_SERVICE_MANAGED=1`; the Windows Task
 * Scheduler wrapper writes `OCX_SERVICE=1` with its stay-out protocol marker instead.
 * Bare `OCX_SERVICE=1` never qualifies: `ocx claude` and `ocx opencode` companions carry
 * it, and legacy WinSW definitions without the managed marker do not delegate until repaired.
 */
export function isManagedServiceEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env[SERVICE_MANAGED_ENV] === "1" || (env.OCX_SERVICE === "1" && env[WINDOWS_WRAPPER_PROTOCOL_ENV] === "1");
}
