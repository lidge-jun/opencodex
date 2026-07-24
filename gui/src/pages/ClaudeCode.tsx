import { useCallback, useEffect, useMemo, useState } from "react";
import { Notice, Select, type SelectOption } from "../ui";
import { IconPlus, IconX } from "../icons";
import { Trans } from "../i18n/provider";
import { useT } from "../i18n/shared";
import { modelLabel } from "../model-display";
import { reconcileAutoConnectState } from "./claude-autoconnect";
import { buildManualEnv, type SidecarBackend, type SidecarOverride } from "./claude-manual-env";

interface ClaudeCodeState {
  enabled: boolean;
  authMode: "subscription" | "proxy";
  autoConnectSupported: boolean;
  systemEnv: boolean;
  fastMode: boolean | null;
  /** Legacy config override (no GUI control anymore) — still disables auto-context when hand-set. */
  maxContextTokens: number | null;
  autoContext: boolean;
  autoCompactWindow: number | null;
  injectAgents: boolean;
  smallFastModel: string;
  tierModels?: { haiku?: string };
  effectiveModelEnv: Record<string, string>;
  available: string[];
  aliases: { id: string; display_name: string }[];
  webSearchSidecar?: SidecarOverride;
  visionSidecar?: SidecarOverride;
  port: number;
}

interface MapRow { from: string; to: string }

function formatCompactWindow(value: number): string {
  return value >= 1_000_000 ? "1M" : `${Math.round(value / 1_000)}k`;
}

function SettingToggle({
  label,
  checked,
  onChange,
  disabled = false,
  describedBy,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-describedby={describedBy}
        onChange={event => onChange(event.target.checked)}
      />
      <span className="slider" aria-hidden="true" />
    </label>
  );
}

