import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync,
  realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getConfigDir } from "../config";
import { durableBunRuntime } from "../lib/bun-runtime";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { truncateRetainedUtf8 } from "../lib/admission";
import type { CodexShimDiagnostic } from "./shim-diagnostics";
import type { CodexShimAutoRestoreResult } from "./shim";
import { sameFingerprint, shimPathFingerprint, stableShimPathProbe } from "./shim-fingerprint";
import { migrateLegacyUnixShim } from "./shim-migration";
import { findFirstCodexOnPath, isExecutableCodexCandidate } from "./shim-path-resolution";
import { CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS, MAX_DIAGNOSTIC_VALUE_BYTES, probeUnixShimFiles } from "./shim-probe";
import { tryAcquireShimRestoreLock } from "./shim-restore-lock";
import {
  decodeOverlayState, fileErrorCode, readBoundedRegularFile, readStateResult, statePath,
  type OverlayIdentity, type OverlayState, type ShimState,
} from "./shim-state-file";
import { buildUnixCodexShim, SHIM_MARKER, UNIX_SHIM_REVISION_MARKER, shQuote } from "./shim-templates";

type Snapshot = { identity: OverlayIdentity; mode: number; content: string; uid?: number; gid?: number };
type Publication = { path: string; staged: string; created: Snapshot; prior: Snapshot | null; rollback: string };
type Journal = { version: 1; token: string; launcher: string; files: Publication[] };
type InstallResult = { installed: boolean; message: string; refused?: boolean; runnable?: boolean };
type RestoreOptions = {
  enabled: () => boolean;
  stabilitySleep?: (ms: number) => void;
  afterRestoreLockAcquired?: () => void;
  beforeStaleRestoreLockDelete?: () => void;
};
const JOURNAL_NAME = "codex-shim.transaction.json";
const ENV_HEADER = "# opencodex managed Codex PATH\n";
const PRIVATE_FILE_MAX_BYTES = 64 * 1024;

export function overlayPaths(configDir = getConfigDir()): { wrapper: string; env: string } {
  return { wrapper: join(resolve(configDir), "bin", "codex"), env: join(resolve(configDir), "codex-shell-env.sh") };
}
export function overlayActivationHint(configDir = getConfigDir()): string {
  return `For sh/bash/zsh, run . ${shQuote(overlayPaths(configDir).env)} and add that line after other PATH setup in your shell startup file. Absolute Codex paths and GUI launchers bypass this shim.`;
}
function sameId(left: OverlayIdentity | null | undefined, right: OverlayIdentity | null | undefined): boolean {
  return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
}
function lexical(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) { if (fileErrorCode(error) === "ENOENT") return null; throw error; }
}
function snapshot(path: string): Snapshot | null {
  const before = lexical(path);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.() || (before.mode & 0o022)) {
    throw new Error("Private Codex artifact is not an owned regular file");
  }
  const bounded = readBoundedRegularFile(path, PRIVATE_FILE_MAX_BYTES);
  if (!bounded || "warning" in bounded) throw new Error("Private Codex artifact is unreadable or changed");
  const after = lstatSync(path);
  if (!sameId(before, after) || before.mode !== after.mode || before.uid !== after.uid
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    || !sameId(bounded.stat, after) || bounded.stat.mode !== after.mode || bounded.stat.uid !== after.uid
    || bounded.stat.size !== after.size || bounded.stat.mtimeMs !== after.mtimeMs || bounded.stat.ctimeMs !== after.ctimeMs) {
    throw new Error("Private Codex artifact changed");
  }
  return { identity: { dev: after.dev, ino: after.ino }, mode: after.mode & 0o7777,
    content: bounded.content, uid: after.uid, gid: after.gid };
}
function unchanged(path: string, expected: Snapshot | null): boolean {
  const current = snapshot(path);
  return expected ? !!current && sameId(current.identity, expected.identity)
    && current.content === expected.content && current.mode === expected.mode
    && (expected.uid === undefined || current.uid === expected.uid)
    && (expected.gid === undefined || current.gid === expected.gid) : current === null;
}

