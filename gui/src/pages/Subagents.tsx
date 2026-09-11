import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { Notice } from "../ui";
import { useT } from "../i18n/shared";
import SubagentsWorkspace, { FEATURED_MAX } from "../components/subagents-workspace/SubagentsWorkspace";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { useSubagentDelegation, type UltraModePatch, type UltraModeState } from "./use-subagent-delegation";

type CachedSubagents = { available: string[]; chosen: string[]; fallback?: string[]; pollMs?: number; fallbackAvailable?: string[] };

const UNLOADED_ULTRA_MODE: UltraModeState = {
  enabled: false, hintText: null, recommendation: null,
  multiAgentV2Enabled: false, multiAgentMode: "default",
};

function seedSubagents(cacheKey: string): CachedSubagents | null {
  return readSessionListCache<CachedSubagents>(cacheKey);
}

export default function Subagents({ apiBase }: { apiBase: string }) {
  const t = useT();
  const cacheKey = `ocx.subagents.v1:${apiBase}`;
  const cached = seedSubagents(cacheKey);
  const [chosen, setChosen] = useState<string[]>(() => cached?.chosen ?? []);
  const [fallback, setFallback] = useState<string[]>(() => cached?.fallback ?? []);
  const [fallbackPollMs, setFallbackPollMs] = useState(() => cached?.pollMs ?? 60000);
  const [fallbackBusy, setFallbackBusy] = useState(false);
  const [fallbackLoaded, setFallbackLoaded] = useState(() => Array.isArray(cached?.fallback) && Number.isInteger(cached?.pollMs));
  const [fallbackAvailable, setFallbackAvailable] = useState<string[] | undefined>(() => cached?.fallbackAvailable);
  const [fallbackError, setFallbackError] = useState("");
  const [fallbackLoading, setFallbackLoading] = useState(true);
  const fallbackLoadController = useRef<AbortController | null>(null);
  const fallbackSnapshot = useRef<Pick<CachedSubagents, "fallback" | "pollMs" | "fallbackAvailable">>({
    fallback: cached?.fallback, pollMs: cached?.pollMs, fallbackAvailable: cached?.fallbackAvailable,
  });
  const fallbackRevision = useRef(0);
  const rosterRevision = useRef(0);
  const fallbackSaveInFlight = useRef(false);
  const committed = useRef<CachedSubagents | null>(cached);
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Sync guard: state-only `busy` can miss clicks before the disabled re-render commits. */
  const saveInFlight = useRef(false);
  const delegation = useSubagentDelegation(apiBase);
  const [ultraState, setUltraState] = useState<{ apiBase: string; mode: UltraModeState } | null>(null);
  const ultraModeCurrent = ultraState?.apiBase === apiBase;
  const ultraMode = ultraModeCurrent ? ultraState.mode : UNLOADED_ULTRA_MODE;
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
      keepNativeChatGptOnV1?: boolean;
      multiAgentModeHintRecommendation?: { text?: unknown; revision?: unknown };
    }>(res, t("sub.ultraModeLoadFail"));
    if (!data) return false;
    if (signal?.aborted || generation !== ultraLoadGeneration.current || currentUltraApiBase.current !== apiBase) return false;
    setUltraLoadFailed(false);
    const rawRecommendation = data.multiAgentModeHintRecommendation;
    const recommendation = rawRecommendation
      && typeof rawRecommendation.text === "string"
      && rawRecommendation.text.trim().length > 0
      && typeof rawRecommendation.revision === "string"
      && rawRecommendation.revision.trim().length > 0
      ? { text: rawRecommendation.text, revision: rawRecommendation.revision }
      : null;
    setUltraState({ apiBase, mode: {
      enabled: data.enabled ?? false,
      loaded: true,
      keepNativeChatGptOnV1: data.keepNativeChatGptOnV1 === true,
      hintText: data.multiAgentModeHintText ?? null,
      recommendation,
      // Ultra mode replaces Codex's effort-derived policy for every model. The
      // `default` surface still preserves upstream V1 pins (for example luna),
      // so only an explicitly forced V2 catalog is an effective surface here.
      multiAgentV2Enabled: data.enabled === true && data.multiAgentMode === "v2",
      multiAgentMode: data.multiAgentMode ?? "default",
    } });
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
    if (ultraSaving || !ultraModeCurrent || currentUltraApiBase.current !== apiBase) return;
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

  const loadFallback = useCallback(async () => {
    fallbackLoadController.current?.abort();
    const controller = new AbortController();
    fallbackLoadController.current = controller;
    const { signal } = controller;
    const readRevision = fallbackRevision.current;
    try {
      const res = await fetch(`${apiBase}/api/subagent-model-fallback`, { signal });
      const data = await readJsonOrThrow<{ models?: unknown; pollMs?: unknown; available?: unknown }>(res);
      if (!data || !Array.isArray(data.models) || !data.models.every(model => typeof model === "string" && model.trim())
        || typeof data.pollMs !== "number" || !Number.isInteger(data.pollMs) || data.pollMs < 5000 || data.pollMs > 600000
        || !Array.isArray(data.available) || !data.available.every(model => typeof model === "string" && model.trim())) {
        throw new Error(t("sub.loadFail"));
      }
      if (signal.aborted || readRevision !== fallbackRevision.current || fallbackSaveInFlight.current) return;
      const next = { fallback: data.models, pollMs: data.pollMs, fallbackAvailable: data.available };
      fallbackSnapshot.current = next;
      setFallback(next.fallback);
      setFallbackPollMs(next.pollMs);
      setFallbackAvailable(next.fallbackAvailable);
      setFallbackLoaded(true);
      setFallbackError("");
      // An auxiliary success cannot seed a successful roster before its own read settles.
      if (committed.current) {
        committed.current = { ...committed.current, ...next };
        writeSessionListCache(cacheKey, committed.current);
      }
    } catch (error) {
      if (signal.aborted || readRevision !== fallbackRevision.current || fallbackSaveInFlight.current) return;
      setFallbackLoaded(false);
      setFallbackError(error instanceof Error && !(error instanceof SyntaxError) ? error.message : t("sub.loadFail"));
    } finally {
      if (!signal.aborted) setFallbackLoading(false);
    }
  }, [apiBase, cacheKey, t]);

  useEffect(() => {
    void (async () => { await loadFallback(); })();
    return () => { fallbackLoadController.current?.abort(); };
  }, [loadFallback]);

  const loadSubagents = useCallback(async (signal?: AbortSignal): Promise<CachedSubagents> => {
    // Auxiliary fallback discovery must neither reject nor delay the roster resource.
    const rosterReadRevision = rosterRevision.current;
    const rosterRes = await fetch(`${apiBase}/api/subagent-models`, { signal });
    const response = await readJsonOrThrow<{ available?: string[]; chosen?: string[] }>(rosterRes, t("sub.loadFail"));
    if (!response) throw new Error(t("sub.loadFail"));
    const available = response.available ?? [];
    const availableSet = new Set(available);
    const rosterCurrent = rosterReadRevision === rosterRevision.current && !saveInFlight.current;
    const next = {
      ...fallbackSnapshot.current,
      available,
      chosen: rosterCurrent ? (response.chosen ?? []).filter(model => availableSet.has(model)) : committed.current?.chosen ?? [],
    };
    if (signal?.aborted) throw signal.reason;
    committed.current = next;
    if (rosterCurrent) setChosen(next.chosen);
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
    rosterRevision.current += 1;
    setChosen(prev => prev.includes(m) ? prev.filter(x => x !== m) : (prev.length >= FEATURED_MAX ? prev : [...prev, m]));
  };
  const move = (i: number, dir: -1 | 1) => {
    if (busy) return;
    rosterRevision.current += 1;
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
    rosterRevision.current += 1;
    setBusy(true);
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/subagent-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: chosen }),
      });
      const d = await readJsonOrThrow<{ applied?: string[] }>(r, t("sub.saveFailed"));
      rosterRevision.current += 1;
      const applied = d?.applied ?? chosen;
      if (d?.applied) setChosen(d.applied);
      // A legacy roster-only seed does not prove that an empty fallback was loaded.
      const next = { ...committed.current, available, chosen: applied };
      committed.current = next;
      writeSessionListCache(cacheKey, next);
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

  const saveFallback = async () => {
    if (!fallbackLoaded || fallbackSaveInFlight.current || !Number.isInteger(fallbackPollMs) || fallbackPollMs < 5000 || fallbackPollMs > 600000) return;
    fallbackSaveInFlight.current = true;
    fallbackRevision.current += 1;
    const requestApiBase = apiBase;
    setFallbackBusy(true);
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/subagent-model-fallback`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: fallback, pollMs: fallbackPollMs }),
      });
      const d = await readJsonOrThrow<{ models?: string[]; pollMs?: number }>(r, t("sub.fallbackSaveFailed"));
      if (currentUltraApiBase.current !== requestApiBase) return;
      if (!d || !Array.isArray(d.models) || typeof d.pollMs !== "number") throw new Error(t("sub.fallbackSaveFailed"));
      fallbackRevision.current += 1;
      setFallback(d.models);
      setFallbackPollMs(d.pollMs);
      fallbackSnapshot.current = { ...fallbackSnapshot.current, fallback: d.models, pollMs: d.pollMs };
      const next = { available, chosen: committed.current?.chosen ?? [], ...fallbackSnapshot.current };
      committed.current = next;
      writeSessionListCache(cacheKey, next);
      setOk(true);
      setStatus(t("sub.fallbackSaved"));
    } catch (error) {
      setOk(false);
      setStatus(error instanceof Error && error.message ? error.message : t("sub.networkError"));
    } finally {
      fallbackSaveInFlight.current = false;
      setFallbackBusy(false);
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
      {fallbackError && (
        <Notice tone="err">
          {t("sub.fallbackLabel")}: {t("sub.loadFail")}
          {fallbackError !== t("sub.loadFail") && <> {fallbackError}</>}
          <button type="button" className="btn btn-ghost btn-sm" disabled={fallbackLoading} onClick={() => { setFallbackLoading(true); void loadFallback(); }}>{t("common.retry")}</button>
        </Notice>
      )}
      <SubagentsWorkspace
        available={available}
        fallbackAvailable={fallbackAvailable ?? []}
        chosen={chosen}
        busy={busy}
        onToggle={toggle}
        onMove={move}
          onSave={() => { void save(); }}
          fallback={fallback}
          fallbackPollMs={fallbackPollMs}
          fallbackBusy={fallbackBusy || !fallbackLoaded}
          onFallbackChange={models => { fallbackRevision.current += 1; setFallback(models); }}
          onFallbackPollMsChange={pollMs => { fallbackRevision.current += 1; setFallbackPollMs(pollMs); }}
          onFallbackSave={() => { void saveFallback(); }}
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
          ultraSaving: ultraSaving || !ultraModeCurrent,
          onUltraModeSave: patch => { void saveUltraMode(patch); },
          ultraLoadFailed,
          onUltraModeRetry: () => { void retryUltraMode(); },
        }}
      />
    </>
  );
}
