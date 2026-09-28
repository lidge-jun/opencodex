import { getConfigDir } from "../config/paths";
import { parseRetryAfterMs } from "./routing/cooldown-math";

const BASE_DELAY_MS = 5 * 60_000;
const MAX_DELAY_MS = 60 * 60_000;
const MAX_ENTRIES = 256;

/** One capped schedule for failed queries and successful-but-blocked recovery. */
export function nextQuotaQueryDelay(previous = BASE_DELAY_MS / 2): number {
  return Math.min(previous * 2, MAX_DELAY_MS);
}

type Attempt = { delay: number; after: number; retryAfterUntil?: number; poolAccountId?: string; inFlight: boolean; pending?: Promise<unknown>; resolve?: (result: unknown) => void };
// Keys contain configuration-home and caller-owned generation identifiers, never credentials.
const attempts = new Map<string, Attempt>();
const sharedDeadlines = new Map<string, { after: number; retryAfterUntil: number; poolAccountId?: string }>();
const scopedKey = (key: string) => `${getConfigDir()}\0${key}`;
const baseQueryKey = (key: string) => key.replace(/:post-reset:\d+$/, "");

/** The next eligible query time for the current home and credential generation. */
export function nextCodexUsageQueryAt(key: string): number | undefined {
  const scoped = scopedKey(key);
  const base = scopedKey(baseQueryKey(key));
  return Math.max(attempts.get(scoped)?.after ?? 0, attempts.get(base)?.after ?? 0,
    sharedDeadlines.get(base)?.after ?? 0) || undefined;
}

export interface CodexUsageOwner<T> {
  kind: "owner";
  response: Response;
  /** Publish the parsed result to same-key joiners after validation and publication. */
  settle(usable: boolean, result?: T): void;
}
export type CodexUsageRead<T> = CodexUsageOwner<T> | { kind: "joined"; result: T };

export interface CodexUsageSchedule {
  /** Same credential deadline for an epoch-specific dispatch key. */
  pacingKey?: string;
  /** Direct/non-pool main reads retain their original uncached dispatch behavior. */
  unpaced?: true;
  /** Opaque pool identity for removal cleanup; never logged or persisted. */
  poolAccountId?: string;
  /** Recovery claims already have their own five-minute admission interval. */
  recoveryProbe?: true;
  /** The sweep's clock also drives its quota-query deadline. */
  now?: () => number;
}

/** Removal invalidates even active reads, so their late settlements cannot restore pacing. */
export function pruneRemovedCodexPoolUsageAccounts(configuredIds: ReadonlySet<string>): void {
  const homePrefix = `${getConfigDir()}\0`;
  for (const [key, attempt] of attempts) {
    if (key.startsWith(homePrefix) && attempt.poolAccountId
      && !configuredIds.has(attempt.poolAccountId)) attempts.delete(key);
  }
  for (const [key, deadline] of sharedDeadlines) {
    if (key.startsWith(homePrefix) && deadline.poolAccountId
      && !configuredIds.has(deadline.poolAccountId)) sharedDeadlines.delete(key);
  }
}

/** Shared by main, pool and 401-replay usage reads. Cache bypass does not bypass pacing. */
export async function fetchCodexUsage<T>(
  key: string,
  init: RequestInit,
  onDispatch?: () => void,
  schedule: CodexUsageSchedule = {},
): Promise<CodexUsageRead<T> | null> {
  if (schedule.unpaced) {
    onDispatch?.();
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", init);
    return { kind: "owner", response, settle: () => {} };
  }
  const pacingKey = scopedKey(schedule.pacingKey ?? baseQueryKey(key));
  key = scopedKey(key);
  const previous = attempts.get(key);
  if (previous?.inFlight) {
    const result = (await previous.pending) as T | undefined;
    return result === undefined ? null : { kind: "joined", result };
  }
  const now = schedule.now ?? Date.now;
  const base = attempts.get(pacingKey);
  const shared = sharedDeadlines.get(pacingKey);
  if (schedule.recoveryProbe
    ? Math.max(previous?.retryAfterUntil ?? 0, base?.retryAfterUntil ?? 0,
      shared?.retryAfterUntil ?? 0) > now()
    : Math.max(previous?.after ?? 0, base?.after ?? 0, shared?.after ?? 0) > now()) return null;
  if (!previous && attempts.size >= MAX_ENTRIES) {
    const evict = [...attempts].find(([, entry]) => !entry.inFlight)?.[0];
    if (!evict) return null;
    attempts.delete(evict);
  }
  let resolve!: (result: unknown) => void;
  const pending = new Promise<unknown>(done => { resolve = done; });
  const attempt: Attempt = { delay: previous?.delay ?? BASE_DELAY_MS / 2, after: 0,
    ...(schedule.poolAccountId ? { poolAccountId: schedule.poolAccountId } : {}),
    inFlight: true, pending, resolve };
  attempts.set(key, attempt);
  let response: Response | undefined;
  const settle = (usable: boolean, result?: T) => {
    if (!attempt.inFlight) return;
    attempt.inFlight = false;
    if (attempts.get(key) === attempt) {
      if (usable || response?.status === 401 || response?.status === 403) {
        attempts.delete(key);
        if (usable) {
          sharedDeadlines.delete(pacingKey);
          if (pacingKey !== key && attempts.get(pacingKey)?.inFlight === false)
            attempts.delete(pacingKey);
        }
      }
      else {
        const at = now();
        const delay = schedule.recoveryProbe ? BASE_DELAY_MS : nextQuotaQueryDelay(previous?.delay);
        const retryAfter = parseRetryAfterMs(response?.headers.get("retry-after"), at) ?? 0;
        const settledBase = pacingKey === key ? previous : attempts.get(pacingKey);
        const settledShared = sharedDeadlines.get(pacingKey);
        const after = Math.max(previous?.after ?? 0, settledBase?.after ?? 0, settledShared?.after ?? 0,
          at + Math.max(delay, retryAfter));
        const retryAfterUntil = Math.max(previous?.retryAfterUntil ?? 0,
          settledBase?.retryAfterUntil ?? 0, settledShared?.retryAfterUntil ?? 0, at + retryAfter);
        attempts.set(key, { delay, after,
          ...(attempt.poolAccountId ? { poolAccountId: attempt.poolAccountId } : {}),
          ...(retryAfterUntil > 0 ? { retryAfterUntil } : {}), inFlight: false });
        if (pacingKey !== key) {
          if (!sharedDeadlines.has(pacingKey) && sharedDeadlines.size >= MAX_ENTRIES)
            sharedDeadlines.delete(sharedDeadlines.keys().next().value!);
          sharedDeadlines.set(pacingKey, { after, retryAfterUntil,
            ...(attempt.poolAccountId ? { poolAccountId: attempt.poolAccountId } : {}) });
        }
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
  sharedDeadlines.clear();
}
