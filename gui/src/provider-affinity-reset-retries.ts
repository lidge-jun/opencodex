/** App-lifetime retry state. No credentials or account labels are retained. */
export type AffinityResetRetry = { accountId: string; kind: "active" }
  | { accountId: string; kind: "pause"; paused: boolean }
  | { accountId: string; kind: "reset" };
type Snapshot = Readonly<Record<string, AffinityResetRetry>>;
const empty: Snapshot = Object.freeze(Object.create(null) as Record<string, AffinityResetRetry>);
const byServer = new Map<string, Snapshot>();
const listeners = new Set<() => void>();
type Reducer = (current: AffinityResetRetry | undefined) => AffinityResetRetry | undefined;
type Outcome = { kind: "unpersisted"; accountId: string } | { kind: "confirmed" };
type Operation = { reduce?: Reducer; active: boolean; settled: boolean };
type Journal = { base: AffinityResetRetry | undefined; operations: Operation[];
  observedDebt: number; clearedDebt: number; debtAccountId?: string };
const journals = new Map<string, Map<string, Journal>>();

function publish(apiBase: string, provider: string, retry: AffinityResetRetry | undefined): void {
  const current = affinityResetRetries(apiBase);
  const previous = current[provider];
  if (previous === retry || previous && retry && previous.kind === retry.kind && previous.accountId === retry.accountId
    && (previous.kind !== "pause" || retry.kind === "pause" && previous.paused === retry.paused)) return;
  const next: Record<string, AffinityResetRetry> = Object.assign(Object.create(null), current);
  if (retry) next[provider] = retry;
  else delete next[provider];
  if (Object.keys(next).length) byServer.set(apiBase, next);
  else byServer.delete(apiBase);
  for (const listener of listeners) listener();
}

/** Order replay intent by request start; acknowledge only reset debt observed before that request. */
export function beginAffinityResetOperation(apiBase: string, provider: string): (reduce?: Reducer, replaces?: boolean, outcome?: Outcome) => void {
  let server = journals.get(apiBase);
  if (!server) { server = new Map(); journals.set(apiBase, server); }
  let journal = server.get(provider);
  if (!journal) { journal = { base: undefined, operations: [], observedDebt: 0, clearedDebt: 0 }; server.set(provider, journal); }
  const knownDebt = journal.observedDebt;
  const operation: Operation = { active: true, settled: false };
  journal.operations.push(operation);
  return (reduce = current => current, replaces = false, outcome) => {
    if (operation.settled) return;
    operation.settled = true;
    // Retiring an old command does not prove a later reset covered its server-side commit.
    if (outcome?.kind === "unpersisted") {
      journal.observedDebt++;
      journal.debtAccountId = outcome.accountId;
    } else if (outcome?.kind === "confirmed") journal.clearedDebt = Math.max(journal.clearedDebt, knownDebt);
    if (operation.active) {
      operation.reduce = reduce;
      // Unconditional set/clear supersedes older replay intent, including unresolved requests.
      // Retiring a token never suppresses an eventual, explicitly unpersisted server receipt.
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
    }
    let next = journal.base;
    for (const pending of journal.operations) if (pending.reduce) next = pending.reduce(next);
    // Keep counters for the app lifetime: an old confirmation must never see a recreated epoch.
    if (journal.observedDebt <= journal.clearedDebt) journal.debtAccountId = undefined;
    else if (!next && journal.debtAccountId !== undefined) next = { kind: "reset", accountId: journal.debtAccountId };
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
  // This clears replay intent, not evidenced debt; only a confirmed request can acknowledge that.
  beginAffinityResetOperation(apiBase, provider)(() => undefined, true);
}
