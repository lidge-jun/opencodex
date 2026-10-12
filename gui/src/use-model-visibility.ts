import { useLayoutEffect, useRef, useState } from "react";
import { createBoundedFetch } from "./bounded-fetch";
import { putModelVisibility, type ModelVisibilityScope, type ModelVisibilityTarget } from "./model-visibility";

type Mutation = { scope: ModelVisibilityScope; provider: string; targets: ModelVisibilityTarget[]; enabled: boolean };
type ErrorKey = "models.saveFailed" | "models.networkError";
type Options = {
  onQueued(): void;
  onBusy(busy: boolean): void;
  onResponse(body: unknown): void;
  refresh(signal: AbortSignal): Promise<boolean>;
  onSettled(error: ErrorKey | null): void;
};

const key = (provider: string, id: string, native: boolean) => JSON.stringify([provider, id, native]);
const emptyOverrides: ReadonlyMap<string, boolean> = new Map();

/** Immediate row feedback, ordered writes, and one authoritative read when the queue drains. */
export function useModelVisibility(apiBase: string, options: Options) {
  const [draft, setDraft] = useState<{ apiBase: string; overrides: ReadonlyMap<string, boolean>; pending: boolean }>({
    apiBase, overrides: emptyOverrides, pending: false,
  });
  if (draft.apiBase !== apiBase) setDraft({ apiBase, overrides: emptyOverrides, pending: false });
  // A new target never displays another server's optimistic draft, without an effect reset.
  const overrides = draft.apiBase === apiBase ? draft.overrides : emptyOverrides;
  const pending = draft.apiBase === apiBase && draft.pending;
  const callbacks = useRef(options);
  useLayoutEffect(() => { callbacks.current = options; });
  const flight = useRef<{
    active: boolean; running: boolean; queue: Mutation[]; readVersion: number;
    bounded: ReturnType<typeof createBoundedFetch> | null;
  } | null>(null);

  useLayoutEffect(() => {
    const current = { active: true, running: false, queue: [] as Mutation[], readVersion: 0, bounded: null as ReturnType<typeof createBoundedFetch> | null };
    flight.current = current;
    callbacks.current.onBusy(false);
    return () => {
      current.active = false;
      current.queue.length = 0;
      current.bounded?.controller.abort();
      current.bounded?.clear();
    };
  }, [apiBase]);

  const drain = async (current: NonNullable<typeof flight.current>) => {
    let error: ErrorKey | null = null;
    while (current.active) {
      while (current.active && current.queue.length > 0) {
        const mutation = current.queue.shift()!;
        const bounded = createBoundedFetch(60_000);
        current.bounded = bounded;
        try {
          const response = await putModelVisibility(apiBase, mutation.scope, mutation.provider,
            mutation.targets, mutation.enabled, fetch, bounded.signal);
          // Target changes during the write must discard its response before parsing it.
          if (current.active) {
            if (!response.ok) error = "models.saveFailed";
            else {
              // Integration refresh details are optional; a successful empty/legacy response
              // still reconciles visibility through the authoritative catalog read below.
              const body: unknown = await response.json().catch(() => undefined);
              if (current.active) callbacks.current.onResponse(body);
            }
          }
        } catch {
          if (!current.active) return;
          error = "models.networkError";
        } finally {
          bounded.clear();
          current.bounded = null;
        }
      }
      if (!current.active) return;
      const readVersion = current.readVersion;
      let refreshed = false;
      const bounded = createBoundedFetch(60_000);
      current.bounded = bounded;
      try { refreshed = await callbacks.current.refresh(bounded.signal); } catch { /* reconcile failure is surfaced below */ }
      finally { bounded.clear(); current.bounded = null; }
      if (!current.active) return;
      // A click during the read invalidates it and keeps the newer optimistic intent visible.
      if (current.queue.length || readVersion !== current.readVersion) continue;
      current.running = false;
      setDraft({ apiBase, overrides: emptyOverrides, pending: false });
      callbacks.current.onBusy(false);
      callbacks.current.onSettled(error ?? (refreshed ? null : "models.networkError"));
      return;
    }
  };

  const enqueue = (scope: ModelVisibilityScope, provider: string, targets: ModelVisibilityTarget[], enabled: boolean) => {
    const current = flight.current;
    if (!current?.active) return;
    current.queue.push({ scope, provider, targets, enabled });
    current.readVersion++;
    callbacks.current.onQueued();
    setDraft(previous => {
      const next = new Map(previous.apiBase === apiBase ? previous.overrides : emptyOverrides);
      for (const target of targets) next.set(key(provider, target.id, target.native === true), enabled);
      return { apiBase, overrides: next, pending: true };
    });
    if (!current.running) {
      current.running = true;
      callbacks.current.onBusy(true);
      void drain(current);
    }
  };

  return { pending, overrides, enqueue, isRunning: () => flight.current?.running === true,
    visible: (provider: string, id: string, native: boolean, saved: boolean) => overrides.get(key(provider, id, native)) ?? saved,
  };
}
