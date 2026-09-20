import { accessSync, chmodSync, closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { expandUserPath, getConfigDir } from "../config";
import { resolveCodexHomeDir, type CodexHomeDeps } from "../codex/home";
import { resolveCodexSqliteHome } from "../codex/paths";
import { durableBunRuntime, type BunRuntimeSource, type DurableBunRuntime } from "../lib/bun-runtime";
import { WINSW_SHA256, WINSW_VERSION } from "../lib/winsw";
import { hardenSecretPath } from "../lib/windows-secret-acl";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { isProtectedHomeUnderTest, isTestHomeGuardArmed } from "../lib/test-home-guard";
import { isStandaloneBinary } from "../lib/standalone";

/**
 * Written only by the launchd plist and the systemd unit. `OCX_SERVICE=1` cannot stand in
 * for it: `ocx claude` and `ocx opencode` set that on the proxies they spawn to borrow its
 * routing-preservation meaning, so a proxy carrying it is not necessarily the managed job.
 */
export const SERVICE_MANAGED_ENV = "OCX_SERVICE_MANAGED";

export const LABEL = "com.opencodex.proxy";
export const TASK = "opencodex-proxy";

// This module lives one level below the original src/service.ts, so path-relative
// lookups anchored at that file's directory go through this constant instead.
export const serviceSourceDir = dirname(import.meta.dir);

export type ServiceBackend = "scheduler" | "native";

export function cliEntry(runtime: DurableBunRuntime = durableBunRuntime()): { bun: string; bunRuntimeSource: BunRuntimeSource; cli: string | null } {
  // Bake the bundled Bun (manager-owned global package directory, survives `ocx update`) rather than
  // a transient system Bun, so launchd/systemd/schtasks keep resolving even if a
  // standalone Bun is later removed. The CLI entry lives at src/cli/index.ts.
  //
  // Path and provenance come from ONE resolution so the marker can never describe a
  // different binary than the one actually baked.
  return {
    bun: runtime.path,
    bunRuntimeSource: runtime.source,
    cli: runtime.source === "standalone" || isStandaloneBinary() ? null : join(serviceSourceDir, "cli", "index.ts"),
  };
}

/**
 * The stable `ocx` launcher to bake into a systemd unit, or null to fall back to the
 * Bun + CLI pair.
 *
 * `cliEntry()` resolves both of its paths from `import.meta.dir`, so they point INSIDE
 * the installed package tree. Under a version manager that tree is a versioned directory:
 * `~/.local/share/mise/installs/npm-opencodex/2.35.0/...`. An upgrade installs 2.36.0 and
 * deletes 2.35.0, after which the unit's `exec <old-bun> <old-cli>` cannot resolve, and
 * `Restart=on-failure` turns that into a restart loop (#2898). The shim in
 * `~/.local/share/mise/shims/ocx` survives the upgrade and dispatches to whatever version
 * is current, so it is the durable thing to name.
 *
 * Deliberately LEXICAL. Resolving the symlink would write the versioned target back into
 * the unit and reintroduce the bug — the indirection is the entire point.
 *
 * Only an absolute path is accepted. A bare `ocx` would be re-resolved through `PATH` on
 * every restart, which turns a service definition into a PATH-hijacking surface; naming
 * one validated absolute file keeps the target fixed at install time.
 *
 * The RECORDED launcher wins over a fresh PATH walk. `ocx service repair` runs from
 * whatever shell the operator (or `ocx update`, or a tray helper) happened to have, and a
 * context without `ocx` on `PATH` used to resolve null here — rewriting a working
 * launcher-form plist into the version-pinned Bun + CLI pair and then booting the healthy
 * job out to load it (#4236, defect 1g). A launcher that is still an executable file is
 * the thing the installed service already runs, so repair must keep naming it; only a
 * recorded launcher that has disappeared falls through to discovery.
 *
 * That preference is NOT macOS-only: `installSystemd` resolves this same function, so a
 * Linux `ocx service repair` from a PATH-less context keeps the `ExecStart` the unit
 * already has instead of rewriting it to the version-pinned pair — the #2898 shape this
 * function exists to avoid. The failure mode it prevents is milder there (systemd
 * `daemon-reload` + `restart` does not evict-then-maybe-nothing the way launchd did), but
 * the rewrite was the same, so the behavior is deliberately shared rather than branched.
 */
export function stableLauncherEntry(deps: {
  env?: NodeJS.ProcessEnv;
  isExecutableFile?: (path: string) => boolean;
  pathDelimiter?: string;
  state?: ServiceInstallState | null;
} = {}): string | null {
  const env = deps.env ?? process.env;
  const isExecutableFile = deps.isExecutableFile ?? ((path: string): boolean => {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  const recorded = (deps.state === undefined ? readServiceInstallState() : deps.state)?.launcherPath;
  if (recorded && isAbsolute(recorded) && isExecutableFile(recorded)) return recorded;
  const entries = (env.PATH ?? "").split(deps.pathDelimiter ?? delimiter);
  for (const entry of entries) {
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = join(entry, "ocx");
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function logPath(): string {
  return join(getConfigDir(), "service.log");
}

export function serviceLogPath(): string {
  return logPath();
}

export function windowsServiceScriptPath(): string {
  return join(getConfigDir(), "opencodex-service.cmd");
}

export function windowsLauncherVbsPath(): string {
  return join(getConfigDir(), "opencodex-service-launcher.vbs");
}

export function windowsTaskXmlPath(): string {
  return join(getConfigDir(), "opencodex-service-task.xml");
}

export function serviceStatePath(): string {
  return join(getConfigDir(), "service-state.json");
}

function defaultOpenCodexHome(): string {
  return resolve(join(homedir(), ".opencodex"));
}

export function serviceStatePathsForOpenCodexHome(opencodexHome: string): string[] {
  const paths = [join(opencodexHome, "service-state.json")];
  const defaultPath = join(defaultOpenCodexHome(), "service-state.json");
  if (normalizePathForCompare(defaultPath) !== normalizePathForCompare(paths[0])) paths.push(defaultPath);
  return paths;
}

export function serviceStatePaths(): string[] {
  const paths = serviceStatePathsForOpenCodexHome(currentOpenCodexHome());
  if (!isTestHomeGuardArmed()) return paths;
  /*
   * Under an armed test process the legacy default-home entry IS the developer's real
   * `~/.opencodex/service-state.json`. It is there so an install made before
   * OPENCODEX_HOME was set can still be found, but it means a test whose OPENCODEX_HOME
   * points at a sandbox still writes their live install state — observed while building
   * the launchd repair coverage: one case replaced the real record's codexHome and
   * opencodexHome with temp-directory paths. Drop it rather than deny the write, so the
   * sandbox path keeps working and the real one is simply not in the list.
   *
   * The predicate is the guard's own, not a local `resolve()` compare: the guard
   * canonicalizes through `realpath`, and on macOS a sandbox under `/var/folders/...`
   * resolves to `/private/var/folders/...`, so two spellings of one directory must not
   * decide this.
   */
  return paths.filter(path => !isProtectedHomeUnderTest(dirname(path)));
}

/**
 * The state paths a WRITE may use. Same list, but an empty one is an error instead of a
 * silent no-op.
 *
 * With OPENCODEX_HOME unset under an armed test process, `currentOpenCodexHome()` falls
 * back to the real `~/.opencodex` (`os.homedir()` ignores `$HOME`), the filter above then
 * removes every candidate, and `writeServiceInstallState` wrote NOTHING while reporting
 * success — a test asserting on install state would read the previous run's record, or
 * none. Fail the way `assertNotRealHomeUnderTest` does, naming the fix.
 */
function serviceStateWritePaths(): string[] {
  const paths = serviceStatePaths();
  if (paths.length > 0) return paths;
  throw new Error(
    "refusing to write service install state with no writable state path: every candidate "
    + "resolved to the real OpenCodex home and was filtered out. Point OPENCODEX_HOME at a "
    + "temp directory for this test (the preload does it for every invocation; something "
    + "deleted the variable without restoring it).",
  );
}

export function currentCodexHome(deps: CodexHomeDeps = {}): string {
  // Service ownership must identify the same home as the runtime. In WSL an
  // unset CODEX_HOME can resolve to the single Windows Desktop home rather than
  // Linux ~/.codex; recording the fallback here creates a false foreign owner.
  return resolveCodexHomeDir(deps);
}

export function currentCodexSqliteHomeAbsolute(target: "native" | "windows" = "native"): string | undefined {
  const raw = process.env.CODEX_SQLITE_HOME?.trim();
  if (!raw) return undefined;
  const expanded = expandUserPath(raw);
  // Service artifacts can be rendered by cross-platform tests and repair tooling, so an
  // already-absolute path for the TARGET platform is preserved rather than re-anchored
  // against the writing host. `resolve()` is host-relative in both directions: on a POSIX
  // host it turns `C:\data` into `<cwd>/C:\data`, and on a Windows host it turns `/tmp/x`
  // into `D:\tmp\x` — neither is a path the target can use. A relative value still resolves,
  // because a service unit has no meaningful working directory.
  //
  // CODEX_HOME and OPENCODEX_HOME are carried through literally, so without this the same
  // generated file disagreed with itself about two variables holding the same kind of value.
  if (target === "windows") {
    return win32.isAbsolute(expanded) ? win32.normalize(expanded) : resolve(expanded);
  }
  return posix.isAbsolute(expanded) ? posix.normalize(expanded) : resolve(expanded);
}

export function currentOpenCodexHome(): string {
  // getConfigDir() already resolves OPENCODEX_HOME with ~ expansion; keep the
  // install-state comparison on the same normalization or `~/...` values falsely
  // fail the environment-match check depending on cwd.
  return getConfigDir();
}

export function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export interface ServiceInstallState {
  version: 1 | 2;
  codexHome: string;
  opencodexHome: string;
  /** Effective Codex SQLite home used by this service's history integration. */
  codexSqliteHome?: string;
  /** Baked at install; lets status flag paths gone stale after npm prefix/nvm moves. */
  bunPath?: string;
  cliPath?: string | null;
  /**
   * launchd and systemd. The stable `ocx` launcher the service definition actually invokes,
   * when one was found. Present means `bunPath`/`cliPath` are provenance for the install,
   * NOT what the service runs — so staleness must be judged against THIS path instead. A version-manager
   * upgrade replaces the directory those two point into while the launcher survives, and
   * checking the old pair would report a stale service that is in fact healthy.
   */
  launcherPath?: string;
  /** v2: which Windows backend was chosen at install; absent (v1/legacy) means scheduler. */
  backend?: ServiceBackend;
  winswVersion?: string;
  winswSha256?: string;
  /**
   * Bumped by every write through {@link swapServiceInstallState}; the compare-and-swap
   * token. Absent means a record written before this field existed, which compares equal
   * to 0 so the first swap over it still lands.
   */
  revision?: number;
  /** Who owns the running proxy. Absent means the CLI install that registered the service. */
  ownership?: ServiceOwnership;
  /**
   * The highest consent generation this record has ever carried, kept across a release.
   *
   * Without it the counter is an ABA token: granting, releasing and granting again produces
   * generation 1 twice, and an app-local record holding the first 1 would read the second
   * one as its own prior consent.
   */
  consentGenerationCeiling?: number;
}

/**
 * The two kinds of installation that can own the proxy.
 *
 * `cli` is the npm (or standalone) `ocx` install that registered the background service.
 * `desktop` is the packaged app, which brings its own bundled runtime.
 */
export type ServiceOwner = "cli" | "desktop";

/**
 * Durable ownership, recorded in the shared service install state.
 *
 * Ownership used to be a boolean the desktop shell recomputed at every launch from whether
 * it happened to spawn a child, so a restart silently demoted the app back to guest and
 * "ask once, then own permanently" could not be expressed at all. This record is the thing
 * that survives the restart.
 *
 * ABSENT IS NOT UNOWNED. Every installation that predates this field has no record, and the
 * npm service registration is what owns the runtime there, so absence has to keep meaning
 * exactly that.
 */
export interface ServiceOwnership {
  readonly owner: ServiceOwner;
  /**
   * Opaque identity of the owning INSTALLATION — not of the user, the machine or the
   * account. The desktop app keeps the same value in its own app-local store, and comparing
   * the two through {@link ownershipGrantedTo} is how a reinstalled app tells its own prior
   * consent from another installation's.
   */
  readonly installId: string;
  /**
   * Increments once per ownership grant. Re-recording the same owner and install id leaves
   * it alone, so a relaunch cannot inflate it and "exactly one increment per takeover" is
   * an assertion a test can make.
   */
  readonly consentGeneration: number;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Validate an ownership claim read off disk.
 *
 * Returns the ORIGINAL object rather than a rebuilt one: a newer writer may carry fields
 * this version does not know about, and rebuilding would drop them on the next preserve —
 * which is the same lost-field failure this whole record exists to stop.
 */
export function parseServiceOwnership(value: unknown): ServiceOwnership | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ownership = value as Record<string, unknown>;
  if (ownership.owner !== "cli" && ownership.owner !== "desktop") return null;
  if (typeof ownership.installId !== "string" || ownership.installId.length === 0) return null;
  if (!isNonNegativeInteger(ownership.consentGeneration)) return null;
  return value as ServiceOwnership;
}

export function parseServiceInstallState(value: unknown): ServiceInstallState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 && state.version !== 2) return null;
  if (typeof state.codexHome !== "string" || state.codexHome.length === 0) return null;
  if (typeof state.opencodexHome !== "string" || state.opencodexHome.length === 0) return null;
  for (const key of ["codexSqliteHome", "bunPath", "launcherPath", "winswVersion", "winswSha256"] as const) {
    if (state[key] !== undefined && (typeof state[key] !== "string" || state[key].length === 0)) return null;
  }
  // `cliPath` is the one path that is legitimately null: `cliEntry()` returns null for a
  // standalone binary, and the writer stores it. Validating it as a non-empty string made
  // every standalone install write a record its OWN parser rejected — which reads back as
  // "no install state", and after ownership moved into this record, as "nobody owns the
  // runtime". Pre-existing; found while making ownership fail closed.
  if (state.cliPath !== undefined && state.cliPath !== null
    && (typeof state.cliPath !== "string" || state.cliPath.length === 0)) return null;
  if (state.revision !== undefined && !isNonNegativeInteger(state.revision)) return null;
  if (state.consentGenerationCeiling !== undefined && !isNonNegativeInteger(state.consentGenerationCeiling)) return null;
  // A malformed ownership claim invalidates the whole record instead of being dropped:
  // silently discarding it is precisely the demotion this field is here to prevent, and a
  // reader that cannot trust the claim must not be told the runtime is unowned.
  if (state.ownership !== undefined && parseServiceOwnership(state.ownership) === null) return null;
  if (state.version === 1) {
    if (state.backend !== undefined) return null;
  } else if (state.backend !== "scheduler" && state.backend !== "native") {
    return null;
  }
  return state as unknown as ServiceInstallState;
}

/**
 * What an install bakes into the record: the homes, the provenance paths and the backend.
 *
 * Everything here is rebuilt from the CURRENT process on every write, which is the point —
 * it describes the install that just ran. {@link ServiceInstallState.ownership} deliberately
 * is not part of it.
 */
function installProvenanceRecord(backend: ServiceBackend, launcherPath?: string | null): ServiceInstallState {
  const { bun, cli } = cliEntry();
  const codexHome = currentCodexHome();
  return {
    version: 2,
    codexHome,
    opencodexHome: currentOpenCodexHome(),
    codexSqliteHome: resolveCodexSqliteHome({ codexHome }),
    bunPath: bun,
    cliPath: cli,
    ...(launcherPath ? { launcherPath } : {}),
    backend,
    ...(backend === "native" ? { winswVersion: WINSW_VERSION, winswSha256: WINSW_SHA256 } : {}),
  };
}

/**
 * Record an install, PRESERVING whatever owns the runtime.
 *
 * Every install, repair, update and stop path ends here, and each one used to hand this
 * function a freshly rebuilt record that simply replaced the file. That is why ownership
 * cannot be an ordinary field written by whoever ran last: a repair kicked off by a tray
 * helper, or by `ocx update`, would erase a takeover the user had consented to and hand the
 * runtime back to the npm launcher without saying anything. Preserving it here is what makes
 * the consent durable.
 */
export function writeServiceInstallState(backend: ServiceBackend = "scheduler", launcherPath?: string | null): void {
  // Resolved across every state path, so a claim living only on the legacy mirror is carried
  // onto the anchor rather than lost the first time this home writes.
  //
  // This does NOT refuse on an unknown resolution. It runs at the END of a successful install
  // or repair, where a throw would report a service that is registered and running as a
  // failure. The fail-closed decision belongs in front of the mutation, where repair and the
  // updaters make it; here the job is to preserve as much as can be read.
  const resolution = resolveServiceOwnership();
  swapServiceInstallState(current => ({
    ...installProvenanceRecord(backend, launcherPath),
    ...preservedConsent(current, resolution),
  }));
}

/** The ownership half of a record: the claim itself plus the generation high-water mark. */
function preservedConsent(
  current: ServiceInstallState | null,
  resolution: ServiceOwnershipResolution,
): Pick<ServiceInstallState, "ownership" | "consentGenerationCeiling"> {
  const ownership = resolution.kind === "owned" ? resolution.ownership : current?.ownership;
  const ceiling = Math.max(current?.consentGenerationCeiling ?? 0, ownership?.consentGeneration ?? 0);
  return {
    ...(ownership ? { ownership } : {}),
    ...(ceiling > 0 ? { consentGenerationCeiling: ceiling } : {}),
  };
}

export function readServiceInstallState(): ServiceInstallState | null {
  for (const path of serviceStatePaths()) {
    try {
      const parsed = parseServiceInstallState(JSON.parse(readFileSync(path, "utf8")));
      if (parsed) return parsed;
    } catch {
      /* try the next known state path */
    }
  }
  return null;
}

/** Raised when a state write kept losing its compare-and-swap; NOTHING was written. */
export class ServiceStateConflictError extends Error {
  constructor(readonly path: string, readonly attempts: number) {
    super(
      `service install state at ${path} was rewritten by another process during all ${attempts} `
      + "compare-and-swap attempts; nothing was written. Re-run the command.",
    );
    this.name = "ServiceStateConflictError";
  }
}

export interface ServiceStateSwapDeps {
  /** Test seam: which state paths to write. Defaults to every writable state path. */
  paths?: readonly string[];
  /** How many times to re-read and recompute before giving up. */
  attempts?: number;
  /**
   * Test seam: runs immediately before each commit. It is the only place a competing writer
   * can be interleaved deterministically, which is what makes the revision check testable
   * rather than a claim in a comment.
   */
  beforeCommit?: (attempt: number) => void;
  /** How long to wait for another process to release the anchor lock. */
  lockWaitMs?: number;
}

const SERVICE_STATE_SWAP_ATTEMPTS = 5;
const SERVICE_STATE_LOCK_WAIT_MS = 2_000;
const SERVICE_STATE_LOCK_POLL_MS = 20;
const SERVICE_STATE_LOCK_STALE_MS = 30_000;
/** Lock paths this process holds, with a depth so a nested swap does not deadlock on itself. */
const heldStateLocks = new Map<string, number>();

function isFileExistsError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && "code" in (error as object)
    && (error as { code?: unknown }).code === "EEXIST";
}

/**
 * Hold an exclusive lock over the anchor record for one whole read-modify-write.
 *
 * The revision check alone cannot make the swap atomic: two processes can both pass it,
 * both commit, and both verify their own bytes, after which the second silently drops the
 * first's mutation and reports success. `O_EXCL` creation is the cheap cross-process
 * exclusion that closes it for every writer that comes through here.
 *
 * The revision check stays anyway, because this lock binds only cooperating writers — an
 * older `ocx` on the same machine does not take it.
 *
 * Re-entrant per process. A swap nested inside another one is a caller ordering its own
 * writes, not a race, and blocking it would be a self-deadlock.
 */
function withServiceStateLock<T>(anchor: string, run: () => T, waitMs = SERVICE_STATE_LOCK_WAIT_MS): T {
  const lockPath = `${anchor}.lock`;
  const depth = heldStateLocks.get(lockPath);
  if (depth !== undefined) {
    heldStateLocks.set(lockPath, depth + 1);
    try { return run(); } finally { releaseHeldLock(lockPath, false); }
  }
  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      // A lock we could not create for any reason OTHER than "it is held" is a filesystem
      // failure, and writing the record anyway is the unprotected path this exists to close.
      if (!isFileExistsError(error)) throw error;
      if (Date.now() < deadline) { Bun.sleepSync(SERVICE_STATE_LOCK_POLL_MS); continue; }
      // Break a lock whose holder is gone. Age comes from the lock file itself, so a holder
      // that is merely slow keeps refusing us rather than being evicted mid-write.
      let ageMs: number | null = null;
      try { ageMs = Date.now() - statSync(lockPath).mtimeMs; } catch { ageMs = null; }
      if (ageMs !== null && ageMs > SERVICE_STATE_LOCK_STALE_MS) {
        try { unlinkSync(lockPath); } catch { /* another process broke it first */ }
        continue;
      }
      throw new Error(
        `another process is writing the service install state at ${anchor} and did not release `
        + `it within ${waitMs}ms; nothing was written. Re-run the command.`,
      );
    }
  }
  heldStateLocks.set(lockPath, 1);
  try {
    return run();
  } finally {
    try { closeSync(fd); } catch { /* best-effort */ }
    releaseHeldLock(lockPath, true);
  }
}

