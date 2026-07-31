import { useCallback, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { Notice } from "../ui";
import { useT } from "../i18n/shared";
import SubagentsWorkspace, { FEATURED_MAX } from "../components/subagents-workspace/SubagentsWorkspace";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton, DataSurfaceStatus } from "../components/data-surface";
import { useSubagentDelegation } from "./use-subagent-delegation";

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

  const loadSubagents = useCallback(async (): Promise<CachedSubagents> => {
    const res = await fetch(`${apiBase}/api/subagent-models`);
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
    { isEmpty: () => false },
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
      {state.refreshing && <DataSurfaceStatus live={!state.showError}>{t("sub.loading")}</DataSurfaceStatus>}
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
        }}
      />
    </>
  );
}
