/**
 * config-write-lock.ts — one advisory lock for every opencodex-originated
 * `config.toml` write.
 *
 * Why a second lock next to the existing two: the injector's SQLite lock N
 * serializes injection against injection, and the prompt-layers lock serializes
 * prompt edits against prompt edits. Neither covers the writers BETWEEN them —
 * the feature scalars in `features.ts`, the `ocx restore`/`removeCodexConfig`
 * transforms, and the journal replay each did their own unlocked read → edit →
 * `atomicWriteFile`. Each write is individually atomic, but a foreign rewrite
 * landing between any writer's read and its rename was silently discarded:
 * a features edit could drop an injection's freshly-written routing keys, a
 * remove could drop a prompt projection committed a millisecond earlier.
 *
 * This lock closes that class at its source rather than per call site: every
 * opencodex writer reads `config.toml` and renames over it while holding
 * `<config>.ocx-write.lock`, so no cooperating writer can be computed against
 * stale bytes and none can land mid-section.
 *
 * What it deliberately does NOT cover:
 * - Codex itself knows nothing about the file; upstream's own rewrites cannot
 *   be serialized from here. That residual is why the injector's witness and
 *   the drift healer still exist.
 * - Lock ordering: prompt-layers commit() takes the prompt store lock first,
 *   then this one; the injector takes this one first, then N, then C — and the
 *   coordinated restore path follows that same file-first order
 *   (`restoreNativeCodexAsyncImpl` acquires this lock before its `withCodexWriteLock`
 *   journal replay), so no cross-lock inversion remains. Synchronous
 *   acquisition fails fast; asynchronous acquisition has a bounded wait.
 * - The injector's held section contains awaits (`withCodexWriteLock` is
 *   async), so the lock must NOT be implicitly reentrant — a same-process
 *   writer that slipped inside on a process-global check would interleave
 *   mid-section. Reentrancy is explicit instead: a caller that already holds
 *   the file passes its handle (`heldConfigWriteLock`) to the writer it
 *   calls.
 * - Acquisition is a single attempt for synchronous writers: the section under
 *   this lock is a handful of file operations, so a busy result means the
 *   caller reports "locked" and the operator retries — the same contract the
 *   prompt store lock already exposes. Async callers (the injector) use the
 *   bounded wait in `acquireConfigWriteLock`.
 */
