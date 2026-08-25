/**
 * N — one bounded writer per canonical `CODEX_HOME`.
 *
 * The failure this closes is lock SPLITTING plus event-loop denial, not a
 * missing mutex. Two spellings of one Codex home can reach different textual
 * paths, and a lock held across provider discovery or history walking recreates
 * the 10.5-second listener stall that killed the previous design.
 *
 * Three decisions are load-bearing and each was forced by a defect:
 *
 * - The namespace keys on the EFFECTIVE USER (uid/SID), never on a home path.
 *   Under Bun 1.3.14 both `os.homedir()` and `os.userInfo().homedir` follow the
 *   environment, so a service and a CLI for one account can see different homes
 *   and coordinate through different databases — exclusion defeated, silently.
 *   `resolveCodexCoordinatorDatabasePath` owns that; this module consumes its
 *   result verbatim and appends nothing.
 *
 * - The commit callback is SYNCHRONOUS. Provider I/O, subprocesses, history
 *   walking and retry sleeps are forbidden beneath it; a thenable that slips
 *   through the type is detected, rolled back, and rejected.
 *
 * - Acquisition is finite and typed. `busy` means try again; `refused` means
 *   never. Collapsing them is how a permanent denial becomes an endless retry
 *   loop wearing the costume of contention.
 *
 * Lock order is `N -> C`. C is `withConfigMutationLockSync`, entered while N is
 * held and released before N commits. There is no `C -> N`.
 *
 * Design record: devlog/_fin/260804_codex_write_substrate/030_lock_protocol.md.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

import { withConfigMutationLockSync } from "../config";
import type {
  CodexCoordinatorTransaction,
  CommitExpectation,
} from "./convergence-types";
import { getCodexHome } from "./paths";
import { nativeMainOwnerFilesystemSupported } from "./native-main-owner";
import { openCodexCoordinatorTransaction } from "./transition-state";
import {
  CodexUserIdentityRefusal,
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "./user-identity";

export const CODEX_WRITE_LOCK_MAX_TIMEOUT_MS = 30_000;

/** Uniform, small, and jittered: a fixed interval makes contenders resonate. */
const RETRY_MIN_MS = 25;
const RETRY_MAX_MS = 75;

export type CodexWriteLockRefusalReason =
  | "codex_home_missing"
  | "codex_home_unsafe"
  | "authority_not_proven"
  | "namespace_unsafe"
  | "lock_path_unsafe"
  | "unsupported_filesystem"
  | "reentrant"
  | "lock_unavailable";

export type CodexWriteLockResult<T> =
  | { status: "acquired"; value: T; waitedMs: number; lockId: string }
  | { status: "skipped"; reason: "desired_disabled" | "desired_enabled"; waitedMs: number }
  | { status: "busy"; reason: "deadline" | "cancelled"; retryable: true; waitedMs: number; lockId: string }
  | {
      status: "refused";
      reason: CodexWriteLockRefusalReason;
      retryable: false;
      message: string;
    };

export interface CodexWriteLockOptions {
  /** Defaults to the ambient home. An explicit value must MATCH it — see below. */
  codexHome?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Read-only witness obtained before any namespace creation.
   *
   * Typed by what the lock actually uses — one comparable id — rather than by
   * `AdmissionSnapshot`, so a caller that coordinates a write WITHOUT gating on
   * admission can hold the lock honestly. `AdmissionSnapshot` satisfies this
   * structurally through its `authoritySnapshotId`, so existing callers are
   * unchanged; see `write-coordination.ts` for why the two are not the same
   * claim.
   */
  admitted: CodexWriteWitness;
  /** Authoritative synchronous re-read while N and C are both held. */
  readAdmissionUnderLock(): CodexWriteWitness;
  /** Positively authorized migration of an already-routed pre-substrate home. */
  adoption?: { readonly direction: "apply" | "remove" };
}

/**
 * The only thing the lock compares.
 *
 * Kept deliberately minimal: widening it would let the lock depend on evidence
 * a caller cannot re-read under N and C, which is how a comparison starts
 * matching itself instead of detecting drift.
 */
export interface CodexWriteWitness {
  readonly authoritySnapshotId: string;
}

export interface CodexWriteCommitContext {
  readonly canonicalCodexHome: string;
  readonly lockId: string;
  readonly admission: CodexWriteWitness;
  readonly expectation: CommitExpectation;
  /**
   * The `currentTxId` the coordinator row holds RIGHT NOW.
   *
   * `CommitExpectation` carries the generation pair and the NEW txId, but the
   * conditional row update also matches on the existing one. Without this the
   * caller has to guess it — and guessing `null` works only on a row nobody has
   * ever transitioned, so the guess passes on a fresh machine and fails on a
   * real one.
   */
  readonly currentTxId: string | null;
  /** Opaque authority over the ALREADY-OPEN transaction. Not SQLite. */
  readonly coordinator: CodexCoordinatorTransaction;
}