export function AutoConnectSetting({
  supported,
  checked,
  onChange,
}: {
  supported: boolean;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const t = useT();
  const unsupportedDescriptionId = supported ? undefined : "claude-system-env-unsupported";

  return (
    <div className="setting-row">
      <div className="setting-label">
        <span className="title">{t("claude.systemEnv")}</span>
        {supported ? (
          <span className="desc">{t("claude.systemEnvDesc")}</span>
        ) : (
          <span className="desc" id={unsupportedDescriptionId}>
            <Trans k="claude.systemEnvUnsupported" cmd="ocx claude" />
          </span>
        )}
        {supported && checked && (
          <span className="desc" style={{ color: "var(--red)" }}>
            {t("claude.systemEnvWarn")}
          </span>
        )}
      </div>
      <SettingToggle
        label={t("claude.systemEnv")}
        checked={supported && checked}
        disabled={!supported}
        describedBy={unsupportedDescriptionId}
        onChange={onChange}
      />
    </div>
  );
}

export function SmallFastModelSetting({
  value,
  tierHaikuModel,
  options,
  onChange,
}: {
  value: string;
  tierHaikuModel?: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const t = useT();
  const effectiveHelperModel = tierHaikuModel ?? value;
  return (
    <>
      <div className="h-section">{t("claude.smallFastModel")}</div>
      <p className="muted text-label" style={{ margin: "0 0 8px" }}>
        {t("claude.smallFastModelAccurateHint")}
      </p>
      <Select
        value={value}
        options={options}
        onChange={onChange}
        label={t("claude.smallFastModel")}
        style={{ maxWidth: 420 }}
      />
      {effectiveHelperModel === "" && (
        <p className="notice-warn" role="status" style={{ marginTop: 8 }}>
          {t("claude.smallFastModelNativeWarning")}
        </p>
      )}
    </>
  );
}

export default function ClaudeCode({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [state, setState] = useState<ClaudeCodeState | null>(null);
  const [rows, setRows] = useState<MapRow[]>([]);
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/api/claude-code`).then(res => res.json());
      setState({
        ...r,
        authMode: r.authMode === "proxy" ? "proxy" : "subscription",
        ...reconcileAutoConnectState(r),
        fastMode: r.fastMode ?? null,
        maxContextTokens: r.maxContextTokens ?? null,
        autoContext: r.autoContext !== false,
        autoCompactWindow: r.autoCompactWindow ?? null,
        injectAgents: r.injectAgents !== false,
        effectiveModelEnv: r.effectiveModelEnv ?? {},
      });
      setRows(Object.entries(r.modelMap ?? {}).map(([from, to]) => ({ from, to: String(to) })));
    } catch {
      setOk(false);
      setStatus(t("claude.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);
  useEffect(() => {
    // Deferred initial load (matches Models/Usage): avoids synchronous setState
    // inside the effect, per the react-hooks/set-state-in-effect lint gate.
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const modelOptions = useMemo(() => {
    const options = (state?.available ?? []).map(m => ({ value: m, label: String(modelLabel(m)) }));
    return [{ value: "", label: t("claude.smallFastModelUnsetOption") }, ...options];
  }, [state?.available, t]);

  // Auto-compact window presets (devlog 020 + user request): dropdown like the model
  // pickers. "" = 350k default; a saved off-ladder value is surfaced as its own option.
  const autoCompactOptions = useMemo(() => {
    const ladder = [100_000, 200_000, 250_000, 300_000, 350_000, 400_000, 500_000, 600_000, 750_000, 900_000, 1_000_000];
    // Compact SI-style units (1M / 350k) — technical number format, not prose.
    const current = state?.autoCompactWindow ?? null;
    const values = current !== null && !ladder.includes(current) ? [...ladder, current].sort((a, b) => a - b) : ladder;
    return [
      { value: "", label: t("claude.autoCompactDefault") },
      ...values.map(value => ({ value: String(value), label: formatCompactWindow(value) })),
    ];
  }, [state?.autoCompactWindow, t]);

  const save = async () => {
    if (!state) return;
    setStatus("");
    const modelMap: Record<string, string> = {};
    for (const row of rows) {
      if (row.from.trim() && row.to.trim()) modelMap[row.from.trim()] = row.to.trim();
    }
    try {
      const r = await fetch(`${apiBase}/api/claude-code`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: state.enabled,
          authMode: state.authMode,
          systemEnv: state.systemEnv,
          fastMode: state.fastMode,
          autoContext: state.autoContext,
          autoCompactWindow: state.autoCompactWindow,
          injectAgents: state.injectAgents,
          smallFastModel: state.smallFastModel,
          modelMap,
          webSearchSidecar: state.webSearchSidecar
            ? { backend: state.webSearchSidecar.backend ?? null, model: state.webSearchSidecar.model ?? "" }
            : null,
          visionSidecar: state.visionSidecar
            ? { backend: state.visionSidecar.backend ?? null, model: state.visionSidecar.model ?? "" }
            : null,
        }),
      });
      const d = await r.json();
      setOk(r.ok);
      setStatus(r.ok ? t("claude.saved") : (d.error || t("claude.saveFailed")));
      if (r.ok) await load();
    } catch {
      setOk(false);
      setStatus(t("claude.networkError"));
    }
  };

  if (loading) return <div className="muted" style={{ padding: 8 }}>{t("claude.loading")}</div>;
  if (!state) return <Notice tone="err">{status || t("claude.loadFail")}</Notice>;

  const manualEnv = buildManualEnv(state);

  return (
    <>
      <div className="page-head"><h2>{t("claude.pageTitle")}</h2></div>
      <p className="page-sub">{t("claude.subtitle")}</p>

      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

      <div className="card" style={{ overflow: "hidden" }}>
        <div className="setting-row">
          <div className="setting-label">
            <span className="title">{t("claude.enabledLabel")}</span>
            <span className="desc">{t("claude.enabledHint")}</span>
          </div>
          <SettingToggle label={t("claude.enabledLabel")} checked={state.enabled} onChange={enabled => setState({ ...state, enabled })} />
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="title">{t("claude.authMode")}</span>
            <span className="desc">{t("claude.authModeHint")}</span>
          </div>
          <Select
            value={state.authMode}
            options={[
              { value: "subscription", label: t("claude.authModeSubscription") },
              { value: "proxy", label: t("claude.authModeProxy") },
            ]}
            onChange={v => setState({ ...state, authMode: v as ClaudeCodeState["authMode"] })}
            label={t("claude.authMode")}
            style={{ minWidth: 220 }}
          />
        </div>

        <AutoConnectSetting
          supported={state.autoConnectSupported}
          checked={state.systemEnv}
          onChange={systemEnv => setState({ ...state, systemEnv })}
        />

        <div className="setting-row">
          <div className="setting-label">
            <span className="title">{t("claude.fastMode")}</span>
            <span className="desc">{t("claude.fastModeDesc")}</span>
          </div>
          <select
            value={state.fastMode === null ? "auto" : state.fastMode ? "on" : "off"}
            onChange={e => {
              const v = e.target.value;
              setState({ ...state, fastMode: v === "auto" ? null : v === "on" });
            }}
            className="text-label font-medium"
            aria-label={t("claude.fastMode")}
            style={{ padding: "5px 10px", borderRadius: "var(--radius-xs)", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)" }}
          >
            <option value="auto">{t("claude.fastAuto")}</option>
            <option value="on">{t("claude.fastOn")}</option>
            <option value="off">{t("claude.fastOff")}</option>
          </select>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            <span className="title">{t("claude.autoContext")}</span>
            <span className="desc">{t("claude.autoContextDesc")}</span>
            {state.maxContextTokens !== null && <span className="desc" style={{ color: "var(--muted)" }}>{t("claude.autoContextInert")}</span>}
          </div>
          <SettingToggle label={t("claude.autoContext")} checked={state.autoContext} onChange={autoContext => setState({ ...state, autoContext })} />
        </div>

        {state.autoContext && (
          <div className="setting-row">
            <div className="setting-label">
              <span className="title">{t("claude.autoCompactWindow")}</span>
              <span className="desc">{t("claude.autoCompactWindowDesc")}</span>
              {state.autoCompactWindow !== null && <span className="desc" style={{ color: "var(--red)" }}>{t("claude.autoCompactWindowWarn")}</span>}
            </div>
            <Select
              value={state.autoCompactWindow === null ? "" : String(state.autoCompactWindow)}
              options={autoCompactOptions}
              onChange={v => setState({ ...state, autoCompactWindow: v === "" ? null : Number(v) })}
              label={t("claude.autoCompactWindow")}
              style={{ minWidth: 130 }}
            />
          </div>
        )}

        <div className="setting-row">
          <div className="setting-label">
            <span className="title">{t("claude.injectAgents")}</span>
            <span className="desc">{t("claude.injectAgentsDesc")}</span>
          </div>
          <SettingToggle label={t("claude.injectAgents")} checked={state.injectAgents} onChange={injectAgents => setState({ ...state, injectAgents })} />
        </div>

        {(["webSearchSidecar", "visionSidecar"] as const).map(key => {
          const override = state[key];
          const titleKey = key === "webSearchSidecar" ? "claude.webSearchSidecar" : "claude.visionSidecar";
          const hintKey = key === "webSearchSidecar" ? "claude.webSearchSidecarHint" : "claude.visionSidecarHint";
          return (
            <div className="setting-row" key={key} style={{ alignItems: "flex-start" }}>
              <div className="setting-label setting-copy" style={{ flex: 1 }}>
                <span className="title">{t(titleKey)}</span>
                <span className="desc">{t(hintKey)}</span>
              </div>
              <div className="setting-controls" style={{ display: "flex", gap: 8 }}>
                <Select
                  value={!override ? "inherit" : override.backend ?? "auto"}
                  options={[
                    { value: "inherit", label: t("claude.useMainSetting") },
                    { value: "auto", label: t("dash.backendAuto") },
                    { value: "openai", label: t("dash.backendOpenAI") },
                    { value: "anthropic", label: t("dash.backendAnthropic") },
                  ]}
                  onChange={value => setState({
                    ...state,
                    [key]: value === "inherit"
                      ? undefined
                      : { ...override, backend: value === "auto" ? undefined : value as SidecarBackend },
                  })}
                  label={t("dash.sidecarBackend")}
                />
                <input
                  className="input mono"
                  value={override?.model ?? ""}
                  onChange={e => setState({ ...state, [key]: { ...override, model: e.target.value } })}
                  placeholder={t("claude.sidecarModelPlaceholder")}
                  disabled={!override}
                  aria-label={t("dash.sidecarModel")}
                  style={{ minWidth: 210 }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="h-section">{t("claude.quickstart")}</div>
      <p className="muted text-label" style={{ margin: "0 0 8px" }}><Trans k="claude.quickstartHint" cmd="ocx claude" /></p>
      <pre className="mono card" style={{ padding: "10px 14px", overflowX: "auto", margin: 0 }}>ocx claude</pre>
      {/* Advanced manual setup: collapsed by default (audit 080 UX-1). */}
      <details style={{ margin: "10px 0 0" }}>
        <summary className="muted text-label" style={{ cursor: "pointer", padding: "2px 2px" }}>{t("claude.manualEnv")}</summary>
        <pre className="mono card text-label" style={{ padding: "10px 14px", overflowX: "auto", margin: "6px 0 0" }}>{manualEnv}</pre>
      </details>

      <SmallFastModelSetting
        value={state.smallFastModel}
        tierHaikuModel={state.tierModels?.haiku}
        options={modelOptions}
        onChange={smallFastModel => setState({ ...state, smallFastModel })}
      />

      <div className="h-section">{t("claude.modelMap")} <span className="count">{rows.length}</span></div>
      <p className="muted text-label" style={{ margin: "0 0 8px" }}>{t("claude.modelMapHint")}</p>
      <div className="stack" style={{ gap: 8 }}>
        {rows.map((row, i) => (
          <div key={i} className="row" style={{ gap: 8 }}>
            <input
              className="input mono"
              value={row.from}
              placeholder={t("claude.mapFrom")}
              aria-label={t("claude.mapFrom")}
              onChange={e => setRows(prev => prev.map((r, j) => j === i ? { ...r, from: e.target.value } : r))}
              style={{ flex: 1 }}
            />
            <span className="muted" aria-hidden>→</span>
            <input
              className="input mono"
              value={row.to}
              placeholder={t("claude.mapTo")}
              aria-label={t("claude.mapTo")}
              onChange={e => setRows(prev => prev.map((r, j) => j === i ? { ...r, to: e.target.value } : r))}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setRows(prev => prev.filter((_, j) => j !== i))}
              aria-label={t("claude.removeMapping")} style={{ color: "var(--red)" }}>
              <IconX />
            </button>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows(prev => [...prev, { from: "", to: "" }])}>
          <IconPlus /> {t("claude.addMapping")}
        </button>
      </div>

      <div style={{ marginTop: 14 }}>
        <button type="button" className="btn btn-primary" onClick={save}>{t("common.save")}</button>
      </div>

      <div className="h-section">{t("claude.aliases")} <span className="count">{state.aliases.length}</span></div>
      <p className="muted text-label" style={{ margin: "0 0 8px" }}>{t("claude.aliasesHint")}</p>
      {state.aliases.length === 0 ? (
        <div className="muted text-label">{t("claude.none")}</div>
      ) : (
        // Grouped by provider (audit 080 UX-2): one scroll area, group labels first.
        <div className="stack" style={{ gap: 6, maxHeight: 320, overflowY: "auto" }}>
          {Array.from(
            state.aliases.reduce((groups, a) => {
              const m = /\(([^)]+)\)\s*$/.exec(a.display_name);
              const provider = m ? m[1]! : "etc";
              (groups.get(provider) ?? groups.set(provider, []).get(provider)!).push(a);
              return groups;
            }, new Map<string, { id: string; display_name: string }[]>()),
          ).map(([provider, rows]) => (
            <div key={provider}>
              <div className="muted text-caption font-semibold" style={{ textTransform: "uppercase", letterSpacing: "var(--tracking-wide)", margin: "6px 2px 4px" }}>{provider} · {rows.length}</div>
              <div className="stack" style={{ gap: 4 }}>
                {rows.map(a => (
                  <div key={a.id} className="card row" style={{ padding: "6px 12px", gap: 10 }}>
                    <code className="mono text-label" style={{ flex: 1 }}>{a.id}</code>
                    <span className="muted text-label">{a.display_name}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
