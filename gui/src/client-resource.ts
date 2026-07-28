import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";

export type ResourceSnapshot<T> = {
  data: T | undefined;
  error: unknown;
  loading: boolean;
};

type Store<T> = {
  snapshot: ResourceSnapshot<T>;
  listeners: Set<() => void>;
  /** listener → requested poll interval (undefined = no poll from that subscriber) */
  pollByListener: Map<() => void, number | undefined>;
  /** listener → fetcher owned by that subscriber */
  fetcherByListener: Map<() => void, (signal: AbortSignal) => Promise<T>>;
  subscriberCount: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  /** Currently scheduled poll interval; avoids resetting the countdown on churn. */
  pollIntervalMs: number | undefined;
  inflight: AbortController | null;
  /** Subscriber that started the current in-flight request (if any). */
  inflightOwner: (() => void) | null;
  generation: number;
};

/**
 * Module cache keyed by string. Call sites must not reuse the same key for
 * different resource types (no runtime check — keys are an API contract).
 */
const stores = new Map<string, Store<unknown>>();

const EMPTY_SNAPSHOT: ResourceSnapshot<never> = { data: undefined, error: undefined, loading: false };

function getStore<T>(key: string): Store<T> {
  let store = stores.get(key) as Store<T> | undefined;
  if (!store) {
    store = {
      snapshot: { data: undefined, error: undefined, loading: false },
      listeners: new Set(),
      pollByListener: new Map(),
      fetcherByListener: new Map(),
      subscriberCount: 0,
      pollTimer: null,
      pollIntervalMs: undefined,
      inflight: null,
      inflightOwner: null,
      generation: 0,
    };
    stores.set(key, store);
  }
  return store;
}

function emit<T>(store: Store<T>) {
  for (const listener of store.listeners) listener();
}

function clearPollTimer<T>(store: Store<T>) {
  if (store.pollTimer !== null) {
    clearInterval(store.pollTimer);
    store.pollTimer = null;
  }
  store.pollIntervalMs = undefined;
}

/** Prefer a polling subscriber's fetcher; otherwise any remaining subscriber. */
function pickFetcherEntry<T>(
  store: Store<T>,
): { owner: () => void; fetcher: (signal: AbortSignal) => Promise<T> } | null {
  for (const [listener, ms] of store.pollByListener) {
    if (typeof ms === "number" && ms > 0) {
      const fetcher = store.fetcherByListener.get(listener);
      if (fetcher) return { owner: listener, fetcher };
    }
  }
  for (const [listener, fetcher] of store.fetcherByListener) {
    return { owner: listener, fetcher };
  }
  return null;
}

/** Honor the most aggressive (smallest positive) poll interval among subscribers. */
function recomputePoll<T>(store: Store<T>) {
  let pollMs: number | undefined;
  for (const ms of store.pollByListener.values()) {
    if (typeof ms === "number" && ms > 0) {
      pollMs = pollMs === undefined ? ms : Math.min(pollMs, ms);
    }
  }
  // Keep the existing countdown when the effective interval is unchanged.
  if (pollMs === store.pollIntervalMs && (pollMs === undefined || store.pollTimer !== null)) {
    return;
  }
  clearPollTimer(store);
  store.pollIntervalMs = pollMs;
  if (pollMs === undefined) return;
  store.pollTimer = setInterval(() => {
    const entry = pickFetcherEntry(store);
    if (!entry) return;
    // Skip ticks while a request is in flight so slow polls can finish.
    void runFetch(store, entry.fetcher, { replaceInflight: false, owner: entry.owner });
  }, pollMs);
}

async function runFetch<T>(
  store: Store<T>,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: { replaceInflight?: boolean; owner?: (() => void) | null; forceLoading?: boolean },
) {
  const replaceInflight = options?.replaceInflight !== false;
  if (store.inflight && !replaceInflight) return;

  if (replaceInflight) store.inflight?.abort();
  const controller = new AbortController();
  store.inflight = controller;
  store.inflightOwner = options?.owner ?? null;
  const gen = ++store.generation;

  // Falsy cached values stay visible during polls; forceLoading is for identity changes (deps).
  if (store.snapshot.data === undefined || options?.forceLoading) {
    store.snapshot = { ...store.snapshot, loading: true };
    emit(store);
  }

  try {
    const data = await fetcher(controller.signal);
    if (gen !== store.generation || controller.signal.aborted) return;
    store.snapshot = { data, error: undefined, loading: false };
  } catch (error) {
    if (gen !== store.generation || controller.signal.aborted) return;
    store.snapshot = { ...store.snapshot, error, loading: false };
  } finally {
    if (store.inflight === controller) {
      store.inflight = null;
      store.inflightOwner = null;
    }
    emit(store);
  }
}

function abortInflightOwnedBy<T>(store: Store<T>, owner: () => void): boolean {
  if (store.inflightOwner !== owner) return false;
  store.inflight?.abort();
  store.inflight = null;
  store.inflightOwner = null;
  store.generation++;
  return true;
}

/**
 * Drop the module cache only after a macrotask so React's subscribe teardown +
 * resubscribe (pollMs / enabled / key churn) can reattach in the same turn
 * without wiping cached data.
 */