/** A synchronous under-lock policy re-read proved the requested apply stale. */
export class CodexWriteLockSkipped extends Error {
  constructor(readonly reason: "desired_disabled" | "desired_enabled") {
    super(reason);
    this.name = "CodexWriteLockSkipped";
  }
}

/** Rejects an `async` callback at typecheck; a cast thenable is caught at runtime. */
type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * Same-task reentrancy detection.
 *
 * NOT the exclusion mechanism — `busy_timeout = 0` before `BEGIN IMMEDIATE`
 * already makes a second open in this process fail with SQLITE_BUSY. This exists
 * only to turn that indistinguishable `busy` into a typed `refused/reentrant`,
 * so a caller is told "you already hold this" rather than "try again forever".
 */
const heldHomes = new AsyncLocalStorage<ReadonlySet<string>>();

function refuse<T>(reason: CodexWriteLockRefusalReason, message: string): CodexWriteLockResult<T> {
  return { status: "refused", reason, retryable: false, message };
}

function isBusyError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message);
}

function expandLeadingTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return path;
}

export interface CanonicalCodexHome {
  readonly path: string;
  /** Stable id for one home, independent of which spelling reached us. */
  readonly lockId: string;
}

/**
 * Canonicalize a `CODEX_HOME` so every spelling of one directory takes one lock.
 *
 * Default, explicit, absolute, tilde and symlinked spellings must contend; two
 * genuinely different directories must not. A MISSING home is refused rather
 * than resolved optimistically: keeping an unresolved suffix would either split
 * one future home on a case-insensitive filesystem or alias two on a
 * case-sensitive one.
 */
export function canonicalizeCodexHome(
  candidate: string,
): { ok: true; home: CanonicalCodexHome } | { ok: false; reason: CodexWriteLockRefusalReason; message: string } {
  const expanded = resolve(expandLeadingTilde(candidate));
  if (!isAbsolute(expanded)) {
    return { ok: false, reason: "codex_home_unsafe", message: "CODEX_HOME did not resolve to an absolute path." };
  }
  let entry;
  try {
    entry = lstatSync(expanded);
  } catch {
    return { ok: false, reason: "codex_home_missing", message: `CODEX_HOME does not exist: ${expanded}` };
  }
  // A symlinked home is fine — realpath collapses it below, which is how two
  // spellings end up on one lock. A home that is a FILE is not.
  if (!entry.isDirectory() && !entry.isSymbolicLink()) {
    return { ok: false, reason: "codex_home_unsafe", message: `CODEX_HOME is not a directory: ${expanded}` };
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(expanded);
    if (!lstatSync(canonical).isDirectory()) {
      return { ok: false, reason: "codex_home_unsafe", message: `CODEX_HOME is not a directory: ${canonical}` };
    }
  } catch {
    return { ok: false, reason: "codex_home_missing", message: `CODEX_HOME does not exist: ${expanded}` };
  }
  if (!nativeMainOwnerFilesystemSupported(canonical)) {
    return {
      ok: false,
      reason: "unsupported_filesystem",
      message: `CODEX_HOME is on a filesystem that cannot hold this lock: ${canonical}`,
    };
  }
  // Windows paths are case-insensitive, so two spellings of one directory must
  // hash alike there; POSIX paths are not, so they must not be folded.
  const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const lockId = createHash("sha256")
    .update("opencodex-codex-write-lock-v1\0")
    .update(normalized)
    .digest("hex");
  return { ok: true, home: { path: canonical, lockId } };
}

