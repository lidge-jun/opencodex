/** Process-local serving capacity for Kiro OAuth accounts. */
export interface AccountLease {
  readonly provider: string;
  readonly accountId: string;
  release(): void;
}

export interface AccountLeaseOptions {
  maxConcurrentPerAccount?: number;
  waitMs?: number;
  signal?: AbortSignal;
}

export const KIRO_LEASE_MAX_MS = 15 * 60_000;
export const KIRO_ACCOUNT_WAIT_MS = 250;

interface LeaseRecord { acquiredAt: number; released: boolean }
interface Waiter { grant(now: number): "granted" | "blocked" | "expired" }
interface AccountState { records: Map<number, LeaseRecord>; waiters: Waiter[] }

const accounts = new Map<string, AccountState>();
let nextLeaseId = 0;
const keyOf = (provider: string, accountId: string) => `${provider}\u0000${accountId}`;

function handoff(state: AccountState, now: number): void {
  while (state.waiters.length > 0) {
    const waiter = state.waiters.shift()!;
    const result = waiter.grant(now);
    if (result === "granted") return;
    if (result === "blocked") { state.waiters.unshift(waiter); return; }
  }
}

function leaseFor(provider: string, accountId: string, key: string, state: AccountState, now: number): AccountLease {
  const id = ++nextLeaseId;
  const record: LeaseRecord = { acquiredAt: now, released: false };
  state.records.set(id, record);
  accounts.set(key, state);
  return { provider, accountId, release() {
    if (record.released) return;
    record.released = true;
    state.records.delete(id);
    handoff(state, Date.now());
    if (state.records.size === 0 && state.waiters.length === 0) accounts.delete(key);
  } };
}

function reclaim(key: string, now: number): AccountState | undefined {
  const state = accounts.get(key);
  if (!state) return undefined;
  for (const [id, record] of state.records) {
    if (now - record.acquiredAt < KIRO_LEASE_MAX_MS) continue;
    record.released = true;
    state.records.delete(id);
    handoff(state, now);
  }
  if (state.records.size === 0 && state.waiters.length === 0) accounts.delete(key);
  return state;
}

export function accountInFlight(provider: string, accountId: string): number {
  return reclaim(keyOf(provider, accountId), Date.now())?.records.size ?? 0;
}

/** A null result means the deadline expired or the caller aborted. */
export async function acquireAccountLease(
  provider: string, accountId: string, opts: AccountLeaseOptions = {},
): Promise<AccountLease | null> {
  const key = keyOf(provider, accountId);
  const deadline = Date.now() + Math.max(0, opts.waitMs ?? 0);
  if (opts.signal?.aborted) return null;
  const now = Date.now();
  const state: AccountState = reclaim(key, now) ?? { records: new Map(), waiters: [] };
  if (state.waiters.length === 0
    && (opts.maxConcurrentPerAccount === undefined || state.records.size < opts.maxConcurrentPerAccount)) {
    return leaseFor(provider, accountId, key, state, now);
  }
  const remaining = deadline - now;
  if (remaining <= 0) return null;
  return await new Promise<AccountLease | null>(resolve => {
    let settled = false;
    const finish = (lease: AccountLease | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      if (state.records.size === 0 && state.waiters.length === 0) accounts.delete(key);
      resolve(lease);
    };
    const abort = () => finish(null);
    const waiter: Waiter = { grant(grantNow) {
      if (settled) return "expired";
      if (opts.signal?.aborted || grantNow >= deadline) { finish(null); return "expired"; }
      if (opts.maxConcurrentPerAccount !== undefined && state.records.size >= opts.maxConcurrentPerAccount)
        return "blocked";
      finish(leaseFor(provider, accountId, key, state, grantNow));
      return "granted";
    } };
    state.waiters.push(waiter);
    accounts.set(key, state);
    const timer = setTimeout(() => finish(null), remaining);
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) finish(null);
  });
}
