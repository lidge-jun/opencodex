import { assertRemovalOutsideProtectedTrees } from "../../src/lib/test-home-guard";
import { removeTestTempTree } from "../../scripts/test-temp";

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
 */
export function removeTreeWithRetry(
  path: string,
  options: RemoveTreeWithRetryOptions = {},
): void {
  assertRemovalOutsideProtectedTrees(path);
  removeTestTempTree(path, options);
}