/** Validate the physical configured home alias; managed bin may never be a symlink. */
function namespace(create: boolean): () => void {
  const home = resolve(getConfigDir());
  if (home.includes(":") || /[\x00-\x1f\x7f]/.test(home)) throw new Error("Private Codex home cannot contain colon or control characters");
  if (!lexical(home)) {
    if (!create) throw new Error("Private Codex home is missing");
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  const physical = realpathSync.native(home);
  const root = statSync(home);
  if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o022)) {
    throw new Error("Private Codex home must be owned by the current user and not group/world writable");
  }
  const bin = join(home, "bin");
  if (!lexical(bin) && create) mkdirSync(bin, { mode: 0o700 });
  const child = lexical(bin);
  const trusted = (value: Stats): boolean => value.isDirectory()
    && value.uid === process.getuid?.() && (value.mode & 0o022) === 0;
  if (!trusted(root) || (child && (!trusted(child) || child.isSymbolicLink()))) {
    throw new Error("Private Codex home/bin must be owned by the current user and not group/world writable");
  }
  return () => {
    if (realpathSync.native(home) !== physical || !sameId(root, statSync(home)) || !trusted(statSync(home))) {
      throw new Error("Private Codex home changed during operation");
    }
    const current = lexical(bin);
    if (child ? !current || !sameId(child, current) || !trusted(current) || current.isSymbolicLink() : current !== null) {
      throw new Error("Private Codex bin changed during operation");
    }
  };
}
function scriptFor(launcher: string): string {
  const runtime = durableBunRuntime();
  return buildUnixCodexShim(launcher, runtime.path, join(import.meta.dir, "..", "cli", "index.ts"), runtime.source);
}
function shellEnvironment(): string {
  return [ENV_HEADER.trimEnd(), `ocx_shim_dir=${shQuote(dirname(overlayPaths().wrapper))}`,
    'ocx_shim_rest="${PATH-}"', 'ocx_shim_path="$ocx_shim_dir"', 'ocx_shim_more=1',
    'while [ "$ocx_shim_more" = 1 ]; do', '  case "$ocx_shim_rest" in',
    '    *:*) ocx_shim_part="${ocx_shim_rest%%:*}"; ocx_shim_rest="${ocx_shim_rest#*:}" ;;',
    '    *) ocx_shim_part="$ocx_shim_rest"; ocx_shim_more=0 ;;', '  esac',
    '  if [ "$ocx_shim_part" != "$ocx_shim_dir" ]; then ocx_shim_path="$ocx_shim_path:$ocx_shim_part"; fi',
    'done', 'export PATH="$ocx_shim_path"',
    'unset ocx_shim_dir ocx_shim_rest ocx_shim_path ocx_shim_more ocx_shim_part', ""].join("\n");
}
function ownedWrapper(value: Snapshot, state: OverlayState): boolean {
  return sameId(value.identity, state.wrapperIdentity)
    && value.content.includes(SHIM_MARKER) && value.content.includes(`exec ${shQuote(state.launcherPath)} "$@"`);
}
function requireOverlayIdentities(state: OverlayState): void {
  if (!state.wrapperIdentity || !state.envIdentity) {
    throw new Error("Private Codex shim ownership identities are missing; preserving all files. Remove the private files manually, then reinstall with ocx codex-shim install.");
  }
}
function ownedEnvironment(value: Snapshot, state: OverlayState): boolean {
  return sameId(value.identity, state.envIdentity) && value.content === shellEnvironment();
}
function revalidateOverlay(state: OverlayState, saved: Snapshot | null, wrapper: Snapshot | null, env: Snapshot | null): void {
  if (!unchanged(statePath(), saved) || !unchanged(state.wrapperPath, wrapper) || !unchanged(overlayPaths().env, env)) {
    throw new Error("Private Codex installation changed during inspection; preserving artifacts");
  }
}
/** Validate the whole installation before endorsing either execution or activation. */
function inspectOverlay(state: OverlayState): {
  wrapper: Snapshot | null; environmentPresent: boolean; complete: boolean; revalidate: () => void;
} {
  requireOverlayIdentities(state);
  const saved = snapshot(statePath());
  const recorded = saved ? decodeOverlayState(JSON.parse(saved.content), getConfigDir()) : null;
  if (!saved || !recorded || recorded.platform !== state.platform || recorded.wrapperPath !== state.wrapperPath
    || recorded.launcherPath !== state.launcherPath || recorded.transactionId !== state.transactionId
    || !sameId(recorded.wrapperIdentity, state.wrapperIdentity) || !sameId(recorded.envIdentity, state.envIdentity)) {
    throw new Error("Private Codex shim state changed; preserving artifacts");
  }
  const wrapper = snapshot(state.wrapperPath);
  const env = snapshot(overlayPaths().env);
  if (wrapper && !ownedWrapper(wrapper, state)) throw new Error("Private Codex launcher was replaced; preserving it");
  if (env && !ownedEnvironment(env, state)) throw new Error("Codex shell environment file was replaced; preserving it");
  const revalidate = () => revalidateOverlay(state, saved, wrapper, env);
  revalidate();
  return { wrapper, environmentPresent: !!env, complete: saved.mode === 0o600 && !!env && env.mode === 0o600, revalidate };
}
function nativeProbe(path: string) {
  if (!isExecutableCodexCandidate(path)) return null;
  const probe = stableShimPathProbe(path);
  return probe && !probe.prefix.includes(SHIM_MARKER) ? probe : null;
}
function overlayRunnable(state: OverlayState, wrapper: Snapshot | null): boolean {
  return state.platform === process.platform && !!wrapper && ownedWrapper(wrapper, state)
    && wrapper.content.includes(UNIX_SHIM_REVISION_MARKER) && wrapper.content === scriptFor(state.launcherPath)
    && isExecutableCodexCandidate(state.wrapperPath) && !!nativeProbe(state.launcherPath);
}
export function overlayDiagnostic(state: ShimState): CodexShimDiagnostic {
  const overlay = decodeOverlayState(state, getConfigDir());
  let runnable = false;
  let active: boolean | null = false;
  let integrityMessage = "";
  let complete = false;
  try {
    const check = namespace(false);
    const inspection = overlay ? inspectOverlay(overlay) : null;
    const wrapper = inspection?.wrapper;
    complete = !!inspection?.complete;
    runnable = !!overlay && !!inspection?.environmentPresent && overlayRunnable(overlay, wrapper ?? null);
    if (inspection && !inspection.complete) integrityMessage = "Private Codex state and shell environment must be present with mode 0600; run ocx codex-shim install to repair them.";
    if (!complete) active = null;
    if (complete && overlay && wrapper) {
      try {
        const selected = findFirstCodexOnPath();
        if (selected) {
          const identity = shimPathFingerprint(selected.path);
          active = identity ? sameId(identity.target ?? identity, wrapper.identity) : null;
        }
      } catch { active = null; }
    }
    check();
    inspection?.revalidate();
  } catch (error) { active = null; runnable = false; integrityMessage = failure(error).message; }
  return { installed: true, healthy: complete && runnable && active === true, runnable, active,
    summary: `Codex PATH shim: ${complete && runnable ? "ready" : "unhealthy"} at ${state.wrapperPath}; launcher ${state.launcherPath}; PATH ${active === null ? "unverified" : active ? "active" : "inactive"}. ${complete && runnable ? overlayActivationHint() : integrityMessage || "Run ocx codex-shim install to repair the shim."}` };
}