function releaseHeldLock(lockPath: string, removeFile: boolean): void {
  const depth = (heldStateLocks.get(lockPath) ?? 1) - 1;
  if (depth > 0) { heldStateLocks.set(lockPath, depth); return; }
  heldStateLocks.delete(lockPath);
  if (removeFile) { try { unlinkSync(lockPath); } catch { /* best-effort */ } }
}

/** One state path's record, or null when it is absent or unparseable. Throws if unreadable. */
function readServiceInstallStateAt(path: string): ServiceInstallState | null {
  const evidence = inspectServiceStateEvidence([path])[0]!;
  // Unreadable is not absent. Treating EACCES as "no record" would compute a swap from an
  // empty base and erase an ownership claim we were merely not allowed to look at.
  if (evidence.kind === "unreadable") {
    throw new Error(
      `service install state at ${path} could not be read (${evidence.reason}), so its recorded `
      + "owner cannot be preserved; nothing was written. Fix the file's permissions and retry.",
    );
  }
  // Invalid IS overwritten: there is no claim in an unparseable record to preserve.
  return evidence.kind === "valid" ? evidence.state : null;
}

function commitServiceStateFile(path: string, serialized: string): void {
  const dir = dirname(path);
  recordOwnedConfigPath(getConfigDir(), path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, serialized, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  if (process.platform === "win32") hardenSecretPath(path, { required: true });
}

/**
 * Read the recorded state, compute the next one from it, and commit it only if nothing else
 * moved the record in between.
 *
 * `mutate` may return null to mean "nothing to change", which writes nothing and leaves the
 * file — including its absence — exactly as it was.
 *
 * WHAT THE REVISION CHECK IS. The anchor is re-read immediately before the commit and the
 * committed bytes are read back immediately after, so a writer that landed on either side of
 * the window is DETECTED and the whole read-modify-write runs again against the new base.
 * The comparison is over the serialized record rather than the revision number alone,
 * because two writers racing from one base both compute the same next revision — identical
 * bytes mean nothing was lost, and differing bytes mean something was.
 *
 * WHAT THE LOCK IS. {@link withServiceStateLock} holds the anchor exclusively for the whole
 * read-modify-write, because the revision check alone is not atomic: two processes can both
 * pass it, both commit and both verify their own bytes, after which the second silently
 * drops the first's mutation and reports success. The revision check remains the guard
 * against a writer that does not take the lock, such as an older `ocx` on the same machine.
 */
export function swapServiceInstallState(
  mutate: (current: ServiceInstallState | null) => ServiceInstallState | null,
  deps: ServiceStateSwapDeps = {},
): ServiceInstallState | null {
  const paths = deps.paths ?? serviceStateWritePaths();
  // The anchor is the first path, which is the state path for THIS OpenCodex home;
  // `readServiceInstallState` reads the same list in the same order, so the record the
  // swap compares against is the record every reader resolves. The remaining paths are
  // legacy mirrors and receive a copy of whatever the anchor commits.
  const anchor = paths[0];
  if (anchor === undefined) throw new Error("refusing to swap service install state with no state path");
  const attempts = deps.attempts ?? SERVICE_STATE_SWAP_ATTEMPTS;
  return withServiceStateLock(anchor, () => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const base = readServiceInstallStateAt(anchor);
      const baseRevision = base?.revision ?? 0;
      const candidate = mutate(base);
      if (candidate === null) return base;
      const next: ServiceInstallState = { ...candidate, revision: baseRevision + 1 };
      const serialized = JSON.stringify(next, null, 2) + "\n";
      deps.beforeCommit?.(attempt);
      if ((readServiceInstallStateAt(anchor)?.revision ?? 0) !== baseRevision) continue;
      for (const path of paths) commitServiceStateFile(path, serialized);
      let committed: string | null = null;
      try { committed = readFileSync(anchor, "utf8"); } catch { /* the comparison below decides */ }
      if (committed === serialized) return next;
    }
    throw new ServiceStateConflictError(anchor, attempts);
  }, deps.lockWaitMs);
}

