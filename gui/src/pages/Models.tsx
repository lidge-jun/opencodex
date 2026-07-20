import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Switch, Notice, EmptyState, Select } from "../ui";
import { IconChevron, IconBoxes, IconInfo } from "../icons";
import { useT } from "../i18n/shared";
import type { TFn, TKey } from "../i18n/shared";
import { modelLabel } from "../model-display";

interface ModelRow {
  provider: string;
  id: string;
  namespaced: string;
  disabled: boolean;
  native?: boolean;
  contextWindow?: number;
  contextCap?: number;
  contextCapped?: boolean;
}

interface ProviderContextCapsResponse {
  cap?: number;
  value?: number;
  caps?: Record<string, number>;
}

interface V2Status {
  enabled: boolean;
  agentsMaxThreadsConflict: boolean;
  maxConcurrentThreadsPerSession?: number | null;
  multiAgentMode?: "v1" | "default" | "v2";
}

interface ShadowCallData {
  enabled: boolean;
  model: string;
}

const CAP_OPTIONS = Array.from({ length: 18 }, (_, i) => 100_000 + i * 50_000); // 100k … 950k
const CAP_OPTION_SET = new Set(CAP_OPTIONS);
const CUSTOM_OPTION = "custom";
const THREAD_OPTIONS = [4, 8, 16, 32, 64, 128, 256, 500, 1000];
const THREAD_OPTION_SET = new Set(THREAD_OPTIONS);
const PAGE = 60; // rows rendered per provider before a "show more" (keeps 1000s-of-models providers usable)

/** Compact token display (350k) — unit is technical, not prose. */
function fmtK(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return String(n);
  return n % 1000 === 0 ? `${n / 1000}k` : n.toLocaleString();
}

function collectDisabledNamespaced(rows: ModelRow[]): Set<string> {
  const next = new Set<string>();
  for (const m of rows) {
    if (m.disabled) next.add(m.namespaced);
  }
  return next;
}

function activeModelOptions(models: ModelRow[], disabled: Set<string>): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (const m of models) {
    if (!disabled.has(m.id) && !disabled.has(m.namespaced)) {
      options.push({ value: m.namespaced, label: m.namespaced });
    }
  }
  return options;
}

