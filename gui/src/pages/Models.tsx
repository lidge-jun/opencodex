import { useEffect, useMemo, useRef, useState } from "react";
import { Switch, Notice } from "../ui";
import { IconChevron, IconBoxes } from "../icons";
import { useT } from "../i18n";

interface ModelRow {
  provider: string;
  id: string;
  namespaced: string;
  disabled: boolean;
  contextWindow?: number;
  contextCap?: number;
  contextCapped?: boolean;
}

interface ProviderContextCapsResponse {
  cap?: number;
  caps?: Record<string, number>;
}

export default function Models({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [models, setModels] = useState<ModelRow[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [contextCaps, setContextCaps] = useState<Record<string, number>>({});
  const [contextCapValue, setContextCapValue] = useState(350_000);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const load = async () => {
    try {
      const [data, capsData] = await Promise.all([
        fetch(`${apiBase}/api/models`).then(r => r.json()) as Promise<ModelRow[]>,
        fetch(`${apiBase}/api/provider-context-caps`).then(r => r.json()) as Promise<ProviderContextCapsResponse>,
      ]);
      setModels(data);
      setDisabled(new Set(data.filter(m => m.disabled).map(m => m.namespaced)));
      if (typeof capsData.cap === "number" && Number.isFinite(capsData.cap) && capsData.cap > 0) setContextCapValue(capsData.cap);
      setContextCaps(capsData.caps ?? {});
    } catch {
      setOk(false); setStatus(t("models.loadFail"));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    // Provider models resolve lazily (live /models + OAuth tokens), so a provider that wasn't ready
    // on first load (e.g. anthropic right after login) would otherwise stay missing until a manual
    // remove/re-add. Re-poll to pick it up; skip while a toggle PUT is in flight to avoid clobbering.
    const timer = setInterval(() => { if (!busyRef.current) load(); }, 10000);
    return () => clearInterval(timer);
  }, [apiBase]);

  const groups = useMemo(() => {
    const g: Record<string, ModelRow[]> = {};
    for (const m of models) (g[m.provider] ??= []).push(m);
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [models]);

  const apply = async (next: Set<string>) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/disabled-models`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: [...next] }),
      });
      if (r.ok) { setDisabled(next); setOk(true); setStatus(t("models.applied")); }
      else { setOk(false); setStatus(t("models.saveFailed")); }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  const toggle = (ns: string) => {
    const next = new Set(disabled);
    if (next.has(ns)) next.delete(ns); else next.add(ns);
    apply(next);
  };
  const toggleProvider = (rows: ModelRow[], enable: boolean) => {
    const next = new Set(disabled);
    for (const m of rows) { if (enable) next.delete(m.namespaced); else next.add(m.namespaced); }
    apply(next);
  };
  const toggleProviderCap = async (provider: string) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    const enabled = contextCaps[provider] !== contextCapValue;
    try {
      const r = await fetch(`${apiBase}/api/provider-context-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, enabled }),
      });
      if (r.ok) {
        const data = (await r.json()) as ProviderContextCapsResponse;
        setContextCaps(data.caps ?? {});
        setOk(true);
        setStatus(t("models.capApplied"));
        await load();
      } else {
        setOk(false);
        setStatus(t("models.capSaveFailed"));
      }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };
  const toggleCollapse = (p: string) => {
    setCollapsed(prev => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  };

  if (loading) return <div className="row muted"><span className="spin" /> {t("models.loading")}</div>;


  return (
    <>
      <div className="page-head">
        <h2>{t("nav.models")}</h2>
        <span className="muted mono" style={{ fontSize: 12 }}>{t("models.active", { active: models.length - disabled.size, total: models.length })}</span>
      </div>
      <p className="page-sub">{t("models.subtitle")}</p>
      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

      {groups.map(([provider, rows]) => {
        const isCollapsed = collapsed.has(provider);
        const activeCount = rows.filter(m => !disabled.has(m.namespaced)).length;
        const capOn = contextCaps[provider] === contextCapValue;
        return (
          <div key={provider} className="card" style={{ marginBottom: 8, overflow: "hidden" }}>
            <div onClick={() => toggleCollapse(provider)}
              className="row" style={{ padding: "10px 12px", background: "var(--raised)", cursor: "pointer" }}>
              <IconChevron style={{ width: 14, height: 14, color: "var(--muted)", transform: isCollapsed ? "none" : "rotate(90deg)", transition: "transform .12s" }} />
              <span style={{ fontWeight: 600, fontSize: 14 }}>{provider}</span>
              <span className="muted mono" style={{ fontSize: 12 }}>{t("models.active", { active: activeCount, total: rows.length })}</span>
              <div style={{ flex: 1 }} />
              <div className="row" onClick={e => e.stopPropagation()} style={{ gap: 6 }}>
                <Switch on={capOn} onClick={() => toggleProviderCap(provider)} disabled={busy} label={t("models.cap350k")} />
                <span className="muted mono" style={{ fontSize: 12 }}>{t("models.cap350k")}</span>
              </div>
              <button onClick={e => { e.stopPropagation(); toggleProvider(rows, true); }} disabled={busy} className="btn btn-ghost btn-sm">{t("models.allOn")}</button>
              <button onClick={e => { e.stopPropagation(); toggleProvider(rows, false); }} disabled={busy} className="btn btn-ghost btn-sm">{t("models.allOff")}</button>
            </div>
            {!isCollapsed && (
              <div style={{ padding: "6px 12px" }}>
                {rows.map(m => {
                  const off = disabled.has(m.namespaced);
                  return (
                    <div key={m.namespaced} className="row" style={{ padding: "5px 0" }}>
                      <Switch on={!off} onClick={() => toggle(m.namespaced)} disabled={busy} label={m.id} />
                      <code className="mono" style={{ fontSize: 13, color: off ? "var(--faint)" : "var(--text)", textDecoration: off ? "line-through" : "none" }}>{m.id}</code>
                      {m.contextCapped && <span className="muted mono" style={{ fontSize: 11, padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 999 }}>{t("models.contextCapped")}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {groups.length === 0 && (
        <div className="empty">
          <IconBoxes />
          <div className="title">{t("models.noRouted")}</div>
          <div style={{ fontSize: 13 }}>{t("models.noRoutedHint")}</div>
        </div>
      )}
    </>
  );
}
