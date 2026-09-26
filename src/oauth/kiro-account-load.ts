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
interface Waiter { wake(): void }
interface AccountState { records: Map<number, LeaseRecord>; waiters: Waiter[] }

const accounts = new Map<string, AccountState>();
let nextLeaseId = 0;
const keyOf = (provider: string, accountId: string) => `${provider}\u0000${accountId}`;

function wakeFirstLive(state: AccountState): void {
  state.waiters.shift()?.wake();
}

function reclaim(key: string, now: number): AccountState | undefined {
  const state = accounts.get(key);
  if (!state) return undefined;
  for (const [id, record] of state.records) {
    if (now - record.acquiredAt < KIRO_LEASE_MAX_MS) continue;
    record.released = true;
    state.records.delete(id);
    wakeFirstLive(state);
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
  while (!opts.signal?.aborted) {
    const state: AccountState = reclaim(key, Date.now()) ?? { records: new Map(), waiters: [] };
    if (opts.maxConcurrentPerAccount === undefined || state.records.size < opts.maxConcurrentPerAccount) {
      const id = ++nextLeaseId;
      const record: LeaseRecord = { acquiredAt: Date.now(), released: false };
      state.records.set(id, record);
      accounts.set(key, state);
      return { provider, accountId, release() {
        if (record.released) return;
        record.released = true;
        state.records.delete(id);
        wakeFirstLive(state);
        if (state.records.size === 0 && state.waiters.length === 0) accounts.delete(key);
      } };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", finish);
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        if (state.records.size === 0 && state.waiters.length === 0) accounts.delete(key);
        resolve();
      };
      const waiter: Waiter = { wake: finish };
      state.waiters.push(waiter);
      accounts.set(key, state);
      const timer = setTimeout(finish, remaining);
      opts.signal?.addEventListener("abort", finish, { once: true });
      if (opts.signal?.aborted) finish();
    });
  }
  return null;
}