/** The recorded owner of ONE already-read record, or null. Prefer {@link resolveServiceOwnership}. */
export function serviceOwnership(state: ServiceInstallState | null = readServiceInstallState()): ServiceOwnership | null {
  return state?.ownership ?? null;
}

/**
 * What every state path, together, says about who owns the runtime.
 *
 * An unknown resolution is the answer that matters. \`readServiceInstallState\` collapses
 * unreadable, malformed and absent into one null, and a caller that reads that null as "the
 * CLI owns it" will re-enable the npm launcher over a claim it merely failed to read — the
 * exact demotion the record exists to prevent. Absence is the only thing that may mean no
 * claim.
 */
export type ServiceOwnershipResolution =
  | { readonly kind: "none" }
  | { readonly kind: "owned"; readonly ownership: ServiceOwnership }
  | { readonly kind: "unknown"; readonly reason: string };

export function resolveServiceOwnership(
  evidence: readonly ServiceStateEvidence[] = inspectServiceStateEvidence(),
): ServiceOwnershipResolution {
  for (const entry of evidence) {
    // Any path. A claim we are not allowed to look at is still a claim.
    if (entry.kind === "unreadable") {
      return { kind: "unknown", reason: `a service state path could not be read (${entry.reason})` };
    }
  }
  // Only the ANCHOR's corruption is fatal. The second path is the legacy default-home entry
  // kept so an install made before OPENCODEX_HOME existed can still be found; unrelated junk
  // left there by an old version must not be able to block every repair on this machine.
  if (evidence[0]?.kind === "invalid") {
    return { kind: "unknown", reason: "the service install record is present but not valid" };
  }
  const claims = evidence.flatMap(entry => (
    entry.kind === "valid" && entry.state.ownership ? [entry.state.ownership] : []
  ));
  const first = claims[0];
  if (first === undefined) return { kind: "none" };
  if (claims.some(claim => claim.owner !== first.owner || claim.installId !== first.installId)) {
    return { kind: "unknown", reason: "the service state paths name different owners" };
  }
  // Same claim in both places; the higher generation is the later write.
  return {
    kind: "owned",
    ownership: claims.reduce((best, claim) => claim.consentGeneration > best.consentGeneration ? claim : best, first),
  };
}

