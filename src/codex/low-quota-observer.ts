import type { StoredAccountQuota } from "./quota-types";

type Observer = (accountId: string, quota: Omit<StoredAccountQuota, "updatedAt">) => void;
const observers = new Map<symbol, Observer>();

/** The composition root owns the live config; quota writers know only this synchronous slot. */
export function registerLowQuotaObserver(observer: Observer): () => void {
  const owner = Symbol();
  observers.set(owner, observer);
  return () => { observers.delete(owner); };
}

/** Only newly accepted evidence belongs here, never carried or disk-hydrated windows. */
export function observeCodexLowQuota(accountId: string, quota: Omit<StoredAccountQuota, "updatedAt">): void {
  const observer = [...observers.values()].at(-1);
  if (!observer) return;
  try {
    observer(accountId, quota);
  } catch {
    // Optional protection must not turn a committed quota observation into a failed request.
    console.warn("[codex-low-quota] protection action failed");
  }
}
