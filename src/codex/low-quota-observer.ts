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
  for (const observer of observers.values()) {
    try {
      observer(accountId, quota);
    } catch {
      // One server's optional policy cannot suppress another server's observation.
      console.warn("[codex-low-quota] protection action failed");
    }
  }
}
