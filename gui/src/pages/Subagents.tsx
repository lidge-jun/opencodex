import { useCallback, useEffect, useMemo, useState } from "react";
import { Notice, EmptyState } from "../ui";
import { IconArrowUp, IconArrowDown, IconX, IconCheck, IconSearch, IconBot, IconInfo } from "../icons";
import { useT, Trans } from "../i18n";
import { modelLabel } from "../model-display";

export default function Subagents({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [available, setAvailable] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/api/subagent-models`).then(res => res.json());
      const avail: string[] = r.available ?? [];
      setAvailable(avail);
      setChosen((r.chosen ?? []).filter((m: string) => avail.includes(m)));
    } catch {
      setOk(false);
      setStatus(t("sub.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const toggle = (m: string) => {
    setStatus("");
    setChosen(prev => prev.includes(m) ? prev.filter(x => x !== m) : (prev.length >= 5 ? prev : [...prev, m]));
  };
  const move = (i: number, dir: -1 | 1) => {
    setChosen(prev => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const save = async () => {
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/subagent-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: chosen }),
      });
      const d = await r.json();
      setOk(r.ok);
      setStatus(r.ok
        ? t("sub.saved", { n: d.applied?.length ?? 0, cmd: "ocx sync" })
        : (d.error || t("sub.saveFailed")));
    } catch {
      setOk(false);
      setStatus(t("sub.networkError"));
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return available.filter(m => !q || m.toLowerCase().includes(q));
  }, [available, query]);

  if (loading) return <div className="muted" style={{ padding: 8 }}>{t("sub.loading")}</div>;

  return (
    <>
      <div className="page-head"><h2>{t("nav.subagents")}</h2></div>
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
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t("sub.moveUp", { m })}>
                <IconArrowUp />
              </button>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => move(i, 1)} disabled={i === chosen.length - 1} aria-label={t("sub.moveDown", { m })}>
                <IconArrowDown />
              </button>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => toggle(m)} aria-label={t("sub.removeAria", { m })} style={{ color: "var(--red)" }}>
                <IconX />
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <button className="btn btn-primary" onClick={save}>{t("common.save")}</button>
      </div>

      <div className="h-section">{t("sub.models")} <span className="count">{filtered.length}</span></div>
      <div style={{ position: "relative", marginBottom: 10 }}>
        <IconSearch style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", width: 15, height: 15, color: "var(--faint)", pointerEvents: "none" }} />
        <input
          className="input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("sub.search")}
          style={{ paddingLeft: 34 }}
        />
      </div>
      <div className="stack" style={{ gap: 6, maxHeight: 360, overflowY: "auto" }}>
        {filtered.map(m => {
          const sel = chosen.includes(m);
          const full = !sel && chosen.length >= 5;
          return (
            <button
              key={m}
              className="card row"
              onClick={() => toggle(m)}
              disabled={full}
              aria-pressed={sel}
              style={{
                padding: "9px 12px", gap: 10, width: "100%", textAlign: "left", cursor: full ? "not-allowed" : "pointer",
                opacity: full ? 0.45 : 1,
                background: sel ? "var(--accent-soft)" : undefined,
                borderColor: sel ? "var(--accent-ring)" : undefined,
              }}
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
