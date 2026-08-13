import { rmSync } from "node:fs";

const TRANSIENT_REMOVE_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);
const REMOVE_ATTEMPTS = 50;
const REMOVE_RETRY_DELAY_MS = 50;

type RemoveTreeWithRetryOptions = Readonly<{
  remove?: (path: string) => void;
  sleep?: (milliseconds: number) => void;
}>;

/** Retry only Windows filesystem-release races; preserve every other cleanup failure. */
export function removeTreeWithRetry(
  path: string,
  options: RemoveTreeWithRetryOptions = {},
): void {
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