function scheduleStoreEviction(key: string, store: Store<unknown>) {
  clearPollTimer(store);
  setTimeout(() => {
    if (store.subscriberCount !== 0) return;
    if (stores.get(key) !== store) return;
    store.inflight?.abort();
    store.inflight = null;
    store.inflightOwner = null;
    stores.delete(key);
  }, 0);
}

function subscribeResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  pollMs: number | undefined,
  onStoreChange: () => void,
) {
  const store = getStore<T>(key);
  store.listeners.add(onStoreChange);
  store.pollByListener.set(onStoreChange, pollMs);
  store.fetcherByListener.set(onStoreChange, fetcher);
  store.subscriberCount++;

  // Cold start only — keep cached data across transient 0→1 resubscribe gaps.
  if (store.subscriberCount === 1 && store.snapshot.data === undefined) {
    void runFetch(store, fetcher, { replaceInflight: true, owner: onStoreChange });
  }
  recomputePoll(store);

  return () => {
    store.listeners.delete(onStoreChange);
    store.pollByListener.delete(onStoreChange);
    store.fetcherByListener.delete(onStoreChange);
    store.subscriberCount--;
    // Drop this subscriber's in-flight work so a late resolve cannot stomp shared data.
    const abortedOwned = abortInflightOwnedBy(store, onStoreChange);
    if (store.subscriberCount === 0) {
      scheduleStoreEviction(key, store);
      return;
    }
    // Replace aborted work immediately so the shared snapshot cannot stay stuck loading.
    if (abortedOwned) {
      const entry = pickFetcherEntry(store);
      if (entry) {
        void runFetch(store, entry.fetcher, { replaceInflight: true, owner: entry.owner });
      }
    }
    recomputePoll(store);
  };
}

/** Module-level fetch cache with useSyncExternalStore subscriptions (no fetch in useEffect). */
export function useClientResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: { pollMs?: number; enabled?: boolean },
): ResourceSnapshot<T> & { refresh: (opts?: { forceLoading?: boolean }) => void } {
  const enabled = options?.enabled !== false;
  const pollMs = options?.pollMs;
  const fetcherRef = useRef(fetcher);
  // Sync latest fetcher every commit. No dep array on purpose: inline fetchers are
  // reallocated every render; listing them would re-subscribe forever.
  useLayoutEffect(() => {
    fetcherRef.current = fetcher;
  });

  const stableFetcher = useCallback(
    (signal: AbortSignal) => fetcherRef.current(signal),
    [],
  );

  const listenerRef = useRef<(() => void) | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!enabled) return () => {};
      listenerRef.current = onStoreChange;
      return subscribeResource(key, stableFetcher, pollMs, onStoreChange);
    },
    [key, stableFetcher, pollMs, enabled],
  );

  const getSnapshot = useCallback((): ResourceSnapshot<T> => {
    if (!enabled) return EMPTY_SNAPSHOT;
    return getStore<T>(key).snapshot;
  }, [key, enabled]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback((opts?: { forceLoading?: boolean }) => {
    if (!enabled) return;
    void runFetch(getStore<T>(key), stableFetcher, {
      replaceInflight: true,
      owner: listenerRef.current,
      forceLoading: opts?.forceLoading,
    });
  }, [key, stableFetcher, enabled]);

  return { ...snapshot, refresh };
}

function depsChanged(prev: readonly unknown[] | null, next: readonly unknown[]): boolean {
  if (prev === null) return false;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

/**
 * Like `useClientResource`, but refetches when `deps` change (element-wise
 * `Object.is`), even if the cache `key` stays the same. Callers may allocate a
 * fresh deps array each render — identity of the array is ignored.
 * Deps changes force `loading: true` while retaining previous data until the
 * new response arrives (unlike quiet poll refreshes).
 */
export function useKeyedClientResource<T>(
  key: string,
  deps: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>,
  options?: { pollMs?: number; enabled?: boolean },
): ResourceSnapshot<T> & { refresh: (opts?: { forceLoading?: boolean }) => void } {
  const resource = useClientResource(key, load, options);
  const prevDepsRef = useRef<readonly unknown[] | null>(null);

  useLayoutEffect(() => {
    const prev = prevDepsRef.current;
    prevDepsRef.current = deps;
    if (!depsChanged(prev, deps)) return;
    resource.refresh({ forceLoading: true });
  });

  return resource;
}

/** Publish data for a key and invalidate any in-flight fetch so it cannot stomp this write. */
export function setClientResourceData<T>(key: string, data: T) {
  const store = getStore<T>(key);
  store.inflight?.abort();
  store.inflight = null;
  store.inflightOwner = null;
  store.generation++;
  store.snapshot = { data, error: undefined, loading: false };
  emit(store);
}

/** Test-only: drop every module cache entry so suite order cannot skip cold-start fetches. */
export function clearClientResourceStoresForTests(): void {
  for (const store of stores.values()) {
    clearPollTimer(store);
    store.inflight?.abort();
    store.inflight = null;
    store.inflightOwner = null;
  }
  stores.clear();
}
