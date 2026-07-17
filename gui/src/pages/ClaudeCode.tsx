import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { Notice, Select } from "../ui";
import { IconPlus, IconX } from "../icons";
import { useT } from "../i18n/shared";
import { Trans } from "../i18n/provider";
import { modelLabel } from "../model-display";
import type { TFn } from "../i18n/shared";

type SidecarBackend = "openai" | "anthropic";
interface SidecarOverride { backend?: SidecarBackend; model?: string }

interface ClaudeCodeState {
  enabled: boolean;
  authMode: "subscription" | "proxy";
  systemEnv: boolean;
  fastMode: boolean | null;
  maxContextTokens: number | null;
  autoContext: boolean;
  autoCompactWindow: number | null;
  injectAgents: boolean;
  smallFastModel: string;
  effectiveModelEnv: Record<string, string>;
  available: string[];
  aliases: { id: string; display_name: string }[];
  webSearchSidecar?: SidecarOverride;
  visionSidecar?: SidecarOverride;
  port: number;
}

interface MapRow { id: string; from: string; to: string }

const MODEL_ENV_NAMES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
] as const;

function newMapRow(from = "", to = ""): MapRow {
  return { id: crypto.randomUUID(), from, to };
}

function buildManualEnv(state: ClaudeCodeState): string {
  const baseUrl = `http://127.0.0.1:${state.port}`;
  const env = state.effectiveModelEnv;
  const autoCompactActive = state.autoContext && state.maxContextTokens === null;
  const modelEnvExports: string[] = [];
  for (const name of MODEL_ENV_NAMES) {
    if (env[name]) modelEnvExports.push(`export ${name}=${env[name]}`);
  }
  return [
    `export ANTHROPIC_BASE_URL=${baseUrl}`,
    ...(state.authMode === "proxy"
      ? ["export ANTHROPIC_AUTH_TOKEN=opencodex-proxy"]
      : ["# no ANTHROPIC_AUTH_TOKEN: your claude.ai login (and connectors) stay active"]),
    "export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1",
    ...(autoCompactActive ? [`export CLAUDE_CODE_AUTO_COMPACT_WINDOW=${state.autoCompactWindow ?? 350000}`] : []),
    ...modelEnvExports,
    "claude",
  ].join("\n");
}

function SettingToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} aria-label={label} />
      <span className="slider" aria-hidden="true" />
    </label>
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
        systemEnv: r.systemEnv !== false,
        fastMode: r.fastMode ?? null,
        maxContextTokens: r.maxContextTokens ?? null,
        autoContext: r.autoContext !== false,
        autoCompactWindow: r.autoCompactWindow ?? null,
        injectAgents: r.injectAgents !== false,
        effectiveModelEnv: r.effectiveModelEnv ?? {},
      });
      setRows(Object.entries(r.modelMap ?? {}).map(([from, to]) => newMapRow(from, String(to))));
    } catch {
      setOk(false);
      setStatus(t("claude.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const modelOptions = useMemo(() => {
    const options = (state?.available ?? []).map(m => ({ value: m, label: String(modelLabel(m)) }));
    return [{ value: "", label: t("claude.slotUnset") }, ...options];
  }, [state?.available, t]);

  const autoCompactOptions = useMemo(() => {
    const ladder = [100_000, 200_000, 250_000, 300_000, 350_000, 400_000, 500_000, 600_000, 750_000, 900_000, 1_000_000];
    const fmt = (v: number) => (v >= 1_000_000 ? "1M" : `${Math.round(v / 1_000)}k`);
    const current = state?.autoCompactWindow ?? null;
    const values = current !== null && !ladder.includes(current) ? [...ladder, current].sort((a, b) => a - b) : ladder;
    return [
      { value: "", label: t("claude.autoCompactDefault") },
      ...values.map(v => ({ value: String(v), label: fmt(v) })),
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

  return (
    <>
      <div className="page-head"><h2>{t("claude.pageTitle")}</h2></div>
      <p className="page-sub">{t("claude.subtitle")}</p>
      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

      <ClaudeCodeSettingsCard
        state={state}
        setState={setState}
        autoCompactOptions={autoCompactOptions}
        t={t}
      />
      <ClaudeCodeQuickstart manualEnv={buildManualEnv(state)} t={t} />
      <ClaudeCodeSmallFastModel
        state={state}
        setState={setState}
        modelOptions={modelOptions}
        t={t}
      />
      <ClaudeCodeModelMap rows={rows} setRows={setRows} onSave={save} t={t} />
      <ClaudeCodeAliases aliases={state.aliases} t={t} />
    </>
  );
}

function ClaudeCodeSettingsCard({
  state, setState, autoCompactOptions, t,
}: {
  state: ClaudeCodeState;
  setState: Dispatch<SetStateAction<ClaudeCodeState | null>>;
  autoCompactOptions: { value: string; label: string }[];
  t: TFn;
}) {
  return (
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

      <div className="setting-row">
        <div className="setting-label">
          <span className="title">{t("claude.systemEnv")}</span>
          <span className="desc">{t("claude.systemEnvDesc")}</span>
          {state.systemEnv && <span className="desc" style={{ color: "var(--red)" }}>{t("claude.systemEnvWarn")}</span>}
        </div>
        <SettingToggle label={t("claude.systemEnv")} checked={state.systemEnv} onChange={systemEnv => setState({ ...state, systemEnv })} />
      </div>

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
  );
}

function ClaudeCodeQuickstart({ manualEnv, t }: { manualEnv: string; t: TFn }) {
  return (
    <>
      <div className="h-section">{t("claude.quickstart")}</div>
      <p className="muted text-label" style={{ margin: "0 0 8px" }}><Trans k="claude.quickstartHint" cmd="ocx claude" /></p>
      <pre className="mono card" style={{ padding: "10px 14px", overflowX: "auto", margin: 0 }}>ocx claude</pre>
      <details style={{ margin: "10px 0 0" }}>
        <summary className="muted text-label" style={{ cursor: "pointer", padding: "2px 2px" }}>{t("claude.manualEnv")}</summary>
        <pre className="mono card text-label" style={{ padding: "10px 14px", overflowX: "auto", margin: "6px 0 0" }}>{manualEnv}</pre>
      </details>
    </>
  );
}

function ClaudeCodeSmallFastModel({
  state, setState, modelOptions, t,
}: {
  state: ClaudeCodeState;
  setState: Dispatch<SetStateAction<ClaudeCodeState | null>>;
  modelOptions: { value: string; label: string }[];
  t: TFn;
}) {
  return (
    <>
      <div className="h-section">{t("claude.smallFastModel")}</div>
      <p className="muted text-label" style={{ margin: "0 0 8px" }}>{t("claude.smallFastModelHint")}</p>
      <Select
        value={state.smallFastModel}
        options={modelOptions}
        onChange={v => setState({ ...state, smallFastModel: v })}
        label={t("claude.smallFastModel")}
        style={{ maxWidth: 420 }}
      />
    </>
  );
}

function ClaudeCodeModelMap({
  rows, setRows, onSave, t,
}: {
  rows: MapRow[];
  setRows: Dispatch<SetStateAction<MapRow[]>>;
  onSave: () => void;
  t: TFn;
}) {
  return (
    <>
      <div className="h-section">{t("claude.modelMap")} <span className="count">{rows.length}</span></div>
      <p className="muted text-label" style={{ margin: "0 0 8px" }}>{t("claude.modelMapHint")}</p>
      <div className="stack" style={{ gap: 8 }}>
        {rows.map((row, i) => (
          <div key={row.id} className="row" style={{ gap: 8 }}>
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
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows(prev => [...prev, newMapRow()])}>
          <IconPlus /> {t("claude.addMapping")}
        </button>
      </div>
      <div style={{ marginTop: 14 }}>
        <button type="button" className="btn btn-primary" onClick={onSave}>{t("common.save")}</button>
      </div>
    </>
  );
}

function ClaudeCodeAliases({ aliases, t }: { aliases: ClaudeCodeState["aliases"]; t: TFn }) {
  return (
    <>
      <div className="h-section">{t("claude.aliases")} <span className="count">{aliases.length}</span></div>
      <p className="muted text-label" style={{ margin: "0 0 8px" }}>{t("claude.aliasesHint")}</p>
      {aliases.length === 0 ? (
        <div className="muted text-label">{t("claude.none")}</div>
      ) : (
        <div className="stack" style={{ gap: 6, maxHeight: 320, overflowY: "auto" }}>
          {Array.from(
            aliases.reduce((groups, a) => {
              const m = /\(([^)]+)\)\s*$/.exec(a.display_name);
              const provider = m ? m[1]! : "etc";
              (groups.get(provider) ?? groups.set(provider, []).get(provider)!).push(a);
              return groups;
            }, new Map<string, { id: string; display_name: string }[]>()),
          ).map(([provider, groupRows]) => (
            <div key={provider}>
              <div className="muted text-caption font-semibold" style={{ textTransform: "uppercase", letterSpacing: "var(--tracking-wide)", margin: "6px 2px 4px" }}>{provider} · {groupRows.length}</div>
              <div className="stack" style={{ gap: 4 }}>
                {groupRows.map(a => (
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
