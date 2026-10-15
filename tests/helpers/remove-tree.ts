import { assertRemovalOutsideProtectedTrees } from "../../src/lib/test-home-guard";
import { pendingBackgroundWork, settleBackgroundWork } from "../../src/lib/background-work";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { REMOVE_RETRY_BUDGET_MS, removeTestTempTree, removeTestTempTreeAsync } from "../../scripts/test-temp";

type RemoveTreeWithRetryOptions = Readonly<{
  remove?: (path: string) => void;
  sleep?: (milliseconds: number) => void;
}>;

/**
 * Retry only Windows filesystem-release races; preserve every other cleanup failure.
 *
 * The refusal comes FIRST, before the injected `remove` can run, because this helper is the
 * one removal path the whole suite shares: a fixture that resolves the process-global config
 * directory and hands it here would otherwise delete the developer's real home on any run that
 * never pinned OPENCODEX_HOME. The check is a path comparison against three canonical trees,
 * so it costs nothing for the temp directories every caller actually passes.
 *
 * The retry policy itself lives in `scripts/test-temp` so the wrapper's own cleanup and every
 * fixture teardown wait the same way. They were separate schedules for one release, and the
 * duplicate is what let the shard-load failure in #4789 be fixed in one place and not the other.
 *
 * This variant blocks the event loop between attempts, so it cannot outwait a holder that is
 * async work in this process. A failure while such work is in flight names it: that case
 * belongs to {@link removeTreeAfterBackgroundWork}.
 */
export function removeTreeWithRetry(
  path: string,
  options: RemoveTreeWithRetryOptions = {},
): void {
  assertRemovalOutsideProtectedTrees(path);
  try {
    removeTestTempTree(path, options);
  } catch (error) {
    const pending = pendingBackgroundWork();
    if (pending.length > 0 && error instanceof Error) {
      error.message += ` (in-process background work still running: ${pending.join(", ")}; `
        + "use removeTreeAfterBackgroundWork so it can finish and release its handles)";
    }
    throw error;
  }
}

/**
 * Teardown for a case that started work it did not await (a lazy quota prime, a startup
 * reconcile): settle that work, wait for any icacls child under the tree to be reaped, then
 * remove with waits that yield, so an in-process handle holder can still close its files.
 */
export async function removeTreeAfterBackgroundWork(path: string): Promise<void> {
  assertRemovalOutsideProtectedTrees(path);
  const { settled, pending } = await settleBackgroundWork({ timeoutMs: REMOVE_RETRY_BUDGET_MS });
  // Removing under a live writer either fails with a sharing violation or lets the writer
  // recreate files after removal. Keep the tree and name the work instead.
  if (!settled) {
    throw new Error(`[test] not removing ${path}: in-process background work still running: ${pending.join(", ")}`);
  }
  await flushWindowsSecretAclReapsBeforeRemoval(path);
  await removeTestTempTreeAsync(path);
}
