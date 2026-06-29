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
  value?: number;
  caps?: Record<string, number>;
}

const CAP_OPTIONS = Array.from({ length: 18 }, (_, i) => 100_000 + i * 50_000); // 100k … 950k
const CUSTOM_OPTION = "custom";

function fmtK(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return String(n);
  return n % 1000 === 0 ? `${n / 1000}k` : n.toLocaleString();
}

export default function Models({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [models, setModels] = useState<ModelRow[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [contextCaps, setContextCaps] = useState<Record<string, number>>({});
  const [contextCapValue, setContextCapValue] = useState(350_000);
  const [customCap, setCustomCap] = useState("");
  const [showCustom, setShowCustom] = useState(false);
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
      const value = typeof capsData.value === "number" && Number.isFinite(capsData.value) && capsData.value > 0
        ? capsData.value
        : (typeof capsData.cap === "number" && Number.isFinite(capsData.cap) && capsData.cap > 0 ? capsData.cap : undefined);
      if (value !== undefined) setContextCapValue(value);
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

  const putCap = async (body: Record<string, unknown>) => {
    setBusy(true);
    busyRef.current = true;
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/provider-context-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const data = (await r.json()) as ProviderContextCapsResponse;
        if (typeof data.value === "number" && Number.isFinite(data.value) && data.value > 0) setContextCapValue(data.value);
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

  const setGlobalCap = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return;
    void putCap({ value: Math.floor(value) });
  };

  const onSelectCap = (raw: string) => {
    if (raw === CUSTOM_OPTION) { setShowCustom(true); setCustomCap(String(contextCapValue)); return; }
    setShowCustom(false);
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0 && value !== contextCapValue) setGlobalCap(value);
  };

  const applyCustomCap = () => {
    const value = Number(customCap.replace(/[_,\s]/g, ""));
    if (!Number.isFinite(value) || value <= 0) { setOk(false); setStatus(t("models.capSaveFailed")); return; }
    setShowCustom(false);
    setGlobalCap(value);
  };

  const allCapped = useMemo(
    () => models.length > 0 && groups.every(([provider]) => contextCaps[provider] === contextCapValue),
    [groups, contextCaps, contextCapValue, models.length],
  );
  const setAll = () => { void putCap({ setAll: !allCapped }); };

  if (loading) return <div className="row muted"><span className="spin" /> {t("models.loading")}</div>;


  return (
    <>
      <div className="page-head">
        <h2>{t("nav.models")}</h2>
        <span className="muted mono" style={{ fontSize: 12 }}>{t("models.active", { active: models.length - disabled.size, total: models.length })}</span>
      </div>
      <p className="page-sub">{t("models.subtitle")}</p>
      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

      <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 13 }}>{t("models.contextCapLabel")}</span>
        <select
          className="select-sm"
          value={showCustom ? CUSTOM_OPTION : (CAP_OPTIONS.includes(contextCapValue) ? String(contextCapValue) : CUSTOM_OPTION)}
          onChange={e => onSelectCap(e.target.value)}
          disabled={busy}
        >
          {!CAP_OPTIONS.includes(contextCapValue) && !showCustom && (
            <option value={String(contextCapValue)}>{fmtK(contextCapValue)}</option>
          )}
          {CAP_OPTIONS.map(v => <option key={v} value={String(v)}>{fmtK(v)}</option>)}
          <option value={CUSTOM_OPTION}>{t("models.custom")}</option>
        </select>
        {showCustom && (
          <>
            <input
              className="input"
              style={{ width: 160 }}
              inputMode="numeric"
              placeholder={t("models.customPlaceholder")}
              value={customCap}
              onChange={e => setCustomCap(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") applyCustomCap(); }}
              disabled={busy}
            />
            <button onClick={applyCustomCap} disabled={busy} className="btn btn-ghost btn-sm">{t("models.customApply")}</button>
          </>
        )}
        <div style={{ flex: 1 }} />
        <Switch on={allCapped} onClick={setAll} disabled={busy} label={t("models.setAll")} />
        <span className="muted mono" style={{ fontSize: 12 }}>{t("models.setAll")}</span>
      </div>

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
                <Switch on={capOn} onClick={() => toggleProviderCap(provider)} disabled={busy} label={t("models.capValue", { value: fmtK(contextCapValue) })} />
                <span className="muted mono" style={{ fontSize: 12 }}>{t("models.capValue", { value: fmtK(contextCapValue) })}</span>
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
                      {m.contextCapped && <span className="muted mono" style={{ fontSize: 11, padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 999 }}>{t("models.contextCappedValue", { value: fmtK(m.contextCap ?? contextCapValue) })}</span>}
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
