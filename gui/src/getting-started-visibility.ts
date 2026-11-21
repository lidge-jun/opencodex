import { useSyncExternalStore } from "react";

/*
 * Whether Home shows its Getting started card. The choice belongs to the screen a person
 * reads, so it lives in this browser profile's localStorage (the desktop app's window has its
 * own) rather than in proxy config. Hiding is reversible from the Set up hub.
 *
 * One snapshot serves every reader: a write notifies this window's subscribers directly
 * (the storage event only reaches other windows), and a localStorage event reconciles those.
 * When storage refuses a read or a write, the last choice made here still holds for this visit.
 */
export const GETTING_STARTED_HIDDEN_KEY = "ocx-home-getting-started-hidden";

const listeners = new Set<() => void>();
/**
 * The last choice made in this window, scoped to the storage it was made against so a fresh
 * window starts from its own storage. `saved` is false when the write was refused, and then
 * this value outranks whatever storage still holds.
 */
let local: { store: Storage | undefined; hidden: boolean; saved: boolean } | undefined;
let watched: Window | undefined;

function currentStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readGettingStartedHidden(): boolean {
  const store = currentStorage();
  const mine = local && local.store === store ? local : undefined;
  if (mine && !mine.saved) return mine.hidden;
  try {
    if (!store) return mine?.hidden ?? false;
    return store.getItem(GETTING_STARTED_HIDDEN_KEY) === "1";
  } catch {
    // Writable but unreadable storage: keep showing what this window chose.
    return mine?.hidden ?? false;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function setGettingStartedHidden(hidden: boolean): void {
  const store = currentStorage();
  try {
    if (!store) throw new Error("storage unavailable");
    if (hidden) store.setItem(GETTING_STARTED_HIDDEN_KEY, "1");
    else store.removeItem(GETTING_STARTED_HIDDEN_KEY);
    local = { store, hidden, saved: true };
  } catch {
    local = { store, hidden, saved: false };
  }
  notify();
}

function onStorage(event: StorageEvent): void {
  // Only this localStorage speaks for the card: a sessionStorage event, or another key, does not.
  if (event.storageArea !== currentStorage()) return;
  // A null key is clear().
  if (event.key !== null && event.key !== GETTING_STARTED_HIDDEN_KEY) return;
  local = undefined;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!watched && typeof window !== "undefined") {
    watched = window;
    watched.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && watched) {
      watched.removeEventListener("storage", onStorage);
      watched = undefined;
    }
  };
}

export function useGettingStartedHidden(): { hidden: boolean; hide: () => void; show: () => void } {
  const hidden = useSyncExternalStore(subscribe, readGettingStartedHidden, () => false);
  return { hidden, hide: hideGettingStarted, show: showGettingStarted };
}

function hideGettingStarted(): void {
  setGettingStartedHidden(true);
}

function showGettingStarted(): void {
  setGettingStartedHidden(false);
}