/**
 * Whether the packaged desktop app owns the runtime.
 *
 * This is the predicate `ocx service repair` and `ocx update` consult before they would
 * re-enable, rewrite or restart the npm service registration. The registration itself is
 * kept either way — the maintainer's decision is that the user's install is never deleted,
 * so this marker is the only thing that makes the takeover durable.
 */
export function desktopOwnsService(state: ServiceInstallState | null = readServiceInstallState()): boolean {
  return serviceOwnership(state)?.owner === "desktop";
}

/**
 * THE COMPARISON RULE. An installation holds the recorded grant only when both the kind of
 * owner and the install id match its own.
 *
 * The desktop app calls this at launch with the install id from its app-local store. True
 * means this very installation already has consent and must not ask again. False with a
 * non-null `ownership` means a DIFFERENT installation owns the runtime — a reinstalled app,
 * or a second copy — and consent has to be asked before taking over. Null means nothing is
 * recorded and the npm install still owns it.
 */
export function ownershipGrantedTo(
  ownership: ServiceOwnership | null,
  owner: ServiceOwner,
  installId: string,
): boolean {
  return ownership !== null && ownership.owner === owner && ownership.installId === installId;
}

/**
 * The record an ownership write lands on when no install state exists yet.
 *
 * Deliberately carries no `bunPath`, `cliPath` or `launcherPath`: those are baked BY AN
 * INSTALL, and a takeover is not one. Recording the claiming process's own paths as install
 * provenance would make `ocx service status` describe a registration nobody created.
 */