import { atomicWriteFileStreamed, type AtomicWriteHooks } from "../config/atomic-write";
import { lstatSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { release, stillHeld, tryAcquire, type AcquireResult, type LockHandle } from "./prompt-lock";

interface Destination { canonical: string; inode: string | null }
const destinations = new WeakMap<LockHandle, Destination>();
interface ConfigWriteRecovery {
  canonical: string;
  preimage: Buffer | null;
  identity: string | null;
  refreshBeforeSpawn: boolean;
}
const recoveries = new WeakMap<LockHandle, ConfigWriteRecovery>();
export class ConfigWriteParentMissing extends Error {
  constructor(readonly path: string) { super(`Codex configuration parent is missing or unresolved at ${path}`); }
}
type ConfigWriteAcquireResult = AcquireResult | { ok: false; error: "missing-parent"; detail: string };
function destination(path: string): Destination {
  const absolute = resolve(path);
  let canonical: string;
  try { canonical = realpathSync.native(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { canonical = join(realpathSync.native(dirname(absolute)), basename(absolute)); }
    catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigWriteParentMissing(dirname(absolute));
      throw parentError;
    }
  }
  try {
    const stat = statSync(canonical, { bigint: true });
    return { canonical, inode: `${stat.dev}:${stat.ino}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { canonical, inode: null };
  }
}
/** Symlink aliases share the lock beside their canonical write destination. */
export function configWriteLockPath(configPath: string): string {
  return `${destination(configPath).canonical}.ocx-write.lock`;
}
export const CONFIG_WRITE_LOCKED_MESSAGE =
  "another opencodex process is writing Codex configuration — retry shortly";
export type ConfigWriteLockOutcome<T> =
  | { ok: true; value: T }
  | Exclude<ConfigWriteAcquireResult, { ok: true }>;

function acquire(configPath: string): ConfigWriteAcquireResult {
  let target: Destination;
  try { target = destination(configPath); }
  catch (error) {
    if (error instanceof ConfigWriteParentMissing) return { ok: false, error: "missing-parent", detail: error.path };
    throw error;
  }
  const acquired = tryAcquire(`${target.canonical}.ocx-write.lock`);
  if (acquired.ok) destinations.set(acquired.handle, target);
  return acquired;
}
export function withConfigWriteLock<T>(configPath: string, run: (handle: LockHandle) => T): ConfigWriteLockOutcome<T> {
  const acquired = acquire(configPath);
  if (!acquired.ok) return acquired;
  try { return { ok: true, value: run(acquired.handle) }; }
  finally { release(acquired.handle); }
}
export function configWriteLockHeld(handle: LockHandle): boolean { return stillHeld(handle); }
export function releaseConfigWriteLock(handle: LockHandle): void { release(handle); }
export type { LockHandle };

export function assertConfigWriteDestination(configPath: string, held: LockHandle): string {
  const current = destination(configPath);
  const expected = destinations.get(held);
  if (!stillHeld(held) || held.path !== `${current.canonical}.ocx-write.lock`
    || (expected && (current.canonical !== expected.canonical || current.inode !== expected.inode))) {
    throw new Error("Codex configuration destination changed; files and recovery evidence were preserved.");
  }
  if (!expected) destinations.set(held, current);
  return current.canonical;
}
/** A writer advances the witness only through its confirmed publication hook. */
export function publishConfigWrite<T>(configPath: string, held: LockHandle, run: (destination: string, hooks: AtomicWriteHooks) => T): T {
  const canonical = assertConfigWriteDestination(configPath, held);
  return run(canonical, {
    validateBeforeRename: () => { assertConfigWriteDestination(configPath, held); },
    afterRename: () => {
      const recovery = recoveries.get(held);
      if (recovery?.canonical === canonical) recovery.identity = canonicalFileIdentity(canonical);
      const after = destination(configPath);
      if (!stillHeld(held) || after.canonical !== canonical) throw new Error("Codex configuration destination changed; recovery evidence was preserved.");
      destinations.set(held, after);
      const watched = targets.get(held);
      if (watched) for (const [path, expected] of watched) if (expected.canonical === canonical) watched.set(path, after);
    },
  });
}
/** Native children use the acquisition witness, never a fresh home resolution. */
export class ConfigWriteDestinationChanged extends Error {
  readonly retryable = false;
  constructor(message = "Codex configuration destination changed; files and recovery evidence were preserved.") { super(message); }
}
/** Refuse before transition staging: native Codex always writes home/config.toml. */
export function assertNativeConfigWriteDestination(configPath: string, held: LockHandle): string {
  let canonical: string;
  try { canonical = assertConfigWriteDestination(configPath, held); }
  catch { throw new ConfigWriteDestinationChanged(); }
  const home = realpathSync.native(dirname(canonical));
  if (basename(canonical) !== "config.toml" || canonical !== join(home, "config.toml")) {
    throw new ConfigWriteDestinationChanged("Native feature changes are unavailable when config.toml is a symlink to a differently named file.");
  }
  return canonical;
}
function canonicalFileIdentity(canonical: string): string | null {
  const current = destination(canonical);
  if (current.canonical !== canonical) throw new Error("canonical configuration target was redirected");
  let stat;
  try { stat = lstatSync(canonical, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && current.inode === null) return null;
    throw error;
  }
  if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== current.inode) throw new Error("canonical configuration target is not the observed regular file");
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
/** Capture before the first write; nested native children share the same recovery scope. */
export function withConfigWriteRecovery<T>(
  configPath: string, held: LockHandle, run: () => T,
  options: { refreshBeforeSpawn?: boolean; preimage?: Buffer } = {},
): T {
  if (recoveries.has(held)) return run();
  let canonical: string;
  try { canonical = assertConfigWriteDestination(configPath, held); }
  catch { throw new ConfigWriteDestinationChanged(); }
  const identity = canonicalFileIdentity(canonical);
  const preimage = identity === null ? null : readFileSync(canonical);
  if (canonicalFileIdentity(canonical) !== identity) throw new ConfigWriteDestinationChanged();
  const recovery: ConfigWriteRecovery = {
    canonical, identity, preimage: options.preimage ?? preimage,
    refreshBeforeSpawn: options.refreshBeforeSpawn === true && options.preimage === undefined,
  };
  recoveries.set(held, recovery);
  try {
    const value = run();
    assertConfigWriteDestination(configPath, held);
    return value;
  } catch (error) {
    let changed = error instanceof ConfigWriteDestinationChanged;
    try { assertConfigWriteDestination(configPath, held); } catch { changed = true; }
    try {
      const validateRecovery = (targetPath = canonical) => {
        if (targetPath !== canonical || !stillHeld(held) || held.path !== `${canonical}.ocx-write.lock`
          || canonicalFileIdentity(canonical) !== recovery.identity) {
          throw new Error("canonical configuration target changed before recovery");
        }
      };
      validateRecovery();
      // A pre-write refusal leaves the original entry intact, including its inode.
      const unchanged = recovery.identity === identity && (recovery.preimage === preimage
        || (recovery.preimage !== null && preimage !== null && recovery.preimage.equals(preimage)));
      if (!unchanged) {
        if (recovery.preimage === null) { validateRecovery(); if (recovery.identity !== null) unlinkSync(canonical); }
        else atomicWriteFileStreamed(canonical, fd => writeFileSync(fd, recovery.preimage!), { validateBeforeRename: validateRecovery });
      }
      destinations.set(held, destination(canonical));
    } catch (recoveryError) {
      let evidence = "recovery evidence could not be persisted";
      try {
        const recoveryPath = `${canonical}.ocx-native-preimage.${randomUUID()}`;
        atomicWriteFileStreamed(recoveryPath, fd => writeFileSync(fd, recovery.preimage ?? Buffer.from('{"preimage":"absent"}\n')));
        evidence = `recovery evidence retained at ${recoveryPath}`;
      } catch { /* Preserve the refusal and diagnostic even when evidence storage fails. */ }
      throw new ConfigWriteDestinationChanged(`Codex configuration destination changed; canonical preimage recovery refused: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}; ${evidence}.`);
    }
    if (changed) throw new ConfigWriteDestinationChanged(`${error instanceof Error ? error.message : String(error)}; canonical preimage restored and recovery evidence preserved.`);
    throw error;
  } finally { recoveries.delete(held); }
}
export function runConfigWriteChild(
  configPath: string, held: LockHandle,
  run: (env: NodeJS.ProcessEnv, validateBeforeSpawn: () => void) => void,
  transitionPreimage?: Buffer,
): void {
  withConfigWriteRecovery(configPath, held, () => {
    const canonical = assertNativeConfigWriteDestination(configPath, held);
    const recovery = recoveries.get(held)!;
    let readyToSpawn = false;
    const validateBeforeSpawn = () => {
      readyToSpawn = false;
      assertNativeConfigWriteDestination(configPath, held);
      const identity = canonicalFileIdentity(canonical);
      const bytes = identity === null ? null : readFileSync(canonical);
      if (canonicalFileIdentity(canonical) !== identity) throw new ConfigWriteDestinationChanged();
      if (recovery.refreshBeforeSpawn) { recovery.preimage = bytes; recovery.identity = identity; }
      readyToSpawn = true;
    };
    publishConfigWrite(configPath, held, (_canonical, hooks) => {
      const env = { ...process.env };
      // Windows env names are case-insensitive; wrappers may honor Orca's override.
      for (const key of Object.keys(env)) {
        if (["CODEX_HOME", "ORCA_CODEX_HOME"].includes(key.toUpperCase())) delete env[key];
      }
      env.CODEX_HOME = realpathSync.native(dirname(canonical));
      validateBeforeSpawn();
      try { run(env, validateBeforeSpawn); }
      // Even a failed child can replace config.toml. Observe only after it entered.
      finally {
        try { if (readyToSpawn) hooks.afterRename?.(canonical); }
        catch { throw new ConfigWriteDestinationChanged(); }
      }
    });
  }, { refreshBeforeSpawn: true, preimage: transitionPreimage });
}
export function withConfigWriteLockHeld<T>(
  configPath: string, held: LockHandle | undefined, run: (handle: LockHandle) => T,
): ConfigWriteLockOutcome<T> {
  if (held !== undefined) {
    try { assertConfigWriteDestination(configPath, held); }
    catch { return { ok: false, error: "unsafe", detail: held.path }; }
    return { ok: true, value: run(held) };
  }
  return withConfigWriteLock(configPath, run);
}
const RETRY_MIN_MS = 25;
const RETRY_MAX_MS = 75;
export const CONFIG_WRITE_LOCK_WAIT_MS = 2_000;
export async function acquireConfigWriteLock(
  configPath: string,
  options: { timeoutMs?: number; nowMs?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ConfigWriteAcquireResult> {
  const timeoutMs = options.timeoutMs ?? CONFIG_WRITE_LOCK_WAIT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 10_000) throw new RangeError("Invalid config lock timeout");
  const now = options.nowMs ?? (() => performance.now());
  const sleep = options.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  const deadline = now() + timeoutMs;
  for (;;) {
    const acquired = acquire(configPath);
    if (acquired.ok || acquired.error !== "locked") return acquired;
    const remaining = deadline - now();
    if (timeoutMs === 0 || remaining <= 0) return { ok: false, error: "locked" };
    await sleep(Math.max(1, Math.min(remaining,
      RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS + 1)))));
  }
}

const targets = new WeakMap<LockHandle, Map<string, Destination>>();
export function watchConfigWriteTargets(held: LockHandle, paths: readonly string[]): void {
  let watched = targets.get(held);
  if (!watched) { watched = new Map(); targets.set(held, watched); }
  for (const path of paths) if (!watched.has(path)) watched.set(path, destination(path));
}
export function publishConfigWriteTarget<T>(
  configPath: string, held: LockHandle, path: string, run: (destination: string, hooks: AtomicWriteHooks) => T,
): T {
  assertConfigWriteDestination(configPath, held);
  watchConfigWriteTargets(held, [path]);
  const watched = targets.get(held)!, expected = watched.get(path)!, current = destination(path);
  if (expected.canonical !== current.canonical || expected.inode !== current.inode) {
    throw new Error("Codex artifact destination changed; files and recovery evidence were preserved.");
  }
  if (path === configPath) {
    const value = publishConfigWrite(configPath, held, run);
    return value;
  }
  return run(current.canonical, {
    validateBeforeRename: () => {
      assertConfigWriteDestination(configPath, held);
      const now = destination(path);
      if (expected.canonical !== now.canonical || expected.inode !== now.inode) throw new Error("Codex artifact destination changed; files and recovery evidence were preserved.");
    },
    afterRename: () => {
      assertConfigWriteDestination(configPath, held);
      const after = destination(path);
      if (after.canonical !== current.canonical) throw new Error("Codex artifact destination changed; recovery evidence was preserved.");
      watched.set(path, after);
    },
  });
}

export function configWriteLockFailureMessage(failure: Exclude<ConfigWriteAcquireResult, { ok: true }>): string {
  if (failure.error === "missing-parent") return `Codex configuration parent is missing or unresolved at ${failure.detail}; no files were changed.`;
  return failure.error === "unsafe"
    ? `Unsafe Codex configuration lock at ${failure.detail}; deliberate removal is required. Files and recovery evidence were preserved.`
    : CONFIG_WRITE_LOCKED_MESSAGE;
}

export class ConfigWriteLockRefusal extends Error {
  readonly retryable: boolean;
  constructor(failure: Exclude<ConfigWriteAcquireResult, { ok: true }>) {
    super(configWriteLockFailureMessage(failure));
    this.retryable = failure.error === "locked";
  }
}
