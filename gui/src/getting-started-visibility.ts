import { useSyncExternalStore } from "react";

/*
 * Whether Home shows its Getting started card. The choice belongs to the screen a person
 * reads, so it lives in this browser profile's localStorage (the desktop app's window has its
 * own) rather than in proxy config. Hiding is reversible from the Set up hub.
 *
 * One snapshot serves every reader: a write notifies this window's subscribers directly
 * (the storage event only reaches other windows), and the storage event reconciles those.
 * When storage refuses a read or a write, the last choice still holds for this visit.
 */
export const GETTING_STARTED_HIDDEN_KEY = "ocx-home-getting-started-hidden";

const listeners = new Set<() => void>();
let unsaved: { store: Storage | undefined; hidden: boolean } | undefined;
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
  // Scoped to the storage it failed on, so a fresh window starts from its own storage.
  if (unsaved && unsaved.store === store) return unsaved.hidden;
  try {
    return store?.getItem(GETTING_STARTED_HIDDEN_KEY) === "1";
  } catch {
    return false;
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
    unsaved = undefined;
  } catch {
    unsaved = { store, hidden };
  }
  notify();
}

function onStorage(event: StorageEvent): void {
  // A null key is clear(); anything else that is not ours leaves the card alone.
  if (event.key !== null && event.key !== GETTING_STARTED_HIDDEN_KEY) return;
  unsaved = undefined;
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
