/** App-lifetime retry state. No credentials or account labels are retained. */
export type AffinityResetRetry = { accountId: string; kind: "active" }
  | { accountId: string; kind: "pause"; paused: boolean }
  | { accountId: string; kind: "reset" };
type Snapshot = Readonly<Record<string, AffinityResetRetry>>;
const empty: Snapshot = Object.freeze({});
const byServer = new Map<string, Snapshot>();
const listeners = new Set<() => void>();
type Reducer = (current: AffinityResetRetry | undefined) => AffinityResetRetry | undefined;
type Operation = { reduce?: Reducer; active: boolean };
type Journal = { base: AffinityResetRetry | undefined; operations: Operation[] };
const journals = new Map<string, Map<string, Journal>>();

function publish(apiBase: string, provider: string, retry: AffinityResetRetry | undefined): void {
  const current = affinityResetRetries(apiBase);
  const previous = current[provider];
  if (previous === retry || previous && retry && previous.kind === retry.kind && previous.accountId === retry.accountId
    && (previous.kind !== "pause" || retry.kind === "pause" && previous.paused === retry.paused)) return;
  const next = { ...current };
  if (retry) next[provider] = retry;
  else delete next[provider];
  if (Object.keys(next).length) byServer.set(apiBase, next);
  else byServer.delete(apiBase);
  for (const listener of listeners) listener();
}

/** Receipts follow request-start intent order, independently of React lifetime or arrival order. */
export function beginAffinityResetOperation(apiBase: string, provider: string): (reduce?: Reducer, replaces?: boolean) => void {
  let server = journals.get(apiBase);
  if (!server) { server = new Map(); journals.set(apiBase, server); }
  let journal = server.get(provider);
  if (!journal) { journal = { base: affinityResetRetries(apiBase)[provider], operations: [] }; server.set(provider, journal); }
  const operation: Operation = { active: true };
  journal.operations.push(operation);
  return (reduce = current => current, replaces = false) => {
    if (!operation.active || operation.reduce) return;
    operation.reduce = reduce;
    // Unconditional set/clear supersedes the entire older prefix, including unresolved requests.
    // Retire those tokens even for an empty clear, so a late reply cannot recreate stale intent.
    if (replaces) {
      const prefix = journal.operations.splice(0, journal.operations.indexOf(operation) + 1);
      for (const retired of prefix) retired.active = false;
      journal.base = reduce(undefined);
    }
    while (journal.operations[0]?.reduce) {
      const settled = journal.operations.shift()!;
      journal.base = settled.reduce!(journal.base);
      settled.active = false;
    }
    let next = journal.base;
    for (const pending of journal.operations) if (pending.reduce) next = pending.reduce(next);
    if (!journal.operations.length) {
      server.delete(provider);
      if (!server.size) journals.delete(apiBase);
    }
    publish(apiBase, provider, next);
  };
}

export function affinityResetRetries(apiBase: string): Snapshot {
  return byServer.get(apiBase) ?? empty;
}
export function subscribeAffinityResetRetries(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function rememberAffinityResetRetry(apiBase: string, provider: string, retry: AffinityResetRetry): void {
  beginAffinityResetOperation(apiBase, provider)(() => retry, true);
}
export function clearAffinityResetRetry(apiBase: string, provider: string): void {
  beginAffinityResetOperation(apiBase, provider)(() => undefined, true);
}
