import { useCallback, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { useT } from "../i18n/shared";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { invalidateClientResource } from "../client-resource";

/** Config `subagentModels`: the models pinned to the top of the client model pickers. */
export type SubagentRoster = { available: string[]; chosen: string[] };

export const FEATURED_MAX = 5;

export function subagentRosterCacheKey(apiBase: string): string {
  return `ocx.subagents.roster.v1:${apiBase}`;
}

/**
 * The pinned roster: loads it through the shared resource layer and autosaves every edit.
 * The Subagents page only reads it; the Models page client picker section edits it.
 */
export function useSubagentRoster(apiBase: string, onSaved?: () => void) {
  const t = useT();
  const cacheKey = subagentRosterCacheKey(apiBase);
  const cached = readSessionListCache<SubagentRoster>(cacheKey);
  const [chosen, setChosen] = useState<string[]>(() => cached?.chosen ?? []);
  const rosterRevision = useRef(0);
  const committed = useRef<SubagentRoster | null>(cached);
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  /** True for the whole autosave drain, so a roster refresh never lands between two writes. */
  const saveInFlight = useRef(false);
  /** The newest roster waiting behind the in-flight write; older queued lists are dropped. */
  const queuedRoster = useRef<string[] | null>(null);
  /** Mirrors `chosen` synchronously, so two clicks in one render both build on the latest list. */
  const latestChosen = useRef<string[]>(chosen);
  const setRoster = useCallback((next: string[]) => {
    latestChosen.current = next;
    setChosen(next);
  }, []);

  const loadRoster = useCallback(async (signal?: AbortSignal): Promise<SubagentRoster> => {
    const rosterReadRevision = rosterRevision.current;
    const rosterRes = await fetch(`${apiBase}/api/subagent-models`, { signal });
    const response = await readJsonOrThrow<{ available?: string[]; chosen?: string[] }>(rosterRes, t("sub.loadFail"));
    if (!response) throw new Error(t("sub.loadFail"));
    const available = response.available ?? [];
    const availableSet = new Set(available);
    const rosterCurrent = rosterReadRevision === rosterRevision.current && !saveInFlight.current;
    const next = {
      available,
      chosen: rosterCurrent ? (response.chosen ?? []).filter(model => availableSet.has(model)) : committed.current?.chosen ?? [],
    };
    if (signal?.aborted) throw signal.reason;
    committed.current = next;
    if (rosterCurrent) setRoster(next.chosen);
    writeSessionListCache(cacheKey, next);
    return next;
  }, [apiBase, cacheKey, setRoster, t]);

  // The shared resource owns mount loading and retries; the session seed keeps the roster
  // usable while the first live response is in flight.
  const resource = useDataSurface<SubagentRoster>(
    cacheKey,
    [apiBase],
    loadRoster,
    { isEmpty: () => false, initialData: cached ?? undefined },
  );
  const { state } = resource;
  const snapshot = state.data ?? cached;
  const available = snapshot?.available ?? [];

  // Writes are serialized: while one PUT is in flight only the newest edit waits, so rapid
  // clicks end on the last list the operator made.
  const persistRoster = async (models: string[]) => {
    queuedRoster.current = models;
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setStatus("");
    let failure: unknown = null;
    let applied = models;
    while (queuedRoster.current) {
      const sending = queuedRoster.current;
      queuedRoster.current = null;
      try {
        const r = await fetch(`${apiBase}/api/subagent-models`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ models: sending }),
        });
        const d = await readJsonOrThrow<{ applied?: string[] }>(r, t("sub.saveFailed"));
        applied = d?.applied ?? sending;
        // The server holds this list even if a newer edit is queued, so it is the restore point.
        committed.current = { available, chosen: applied };
        writeSessionListCache(cacheKey, committed.current);
        failure = null;
      } catch (error) {
        failure = error;
      }
    }
    rosterRevision.current += 1;
    saveInFlight.current = false;
    if (failure) {
      setRoster(committed.current?.chosen ?? []);
      setOk(false);
      setStatus(failure instanceof Error && failure.message ? failure.message : t("sub.networkError"));
      return;
    }
    setRoster(applied);
    // Another reader (Subagents, mounted mid-write) may hold the pre-save roster; reload them all.
    invalidateClientResource(cacheKey);
    onSaved?.();
    setOk(true);
    setStatus(t("sub.saved", { n: applied.length, cmd: "ocx sync" }));
  };

  const editRoster = (next: string[]) => {
    rosterRevision.current += 1;
    setRoster(next);
    void persistRoster(next);
  };
  const toggle = (m: string) => {
    const prev = latestChosen.current;
    if (!prev.includes(m) && prev.length >= FEATURED_MAX) return;
    editRoster(prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    const next = [...latestChosen.current];
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    editRoster(next);
  };

  return { state, snapshot, available, chosen, refresh: resource.refresh, toggle, move, status, ok };
}