function sleepJittered(remainingMs: number, signal?: AbortSignal): Promise<void> {
  const span = RETRY_MAX_MS - RETRY_MIN_MS;
  const wait = Math.min(remainingMs, RETRY_MIN_MS + Math.floor(Math.random() * (span + 1)));
  return new Promise(done => {
    const timer = setTimeout(finish, Math.max(1, wait));
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      done();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Hold N for one canonical `CODEX_HOME` and run `commit` while it is held.
 *
 * Returns `acquired` with the callback's value, `busy` when the deadline or the
 * signal ended the wait, or `refused` when nothing about waiting would help. A
 * caller exception is NOT converted into either: it propagates after rollback,
 * because a failed commit is the caller's error and not a lock outcome.
 */
export async function withCodexWriteLock<T>(
  options: CodexWriteLockOptions,
  commit: (context: CodexWriteCommitContext) => Synchronous<T>,
): Promise<CodexWriteLockResult<T>> {
  const { timeoutMs, signal } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > CODEX_WRITE_LOCK_MAX_TIMEOUT_MS) {
    return refuse("authority_not_proven",
      `timeoutMs must be an integer between 0 and ${CODEX_WRITE_LOCK_MAX_TIMEOUT_MS}.`);
  }

  /*
   * The ambient home is resolved ONCE, and an explicit home must equal it.
   *
   * `classifyNativeRoutedResidue` — the guard that decides whether the
   * coordinator row may be created — resolves its own home from the ambient
   * environment, while the lock path keys on the home WE were given. Forwarding a
   * different explicit home would lock one directory while a different one was
   * safety-checked. Until that guard takes the target as a parameter (WP12), the
   * only honest answer is to refuse the mismatch.
   */
  const ambient = canonicalizeCodexHome(getCodexHome());
  if (!ambient.ok) return refuse(ambient.reason, ambient.message);

  let target = ambient.home;
  if (options.codexHome !== undefined) {
    const trimmed = options.codexHome.trim();
    if (!trimmed) return refuse("codex_home_unsafe", "An explicit codexHome must not be blank.");
    const explicit = canonicalizeCodexHome(trimmed);
    if (!explicit.ok) return refuse(explicit.reason, explicit.message);
    if (explicit.home.path !== ambient.home.path) {
      return refuse("authority_not_proven",
        "The requested CODEX_HOME is not the one this process would inspect for safety.");
    }
    target = explicit.home;
  }

  const held = heldHomes.getStore();
  if (held?.has(target.lockId)) {
    return refuse("reentrant", "This task already holds the Codex write lock for this CODEX_HOME.");
  }

  let databasePath: string;
  try {
    databasePath = resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), target.path);
  } catch (error) {
    return refuse("namespace_unsafe",
      error instanceof CodexUserIdentityRefusal ? error.message : "The lock namespace could not be resolved.");
  }

  const started = performance.now();
  const deadline = started + timeoutMs;
  const waited = (): number => Math.round(performance.now() - started);

  for (;;) {
    if (signal?.aborted) return { status: "busy", reason: "cancelled", retryable: true, waitedMs: waited(), lockId: target.lockId };

    let transaction: ReturnType<typeof openCodexCoordinatorTransaction> | undefined;
    try {
      transaction = openCodexCoordinatorTransaction(databasePath, options.adoption);
    } catch (error) {
      // Only contention retries. A malformed database, an unsafe path, or an
      // identity failure will fail identically forever; telling a caller to retry
      // that is how a UI spins on a problem only the user can fix.
      if (!isBusyError(error)) {
        if (error instanceof CodexUserIdentityRefusal) return refuse("lock_path_unsafe", error.message);
        return refuse("lock_unavailable",
          error instanceof Error ? error.message : "The Codex write lock could not be opened.");
      }
      if (performance.now() >= deadline) {
        return { status: "busy", reason: "deadline", retryable: true, waitedMs: waited(), lockId: target.lockId };
      }
      await sleepJittered(deadline - performance.now(), signal);
      continue;
    }

    // N is held from here. Everything below is synchronous until commit/rollback.
    try {
      const expectation = transaction.expectation();
      const version = transaction.version();
      const nextHeld = new Set(held ?? []);
      nextHeld.add(target.lockId);

      const value = heldHomes.run(nextHeld, () => withConfigMutationLockSync(() => {
        const current = options.readAdmissionUnderLock();
        if (current.authoritySnapshotId !== options.admitted.authoritySnapshotId) {
          throw new CodexWriteLockStaleAdmission();
        }
        const result = commit({
          canonicalCodexHome: target.path,
          lockId: target.lockId,
          admission: current,
          expectation,
          currentTxId: version.currentTxId,
          coordinator: transaction!.capability,
        });
        // A cast `async` callback would return a thenable here. Awaiting it is
        // impossible — C is synchronous — so the only safe answer is to reject.
        if (result && typeof (result as { then?: unknown }).then === "function") {
          throw new TypeError("The Codex write-lock commit callback must be synchronous.");
        }
        return result;
      }));

      transaction.assertPublished(expectation);
      transaction.commit();
      return { status: "acquired", value: value as T, waitedMs: waited(), lockId: target.lockId };
    } catch (error) {
      transaction.rollback();
      if (error instanceof CodexWriteLockSkipped) {
        return { status: "skipped", reason: error.reason, waitedMs: waited() };
      }
      if (error instanceof CodexWriteLockStaleAdmission) {
        return refuse("authority_not_proven",
          "The admitted state changed before the commit could be made under the lock.");
      }
      if (isBusyError(error)) {
        if (performance.now() >= deadline) {
          return { status: "busy", reason: "deadline", retryable: true, waitedMs: waited(), lockId: target.lockId };
        }
        await sleepJittered(deadline - performance.now(), signal);
        continue;
      }
      throw error;
    } finally {
      transaction.close();
    }
  }
}

/** Internal: the under-lock re-read disagreed with what was admitted. */
class CodexWriteLockStaleAdmission extends Error {
  constructor() {
    super("The admitted authority snapshot is stale.");
    this.name = "CodexWriteLockStaleAdmission";
  }
}
