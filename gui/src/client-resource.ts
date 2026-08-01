import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";

export type ResourceSnapshot<T> = {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /**
   * A request is in flight. Unlike `loading`, this never means "replace the content":
   * a quiet poll over cached data raises only this, so a slow revalidation stays visible
   * without blanking the surface.
   */
  refreshing: boolean;
  /** Set once a fetch resolved successfully for this key. Survives later failures. */
  hasSucceeded: boolean;
  /** False when the latest settled attempt failed, so stale-but-shown differs from healthy. */
  lastAttemptOk: boolean;
};

type Store<T> = {
  snapshot: ResourceSnapshot<T>;
  listeners: Set<() => void>;
  /** listener → requested poll interval (undefined = no poll from that subscriber) */
  pollByListener: Map<() => void, number | undefined>;
  /**
   * listener → whether that subscriber's poll may be skipped while the document is hidden.
   *
   * Per subscriber rather than per store: a fixed key can be shared by consumers with
   * different needs, and one opt-out must not be lost because a peer subscribed later.
   */
  pauseWhenHiddenByListener: Map<() => void, boolean>;
  /** listener → fetcher owned by that subscriber */
  fetcherByListener: Map<() => void, (signal: AbortSignal) => Promise<T>>;
  subscriberCount: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  /** Currently scheduled poll interval; avoids resetting the countdown on churn. */
  pollIntervalMs: number | undefined;
  inflight: AbortController | null;
  /** Subscriber that started the current in-flight request (if any). */
  inflightOwner: (() => void) | null;
  /** Store-level visibilitychange handler, installed only while this store polls. */
  visibilityListener: (() => void) | null;
  generation: number;
};

/**
 * Module cache keyed by string. Call sites must not reuse the same key for
 * different resource types (no runtime check — keys are an API contract).
 */
const stores = new Map<string, Store<unknown>>();

const EMPTY_SNAPSHOT: ResourceSnapshot<never> = {
  data: undefined,
  error: undefined,
  loading: false,
  refreshing: false,
  hasSucceeded: false,
  lastAttemptOk: false,
};

