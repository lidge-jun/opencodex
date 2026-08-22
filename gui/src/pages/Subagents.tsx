import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { Notice } from "../ui";
import { useT } from "../i18n/shared";
import SubagentsWorkspace, { FEATURED_MAX } from "../components/subagents-workspace/SubagentsWorkspace";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { useSubagentDelegation, type UltraModePatch, type UltraModeState } from "./use-subagent-delegation";

type CachedSubagents = { available: string[]; chosen: string[] };

function seedSubagents(cacheKey: string): CachedSubagents | null {
  return readSessionListCache<CachedSubagents>(cacheKey);
}

export default function Subagents({ apiBase }: { apiBase: string }) {
  const t = useT();
  const cacheKey = `ocx.subagents.v1:${apiBase}`;
  const cached = seedSubagents(cacheKey);
  const [chosen, setChosen] = useState<string[]>(() => cached?.chosen ?? []);
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Sync guard: state-only `busy` can miss clicks before the disabled re-render commits. */
  const saveInFlight = useRef(false);
  const delegation = useSubagentDelegation(apiBase);
  const [ultraMode, setUltraMode] = useState<UltraModeState>({ enabled: false, hintText: null, multiAgentV2Enabled: false });
  const [ultraSaving, setUltraSaving] = useState(false);
  const [ultraLoadFailed, setUltraLoadFailed] = useState(false);
  const ultraLoadGeneration = useRef(0);
  const currentUltraApiBase = useRef(apiBase);
  useEffect(() => {
    currentUltraApiBase.current = apiBase;
    ultraLoadGeneration.current++;
  }, [apiBase]);

  // Shared loader for /api/v2 state (multi-agent v2 flag + mode hint). Initial-load
  // failures surface sub.ultraModeLoadFail; refresh failures are rethrown so
  // saveUltraMode can report them against the save action.
  const loadUltraMode = useCallback(async (signal?: AbortSignal) => {
    if (currentUltraApiBase.current !== apiBase) return false;
    const generation = ++ultraLoadGeneration.current;
    const res = await fetch(`${apiBase}/api/v2`, { signal });
    const data = await readJsonOrThrow<{
      enabled?: boolean;
      multiAgentMode?: "v1" | "default" | "v2";
      multiAgentModeHintText?: string | null;
    }>(res, t("sub.ultraModeLoadFail"));
    if (!data) return false;
    if (signal?.aborted || generation !== ultraLoadGeneration.current || currentUltraApiBase.current !== apiBase) return false;
    setUltraLoadFailed(false);
    setUltraMode({
      enabled: data.enabled ?? false,
      hintText: data.multiAgentModeHintText ?? null,
      // Ultra mode replaces Codex's effort-derived policy for every model. The
      // `default` surface still preserves upstream V1 pins (for example luna),
      // so only an explicitly forced V2 catalog is an effective surface here.
      multiAgentV2Enabled: data.enabled === true && data.multiAgentMode === "v2",
    });
    return true;
  }, [apiBase, t]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      await loadUltraMode(controller.signal);
    })().catch(() => {
      if (!controller.signal.aborted) {
        setOk(false);
        setUltraLoadFailed(true);
        setStatus(t("sub.ultraModeLoadFail"));
      }
    });
    return () => { controller.abort(); };
  }, [loadUltraMode, t]);

  const saveUltraMode = async (patch: UltraModePatch) => {
    if (ultraSaving) return;
    const requestApiBase = apiBase;
    setUltraSaving(true);
    setStatus("");
    try {
      const res = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      await readJsonOrThrow(res, t("sub.ultraModeSaveFail"));
      if (currentUltraApiBase.current !== requestApiBase || !await loadUltraMode()) return;
      setOk(true);
      setStatus(t("sub.ultraModeSaved"));
    } catch (error) {
      if (currentUltraApiBase.current !== requestApiBase) return;
      setOk(false);
      setStatus(error instanceof Error && error.message ? error.message : t("sub.networkError"));
    } finally {
      setUltraSaving(false);
    }
  };

  const retryUltraMode = useCallback(async () => {
    try {
      if (!await loadUltraMode()) return;
      // A successful retry replaces the failed initial load; do not leave the
      // page-level load error visible after the controls have recovered.
      setOk(false);
      setStatus(current => current === t("sub.ultraModeLoadFail") ? "" : current);
    } catch {
      setOk(false);
      setUltraLoadFailed(true);
      setStatus(t("sub.ultraModeLoadFail"));
    }
  }, [loadUltraMode, t]);

  const loadSubagents = useCallback(async (signal?: AbortSignal): Promise<CachedSubagents> => {
    // The resource layer's deadline abort must reach the wire — a signal dropped
    // here is a store that can only settle by race timeout.
    const res = await fetch(`${apiBase}/api/subagent-models`, { signal });
    const response = await readJsonOrThrow<{ available?: string[]; chosen?: string[] }>(res, t("sub.loadFail"));
    if (!response) throw new Error(t("sub.loadFail"));
    const available = response.available ?? [];
    const availableSet = new Set(available);
    const next = {
      available,
      chosen: (response.chosen ?? []).filter(model => availableSet.has(model)),
    };
    setChosen(next.chosen);
    writeSessionListCache(cacheKey, next);
    return next;
  }, [apiBase, cacheKey, t]);

  // The shared resource owns mount loading and retries; the session seed keeps this workspace
  // usable while the first live response is in flight.
  const resource = useDataSurface<CachedSubagents>(
    cacheKey,
    [apiBase],
    loadSubagents,
    { isEmpty: () => false, initialData: cached ?? undefined },
  );
  const { state } = resource;
  const load = resource.refresh;
  const snapshot = state.data ?? cached;
  const available = snapshot?.available ?? [];

  const toggle = (m: string) => {
    if (busy) return;
    setStatus("");
    setChosen(prev => prev.includes(m) ? prev.filter(x => x !== m) : (prev.length >= FEATURED_MAX ? prev : [...prev, m]));
  };
  const move = (i: number, dir: -1 | 1) => {
    if (busy) return;
    setChosen(prev => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const save = async () => {
    if (busy || saveInFlight.current) return;
    saveInFlight.current = true;
    setBusy(true);
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/subagent-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: chosen }),
      });
      const d = await readJsonOrThrow<{ applied?: string[] }>(r, t("sub.saveFailed"));
      const applied = d?.applied ?? chosen;
      if (d?.applied) setChosen(d.applied);
      writeSessionListCache(cacheKey, { available, chosen: applied });
      setOk(true);
      setStatus(t("sub.saved", { n: applied.length, cmd: "ocx sync" }));
    } catch (error) {
      setOk(false);
      setStatus(error instanceof Error && error.message ? error.message : t("sub.networkError"));
    } finally {
      saveInFlight.current = false;
      setBusy(false);
    }
  };

  // The skeleton owns the live region while this resource has no content yet.
  if (state.showSkeleton && !snapshot) {
    return <DataSurfaceSkeleton label={t("sub.loading")} rows={4} />;
  }

  if (state.kind === "failed-cold") {
    const reason = state.error instanceof Error ? state.error.message : t("sub.loadFail");
    return (
      <>
        <Notice tone="err">{reason}</Notice>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => load()}>{t("common.retry")}</button>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h2>{t("nav.subagents")}</h2>
      </div>
      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}
      {state.showError && <Notice tone="err">{t("sub.loadFail")}</Notice>}
      <SubagentsWorkspace
        available={available}
        chosen={chosen}
        busy={busy}
        onToggle={toggle}
        onMove={move}
        onSave={() => { void save(); }}
        delegation={{
          model: delegation.model,
          effort: delegation.effort,
          efforts: delegation.efforts,
          available: delegation.available,
          guidanceEnabled: delegation.guidanceEnabled,
          syncCodexDefaults: delegation.syncCodexDefaults,
          saving: delegation.saving,
          onSave: patch => { void delegation.save(patch); },
          ultraMode,
          ultraSaving,
          onUltraModeSave: patch => { void saveUltraMode(patch); },
          ultraLoadFailed,
          onUltraModeRetry: () => { void retryUltraMode(); },
        }}
      />
    </>
  );
}
