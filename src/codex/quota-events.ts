/** Dependency-free wakeups for request-owned quota waiters. No timers or network work. */
const listeners = new Set<() => void>();
let revision = 0;
export function getCodexQuotaRevision(): number { return revision; }
export function subscribeCodexQuotaChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyCodexQuotaChanges(): void {
  revision++;
  for (const listener of listeners) {
    try { listener(); }
    catch { console.warn("[codex] quota change listener failed"); }
  }
}