/** Capture the created inode from its descriptor, never by trusting a later pathname read. */
function stage(path: string, content: string, mode: number): Snapshot {
  const fd = openSync(path, "wx", 0o600);
  const created = fstatSync(fd);
  try {
    writeFileSync(fd, content, "utf8");
    if (!sameId(created, lexical(path))) throw new Error("Staged Codex file replaced");
    chmodSync(path, mode);
    const pinned = snapshot(path);
    if (!pinned || !sameId(created, pinned.identity) || pinned.content !== content) throw new Error("Staged Codex file changed");
    return pinned;
  } catch (error) {
    if (sameId(created, lexical(path))) unlinkSync(path);
    throw error;
  } finally { closeSync(fd); }
}

function removePinned(path: string, expected: Snapshot): boolean {
  if (!lexical(path)) return true;
  if (!unchanged(path, expected)) return false;
  unlinkSync(path);
  return true;
}
function journalPath(): string { return join(getConfigDir(), JOURNAL_NAME); }
function validSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Snapshot;
  return !!item.identity && Number.isSafeInteger(item.identity.dev) && Number.isSafeInteger(item.identity.ino)
    && Number.isInteger(item.mode) && item.mode >= 0 && item.mode <= 0o7777 && typeof item.content === "string"
    // Older journals have no owner fields; snapshot() still requires current-user ownership.
    && (item.uid === undefined || Number.isSafeInteger(item.uid) && item.uid >= 0)
    && (item.gid === undefined || Number.isSafeInteger(item.gid) && item.gid >= 0);
}
function readJournal(): { journal: Journal; saved: Snapshot } | null {
  const saved = snapshot(journalPath());
  if (!saved) return null;
  const value = JSON.parse(saved.content) as Journal;
  if (value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.token) || typeof value.launcher !== "string"
    || !Array.isArray(value.files) || value.files.length !== 3) throw new Error("Invalid Codex publication journal");
  const targets = [overlayPaths().wrapper, overlayPaths().env, statePath()];
  for (const [index, file] of value.files.entries()) {
    if (file.path !== targets[index] || file.staged !== `${file.path}.${value.token}.stage`
      || file.rollback !== `${file.path}.${value.token}.rollback` || !validSnapshot(file.created)
      || (file.prior !== null && !validSnapshot(file.prior))) throw new Error("Invalid Codex publication paths");
  }
  const state = decodeOverlayState(JSON.parse(value.files[2]!.created.content), getConfigDir());
  if (!state || state.transactionId !== value.token || state.launcherPath !== value.launcher
    || !sameId(state.wrapperIdentity, value.files[0]!.created.identity)
    || !sameId(state.envIdentity, value.files[1]!.created.identity)
    || !ownedWrapper(value.files[0]!.created, state) || value.files[1]!.created.content !== shellEnvironment()) {
    throw new Error("Invalid Codex publication binding");
  }
  return { journal: value, saved };
}
/** State is the commit marker; uncommitted private publications are rolled back by identity. */
function recoverJournal(check: () => void): void {
  const pending = readJournal();
  if (!pending) return;
  const { journal, saved } = pending;
  const state = readStateResult().state;
  const committed = state?.transactionId === journal.token && unchanged(statePath(), journal.files[2]!.created);
  let complete = true;
  for (const file of [...journal.files].reverse()) {
    check();
    try {
      let discardPrior = committed;
      if (!committed && unchanged(file.path, file.created)) {
        if (file.prior) {
          if (!unchanged(file.rollback, file.prior)) throw new Error("Prior Codex artifact changed");
          renameSync(file.rollback, file.path);
        } else if (!removePinned(file.path, file.created)) throw new Error("Concurrent Codex publication");
        discardPrior = true;
      } else if (!committed && !lexical(file.path) && file.prior) {
        if (!unchanged(file.rollback, file.prior)) throw new Error("Prior Codex artifact unavailable");
        linkSync(file.rollback, file.path);
        discardPrior = true;
      } else if (!committed) {
        discardPrior = unchanged(file.path, file.prior);
        if (!discardPrior) complete = false;
      }
      if (!removePinned(file.staged, file.created)) complete = false;
      if (file.prior && discardPrior && !removePinned(file.rollback, file.prior)) complete = false;
    } catch { complete = false; } // Keep uncertain targets and prior generations for manual recovery.
  }
  check();
  if (!complete || !removePinned(journalPath(), saved)) throw new Error("Concurrent Codex artifacts preserved; inspect the publication journal before retrying");
}