function ownershipBaseRecord(current: ServiceInstallState | null): ServiceInstallState {
  if (current) return current;
  const codexHome = currentCodexHome();
  return {
    version: 2,
    codexHome,
    opencodexHome: currentOpenCodexHome(),
    codexSqliteHome: resolveCodexSqliteHome({ codexHome }),
    backend: "scheduler",
  };
}

/**
 * Record `claim` as the runtime's owner and return what was written.
 *
 * Idempotent by design: re-recording the same owner and install id leaves the consent
 * generation alone, so every relaunch of an app that already has consent is a no-op on the
 * number. A different owner or a different install id is a new grant and increments it once.
 */
export function recordServiceOwner(
  claim: { owner: ServiceOwner; installId: string },
  deps: ServiceStateSwapDeps = {},
): ServiceOwnership {
  if (!claim.installId) throw new Error("refusing to record service ownership without an install id");
  let recorded: ServiceOwnership | null = null;
  swapServiceInstallState(current => {
    const previous = current?.ownership ?? null;
    // The ceiling, not just the live claim: a grant that was released left its number
    // behind on purpose, so a later grant cannot reuse it.
    const floor = Math.max(previous?.consentGeneration ?? 0, current?.consentGenerationCeiling ?? 0);
    recorded = {
      owner: claim.owner,
      installId: claim.installId,
      consentGeneration: previous && ownershipGrantedTo(previous, claim.owner, claim.installId)
        ? previous.consentGeneration
        : floor + 1,
    };
    return {
      ...ownershipBaseRecord(current),
      ownership: recorded,
      consentGenerationCeiling: Math.max(floor, recorded.consentGeneration),
    };
  }, deps);
  if (recorded === null) throw new Error("service ownership was not recorded");
  return recorded;
}

