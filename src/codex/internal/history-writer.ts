/**
 * The history mutation boundary. Every byte Codex history owns is written here,
 * and only while H is held.
 *
 * This module exists because the mutations are spread across three surfaces that
 * do not share a transaction: SQLite rows, the backup manifest, and the rollout
 * files. `syncCodexHistoryProvider` writes the manifest BEFORE its database
 * transaction and patches rollouts inside it; restore writes rollouts, then the
 * database, then the manifest, then ejects again
 * (`src/codex/history-provider.ts:606-648,656-698`). A SQLite busy timeout
 * serializes exactly one of those three, which is why an opposite-direction
 * process could overtake through the other two.
 *
 * The permit argument is not decoration and not a type-level claim. Each entry
 * point asks the lock owner at RUNTIME whether the permit it was handed is still
 * live for the state database about to be written, because a permit leaked past
 * its callback type-checks perfectly. A writer reached without H therefore fails
 * closed rather than racing.
 *
 * Reachability: `src/codex/history-worker.ts` is the only permitted production
 * root. Readers and probes stay in `history-provider.ts`; nothing in the CLI, the
 * server, the guardian, `inject.ts` or `sync.ts` may reach these symbols.
 *
 * Design record: devlog/_fin/260804_codex_write_substrate/020_history_isolation.md.
 */
import { assertHistoryWritePermit, type HistoryWritePermit } from "../history-lock";
import {
  restoreLegacyOpenaiHistory,
  syncCodexHistoryProvider,
  type CodexHistoryProvider,
  type CodexHistorySyncResult,
} from "../history-provider";

/**
 * Everything a history mutation needs, with no ambient state.
 *
 * The paths are explicit because a Worker is a separate process: it does not
 * inherit the module-load `CODEX_HOME` that `history-provider.ts` resolves at
 * import time (`:16`, `:22`), so a request that relied on those constants would
 * silently address the wrong home.
 */
export interface HistoryWriteTarget {
  /** Canonical, absolute; the same identity H was acquired for. */
  readonly canonicalStateDbPath: string;
  /** Canonical, absolute path of the backup manifest for that database. */
  readonly canonicalBackupPath: string;
}

/**
 * Apply opencodex routing to resumable history, or restore it to native.
 *
 * `provider` is the DURABLE operation's direction, resolved by the caller from
 * the coordinator row — never a caller-supplied preference. The Worker passes
 * what the row said, which is what stops a request from turning a restore into
 * an apply.
 */
export function writeHistoryProviderTransition(
  permit: HistoryWritePermit,
  target: HistoryWriteTarget,
  provider: CodexHistoryProvider,
): CodexHistorySyncResult {
  assertHistoryWritePermit(permit, target.canonicalStateDbPath);
  return syncCodexHistoryProvider(provider, target.canonicalStateDbPath, target.canonicalBackupPath);
}

/**
 * Manifest-independent legacy ejection.
 *
 * Distinct from the generic restore above: it never reads, consumes, deletes or
 * replaces the backup manifest. It does patch rollout metadata and returns a
 * `files` count, so calling it "DB-only" would be wrong — the name says what it
 * actually avoids.
 */
export function writeLegacyOpenaiHistoryRecovery(
  permit: HistoryWritePermit,
  target: HistoryWriteTarget,
): CodexHistorySyncResult {
  assertHistoryWritePermit(permit, target.canonicalStateDbPath);
  return restoreLegacyOpenaiHistory(target.canonicalStateDbPath);
}