export default function Models({ apiBase }: { apiBase: string }) {
  const t: TFn = useT();
  const [models, setModels] = useState<ModelRow[]>([]);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState<Record<string, number>>({});
  const [contextCaps, setContextCaps] = useState<Record<string, number>>({});
  const [contextCapValue, setContextCapValue] = useState(350_000);
  const [customCap, setCustomCap] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("ocx-models-collapsed");
      return saved ? new Set(JSON.parse(saved) as string[]) : new Set();
    } catch { return new Set(); }
  });
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // multi_agent_v2 / ultra gate. null = endpoint unavailable (older proxy build) -> section hidden.
  const [v2, setV2] = useState<V2Status | null>(null);
  const [v2Busy, setV2Busy] = useState(false);
  const [v2Note, setV2Note] = useState("");
  const v2BusyRef = useRef(false);
  const [threadsCustom, setThreadsCustom] = useState("");
  const [showThreadsCustom, setShowThreadsCustom] = useState(false);
  const [v2HelpOpen, setV2HelpOpen] = useState(false);
  const [shadowCall, setShadowCall] = useState<ShadowCallData | null>(null);
  const [shadowCallSaving, setShadowCallSaving] = useState(false);

  const shadowModelOptions = useMemo(
    () => activeModelOptions(models, disabled),
    [models, disabled],
  );

  const loadShadowCall = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/api/shadow-call-settings`);
      if (r.ok) setShadowCall(await r.json() as ShadowCallData);
    } catch { /* old server / network: keep the section disabled */ }
  }, [apiBase]);

  const loadV2 = useCallback(async () => {
    // Never let a toggle in flight be clobbered by the poll (same single-flight rule as models).
    if (v2BusyRef.current) return;
    try {
      const r = await fetch(`${apiBase}/api/v2`);
      if (!r.ok || !(r.headers.get("content-type") ?? "").includes("application/json")) { setV2(null); return; }
      const data = await r.json() as V2Status;
      if (typeof data.enabled === "boolean") {
        setV2({
          enabled: data.enabled,
          agentsMaxThreadsConflict: data.agentsMaxThreadsConflict === true,
          maxConcurrentThreadsPerSession: typeof data.maxConcurrentThreadsPerSession === "number" ? data.maxConcurrentThreadsPerSession : null,
          multiAgentMode: data.multiAgentMode === "v1" || data.multiAgentMode === "v2" ? data.multiAgentMode : "default",
        });
      }
    } catch {
      setV2(null); // old server / network: hide the section instead of guessing
    }
  }, [apiBase]);

  const load = useCallback(async () => {
    try {
      const [data, capsData] = await Promise.all([
        fetch(`${apiBase}/api/models`).then(r => r.json()) as Promise<ModelRow[]>,
        fetch(`${apiBase}/api/provider-context-caps`).then(r => r.json()) as Promise<ProviderContextCapsResponse>,
      ]);
      void loadV2(); // best-effort, independent of the models fetch
      void loadShadowCall();
      setModels(data);
      setDisabled(collectDisabledNamespaced(data));
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
  }, [apiBase, loadShadowCall, loadV2, t]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    // Provider models resolve lazily (live /models + OAuth tokens), so a provider that wasn't ready
    // on first load (e.g. anthropic right after login) would otherwise stay missing until a manual
    // remove/re-add. Re-poll to pick it up; skip while a toggle PUT is in flight to avoid clobbering.
    const timer = window.setInterval(() => {
      if (!busyRef.current) {
        void load();
      }
    }, 10000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(timer);
    };
  }, [load]);

  const groups = useMemo(() => {
    const g: Record<string, ModelRow[]> = {};
    for (const m of models) (g[m.provider] ??= []).push(m);
    // The single native `openai` group pins first. Its credential policy comes from
    // the Providers-page Pool/Direct option and never changes model identity here.
    return Object.entries(g).sort(([a, rowsA], [b, rowsB]) => {
      const nativeA = rowsA.every(r => r.native);
      const nativeB = rowsB.every(r => r.native);
      if (nativeA !== nativeB) return nativeA ? -1 : 1;
      return a.localeCompare(b);
    });
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
    setCollapsed(prev => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p); else n.add(p);
      try { localStorage.setItem("ocx-models-collapsed", JSON.stringify([...n])); } catch { /* quota */ }
      return n;
    });
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
    () => {
      // Cap aggregate counts routed providers only; the single native group has no cap switch.
      const routed = groups.filter(([, rows]) => !rows.every(r => r.native));
      return routed.length > 0 && routed.every(([provider]) => contextCaps[provider] === contextCapValue);
    },
    [groups, contextCaps, contextCapValue],
  );
  const setAll = () => { void putCap({ setAll: !allCapped }); };

  const saveShadowCall = async (patch: Partial<ShadowCallData>) => {
    if (!shadowCall || shadowCallSaving) return;
    setShadowCallSaving(true);
    setShadowCall({ ...shadowCall, ...patch });
    try {
      await fetch(`${apiBase}/api/shadow-call-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } finally {
      setShadowCallSaving(false);
    }
  };

  const setMultiAgentMode = async (mode: "v1" | "default" | "v2") => {
    if (!v2 || v2BusyRef.current) return;
    if (v2.multiAgentMode === mode) return;
    setV2Busy(true);
    v2BusyRef.current = true;
    setV2Note("");
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ multiAgentMode: mode }),
      });
      const data = await r.json().catch(() => null) as V2Status & { warnings?: string[]; error?: string } | null;
      if (r.ok && data) {
        void loadV2();
        setOk(true);
        setStatus(t("models.v2Applied"));
        setV2Note((data.warnings ?? []).join(" "));
      } else {
        setOk(false);
        setStatus(data?.error ?? t("models.saveFailed"));
      }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setV2Busy(false);
      v2BusyRef.current = false;
    }
  };

  const putV2Threads = async (value: number) => {
    // Same guards as the flag toggle: single-flight + server-side idempotence
    // (setMaxConcurrentThreads no-ops on equal value), so a re-selected current
    // value or a double click can never double-write config.toml.
    if (!v2 || v2BusyRef.current) return;
    if (!Number.isInteger(value) || value < 1) { setOk(false); setStatus(t("models.v2ThreadsInvalid")); return; }
    if (v2.maxConcurrentThreadsPerSession === value) return;
    setV2Busy(true);
    v2BusyRef.current = true;
    setV2Note("");
    setStatus("");
    try {
      const r = await fetch(`${apiBase}/api/v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrentThreadsPerSession: value }),
      });
      const data = await r.json().catch(() => null) as V2Status & { warnings?: string[]; error?: string } | null;
      if (r.ok && data && typeof data.enabled === "boolean") {
      setV2({
          enabled: data.enabled,
          agentsMaxThreadsConflict: data.agentsMaxThreadsConflict === true,
          maxConcurrentThreadsPerSession: typeof data.maxConcurrentThreadsPerSession === "number" ? data.maxConcurrentThreadsPerSession : null,
          multiAgentMode: data.multiAgentMode === "v1" || data.multiAgentMode === "v2" ? data.multiAgentMode : "default",
        });
        setOk(true);
        setStatus(t("models.v2ThreadsApplied"));
        setShowThreadsCustom(false);
      } else {
        setOk(false);
        setStatus(data?.error ?? t("models.saveFailed"));
      }
    } catch {
      setOk(false); setStatus(t("models.networkError"));
    } finally {
      setV2Busy(false);
      v2BusyRef.current = false;
    }
  };

  const onSelectThreads = (raw: string) => {
    if (raw === CUSTOM_OPTION) { setShowThreadsCustom(true); setThreadsCustom(String(v2?.maxConcurrentThreadsPerSession ?? "")); return; }
    setShowThreadsCustom(false);
    void putV2Threads(Number(raw));
  };

  if (loading) return <div className="row muted"><span className="spin" /> {t("models.loading")}</div>;


  return (
    <>
      <div className="page-head">
        <h2>{t("nav.models")}</h2>
        <span className="muted mono text-label">{t("models.active", { active: models.length - disabled.size, total: models.length })}</span>
      </div>
      <p className="page-sub">{t("models.subtitle")}</p>
      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

      <div className="row muted text-control" style={{ gap: 6, marginBottom: 8, alignItems: "center" }}>
        <span title={t("models.shadowCallInterceptHint")} style={{ cursor: "help" }}>{t("models.shadowCallIntercept")} ⓘ</span>
        <code className="text-caption" style={{ opacity: 0.6 }}>⚠ 5.4-mini →</code>
        <Switch on={shadowCall?.enabled ?? false} onClick={() => void saveShadowCall({ enabled: !shadowCall?.enabled })} disabled={!shadowCall || shadowCallSaving} label={t("models.shadowCallIntercept")} />
        <Select value={shadowCall?.model ?? ""} options={[{ value: "", label: "\u2014" }, ...shadowModelOptions]} onChange={v => { setShadowCall(c => c ? { ...c, model: v } : c); void saveShadowCall({ model: v }); }} disabled={!shadowCall || shadowCallSaving || !shadowCall.enabled} label={t("models.shadowCallIntercept")} />
      </div>

      {v2 && (
        <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="muted text-control">{t("models.v2Label")}</span>
          <div className="segmented" role="radiogroup" aria-label={t("models.v2Label")} style={{ display: "inline-flex", borderRadius: "var(--radius-pill)", background: "var(--surface-soft, var(--raised))", padding: 3, gap: 2 }}>
            {(["v1", "default", "v2"] as const).map(mode => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={(v2.multiAgentMode ?? "default") === mode}
                className={`btn btn-sm${(v2.multiAgentMode ?? "default") === mode ? " btn-primary" : " btn-ghost"}`}
                style={{ borderRadius: "var(--radius-pill)", minWidth: 64, padding: "5px 12px", border: "none", background: (v2.multiAgentMode ?? "default") === mode ? undefined : "transparent", color: (v2.multiAgentMode ?? "default") === mode ? undefined : "var(--muted)" }}
                disabled={v2Busy}
                onClick={() => void setMultiAgentMode(mode)}
              >
                {t(`models.v2Mode_${mode}` as TKey)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ width: 24, height: 24, minWidth: 24, flex: "0 0 24px", padding: 0, borderRadius: "var(--radius-pill)", color: "var(--muted)" }}
            onClick={() => setV2HelpOpen(true)}
            aria-label={t("models.v2Label")}
            aria-haspopup="dialog"
          >
            <IconInfo width={14} height={14} aria-hidden="true" />
          </button>
          {v2.enabled && (
            <>
              <span className="muted text-control" style={{ marginLeft: 8 }}>{t("models.v2ThreadsLabel")}</span>
              <Select
                value={showThreadsCustom
                  ? CUSTOM_OPTION
                  : (v2.maxConcurrentThreadsPerSession !== null && v2.maxConcurrentThreadsPerSession !== undefined
                    ? (THREAD_OPTION_SET.has(v2.maxConcurrentThreadsPerSession) ? String(v2.maxConcurrentThreadsPerSession) : CUSTOM_OPTION)
                    : "")}
                options={[
                  ...(v2.maxConcurrentThreadsPerSession === null || v2.maxConcurrentThreadsPerSession === undefined
                    ? [{ value: "", label: t("models.v2ThreadsDefault") }] : []),
                  ...(v2.maxConcurrentThreadsPerSession !== null && v2.maxConcurrentThreadsPerSession !== undefined
                    && !THREAD_OPTION_SET.has(v2.maxConcurrentThreadsPerSession) && !showThreadsCustom
                    ? [{ value: CUSTOM_OPTION, label: String(v2.maxConcurrentThreadsPerSession) }] : []),
                  ...THREAD_OPTIONS.map(v => ({ value: String(v), label: String(v) })),
                  { value: CUSTOM_OPTION, label: t("models.custom") },
                ]}
                onChange={v => onSelectThreads(v)}
                disabled={v2Busy}
                label={t("models.v2ThreadsLabel")}
              />
              {showThreadsCustom && (
                <>
                  <input
                    className="input"
                    style={{ width: 100 }}
                    inputMode="numeric"
                    value={threadsCustom}
                    onChange={e => setThreadsCustom(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") void putV2Threads(Number(threadsCustom.replace(/[_,\s]/g, ""))); }}
                    disabled={v2Busy}
                    aria-label={t("models.v2ThreadsLabel")}
                  />
                  <button type="button" className="btn btn-sm" disabled={v2Busy}
                    onClick={() => { void putV2Threads(Number(threadsCustom.replace(/[_,\s]/g, ""))); }}>
                    {t("models.v2ThreadsApply")}
                  </button>
                </>
              )}
            </>
          )}
          {v2.enabled && v2.agentsMaxThreadsConflict && (
            <span className="mono text-label" style={{ color: "var(--err, #e5484d)" }}>{t("models.v2Conflict")}</span>
          )}
          {v2Note && <span className="muted text-label">{v2Note}</span>}
        </div>
      )}

      <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span className="muted text-control">{t("models.contextCapLabel")}</span>
        <Select
          value={showCustom ? CUSTOM_OPTION : (CAP_OPTION_SET.has(contextCapValue) ? String(contextCapValue) : CUSTOM_OPTION)}
          options={[
            ...(!CAP_OPTION_SET.has(contextCapValue) && !showCustom
              ? [{ value: String(contextCapValue), label: fmtK(contextCapValue) }] : []),
            ...CAP_OPTIONS.map(v => ({ value: String(v), label: fmtK(v) })),
            { value: CUSTOM_OPTION, label: t("models.custom") },
          ]}
          onChange={v => onSelectCap(v)}
          disabled={busy}
          label={t("models.contextCapLabel")}
        />
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
              aria-label={t("models.customPlaceholder")}
            />
            <button type="button" onClick={applyCustomCap} disabled={busy} className="btn btn-ghost btn-sm">{t("models.customApply")}</button>
          </>
        )}
        <div style={{ flex: 1 }} />
        <Switch on={allCapped} onClick={setAll} disabled={busy} label={t("models.setAll")} />
        <span className="muted mono text-label">{t("models.setAll")}</span>
      </div>

      <div className="row muted text-label leading-body" style={{ alignItems: "flex-start", gap: 8, marginBottom: 12, maxWidth: "80ch" }}>
        <IconInfo width={15} height={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
        <span>{t("models.orderHint")}</span>
      </div>

     {groups.map(([provider, rows]) => {
       const isCollapsed = collapsed.has(provider);
       const activeCount = rows.filter(m => !disabled.has(m.namespaced)).length;
       const capOn = contextCaps[provider] === contextCapValue;
       const isNative = rows.every(m => m.native);
       const q = (search[provider] ?? "").trim().toLowerCase();
       const filtered = q ? rows.filter(m => m.id.toLowerCase().includes(q)) : rows;
       // Display-only: enabled models float to the top of each provider group so they
       // stay findable in long lists. The sort is stable, so the server order is kept
       // inside each partition, and this does not affect the picker order above
       // (visibility toggles still only filter).
       const sorted = [...filtered].sort((a, b) => Number(disabled.has(a.namespaced)) - Number(disabled.has(b.namespaced)));
       const shown = limit[provider] ?? PAGE;
       const visible = sorted.slice(0, shown);
       const remaining = filtered.length - visible.length;
        const allOn = rows.every(m => !disabled.has(m.namespaced));
        const allOff = rows.every(m => disabled.has(m.namespaced));
        const bulkToggle = (enable: boolean) => {
          const next = new Set(disabled);
          for (const m of rows) { if (enable) next.delete(m.namespaced); else next.add(m.namespaced); }
          apply(next);
        };
       return (
         <div key={provider} className="card" style={{ marginBottom: 8, overflow: "hidden" }}>
          <div onClick={() => toggleCollapse(provider)}
             className={`row group-head${isCollapsed ? "" : " open"}`}>
             <IconChevron style={{ width: 14, height: 14, color: "var(--muted)", transform: isCollapsed ? "none" : "rotate(90deg)", transition: "transform .12s" }} />
             <span className="text-body font-semibold">{provider}</span>
             {isNative && <span className="muted mono text-caption" style={{ padding: "1px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-pill)" }}>{t("models.nativeGroupLabel")}</span>}
             <span className="muted mono text-label">{t("models.active", { active: activeCount, total: rows.length })}</span>
             <div style={{ flex: 1 }} />
              <div className="row" onClick={e => e.stopPropagation()} style={{ gap: 6 }}>
                <button type="button" className="btn btn-ghost btn-sm text-caption" disabled={busy || allOn} onClick={() => bulkToggle(true)} style={{ padding: "2px 8px" }}>{t("models.allOn")}</button>
                <button type="button" className="btn btn-ghost btn-sm text-caption" disabled={busy || allOff} onClick={() => bulkToggle(false)} style={{ padding: "2px 8px" }}>{t("models.allOff")}</button>
                {!isNative && <>
                  <Switch on={capOn} onClick={() => toggleProviderCap(provider)} disabled={busy} label={t("models.capValue", { value: fmtK(contextCapValue) })} />
                  <span className="muted mono text-label">{t("models.capValue", { value: fmtK(contextCapValue) })}</span>
                </>}
              </div>
           </div>
           {!isCollapsed && (
             <div style={{ padding: "6px 12px" }}>
               {isNative && <p className="muted text-label" style={{ margin: "2px 0 6px" }}>{t("models.nativeHint")}</p>}
               {rows.length > PAGE / 2 && (
                 <input
                   className="input"
                   style={{ width: "100%", marginBottom: 6 }}
                   placeholder={t("models.search")}
                   value={search[provider] ?? ""}
                   onChange={e => setSearch(prev => ({ ...prev, [provider]: e.target.value }))}
                   aria-label={t("models.search")}
                 />
               )}
                {visible.map(m => {
                  const off = disabled.has(m.namespaced);
                  return (
                    <div key={m.namespaced} className="row" style={{ padding: "5px 0" }}>
                      <Switch on={!off} onClick={() => toggle(m.namespaced)} disabled={busy} label={m.native ? m.id : m.namespaced} />
                      <code className="mono text-control" style={{ color: off ? "var(--faint)" : "var(--text)", textDecoration: off ? "line-through" : "none" }}>{m.native ? modelLabel(m.id) : m.namespaced}</code>
                      {m.contextCapped && <span className="muted mono text-caption" style={{ padding: "1px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-pill)" }}>{t("models.contextCappedValue", { value: fmtK(m.contextCap ?? contextCapValue) })}</span>}
                    </div>
                  );
                })}
                {remaining > 0 && (
                  <button
                    type="button"
                    onClick={() => setLimit(prev => ({ ...prev, [provider]: shown + PAGE }))}
                    className="btn btn-ghost btn-sm"
                    style={{ marginTop: 4 }}
                  >{t("models.showMore", { n: remaining })}</button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {groups.length === 0 && (
        <EmptyState icon={<IconBoxes />} title={t("models.noRouted")}>
          {t("models.noRoutedHint")}
        </EmptyState>
      )}

      {v2HelpOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t("models.v2Label")} onClick={() => setV2HelpOpen(false)} onKeyDown={e => { if (e.key === "Escape") setV2HelpOpen(false); }}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{t("models.v2Label")}</h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setV2HelpOpen(false)} aria-label={t("common.close")}>&times;</button>
            </div>
            <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
              {t("models.v2Help")}
            </div>
            <div style={{ marginTop: 12 }}>
              <a className="text-control" href="https://lidge-jun.github.io/opencodex/guides/sub-agent-surface/" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                {t("models.v2DocsLink")}
              </a>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={() => setV2HelpOpen(false)}>{t("common.ok")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