/**
 * Drop a recorded owner and return what was dropped, or null when nothing was recorded.
 *
 * Writes nothing when there is no claim to release, so asking about an unowned runtime never
 * creates an install record describing a service nobody registered.
 */
export function releaseServiceOwner(deps: ServiceStateSwapDeps = {}): ServiceOwnership | null {
  let released: ServiceOwnership | null = null;
  swapServiceInstallState(current => {
    released = current?.ownership ?? null;
    if (!current?.ownership) return null;
    const { ownership: _released, ...withoutOwnership } = current;
    // Keep the number. Dropping it makes the generation an ABA token: grant, release, grant
    // again would produce 1 twice, and an app-local record still holding the first 1 would
    // read the second grant as its own prior consent.
    return {
      ...withoutOwnership,
      consentGenerationCeiling: Math.max(
        current.consentGenerationCeiling ?? 0,
        current.ownership.consentGeneration,
      ),
    };
  }, deps);
  return released;
}

/** What ONE state path said. Absent, unreadable and invalid are different answers. */
export type ServiceStateEvidence =
  | { readonly path: string; readonly kind: "absent" }
  | { readonly path: string; readonly kind: "unreadable"; readonly reason: string }
  | { readonly path: string; readonly kind: "invalid" }
  | { readonly path: string; readonly kind: "valid"; readonly state: ServiceInstallState };

