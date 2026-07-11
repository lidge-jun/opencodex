import { useEffect, useMemo, useState } from "react";
import { Notice, Select } from "../ui";
import { IconPlus, IconX } from "../icons";
import { useT, Trans } from "../i18n";
import { modelLabel } from "../model-display";

interface ClaudeCodeState {
  enabled: boolean;
  systemEnv: boolean;
  model: string;
  smallFastModel: string;
  modelMap: Record<string, string>;
  available: string[];
  aliases: { id: string; display_name: string }[];
  port: number;
}

interface MapRow { from: string; to: string }

export default function ClaudeCode({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [state, setState] = useState<ClaudeCodeState | null>(null);
  const [rows, setRows] = useState<MapRow[]>([]);
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const r = await fetch(`${apiBase}/api/claude-code`).then(res => res.json());
      setState({ ...r, systemEnv: r.systemEnv !== false });
      setRows(Object.entries(r.modelMap ?? {}).map(([from, to]) => ({ from, to: String(to) })));
    } catch {
      setOk(false);
      setStatus(t("claude.loadFail"));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [apiBase]);

  const modelOptions = useMemo(() => {
    const options = (state?.available ?? []).map(m => ({ value: m, label: modelLabel(m) }));
    return [{ value: "", label: t("claude.slotUnset") }, ...options];
  }, [state?.available, t]);

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
          systemEnv: state.systemEnv,
          model: state.model,
          smallFastModel: state.smallFastModel,
          modelMap,
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

  const baseUrl = `http://127.0.0.1:${state.port}`;
  const manualEnv = [
    `export ANTHROPIC_BASE_URL=${baseUrl}`,
    "# no ANTHROPIC_AUTH_TOKEN: your claude.ai login (and connectors) stay active",
    "export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1",
    ...(state.model ? [`export ANTHROPIC_MODEL=${state.model}`] : []),
    ...(state.smallFastModel ? [`export ANTHROPIC_DEFAULT_HAIKU_MODEL=${state.smallFastModel}`] : []),
    "claude",
  ].join("\n");

  return (
    <>
      <div className="page-head"><h2>{t("nav.claude")} Code</h2></div>
      <p className="page-sub">{t("claude.subtitle")}</p>

      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}

      <div className="card row" style={{ padding: "10px 14px", gap: 12, alignItems: "center" }}>
        <label className="row" style={{ gap: 10, alignItems: "center", cursor: "pointer", flex: 1 }}>
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={e => setState({ ...state, enabled: e.target.checked })}
            aria-label={t("claude.toggleAria")}
          />
          <span style={{ fontWeight: 600 }}>{t("claude.enabledLabel")}</span>
        </label>
        <span className="mono" style={{ color: state.enabled ? "var(--accent)" : "var(--faint)", fontWeight: 700, fontSize: 12 }}>
          {state.enabled ? "Claude ON" : "Claude OFF"}
        </span>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "6px 2px 0" }}>{t("claude.enabledHint")}</p>

      <div className="card row" style={{ padding: "10px 14px", gap: 12, alignItems: "center", marginTop: 10 }}>
        <label className="row" style={{ gap: 10, alignItems: "center", cursor: "pointer", flex: 1 }}>
         <input
           type="checkbox"
           checked={state.systemEnv}
            onChange={e => {
              const enabling = e.target.checked;
              if (enabling) {
                const ok = window.confirm(t("claude.systemEnvWarning"));
                if (!ok) return;
              }
              setState({ ...state, systemEnv: enabling });
            }}
          />
          <span style={{ fontWeight: 600 }}>{t("claude.systemEnv")}</span>
        </label>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "6px 2px 0" }}>
        {t("claude.systemEnvDesc")}
        {state.systemEnv && <><br/><strong style={{ color: "var(--warning)" }}>⚠ {t("claude.systemEnvRestart")}</strong></>}
      </p>

      <div className="h-section">{t("claude.quickstart")}</div>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}><Trans k="claude.quickstartHint" cmd="ocx claude" /></p>
      <pre className="mono card" style={{ padding: "10px 14px", overflowX: "auto", margin: 0 }}>ocx claude</pre>
      <div className="muted" style={{ fontSize: 12.5, margin: "10px 2px 4px" }}>{t("claude.manualEnv")}</div>
      <pre className="mono card" style={{ padding: "10px 14px", overflowX: "auto", margin: 0, fontSize: 12 }}>{manualEnv}</pre>

      <div className="h-section">{t("claude.defaultModel")}</div>
      <Select
        value={state.model}
        options={modelOptions}
        onChange={v => setState({ ...state, model: v })}
        label={t("claude.defaultModel")}
        style={{ maxWidth: 420 }}
      />
      <div className="h-section">{t("claude.smallFastModel")}</div>
      <Select
        value={state.smallFastModel}
        options={modelOptions}
        onChange={v => setState({ ...state, smallFastModel: v })}
        label={t("claude.smallFastModel")}
        style={{ maxWidth: 420 }}
      />

      <div className="h-section">{t("claude.modelMap")} <span className="count">{rows.length}</span></div>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>{t("claude.modelMapHint")}</p>
      <div className="stack" style={{ gap: 8 }}>
        {rows.map((row, i) => (
          <div key={i} className="row" style={{ gap: 8 }}>
            <input
              className="input mono"
              value={row.from}
              placeholder={t("claude.mapFrom")}
              onChange={e => setRows(prev => prev.map((r, j) => j === i ? { ...r, from: e.target.value } : r))}
              style={{ flex: 1 }}
            />
            <span className="muted" aria-hidden>→</span>
            <input
              className="input mono"
              value={row.to}
              placeholder={t("claude.mapTo")}
              onChange={e => setRows(prev => prev.map((r, j) => j === i ? { ...r, to: e.target.value } : r))}
              style={{ flex: 1 }}
            />
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setRows(prev => prev.filter((_, j) => j !== i))}
              aria-label={t("claude.removeMapping")} style={{ color: "var(--red)" }}>
              <IconX />
            </button>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setRows(prev => [...prev, { from: "", to: "" }])}>
          <IconPlus /> {t("claude.addMapping")}
        </button>
      </div>

      <div style={{ marginTop: 14 }}>
        <button className="btn btn-primary" onClick={save}>{t("common.save")}</button>
      </div>

      <div className="h-section">{t("claude.aliases")} <span className="count">{state.aliases.length}</span></div>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>{t("claude.aliasesHint")}</p>
      {state.aliases.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5 }}>{t("claude.none")}</div>
      ) : (
        <div className="stack" style={{ gap: 6, maxHeight: 300, overflowY: "auto" }}>
          {state.aliases.map(a => (
            <div key={a.id} className="card row" style={{ padding: "6px 12px", gap: 10 }}>
              <code className="mono" style={{ flex: 1, fontSize: 12 }}>{a.id}</code>
              <span className="muted" style={{ fontSize: 12 }}>{a.display_name}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