function publishOverlay(launcher: string, state: OverlayState | null, check: () => void, currentState: Snapshot | null): InstallResult {
  const paths = overlayPaths();
  if (state) requireOverlayIdentities(state);
  if (!isAbsolute(launcher) || /[\x00-\x1f\x7f]/.test(launcher)) throw new Error("Unsupported native Codex launcher path");
  const initialNative = nativeProbe(launcher);
  if (!initialNative || resolve(launcher) === paths.wrapper) throw new Error("Native Codex launcher is unusable; repair it with its package manager");
  const wrapper = snapshot(paths.wrapper);
  const env = snapshot(paths.env);
  if (wrapper && (!state || !ownedWrapper(wrapper, state))) throw new Error("Refusing an unowned private Codex launcher");
  if (env && (!state || !ownedEnvironment(env, state))) {
    throw new Error("Refusing an unowned Codex shell environment file");
  }
  if (!unchanged(statePath(), currentState)) throw new Error("Codex shim state changed before publication");
  const script = scriptFor(launcher);
  if (state && wrapper?.content === script && isExecutableCodexCandidate(paths.wrapper) && env?.content === shellEnvironment()
    && env.mode === 0o600 && currentState?.mode === 0o600) {
    check();
    revalidateOverlay(state, currentState, wrapper, env);
    return { installed: false, runnable: true, message: `Codex PATH shim already installed. ${overlayActivationHint()}` };
  }
  const token = randomUUID();
  const files: Publication[] = [];
  let persisted = false;
  let journalSnapshot: Snapshot | null = null;
  const add = (path: string, content: string, mode: number, prior: Snapshot | null): Publication => {
    const staged = `${path}.${token}.stage`;
    const file = { path, staged, created: stage(staged, content, mode), prior, rollback: `${path}.${token}.rollback` };
    files.push(file);
    return file;
  };
  try {
    const wrapperFile = add(paths.wrapper, script, 0o755, wrapper);
    const envFile = add(paths.env, shellEnvironment(), 0o600, env);
    const nextState: OverlayState = { schema: 2, mode: "path-overlay", platform: process.platform,
      wrapperPath: paths.wrapper, launcherPath: launcher, wrapperIdentity: wrapperFile.created.identity,
      envIdentity: envFile.created.identity, transactionId: token };
    if (!decodeOverlayState(nextState, getConfigDir())) throw new Error("Invalid staged Codex overlay state");
    add(statePath(), JSON.stringify(nextState, null, 2) + "\n", 0o600, currentState);
    const probeDir = join(dirname(paths.wrapper), `.probe-${token}`);
    mkdirSync(probeDir, { mode: 0o700 });
    const probeIdentity = lstatSync(probeDir);
    const probeWrapper = join(probeDir, "codex");
    let unsafe: ReturnType<typeof probeUnixShimFiles>;
    try {
      linkSync(wrapperFile.staged, probeWrapper);
      unsafe = probeUnixShimFiles([{ wrapperPath: probeWrapper, originalPath: launcher, backupPath: launcher, realPath: launcher }],
        { PATH: `${probeDir}:${process.env.PATH ?? ""}` });
    } finally {
      check();
      if (sameId(probeIdentity, lexical(probeDir))) {
        removePinned(probeWrapper, wrapperFile.created);
        try { rmdirSync(probeDir); } catch { /* preserve uncertain probe contents */ }
      }
    }
    if (unsafe) {
      const reason = unsafe === "recursive" ? "the saved launcher resolved back to the generated shim"
        : unsafe === "timeout" ? `the saved launcher did not finish --version within ${CODEX_SHIM_INSTALL_PROBE_TIMEOUT_MS}ms`
        : unsafe === "descendants" ? "the saved launcher left background descendants running after --version"
        : typeof unsafe === "object" ? `the saved launcher's probe process group could not be terminated cleanly [phase=${unsafe.phase}; code=${unsafe.code}; status=${unsafe.status ?? "none"}; signal=${unsafe.signal}]`
        : "the saved launcher failed its --version probe";
      throw new Error(`Refusing Codex PATH shim because ${reason}. Native launcher was preserved.`);
    }
    const nativeAfter = nativeProbe(launcher);
    if (!nativeAfter || !sameFingerprint(initialNative.fingerprint, nativeAfter.fingerprint) || initialNative.prefix !== nativeAfter.prefix) {
      throw new Error("Native launcher changed during validation; retry after the package manager finishes");
    }
    check();
    for (const file of files) {
      if (!unchanged(file.path, file.prior) || !unchanged(file.staged, file.created)) throw new Error("Private Codex inputs changed during validation");
      recordOwnedConfigPath(getConfigDir(), file.path);
      if (file.prior) {
        linkSync(file.path, file.rollback);
        if (!unchanged(file.rollback, file.prior)) throw new Error("Private Codex rollback artifact changed");
      }
    }
    check();
    journalSnapshot = stage(journalPath(), JSON.stringify({ version: 1, token, launcher, files } satisfies Journal) + "\n", 0o600);
    persisted = true;
    for (const file of files) {
      const native = nativeProbe(launcher);
      if (!native || !sameFingerprint(initialNative.fingerprint, native.fingerprint) || native.prefix !== initialNative.prefix) {
        throw new Error("Native launcher changed before publication; retry after the package manager finishes");
      }
      check();
      if (!unchanged(file.path, file.prior) || !unchanged(file.staged, file.created)) throw new Error("Private Codex publication changed");
      if (file.prior) renameSync(file.staged, file.path);
      else { linkSync(file.staged, file.path); removePinned(file.staged, file.created); }
    }
    recoverJournal(check);
    return { installed: true, runnable: true, message: `Codex PATH shim installed at ${paths.wrapper}; native launcher ${launcher}. ${overlayActivationHint()}` };
  } catch (error) {
    if (persisted) {
      try { recoverJournal(check); }
      catch { throw new Error("Codex publication could not finish recovery; concurrent artifacts and the recovery journal were preserved"); }
    }
    throw error;
  } finally {
    if (!persisted) {
      check();
      for (const file of files) {
        removePinned(file.staged, file.created);
        if (file.prior) removePinned(file.rollback, file.prior);
      }
      if (journalSnapshot) removePinned(journalPath(), journalSnapshot);
    }
  }
}

