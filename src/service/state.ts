import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { expandUserPath, getConfigDir } from "../config";
import { atomicWriteFileStreamed } from "../config/atomic-write";
import { resolveCodexHomeDir, type CodexHomeDeps } from "../codex/home";
import { resolveCodexSqliteHome } from "../codex/paths";
import { durableBunRuntime, type BunRuntimeSource, type DurableBunRuntime } from "../lib/bun-runtime";
import { WINSW_SHA256, WINSW_VERSION } from "../lib/winsw";
import { isProtectedHomeUnderTest, isTestHomeGuardArmed } from "../lib/test-home-guard";
import { isStandaloneBinary } from "../lib/standalone";
import {
  inspectInstallStateBytes,
  parseInstallStateRecord,
  parseOwnershipClaim,
  SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
  SERVICE_OWNERSHIP_PROTOCOL_VERSION,
  selectAuthoritativeServiceState,
  serviceStateFingerprint,
  serviceStateFilesFor,
} from "./install-state-contract.mjs";
import type { ServiceStateRecordEvidence } from "./state-record.mjs";
import { assertServiceStateLocksOwned, withServiceStateLocks, type ServiceStateLockHooks } from "./state-lock";
import { withOwnershipMutationLease, type OwnershipMutationLeaseOptions } from "./ownership-mutation-lease.mjs";
import {
  assessServiceTakeoverCompatibility,
  sameServiceTakeoverCompatibility,
  type ManagingCliObservation,
  type ServiceTakeoverCompatibility,
} from "./ownership-compatibility";

/**
 * Written only by the launchd plist and the systemd unit. `OCX_SERVICE=1` cannot stand in
 * for it: `ocx claude` and `ocx opencode` set that on the proxies they spawn to borrow its
 * routing-preservation meaning, so a proxy carrying it is not necessarily the managed job.
 */
export const SERVICE_MANAGED_ENV = "OCX_SERVICE_MANAGED";

export const LABEL = "com.opencodex.proxy";
export const TASK = "opencodex-proxy";
export { SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION, SERVICE_OWNERSHIP_PROTOCOL_VERSION };

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
  return serviceStateFilesFor(opencodexHome, defaultOpenCodexHome());
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
  /** Written only by CLIs whose start/repair/update paths honor a desktop claim. */
  ownershipProtocolVersion?: number;
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

/**
 * Validate an ownership claim read off disk.
 *
 * Returns the ORIGINAL object rather than a rebuilt one: a newer writer may carry fields
 * this version does not know about, and rebuilding would drop them on the next preserve —
 * which is the same lost-field failure this whole record exists to stop.
 */
export function parseServiceOwnership(value: unknown): ServiceOwnership | null {
  return parseOwnershipClaim(value) as ServiceOwnership | null;
}

/**
 * The record contract lives in `install-state-contract.mjs` so the Node launcher validates
 * exactly what this reader validates. It used to keep a weaker copy, and a record that fails
 * this contract while merely lacking an `ownership` field read there as "nobody owns the
 * runtime" — which is permission to stop a foreign runtime and reactivate the npm service.
 */
