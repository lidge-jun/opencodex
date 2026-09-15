import { rmSync } from "node:fs";
import { assertRemovalOutsideProtectedTrees } from "../../src/lib/test-home-guard";

const TRANSIENT_REMOVE_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
const REMOVE_ATTEMPTS = 50;
const REMOVE_RETRY_DELAY_MS = 50;

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
 */
export function removeTreeWithRetry(
  path: string,
  options: RemoveTreeWithRetryOptions = {},
): void {
  assertRemovalOutsideProtectedTrees(path);
  const remove = options.remove ?? (target => rmSync(target, { recursive: true, force: true }));
  const sleep = options.sleep ?? Bun.sleepSync;

  for (let attempt = 1; attempt <= REMOVE_ATTEMPTS; attempt += 1) {
    try {
      remove(path);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (!TRANSIENT_REMOVE_CODES.has(code) || attempt === REMOVE_ATTEMPTS) throw error;
      sleep(REMOVE_RETRY_DELAY_MS);
    }
  }
}
