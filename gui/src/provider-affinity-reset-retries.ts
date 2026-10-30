/** App-lifetime retry state. No credentials or account labels are retained. */
export type AffinityResetRetry = { accountId: string; kind: "active" }
  | { accountId: string; kind: "pause"; paused: boolean };
type Snapshot = Readonly<Record<string, AffinityResetRetry>>;
const empty: Snapshot = Object.freeze({});
const byServer = new Map<string, Snapshot>();
const listeners = new Set<() => void>();

export function affinityResetRetries(apiBase: string): Snapshot {
  return byServer.get(apiBase) ?? empty;
}
export function subscribeAffinityResetRetries(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function rememberAffinityResetRetry(apiBase: string, provider: string, retry: AffinityResetRetry): void {
  byServer.set(apiBase, { ...affinityResetRetries(apiBase), [provider]: retry });
  for (const listener of listeners) listener();
}
export function clearAffinityResetRetry(apiBase: string, provider: string): void {
  const current = affinityResetRetries(apiBase);
  if (!current[provider]) return;
  const next = { ...current }; delete next[provider];
  if (Object.keys(next).length) byServer.set(apiBase, next);
  else byServer.delete(apiBase);
  for (const listener of listeners) listener();
}
