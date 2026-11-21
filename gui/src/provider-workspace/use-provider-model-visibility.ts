/**
 * Model on/off for the Providers page.
 *
 * Owned by ProviderWorkspaceShell, which holds the paired /api/selected-models + /api/models
 * read and stays mounted across provider and tab switches, so a provider switch never cancels
 * or forgets a write. Writes go through the same ordered queue as the Models page
 * (useModelVisibility); its re-read is the shell's own paired read: refresh() asks for a new
 * revision and settles when that revision is ready (true) or fails (false).
 *
 * The Providers surface accepts one write at a time: while the queue runs, every switch and
 * Delete/Add is disabled, so the queue never holds an accepted intent that was not yet sent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModelVisibility } from "../use-model-visibility";
import { clientCatalogRefreshFailures, type ClientCatalogRefreshFailure, type ProviderModelMap } from "../model-visibility";
import { collectDisabledNamespaced, type ModelRow } from "../pages/models-shared";
import { rowVisibilityTarget, savedRowVisible } from "../model-visibility-rows";

export interface ProviderModelVisibility {
  /** Final on/off for a row, optimistic draft first. */
  isOn(row: ModelRow): boolean;
  /** Queue the requested state for one row. Returns false when the write was not accepted. */
  toggle(row: ModelRow, enable: boolean): boolean;
  /** True from the click until the post-write re-read settles; synchronous. */
  isRunning(): boolean;
  /** Render-time mirror of isRunning(). */
  running: boolean;
  error: "models.saveFailed" | "models.networkError" | null;
  failures: ClientCatalogRefreshFailure[];
}

type Waiter = { from: string; resolve: (ok: boolean) => void };

/** Resolve and clear the pending revision waiter, if any. Module-level so callbacks close only over refs. */
function settleWaiter(waiter: { current: Waiter | null }, ok: boolean): void {
  const current = waiter.current;
  waiter.current = null;
  current?.resolve(ok);
}

export function useProviderModelVisibility(apiBase: string, source: {
  rows: ModelRow[] | null;
  selected: ProviderModelMap | null;
  revision: string;
  ready: boolean;
  failed: boolean;
  retry: () => void;
}): ProviderModelVisibility {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ProviderModelVisibility["error"]>(null);
  const [failures, setFailures] = useState<ClientCatalogRefreshFailure[]>([]);
  const waiter = useRef<Waiter | null>(null);
  const latest = useRef(source);
  useEffect(() => { latest.current = source; });

  // A newer revision that became ready (or failed) is the authoritative read after the write.
  useEffect(() => {
    const current = waiter.current;
    if (!current || source.revision === current.from) return;
    if (source.ready) settleWaiter(waiter, true);
    else if (source.failed) settleWaiter(waiter, false);
  }, [source.revision, source.ready, source.failed]);
  useEffect(() => () => settleWaiter(waiter, false), []);

  const refresh = useCallback((signal: AbortSignal) => new Promise<boolean>(resolve => {
    settleWaiter(waiter, false);
    const entry: Waiter = { from: latest.current.revision, resolve };
    waiter.current = entry;
    signal.addEventListener("abort", () => { if (waiter.current === entry) settleWaiter(waiter, false); }, { once: true });
    latest.current.retry();
  }), []);

  const visibility = useModelVisibility(apiBase, {
    onQueued: () => { setError(null); },
    onBusy: setRunning,
    onResponse: body => {
      const next = clientCatalogRefreshFailures(body);
      if (next !== undefined) setFailures(next);
    },
    refresh,
    onSettled: next => { setError(next); },
  });

  const disabled = useMemo(() => collectDisabledNamespaced(source.rows ?? []), [source.rows]);
  const selected = source.selected ?? {};
  return {
    isOn: row => visibility.visible(row.provider, row.id, row.native === true, savedRowVisible(selected, disabled, row)),
    toggle: (row, enable) => {
      if (visibility.isRunning()) return false;
      visibility.enqueue("models", row.provider, [rowVisibilityTarget(row)], enable);
      return true;
    },
    isRunning: visibility.isRunning,
    running: running || visibility.pending,
    error,
    failures,
  };
}