export function parseServiceInstallState(value: unknown): ServiceInstallState | null {
  return parseInstallStateRecord(value) as ServiceInstallState | null;
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
    ownershipProtocolVersion: SERVICE_OWNERSHIP_PROTOCOL_VERSION,
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
export function writeServiceInstallState(
  backend: ServiceBackend = "scheduler",
  launcherPath?: string | null,
  deps: ServiceStateSwapDeps = {},
): void {
  swapServiceInstallState(current => ({
    ...installProvenanceRecord(backend, launcherPath),
    ...preservedConsent(current),
  }), deps);
}

/** The ownership half of a record: the claim itself plus the generation high-water mark. */
function preservedConsent(
  current: ServiceInstallState | null,
): Pick<ServiceInstallState, "ownership" | "consentGenerationCeiling"> {
  const ownership = current?.ownership;
  const ceiling = Math.max(current?.consentGenerationCeiling ?? 0, ownership?.consentGeneration ?? 0);
  return {
    ...(ownership ? { ownership } : {}),
    ...(ceiling > 0 ? { consentGenerationCeiling: ceiling } : {}),
  };
}

export function readServiceInstallState(): ServiceInstallState | null {
  const resolved = resolveServiceState();
  return resolved.kind === "state" ? resolved.state : null;
}

/** Raised when a non-cooperating writer prevents a stable authoritative commit. */
export class ServiceStateConflictError extends Error {
  constructor(readonly path: string, readonly attempts: number) {
    super(
      `service install state at ${path} was rewritten by another process during all ${attempts} `
      + "compare-and-swap attempts; a stable commit could not be verified. Re-run the command.",
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
  /** Deterministic lock seams for failure-order tests. */
  lockHooks?: ServiceStateLockHooks;
  /** Atomic publisher seam. The callback must run immediately before its commit point. */
  commitStateFile?: (path: string, serialized: string, validate: () => void) => void;
  /** A mirror failure occurs after the authority committed and is therefore diagnostic. */
  onMirrorError?: (path: string, error: unknown) => void;
  /** Allows consented mutations to preserve a machine-readable unknown-subject error. */
  unknownStateError?: (reason: string) => Error;
  /** Shared with update/install/start so replacement and ownership mutation cannot overlap. */
  mutationLease?: OwnershipMutationLeaseOptions;
}

export interface ServiceStateMutationContext {
  readonly revision: number;
}

const SERVICE_STATE_SWAP_ATTEMPTS = 5;

function authoritativeState(
  paths: readonly string[],
  unknownStateError?: (reason: string) => Error,
): { current: ServiceInstallState | null; revision: number; fingerprint: string } {
  const selected = selectAuthoritativeServiceState(
    inspectServiceStateEvidence(paths) as readonly ServiceStateRecordEvidence[],
  );
  if (selected.kind === "unknown") {
    throw unknownStateError?.(selected.reason) ?? new Error(`${selected.reason}; nothing was written`);
  }
  if (selected.kind === "none") return { current: null, revision: 0, fingerprint: "none" };
  const current = selected.state as ServiceInstallState;
  return { current, revision: selected.revision, fingerprint: serviceStateFingerprint(current) };
}

function commitServiceStateFile(path: string, serialized: string, validate: () => void): void {
  atomicWriteFileStreamed(path, descriptor => {
    writeFileSync(descriptor, serialized, { encoding: "utf8" });
  }, { validateBeforeRename: validate });
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
 * The final path is the authority. With a custom home that is the legacy default-home path —
 * the only path every writer can derive — and the active-home path is a compatibility mirror.
 * The authority's atomic rename is the commit point. A mirror failure is reported but cannot
 * roll back or reclassify the already committed mutation; the next writer repairs the mirror.
 */
export function swapServiceInstallState(
  mutate: (current: ServiceInstallState | null, context: ServiceStateMutationContext) => ServiceInstallState | null,
  deps: ServiceStateSwapDeps = {},
): ServiceInstallState | null {
  const paths = deps.paths ?? serviceStateWritePaths();
  const authority = paths.at(-1);
  if (authority === undefined) throw new Error("refusing to swap service install state with no state path");
  const mirrors = paths.filter(path => path !== authority);
  const attempts = deps.attempts ?? SERVICE_STATE_SWAP_ATTEMPTS;
  const publish = deps.commitStateFile ?? commitServiceStateFile;
  return withOwnershipMutationLease(paths, () => withServiceStateLocks(paths, () => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const base = authoritativeState(paths, deps.unknownStateError);
      const candidate = mutate(base.current, { revision: base.revision });
      if (candidate === null) return base.current;
      if (base.revision >= Number.MAX_SAFE_INTEGER) {
        throw new Error("service state revision is exhausted; refusing to publish an unversioned mutation");
      }
      const next: ServiceInstallState = { ...candidate, revision: base.revision + 1 };
      const serialized = JSON.stringify(next, null, 2) + "\n";
      deps.beforeCommit?.(attempt);
      assertServiceStateLocksOwned(paths);
      const fresh = authoritativeState(paths, deps.unknownStateError);
      if (fresh.revision !== base.revision || fresh.fingerprint !== base.fingerprint) continue;
      const validate = () => assertServiceStateLocksOwned(paths);
      publish(authority, serialized, validate);
      const committed = authoritativeState([authority]);
      if (committed.revision !== next.revision || committed.fingerprint !== serviceStateFingerprint(next)) continue;
      for (const mirror of mirrors) {
        try { publish(mirror, serialized, validate); }
        catch (error) {
          (deps.onMirrorError ?? ((path, cause) => console.warn(
            `service state committed, but compatibility mirror ${path} could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`,
          )))(mirror, error);
        }
      }
      return next;
    }
    throw new ServiceStateConflictError(authority, attempts);
  }, { waitMs: deps.lockWaitMs, hooks: deps.lockHooks }), deps.mutationLease);
}

export interface RemoveServiceStateDeps {
  readonly paths?: readonly string[];
  readonly unlink?: (path: string) => void;
  readonly lockWaitMs?: number;
  readonly lockHooks?: ServiceStateLockHooks;
}

/**
 * Delete mirrors first and the authority last under the same ownership locks.
 *
 * A crash or mirror error before the final unlink leaves the authority in place, so a stale
 * mirror can never become a migration source and resurrect a released desktop claim.
 */
export function removeServiceInstallStateRecords(deps: RemoveServiceStateDeps = {}): void {
  const paths = deps.paths ?? serviceStateWritePaths();
  const authority = paths.at(-1);
  if (!authority) return;
  const unlink = deps.unlink ?? unlinkSync;
  withOwnershipMutationLease(paths, () => withServiceStateLocks(paths, () => {
    for (const mirror of paths.slice(0, -1)) {
      assertServiceStateLocksOwned(paths);
      if (existsSync(mirror)) unlink(mirror);
    }
    assertServiceStateLocksOwned(paths);
    if (existsSync(authority)) unlink(authority);
  }, { waitMs: deps.lockWaitMs, hooks: deps.lockHooks }), { waitMs: deps.lockWaitMs });
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
export type ServiceStateResolution =
  | { readonly kind: "none"; readonly revision: 0; readonly needsRepair: false }
  | { readonly kind: "state"; readonly state: ServiceInstallState; readonly revision: number; readonly needsRepair: boolean }
  | { readonly kind: "unknown"; readonly reason: string };

export type ServiceOwnershipSubject =
  | { readonly kind: "none"; readonly revision: number }
  | { readonly kind: "owned"; readonly ownership: ServiceOwnership; readonly revision: number };

export type ServiceOwnershipResolution = ServiceOwnershipSubject
  | { readonly kind: "unknown"; readonly reason: string };

export function resolveServiceState(
  evidence: readonly ServiceStateEvidence[] = inspectServiceStateEvidence(),
): ServiceStateResolution {
  const selected = selectAuthoritativeServiceState(evidence as readonly ServiceStateRecordEvidence[]);
  if (selected.kind === "unknown") return selected;
  if (selected.kind === "none") return selected;
  return {
    kind: "state",
    state: selected.state as ServiceInstallState,
    revision: selected.revision,
    needsRepair: selected.needsRepair,
  };
}

export function resolveServiceOwnership(
  evidence: readonly ServiceStateEvidence[] = inspectServiceStateEvidence(),
): ServiceOwnershipResolution {
  const state = resolveServiceState(evidence);
  if (state.kind === "unknown") return state;
  if (state.kind === "none" || !state.state.ownership) return { kind: "none", revision: state.revision };
  return { kind: "owned", ownership: state.state.ownership, revision: state.revision };
}

export function sameServiceOwnershipSubject(
  left: ServiceOwnershipSubject,
  right: ServiceOwnershipSubject,
): boolean {
  if (left.kind !== right.kind || left.revision !== right.revision) return false;
  if (left.kind === "none" || right.kind === "none") return true;
  return left.ownership.owner === right.ownership.owner
    && left.ownership.installId === right.ownership.installId
    && left.ownership.consentGeneration === right.ownership.consentGeneration;
}

function sameServiceOwnershipIdentity(left: ServiceOwnershipSubject, right: ServiceOwnershipSubject): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "none" || right.kind === "none") return true;
  return left.ownership.owner === right.ownership.owner
    && left.ownership.installId === right.ownership.installId
    && left.ownership.consentGeneration === right.ownership.consentGeneration;
}

function serviceOwnershipSubject(
  state: ServiceInstallState | null,
  revision: number,
): ServiceOwnershipSubject {
  return state?.ownership
    ? { kind: "owned", ownership: state.ownership, revision }
    : { kind: "none", revision };
}

export class ServiceOwnershipSubjectMismatchError extends Error {
  readonly code = "service-ownership-subject-mismatch" as const;
  constructor(readonly expected: ServiceOwnershipSubject, readonly actual: ServiceOwnershipSubject) {
    super("service ownership changed after consent; resolve again and ask for fresh approval");
    this.name = "ServiceOwnershipSubjectMismatchError";
  }
}

export class ServiceOwnershipSubjectUnknownError extends Error {
  readonly code = "service-ownership-subject-unknown" as const;
  constructor(readonly expected: ServiceOwnershipSubject, readonly reason: string) {
    super(`service ownership could not be revalidated after consent (${reason}); nothing was written`);
    this.name = "ServiceOwnershipSubjectUnknownError";
  }
}

export class ServiceTakeoverCompatibilityChangedError extends Error {
  readonly code = "service-takeover-compatibility-changed" as const;
  constructor(readonly actual: ServiceTakeoverCompatibility) {
    super("the managing CLI compatibility changed after consent; resolve again and ask for fresh approval");
    this.name = "ServiceTakeoverCompatibilityChangedError";
  }
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
export interface RecordServiceOwnerRequest {
  readonly owner: ServiceOwner;
  readonly installId: string;
  readonly expectedSubject: ServiceOwnershipSubject;
  readonly expectedCompatibility: Extract<ServiceTakeoverCompatibility, { kind: "supported" }>;
}

export interface RecordServiceOwnerDeps extends ServiceStateSwapDeps {
  /** Re-observes BOTH the registered manager and the current PATH manager inside the lock. */
  readonly observeManagers: () => Readonly<Record<"service-registration" | "path", ManagingCliObservation>>;
}

export function recordServiceOwner(
  request: RecordServiceOwnerRequest,
  deps: RecordServiceOwnerDeps,
): Extract<ServiceOwnershipSubject, { kind: "owned" }> {
  if (!request.installId) throw new Error("refusing to record service ownership without an install id");
  if (!request.expectedSubject || request.expectedCompatibility?.kind !== "supported") {
    throw new Error("refusing to record service ownership without the exact approved subject and compatibility token");
  }
  if (!deps || typeof deps.observeManagers !== "function") {
    throw new Error("refusing to record service ownership without a managing-CLI revalidation callback");
  }
  const { observeManagers, ...swapDeps } = deps;
  let recorded: ServiceOwnership | null = null;
  const committed = swapServiceInstallState((current, context) => {
    const actualSubject = serviceOwnershipSubject(current, context.revision);
    if (!sameServiceOwnershipSubject(request.expectedSubject, actualSubject)) {
      throw new ServiceOwnershipSubjectMismatchError(request.expectedSubject, actualSubject);
    }
    let managers: Readonly<Record<"service-registration" | "path", ManagingCliObservation>>;
    try { managers = observeManagers(); }
    catch (error) {
      throw new ServiceTakeoverCompatibilityChangedError({
        kind: "blocked",
        reason: "managing-cli-unknown",
        detail: error instanceof Error ? error.message : String(error),
        minimumCliVersion: SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
      });
    }
    const compatibility = assessServiceTakeoverCompatibility({
      state: current,
      subject: actualSubject,
      managers,
    });
    if (!sameServiceTakeoverCompatibility(request.expectedCompatibility, compatibility)) {
      throw new ServiceTakeoverCompatibilityChangedError(compatibility);
    }
    const previous = current?.ownership ?? null;
    // The ceiling, not just the live claim: a grant that was released left its number
    // behind on purpose, so a later grant cannot reuse it.
    const floor = Math.max(previous?.consentGeneration ?? 0, current?.consentGenerationCeiling ?? 0);
    if (floor >= Number.MAX_SAFE_INTEGER) {
      throw new Error("service ownership consent generation is exhausted; nothing was written");
    }
    recorded = {
      owner: request.owner,
      installId: request.installId,
      consentGeneration: previous && ownershipGrantedTo(previous, request.owner, request.installId)
        ? previous.consentGeneration
        : floor + 1,
    };
    return {
      ...ownershipBaseRecord(current),
      ownership: recorded,
      consentGenerationCeiling: Math.max(floor, recorded.consentGeneration),
    };
  }, {
    ...swapDeps,
    unknownStateError: reason => new ServiceOwnershipSubjectUnknownError(request.expectedSubject, reason),
  });
  if (recorded === null || !committed?.ownership || committed.revision === undefined) {
    throw new Error("service ownership was not recorded");
  }
  return { kind: "owned", ownership: committed.ownership, revision: committed.revision };
}

/**
 * Drop a recorded owner and return what was dropped, or null when nothing was recorded.
 *
 * Writes nothing when there is no claim to release, so asking about an unowned runtime never
 * creates an install record describing a service nobody registered.
 */
export interface ReleaseServiceOwnerDeps extends ServiceStateSwapDeps {
  /** Service install refreshes provenance first; that known write may advance only revision. */
  readonly allowRevisionAdvance?: boolean;
}

export function releaseServiceOwner(
  expectedSubject: ServiceOwnershipSubject,
  deps: ReleaseServiceOwnerDeps = {},
): ServiceOwnership | null {
  const { allowRevisionAdvance = false, ...swapDeps } = deps;
  let released: ServiceOwnership | null = null;
  swapServiceInstallState((current, context) => {
    const actualSubject = serviceOwnershipSubject(current, context.revision);
    const matches = allowRevisionAdvance
      ? sameServiceOwnershipIdentity(expectedSubject, actualSubject) && actualSubject.revision >= expectedSubject.revision
      : sameServiceOwnershipSubject(expectedSubject, actualSubject);
    if (!matches) throw new ServiceOwnershipSubjectMismatchError(expectedSubject, actualSubject);
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
  }, {
    ...swapDeps,
    unknownStateError: reason => new ServiceOwnershipSubjectUnknownError(expectedSubject, reason),
  });
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
 * The final path is authoritative; earlier paths are compatibility mirrors and the
 * migration source only while the authority is absent. Keeping the raw evidence separate
 * lets the selector distinguish migration, degraded mirrors and unordered conflicts.
 */
export function inspectServiceStateEvidence(
  paths: readonly string[] = serviceStatePaths(),
): readonly ServiceStateEvidence[] {
  return paths.map(path => (
    inspectInstallStateBytes(path, at => readFileSync(at, "utf8")) as ServiceStateEvidence
  ));
}

/** The homes this process is actually using, for comparison against a claim. */
export function currentServiceHomes(deps: CodexHomeDeps = {}): { codexHome: string; opencodexHome: string } {
  return { codexHome: currentCodexHome(deps), opencodexHome: currentOpenCodexHome() };
}

export function serviceHomeMatches(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

export function serviceCodexHomeMatchesInstall(recordedHome: string, deps: CodexHomeDeps = {}): boolean {
  return serviceHomeMatches(recordedHome, currentCodexHome(deps));
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