function failure(error: unknown): InstallResult {
  const message = error instanceof Error ? error.message : "Codex overlay operation failed";
  return { installed: false, refused: true, message: truncateRetainedUtf8(message.replace(/[\r\n]/g, " "), MAX_DIAGNOSTIC_VALUE_BYTES) };
}
function installLocked(discover: () => string | null, automatic: boolean, check: () => void): InstallResult {
  recoverJournal(check);
  const pinnedState = snapshot(statePath());
  const result = readStateResult();
  const state = result.state;
  if (!unchanged(statePath(), pinnedState)) throw new Error("Codex shim state changed during inspection");
  if (result.present && !state) throw new Error(result.warning ?? "Invalid Codex shim state; refusing installation");
  if (state && state.platform !== process.platform) throw new Error("Codex shim platform mismatch");
  let launcher: string | null;
  let overlay: OverlayState | null = null;
  if (state?.mode === "path-overlay") {
    overlay = decodeOverlayState(state, getConfigDir());
    if (!overlay) throw new Error("Invalid Codex overlay state");
    requireOverlayIdentities(overlay);
    launcher = overlay.launcherPath;
  } else if (state) {
    if (automatic) throw new Error("Legacy Unix shim requires explicit migration: run ocx codex-shim install");
    const migration = migrateLegacyUnixShim(state);
    if (migration.status !== "native-restored") throw new Error(migration.message);
    launcher = migration.launcherPath;
  } else {
    const discovered = automatic ? null : discover();
    launcher = discovered ? resolve(discovered) : null;
  }
  if (!launcher) throw new Error("Native Codex launcher not found; install or repair Codex with its package manager");
  check();
  return publishOverlay(launcher, overlay, check, pinnedState);
}
export function installUnixOverlay(discover: () => string | null): InstallResult {
  let lock: ReturnType<typeof tryAcquireShimRestoreLock> = null;
  try {
    const check = namespace(true);
    lock = tryAcquireShimRestoreLock();
    if (!lock) throw new Error("Codex shim operation is already in progress; retry later");
    check();
    return installLocked(discover, false, check);
  } catch (error) { return failure(error); }
  finally { lock?.release(); }
}
export function autoRestoreUnixOverlay(options: RestoreOptions): CodexShimAutoRestoreResult {
  const result = readStateResult();
  if (!result.state) return { status: result.present ? "ineligible" : "not-installed", ...(result.warning ? { message: result.warning } : {}) };
  const state = decodeOverlayState(result.state, getConfigDir());
  if (!state || state.platform !== process.platform) return { status: "ineligible", message: "Legacy Unix shim requires explicit migration: run ocx codex-shim install" };
  try {
    const check = namespace(false);
    const inspection = inspectOverlay(state);
    const runnable = overlayRunnable(state, inspection.wrapper);
    check();
    const pending = lexical(journalPath());
    inspection.revalidate();
    if (inspection.complete && runnable && !pending) return { status: "healthy" };
  } catch (error) { return { status: "ineligible", message: failure(error).message }; }
  if (!nativeProbe(state.launcherPath)) return { status: "ineligible", message: "Recorded native Codex launcher is unusable; repair it with its package manager" };
  if (!options.enabled()) return { status: "disabled" };
  let lock: ReturnType<typeof tryAcquireShimRestoreLock> = null;
  try {
    const check = namespace(true);
    lock = tryAcquireShimRestoreLock(options.beforeStaleRestoreLockDelete);
    if (!lock) return { status: "deferred" };
    options.afterRestoreLockAcquired?.();
    check();
    const native = nativeProbe(state.launcherPath);
    (options.stabilitySleep ?? Bun.sleepSync)(100);
    const observed = nativeProbe(state.launcherPath);
    if (!native || !observed || !sameFingerprint(native.fingerprint, observed.fingerprint) || native.prefix !== observed.prefix) {
      return { status: "deferred", message: "Native launcher changed during observation; retry after the package manager finishes" };
    }
    const installed = installLocked(() => null, true, check);
    return installed.installed ? { status: "restored", message: installed.message } : { status: "healthy" };
  } catch (error) { return { status: "deferred", message: failure(error).message }; }
  finally { lock?.release(); }
}
export function uninstallUnixCodexShim(): { removed: boolean; message: string } {
  let lock: ReturnType<typeof tryAcquireShimRestoreLock> = null;
  try {
    const check = namespace(false);
    lock = tryAcquireShimRestoreLock();
    if (!lock) throw new Error("Codex shim operation is already in progress");
    check();
    recoverJournal(check);
    const stateFile = snapshot(statePath());
    const result = readStateResult();
    const state = result.state;
    if (!unchanged(statePath(), stateFile)) throw new Error("Codex shim state changed during removal");
    if (!state) return { removed: false, message: result.present ? "Invalid Codex shim state; preserving artifacts" : "Codex autostart shim is not installed." };
    if (!stateFile) throw new Error("Codex state changed during removal");
    if (state.mode !== "path-overlay") {
      const migration = migrateLegacyUnixShim(state);
      if (migration.status !== "native-restored") return { removed: false, message: migration.message };
    } else {
      const overlay = decodeOverlayState(state, getConfigDir());
      if (!overlay || overlay.platform !== process.platform) throw new Error("Invalid private Codex shim state");
      requireOverlayIdentities(overlay);
      const wrapper = snapshot(overlay.wrapperPath);
      const env = snapshot(overlayPaths().env);
      if (wrapper && !ownedWrapper(wrapper, overlay)) throw new Error("Private Codex launcher is no longer owned; preserving it and its state");
      if (env && !ownedEnvironment(env, overlay)) {
        throw new Error("Codex shell environment file is no longer owned; preserving it and its state");
      }
      for (const [path, pinned] of [[overlay.wrapperPath, wrapper], [overlayPaths().env, env]] as const) {
        check();
        if (pinned && !removePinned(path, pinned)) throw new Error("Concurrent private Codex replacement preserved");
      }
    }
    check();
    if (!removePinned(statePath(), stateFile)) throw new Error("Concurrent Codex state replacement preserved");
    return { removed: true, message: "Codex PATH shim removed. Native Codex launcher was preserved. Remove the codex-shell-env source line from your shell startup file." };
  } catch (error) { return { removed: false, message: failure(error).message }; }
  finally { lock?.release(); }
}