function getStore<T>(key: string): Store<T> {
  let store = stores.get(key) as Store<T> | undefined;
  if (!store) {
    store = {
      snapshot: {
        data: undefined,
        error: undefined,
        loading: false,
        refreshing: false,
        hasSucceeded: false,
        lastAttemptOk: false,
      },
      listeners: new Set(),
      pollByListener: new Map(),
      pauseWhenHiddenByListener: new Map(),
      fetcherByListener: new Map(),
      subscriberCount: 0,
      pollTimer: null,
      pollIntervalMs: undefined,
      inflight: null,
      inflightOwner: null,
      visibilityListener: null,
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

/** True when the document is currently hidden. Safe on non-browser runtimes. */
function documentIsHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Pick a subscriber whose poll may run right now.
 *
 * While the document is hidden only subscribers that opted out of pausing are eligible:
 * a background tab has no one reading the paint, but a restart-reconnect poll still has
 * to notice the server coming back. When nothing opted out, the tick is skipped entirely.
 */
function pickPollEntry<T>(
  store: Store<T>,
): { owner: () => void; fetcher: (signal: AbortSignal) => Promise<T> } | null {
  if (!documentIsHidden()) return pickFetcherEntry(store);
  for (const [listener, ms] of store.pollByListener) {
    if (typeof ms !== "number" || ms <= 0) continue;
    if (store.pauseWhenHiddenByListener.get(listener) === false) {
      const fetcher = store.fetcherByListener.get(listener);
      if (fetcher) return { owner: listener, fetcher };
    }
  }
  return null;
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
  if (pollMs === undefined) {
    // No subscriber polls any more, so there is no skipped tick to make up on return.
    removeVisibilityListener(store);
    return;
  }
  store.pollTimer = setInterval(() => {
    const entry = pickPollEntry(store);
    if (!entry) return;
    // Skip ticks while a request is in flight so slow polls can finish.
    void runFetch(store, entry.fetcher, { replaceInflight: false, owner: entry.owner });
  }, pollMs);
  ensureVisibilityListener(store);
}

/**
 * One listener per polling store: when the tab comes back, the skipped ticks are made up
 * with a single quiet revalidation instead of waiting out the remaining interval.
 *
 * `replaceInflight: false` keeps this from cancelling work a visible-again mount just
 * started; if something is already loading, that request is the fresh answer.
 */
function ensureVisibilityListener<T>(store: Store<T>) {
  if (typeof document === "undefined" || store.visibilityListener) return;
  const onVisible = () => {
    if (documentIsHidden()) return;
    if (store.pollIntervalMs === undefined) return;
    const entry = pickFetcherEntry(store);
    if (!entry) return;
    void runFetch(store, entry.fetcher, { replaceInflight: false, owner: entry.owner });
  };
  document.addEventListener("visibilitychange", onVisible);
  store.visibilityListener = onVisible;
}

function removeVisibilityListener<T>(store: Store<T>) {
  if (!store.visibilityListener) return;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", store.visibilityListener);
  }
  store.visibilityListener = null;
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
  // `refreshing` always rises so a slow revalidation is observable without blanking content.
  const shouldShowLoading = store.snapshot.data === undefined || options?.forceLoading === true;
  store.snapshot = {
    ...store.snapshot,
    loading: shouldShowLoading ? true : store.snapshot.loading,
    refreshing: true,
  };
  emit(store);

  try {
    const data = await fetcher(controller.signal);
    if (gen !== store.generation || controller.signal.aborted) return;
    store.snapshot = {
      data,
      error: undefined,
      loading: false,
      refreshing: false,
      hasSucceeded: true,
      lastAttemptOk: true,
    };
  } catch (error) {
    if (gen !== store.generation || controller.signal.aborted) return;
    store.snapshot = {
      ...store.snapshot,
      // Normalize so a loader that rejects with `undefined` still reads as a failure.
      error: error === undefined ? new Error("resource load failed") : error,
      loading: false,
      refreshing: false,
      lastAttemptOk: false,
    };
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
  // The aborted request will never reach its own settle path, so clear its progress marker here.
  if (store.snapshot.refreshing) {
    store.snapshot = { ...store.snapshot, refreshing: false };
    emit(store);
  }
  return true;
}

/**
 * Drop the module cache only after a macrotask so React's subscribe teardown +
 * resubscribe (pollMs / enabled / key churn) can reattach in the same turn
 * without wiping cached data.
 */
function scheduleStoreEviction(key: string, store: Store<unknown>) {
  clearPollTimer(store);
  // The visibility listener exists to wake a poll; with no poll left there is nothing to
  // wake, and leaving it attached would leak one handler per evicted store.
  removeVisibilityListener(store);
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
  pauseWhenHidden = true,
) {
  const store = getStore<T>(key);
  store.listeners.add(onStoreChange);
  store.pollByListener.set(onStoreChange, pollMs);
  store.pauseWhenHiddenByListener.set(onStoreChange, pauseWhenHidden);
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
    store.pauseWhenHiddenByListener.delete(onStoreChange);
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
export interface ClientResourceOptions {
  pollMs?: number;
  enabled?: boolean;
  /**
   * Whether this subscriber's poll may be skipped while the document is hidden.
   * Defaults to true. Set false for polls whose whole purpose is to notice something
   * happening off-screen — a restarting server, for instance.
   */
  pauseWhenHidden?: boolean;
}

export function useClientResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: ClientResourceOptions,
): ResourceSnapshot<T> & { refresh: (opts?: { forceLoading?: boolean }) => void } {
  const enabled = options?.enabled !== false;
  const pollMs = options?.pollMs;
  // Default true: a background tab has nobody reading the paint. Opt out for polls that
  // must keep running while hidden, such as waiting for a restarted server to answer.
  const pauseWhenHidden = options?.pauseWhenHidden !== false;
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
      return subscribeResource(key, stableFetcher, pollMs, onStoreChange, pauseWhenHidden);
    },
    [key, stableFetcher, pollMs, enabled, pauseWhenHidden],
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
  options?: ClientResourceOptions,
): ResourceSnapshot<T> & { refresh: (opts?: { forceLoading?: boolean }) => void } {
  const resource = useClientResource(key, load, options);
  const prevDepsRef = useRef<readonly unknown[] | null>(null);
  const prevKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const prev = prevDepsRef.current;
    const prevKey = prevKeyRef.current;
    prevDepsRef.current = deps;
    prevKeyRef.current = key;
    if (!depsChanged(prev, deps)) return;
    // When the key moved with the deps, subscribing to the new key already started a cold fetch.
    // Revalidating here as well would double every request on a keyed identity change.
    if (prevKey !== null && prevKey !== key) return;
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
  store.snapshot = {
    data,
    error: undefined,
    loading: false,
    refreshing: false,
    hasSucceeded: true,
    lastAttemptOk: true,
  };
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
