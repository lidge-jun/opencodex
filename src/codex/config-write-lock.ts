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
 *   journal replay), so no cross-lock inversion remains. Even if one ever did,
 *   it could not deadlock: this lock never blocks, so a second acquire fails
 *   instantly and the other writer's bounded wait proceeds.
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
import { release, stillHeld, tryAcquire, type LockHandle } from "./prompt-lock";

/** The lock file lives beside the config it serializes: `config.toml.ocx-write.lock`. */
export function configWriteLockPath(configPath: string): string {
  return `${configPath}.ocx-write.lock`;
}

/**
 * The user-facing sentence every writer reports when the section is busy.
 * One shared string keeps every surface — CLI, management routes, restore —
 * telling the operator the same thing.
 */
export const CONFIG_WRITE_LOCKED_MESSAGE =
  "another opencodex process is writing Codex configuration — retry shortly";

export type ConfigWriteLockOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: "locked" };

/**
 * Acquire the config write lock for one synchronous section.
 *
 * Re-exported with the narrower contract this module owns so callers never
 * touch prompt-lock's path arguments directly. Release failures are release()'s
 * own problem (a superseded token means someone else's lock now owns the path);
 * the caller's result stands on what its section did.
 */
export function withConfigWriteLock<T>(
  configPath: string,
  run: (handle: LockHandle) => T,
): ConfigWriteLockOutcome<T> {
  const acquired = tryAcquire(configWriteLockPath(configPath));
  if (!acquired.ok) return { ok: false, error: "locked" };
  try {
    return { ok: true, value: run(acquired.handle) };
  } finally {
    release(acquired.handle);
  }
}

/** True while this process still owns the lock `handle` was acquired on. */
export function configWriteLockHeld(handle: LockHandle): boolean {
  return stillHeld(handle);
}

/**
 * Release a handle from `acquireConfigWriteLock`. A superseded token means the
 * path already belongs to someone else's lock, so a release failure is the
 * caller's signal that its section did not hold to the end.
 */
export function releaseConfigWriteLock(handle: LockHandle): void {
  release(handle);
}

export type { LockHandle };

/**
 * Run `run` under the lock the caller already holds, or take the lock itself.
 * The explicit-held contract above applies: `held` must be a live handle on
 * THIS config's lock file — a handle minted on another path is refused rather
 * than trusted, since it would let the section run unprotected.
 */
export function withConfigWriteLockHeld<T>(
  configPath: string,
  held: LockHandle | undefined,
  run: (handle: LockHandle) => T,
): ConfigWriteLockOutcome<T> {
  if (held !== undefined) {
    if (held.path !== configWriteLockPath(configPath) || !stillHeld(held)) {
      return { ok: false, error: "locked" };
    }
    return { ok: true, value: run(held) };
  }
  return withConfigWriteLock(configPath, run);
}

/** Uniform, small, jittered retry spacing — same reasoning as codex-write-lock. */
const RETRY_MIN_MS = 25;
const RETRY_MAX_MS = 75;

/**
 * How long an async caller waits for the advisory lock. Sections under it are
 * millisecond-scale; the one long holder is `transitionMultiAgentV2`, which can
 * outlast this while it waits on the `codex features` subprocess — and refusing
 * an injection after a short wait beats both queueing behind a subprocess and
 * racing it.
 */
export const CONFIG_WRITE_LOCK_WAIT_MS = 2_000;

/**
 * Bounded wait for the advisory lock, for async callers only.
 *
 * Returns `locked` once the deadline passes — the injector maps that to a
 * retryable busy result rather than a hard refusal, because the holder is by
 * construction finishing a short section.
 */
export async function acquireConfigWriteLock(
  configPath: string,
  options: { timeoutMs?: number; nowMs?: () => number } = {},
): Promise<{ ok: true; handle: LockHandle } | { ok: false; error: "locked" }> {
  const timeoutMs = options.timeoutMs ?? CONFIG_WRITE_LOCK_WAIT_MS;
  const now = options.nowMs ?? (() => Date.now());
  const deadline = now() + timeoutMs;
  for (;;) {
    const acquired = tryAcquire(configWriteLockPath(configPath));
    if (acquired.ok) return acquired;
    if (now() >= deadline) return { ok: false, error: "locked" };
    const wait = Math.min(
      deadline - now(),
      RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS + 1)),
    );
    await new Promise(done => setTimeout(done, Math.max(1, wait)));
  }
}
