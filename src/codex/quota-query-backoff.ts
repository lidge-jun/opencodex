import { getConfigDir } from "../config/paths";
import { parseRetryAfterMs } from "./routing/cooldown-math";

const BASE_DELAY_MS = 5 * 60_000;
const MAX_DELAY_MS = 60 * 60_000;
// Keys contain configuration-home and caller-owned generation identifiers, never credentials.
const failures = new Map<string, { delay: number; after: number }>();

/** Shared by main, pool and 401-replay usage reads. Cache bypass does not bypass pacing. */
export async function fetchCodexUsage(
  key: string,
  init: RequestInit,
  onDispatch?: () => void,
): Promise<Response | null> {
  key = `${getConfigDir()}\0${key}`;
  const previous = failures.get(key);
  if (previous && previous.after > Date.now()) return null;
  if (!failures.has(key) && failures.size >= 256) failures.delete(failures.keys().next().value!);
  const attempt = { delay: previous?.delay ?? BASE_DELAY_MS / 2, after: 0 };
  failures.set(key, attempt);
  const failed = (retryAfter?: string | null) => {
    if (failures.get(key) !== attempt) return; // A newer dispatch owns its pacing evidence.
    const now = Date.now();
    const delay = Math.min((previous?.delay ?? BASE_DELAY_MS / 2) * 2, MAX_DELAY_MS);
    failures.set(key, { delay, after: now + Math.max(delay, parseRetryAfterMs(retryAfter, now) ?? 0) });
  };
  onDispatch?.();
  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", init);
    // Authentication recovery owns 401/403 handling, including its own bounded replay/backoff.
    if (response.ok || response.status === 401 || response.status === 403) {
      if (failures.get(key) === attempt) failures.delete(key);
    } else failed(response.headers.get("retry-after"));
    return response;
  } catch (error) {
    failed();
    throw error;
  }
}

export function resetQuotaQueryBackoffForTests(): void {
  failures.clear();
}
