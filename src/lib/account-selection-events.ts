/** Process-local invalidations. Connection limits, buffering, and timers belong to consumers. */
export type AccountSelectionEvent = {
  provider: string;
  kind: "oauth" | "api-key";
  revision: number;
};

const listeners = new Set<(event: AccountSelectionEvent) => void>();
let revision = 0;

/** Call only after the authoritative selection has been persisted. */
export function publishAccountSelection(provider: string, kind: AccountSelectionEvent["kind"]): void {
  const event: AccountSelectionEvent = Object.freeze({ provider, kind, revision: ++revision });
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A disconnected consumer must not turn a committed write into a reported failure.
    }
  }
}

export function subscribeAccountSelections(listener: (event: AccountSelectionEvent) => void): () => void {
  // Give each subscription its own lifetime, even when a callback is reused.
  const subscription = (event: AccountSelectionEvent) => listener(event);
  listeners.add(subscription);
  return () => { listeners.delete(subscription); };
}

export function currentAccountSelectionRevision(): number {
  return revision;
}
