import { useCallback, useEffect, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { Notice } from "../ui";
import { useT } from "../i18n/shared";
import SubagentsWorkspace, { FEATURED_MAX } from "../components/subagents-workspace/SubagentsWorkspace";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";

type CachedSubagents = { available: string[]; chosen: string[] };

function seedSubagents(cacheKey: string): CachedSubagents | null {
  return readSessionListCache<CachedSubagents>(cacheKey);
}

export default function Subagents({ apiBase }: { apiBase: string }) {
  const t = useT();
  const cacheKey = `ocx.subagents.v1:${apiBase}`;
  const [available, setAvailable] = useState<string[]>(() => seedSubagents(cacheKey)?.available ?? []);
  const [chosen, setChosen] = useState<string[]>(() => seedSubagents(cacheKey)?.chosen ?? []);
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(() => !seedSubagents(cacheKey));
  const [busy, setBusy] = useState(false);
  /** Sync guard: state-only `busy` can miss clicks before the disabled re-render commits. */
  const saveInFlight = useRef(false);
  const hasCacheRef = useRef(Boolean(seedSubagents(cacheKey)));

  const load = useCallback(async () => {
    if (!hasCacheRef.current) setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/subagent-models`);
      const r = await readJsonOrThrow<{ available?: string[]; chosen?: string[] }>(res, t("sub.loadFail"));
      if (!r) throw new Error(t("sub.loadFail"));
      const avail: string[] = r.available ?? [];
      const availSet = new Set(avail);
      const nextChosen = (r.chosen ?? []).filter((m: string) => availSet.has(m));
      setAvailable(avail);
      setChosen(nextChosen);
      hasCacheRef.current = true;
      writeSessionListCache(cacheKey, { available: avail, chosen: nextChosen });
    } catch {
      if (!hasCacheRef.current) {
        setOk(false);
        setStatus(t("sub.loadFail"));
      }
    } finally {
      setLoading(false);
    }
  }, [apiBase, cacheKey, t]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

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

  if (loading) return <div className="muted" style={{ padding: 8 }}>{t("sub.loading")}</div>;

  return (
    <>
      <div className="page-head">
        <h2>{t("nav.subagents")}</h2>
      </div>
      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}
      <SubagentsWorkspace
        available={available}
        chosen={chosen}
        busy={busy}
        onToggle={toggle}
        onMove={move}
        onSave={() => { void save(); }}
      />
    </>
  );
}