/**
 * Every state path, with what each one said.
 *
 * `readServiceInstallState` returns the FIRST path that parsed and discards the
 * rest, so a valid mirror beside a corrupt one reads as clean. That is the right
 * behavior for callers that just need the install state; it is the wrong input
 * for deciding ownership, where a disagreement between mirrors is exactly the
 * evidence that matters.
 */
export function inspectServiceStateEvidence(
  paths: readonly string[] = serviceStatePaths(),
): readonly ServiceStateEvidence[] {
  return paths.map((path): ServiceStateEvidence => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      // ENOENT is an answer. EACCES, ENOTDIR and the rest are a failure to ask,
      // and collapsing them into absence is how a locked-down state file would
      // become permission to write.
      if (code === "ENOENT") return { path, kind: "absent" };
      return { path, kind: "unreadable", reason: code || String(error) };
    }
    let parsed: ServiceInstallState | null;
    try {
      parsed = parseServiceInstallState(JSON.parse(raw));
    } catch {
      return { path, kind: "invalid" };
    }
    return parsed ? { path, kind: "valid", state: parsed } : { path, kind: "invalid" };
  });
}

/** The homes this process is actually using, for comparison against a claim. */
export function currentServiceHomes(deps: CodexHomeDeps = {}): { codexHome: string; opencodexHome: string } {
  return { codexHome: currentCodexHome(deps), opencodexHome: currentOpenCodexHome() };
}

export function serviceHomeMatches(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

/** Single accessor for backend-sensitive service code — v1/legacy state maps to scheduler. */
export function readServiceBackend(): ServiceBackend {
  return readServiceInstallState()?.backend === "native" ? "native" : "scheduler";
}

/**
 * The `ocx` argv that refreshes an already-installed service after an update.
 *
 * `repair` discovers the installed backend itself. A healthy Windows scheduler task only
 * gets refreshed assets plus a restart; a stale live definition is re-registered and may
 * require elevation. `install` always reaches `/create`, so using repair here avoids an
 * unnecessary admin prompt for the common healthy update path.
 *
 * The historical export name is kept for callers outside this module.
 */
export function serviceReinstallArgs(): string[] {
  return ["service", "repair"];
}

/** The `ocx` argv that registers a service from scratch, preserving the chosen backend. */
export function serviceInstallArgs(): string[] {
  return readServiceBackend() === "native" ? ["service", "install", "--native"] : ["service", "install"];
}
