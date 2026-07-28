import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import { Notice, EmptyState } from "../ui";
import { IconArrowUp, IconArrowDown, IconX, IconCheck, IconSearch, IconBot, IconInfo } from "../icons";
import { useT } from "../i18n/shared";
import { Trans } from "../i18n/provider";
import { modelLabel } from "../model-display";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";

type CachedSubagents = { available: string[]; chosen: string[] };

export default function Subagents({ apiBase }: { apiBase: string }) {
  const t = useT();
  const cacheKey = `ocx.subagents.v1:${apiBase}`;
  const cached = readSessionListCache<CachedSubagents>(cacheKey);
  const [available, setAvailable] = useState<string[]>(() => cached?.available ?? []);
  const [chosen, setChosen] = useState<string[]>(() => cached?.chosen ?? []);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(() => !cached);
  const [busy, setBusy] = useState(false);
  /** Sync guard: state-only `busy` can miss clicks before the disabled re-render commits. */
  const saveInFlight = useRef(false);
  const hasCacheRef = useRef(Boolean(cached));

  const chosenSet = useMemo(() => new Set(chosen), [chosen]);

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
    setChosen(prev => prev.includes(m) ? prev.filter(x => x !== m) : (prev.length >= 5 ? prev : [...prev, m]));
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
      if (d?.applied) setChosen(d.applied);
      setOk(true);
      setStatus(t("sub.saved", { n: d?.applied?.length ?? 0, cmd: "ocx sync" }));
    } catch (error) {
      setOk(false);
      setStatus(error instanceof Error && error.message ? error.message : t("sub.networkError"));
    } finally {
      saveInFlight.current = false;
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return available.filter(m => !q || m.toLowerCase().includes(q));
  }, [available, query]);

  if (loading) return <div className="muted" style={{ padding: 8 }}>{t("sub.loading")}</div>;

  return (
    <>
      <div className="page-head">
        <h2>{t("nav.subagents")}</h2>
      </div>
      <p className="page-sub"><Trans k="sub.subtitle" cmd="spawn_agent" /></p>

      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

      <div className="h-section">{t("sub.featured")} <span className="count">{chosen.length}/5</span></div>
      <div className="row muted text-label leading-body" style={{ alignItems: "flex-start", gap: 8, margin: "-2px 0 10px", maxWidth: "80ch" }}>
        <IconInfo width={15} height={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
        <span><Trans k="sub.orderHint" cmd="spawn_agent" /></span>
      </div>
      {chosen.length === 0 ? (
        <EmptyState title={t("sub.noneSelected")} />
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {chosen.map((m, i) => (
            <div key={m} className="card panel-accent row" style={{ padding: "8px 12px", gap: 10 }}>
              <span className="mono font-bold" style={{ width: 18, color: "var(--accent)" }}>{i + 1}</span>
              <code className="mono" style={{ flex: 1, color: "var(--text)" }}>{modelLabel(m)}</code>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => move(i, -1)} disabled={busy || i === 0} aria-label={t("sub.moveUp", { m })}>
                <IconArrowUp />
              </button>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => move(i, 1)} disabled={busy || i === chosen.length - 1} aria-label={t("sub.moveDown", { m })}>
                <IconArrowDown />
              </button>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => toggle(m)} disabled={busy} aria-label={t("sub.removeAria", { m })} style={{ color: "var(--red)" }}>
                <IconX />
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>{t("common.save")}</button>
      </div>

      <div className="h-section">{t("sub.models")} <span className="count">{filtered.length}</span></div>
      <div className="row" style={{ marginBottom: 10, gap: 8 }}>
        <IconSearch width={15} height={15} aria-hidden="true" style={{ color: "var(--faint)", flexShrink: 0 }} />
        <input
          className="input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("sub.search")}
          aria-label={t("sub.search")}
          style={{ flex: 1 }}
        />
      </div>
      <div className="stack" style={{ gap: 6, maxHeight: 360, overflowY: "auto" }}>
        {filtered.map(m => {
          const sel = chosenSet.has(m);
          const full = !sel && chosen.length >= 5;
          return (
            <button
              key={m}
              type="button"
              className={`card row${sel ? " panel-accent" : ""}`}
              onClick={() => toggle(m)}
              disabled={busy || full}
              aria-pressed={sel}
              style={{ width: "100%", opacity: full || busy ? 0.45 : 1, cursor: full || busy ? "not-allowed" : "pointer" }}
            >
              <span style={{ width: 16, height: 16, flexShrink: 0, color: "var(--accent)", display: "inline-flex" }}>
                {sel && <IconCheck style={{ width: 16, height: 16 }} />}
              </span>
              <IconBot style={{ width: 15, height: 15, color: "var(--faint)", flexShrink: 0 }} />
              <code className="mono" style={{ color: "var(--text)" }}>{modelLabel(m)}</code>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <EmptyState title={t("sub.noModels")} />
        )}
      </div>
    </>
  );
}
