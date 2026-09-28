import { getConfigDir } from "../config/paths";
import { parseRetryAfterMs } from "./routing/cooldown-math";

const BASE_DELAY_MS = 5 * 60_000;
const MAX_DELAY_MS = 60 * 60_000;
const MAX_ENTRIES = 256;

/** One capped schedule for failed queries and successful-but-blocked recovery. */
export function nextQuotaQueryDelay(previous = BASE_DELAY_MS / 2): number {
  return Math.min(previous * 2, MAX_DELAY_MS);
}

type Attempt = { delay: number; after: number; inFlight: boolean };
// Keys contain configuration-home and caller-owned generation identifiers, never credentials.
const attempts = new Map<string, Attempt>();
const scopedKey = (key: string) => `${getConfigDir()}\0${key}`;

/** The next eligible query time for the current home and credential generation. */
export function nextCodexUsageQueryAt(key: string): number | undefined {
  return attempts.get(scopedKey(key))?.after || undefined;
}

export interface CodexUsageRead {
  response: Response;
  /** Settle after parsing and publication. A malformed 200 is a failed usage read. */
  settle(usable: boolean): void;
}

/** Shared by main, pool and 401-replay usage reads. Cache bypass does not bypass pacing. */
export async function fetchCodexUsage(
  key: string,
  init: RequestInit,
  onDispatch?: () => void,
): Promise<CodexUsageRead | null> {
  key = scopedKey(key);
  const previous = attempts.get(key);
  if (previous?.inFlight || (previous && previous.after > Date.now())) return null;
  if (!previous && attempts.size >= MAX_ENTRIES) {
    const evict = [...attempts].find(([, entry]) => !entry.inFlight)?.[0];
    if (!evict) return null;
    attempts.delete(evict);
  }
  const attempt: Attempt = { delay: previous?.delay ?? BASE_DELAY_MS / 2, after: 0, inFlight: true };
  attempts.set(key, attempt);
  const settle = (usable: boolean, retryAfter?: string | null) => {
    if (!attempt.inFlight) return;
    attempt.inFlight = false;
    if (attempts.get(key) !== attempt) return;
    if (usable) { attempts.delete(key); return; }
    const now = Date.now();
    const delay = nextQuotaQueryDelay(previous?.delay);
    attempts.set(key, { delay, after: now + Math.max(delay, parseRetryAfterMs(retryAfter, now) ?? 0), inFlight: false });
  };
  try {
    onDispatch?.();
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", init);
    // Authentication recovery owns 401/403 handling. These responses are not usage reads.
    if (response.status === 401 || response.status === 403) settle(true);
    else if (!response.ok) settle(false, response.headers.get("retry-after"));
    return { response, settle };
  } catch (error) {
    settle(false);
    throw error;
  }
}

export function resetQuotaQueryBackoffForTests(): void {
  attempts.clear();
}
