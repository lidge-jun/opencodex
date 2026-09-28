import { getConfigDir } from "../config/paths";
import { parseRetryAfterMs } from "./routing/cooldown-math";

const BASE_DELAY_MS = 5 * 60_000;
const MAX_DELAY_MS = 60 * 60_000;
const MAX_ENTRIES = 256;

/** One capped schedule for failed queries and successful-but-blocked recovery. */
export function nextQuotaQueryDelay(previous = BASE_DELAY_MS / 2): number {
  return Math.min(previous * 2, MAX_DELAY_MS);
}

type Attempt = { delay: number; after: number; inFlight: boolean; pending?: Promise<unknown>; resolve?: (result: unknown) => void };
// Keys contain configuration-home and caller-owned generation identifiers, never credentials.
const attempts = new Map<string, Attempt>();
const scopedKey = (key: string) => `${getConfigDir()}\0${key}`;

/** The next eligible query time for the current home and credential generation. */
export function nextCodexUsageQueryAt(key: string): number | undefined {
  return attempts.get(scopedKey(key))?.after || undefined;
}

export interface CodexUsageOwner<T> {
  kind: "owner";
  response: Response;
  /** Publish the parsed result to same-key joiners after validation and publication. */
  settle(usable: boolean, result?: T): void;
}
export type CodexUsageRead<T> = CodexUsageOwner<T> | { kind: "joined"; result: T };

/** Shared by main, pool and 401-replay usage reads. Cache bypass does not bypass pacing. */
export async function fetchCodexUsage<T>(
  key: string,
  init: RequestInit,
  onDispatch?: () => void,
): Promise<CodexUsageRead<T> | null> {
  key = scopedKey(key);
  const previous = attempts.get(key);
  if (previous?.inFlight) {
    const result = (await previous.pending) as T | undefined;
    return result === undefined ? null : { kind: "joined", result };
  }
  if (previous && previous.after > Date.now()) return null;
  if (!previous && attempts.size >= MAX_ENTRIES) {
    const evict = [...attempts].find(([, entry]) => !entry.inFlight)?.[0];
    if (!evict) return null;
    attempts.delete(evict);
  }
  let resolve!: (result: unknown) => void;
  const pending = new Promise<unknown>(done => { resolve = done; });
  const attempt: Attempt = { delay: previous?.delay ?? BASE_DELAY_MS / 2, after: 0, inFlight: true, pending, resolve };
  attempts.set(key, attempt);
  let response: Response | undefined;
  const settle = (usable: boolean, result?: T) => {
    if (!attempt.inFlight) return;
    attempt.inFlight = false;
    if (attempts.get(key) === attempt) {
      if (usable || response?.status === 401 || response?.status === 403) attempts.delete(key);
      else {
        const now = Date.now();
        const delay = nextQuotaQueryDelay(previous?.delay);
        attempts.set(key, { delay, after: now + Math.max(delay,
          parseRetryAfterMs(response?.headers.get("retry-after"), now) ?? 0), inFlight: false });
      }
    }
    attempt.resolve?.(result);
  };
  try {
    onDispatch?.();
    response = await fetch("https://chatgpt.com/backend-api/wham/usage", init);
    return { kind: "owner", response, settle };
  } catch (error) {
    settle(false);
    throw error;
  }
}

export function resetQuotaQueryBackoffForTests(): void {
  attempts.clear();
}
