/**
 * Windows-tolerant atomic replace.
 *
 * POSIX `rename()` replaces the destination entry unconditionally. Windows can
 * refuse the same call with EBUSY, EPERM or EACCES while another process holds
 * the target open — a real-time scanner that just indexed the file, a sync
 * client, a backup agent. The hold is usually momentary, so a bounded retry
 * turns an operational failure back into a successful publish.
 *
 * The envelope is deliberately small: two retries, 25ms then 50ms, about 75ms
 * total. It is sized for a scanner blinking, not for a file someone actually
 * has open. Widening it without evidence would trade a rare failure for a
 * routine stall.
 *
 * This lives in its own module rather than in config.ts because
 * config-ownership.ts is one of its callers and config.ts already imports
 * config-ownership.ts — exporting it from there would close an import cycle.
 */

import { renameSync } from "node:fs";

/**
 * Which durable publisher retried. A closed union on purpose: the value is a
 * label in a diagnostic surface, and a path-derived string could carry a
 * username. The type is the enforcement — a path cannot be passed here without
 * failing typecheck. (`privacy:scan` reads file text and cannot see a runtime
 * value, so it is a backstop for the response body, not the guard.)
 */
export type ReplacePublisher =
  | "config"
  | "prompt-journal"
  | "config-ownership"
  | "claude-agents"
  | "lab-automation"
  | "lab-ledger"
  | "remote-workspace"
  | "storage-cleanup"
  | "tray";

/** Called immediately before every rename attempt, including each Windows retry. */
export interface RenameValidationHooks { validateBeforeRename?: (destination: string) => void }

/** The Windows error codes this module treats as a momentary hold. */
export type ReplaceRetryCode = "EBUSY" | "EPERM" | "EACCES";

export interface ReplaceRetryCounts {
  /** Replaces that hit this code and were retried. */
  retried: number;
  /** Replaces that exhausted every retry and threw. */
  exhausted: number;
}

/**
 * Keyed by publisher AND code. The code is the diagnostic half: EBUSY from a
 * scanner, EACCES from a permissions problem and EPERM from a lock are three
 * different stories, and collapsing them would leave the counters unable to
 * answer the question they exist for.
 */
const counters = new Map<string, ReplaceRetryCounts>();

function counterKey(publisher: ReplacePublisher, code: ReplaceRetryCode): string {
  return `${publisher}:${code}`;
}

function bump(
  publisher: ReplacePublisher,
  code: ReplaceRetryCode,
  field: keyof ReplaceRetryCounts,
): void {
  const key = counterKey(publisher, code);
  const current = counters.get(key) ?? { retried: 0, exhausted: 0 };
  current[field] += 1;
  counters.set(key, current);
}

/**
 * Process-lifetime snapshot, keyed `publisher:CODE`. These reset on restart,
 * which is fine: the question they answer is "does this ever fire at all", not
 * "how often per hour".
 */
export function readWindowsReplaceRetryCounters(): Record<string, ReplaceRetryCounts> {
  const out: Record<string, ReplaceRetryCounts> = {};
  for (const [key, counts] of counters) out[key] = { ...counts };
  return out;
}

/** Test-only: the counters are module state and cases must not leak into each other. */
export function resetWindowsReplaceRetryCountersForTests(): void {
  counters.clear();
}
export interface AtomicRenameIO {
  platform: NodeJS.Platform;
  rename: (source: string, destination: string) => void;
  sleep: (milliseconds: number) => void;
}

const MAX_RETRIES = 2;

/**
 * Windows sharing violations only, returning the code so the caller can record
 * which one. Any other error is the caller's to see, immediately.
 */
export function transientWindowsReplaceCode(
  platform: NodeJS.Platform,
  error: unknown,
): ReplaceRetryCode | null {
  if (platform !== "win32") return null;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES" ? code : null;
}

/** One filesystem operation plus its retry observers, carried as members (not free callbacks). */
export interface WindowsFileOperationStep<T> {
  run: () => T;
  onRetry?: (code: ReplaceRetryCode, exhausted: boolean) => void;
  beforeAttempt?: () => void;
}

/** Bounded sharing-violation retries for one filesystem operation, never a transaction. */
export function retryWindowsFileOperation<T>(
  step: WindowsFileOperationStep<T>,
  io: Pick<AtomicRenameIO, "platform" | "sleep"> = { platform: process.platform, sleep: Bun.sleepSync },
): T {
  for (let attempt = 0; ; attempt += 1) {
    step.beforeAttempt?.();
    try { return step.run(); }
    catch (error) {
      const code = transientWindowsReplaceCode(io.platform, error);
      if (!code) throw error;
      const exhausted = attempt >= MAX_RETRIES;
      step.onRetry?.(code, exhausted);
      if (exhausted) throw error;
      io.sleep(25 * (attempt + 1));
    }
  }
}

export function renameAtomicFile(
  source: string,
  destination: string,
  io: AtomicRenameIO = {
    platform: process.platform,
    rename: renameSync,
    sleep: Bun.sleepSync,
  },
  publisher: ReplacePublisher = "config",
  hooks: RenameValidationHooks = {},
): void {
  retryWindowsFileOperation({
    run: () => io.rename(source, destination),
    onRetry: (code, exhausted) => bump(publisher, code, exhausted ? "exhausted" : "retried"),
    beforeAttempt: () => hooks.validateBeforeRename?.(destination),
  }, io);
}

export async function renameAtomicFileAsync(
  source: string,
  destination: string,
  publisher: ReplacePublisher = "config",
  hooks: RenameValidationHooks = {},
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    hooks.validateBeforeRename?.(destination);
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = transientWindowsReplaceCode(process.platform, error);
      if (!code) throw error;
      if (attempt >= MAX_RETRIES) {
        bump(publisher, code, "exhausted");
        throw error;
      }
      bump(publisher, code, "retried");
      await Bun.sleep(25 * (attempt + 1));
    }
  }
}
