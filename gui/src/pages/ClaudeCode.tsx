import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Notice } from "../ui";
import { useI18n, useT, LOCALES } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { backgroundHelperOptions } from "./claude-code-helper-options";
import { reconcileAutoConnectState } from "./claude-autoconnect";
import { buildManualEnv } from "./claude-manual-env";
import {
  ClaudeCodeAliasesSection,
  ClaudeCodeModelMapSection,
  ClaudeCodeQuickstartSection,
  ClaudeCodeSettingsCard,
} from "./claude-code-sections";
import { serializeSidecarOverride } from "./claude-code-sidecar";
import { formatCompactWindow, newClientId, type ClaudeCodeState, type MapRow } from "./claude-code-types";
import { SmallFastModelSetting } from "./claude-code-settings";

export { AutoConnectSetting, SmallFastModelSetting } from "./claude-code-settings";

type CachedClaudeCode = { state: ClaudeCodeState; rows: MapRow[] };

function seedClaudeCode(cacheKey: string): CachedClaudeCode | null {
  return readSessionListCache<CachedClaudeCode>(cacheKey);
}

export default function ClaudeCode({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang ?? "en";
  const cacheKey = `ocx.claude-code.v1:${apiBase}`;
  const [state, setState] = useState<ClaudeCodeState | null>(() => seedClaudeCode(cacheKey)?.state ?? null);
  const [rows, setRows] = useState<MapRow[]>(() => seedClaudeCode(cacheKey)?.rows ?? []);
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(() => !seedClaudeCode(cacheKey)?.state);
  const [selectedSection, setSelectedSection] = useState("settings");
  const hasCacheRef = useRef(Boolean(seedClaudeCode(cacheKey)?.state));

  const load = useCallback(async () => {
    if (!hasCacheRef.current) setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/claude-code`);
      const r = await readJsonOrThrow<ClaudeCodeState & { modelMap?: Record<string, string> }>(
        res,
        t("claude.loadFail"),
      );
      if (!r) {
        setOk(false);
        setStatus(t("claude.loadFail"));
        return;
      }
      const nextState: ClaudeCodeState = {
        ...r,
        // No coercion: an absent config key is AUTO, and coercing it to subscription is
        // what silently converted an untouched auto config on every save.
        authMode: r.authMode === "proxy" || r.authMode === "subscription" ? r.authMode : "auto",
        ...reconcileAutoConnectState(r),
        fastMode: r.fastMode ?? null,
        maxContextTokens: r.maxContextTokens ?? null,
        autoContext: r.autoContext !== false,
        autoCompactWindow: r.autoCompactWindow ?? null,
        injectAgents: r.injectAgents !== false,
        effectiveModelEnv: r.effectiveModelEnv ?? {},
      };
      const nextRows = Object.entries(r.modelMap ?? {}).map(([from, to]) => ({ id: newClientId(), from, to: String(to) }));
      setState(nextState);
      setRows(nextRows);
      hasCacheRef.current = true;
      writeSessionListCache(cacheKey, { state: nextState, rows: nextRows });
    } catch (error) {
      if (!hasCacheRef.current) {
        setOk(false);
        setStatus(error instanceof Error && error.message ? error.message : t("claude.loadFail"));
      }
    } finally {
      setLoading(false);
    }
  }, [apiBase, cacheKey, t]);

  useEffect(() => {
    // Deferred initial load (matches Models/Usage): avoids synchronous setState
    // inside the effect, per the react-hooks/set-state-in-effect lint gate.
    const timeout = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const modelOptions = useMemo(
    () => backgroundHelperOptions(state?.available, t("claude.smallFastModelUnsetOption")),
    [state?.available, t],
  );

  // Auto-compact window presets (devlog 020 + user request): dropdown like the model
  // pickers. "" = 350k default; a saved off-ladder value is surfaced as its own option.
  const autoCompactOptions = useMemo(() => {
    const ladder = [100_000, 200_000, 250_000, 300_000, 350_000, 400_000, 500_000, 600_000, 750_000, 900_000, 1_000_000];
    // Compact SI-style units (1M / 350k) — technical number format, not prose.
    const current = state?.autoCompactWindow ?? null;
    const values = current !== null && !ladder.includes(current) ? [...ladder, current].sort((a, b) => a - b) : ladder;
    return [
      { value: "", label: t("claude.autoCompactDefault") },
      ...values.map(value => ({ value: String(value), label: formatCompactWindow(value, localeTag) })),
    ];
  }, [state?.autoCompactWindow, t, localeTag]);

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
          webSearchSidecar: serializeSidecarOverride(state.webSearchSidecar),
          visionSidecar: serializeSidecarOverride(state.visionSidecar),
        }),
      });
      await readJsonOrThrow(r, t("claude.saveFailed"));
      setOk(true);
      setStatus(t("claude.saved"));
      await load();
    } catch (error) {
      setOk(false);
      setStatus(error instanceof Error && error.message ? error.message : t("claude.networkError"));
    }
  };

  if (loading) return <div className="muted" style={{ padding: 8 }}>{t("claude.loading")}</div>;
  if (!state) return <Notice tone="err">{status || t("claude.loadFail")}</Notice>;

  const sections: Array<{ id: string; label: string; body: ReactNode }> = [
    {
      id: "settings",
      label: t("claude.workspace.settings"),
      body: (
        <ClaudeCodeSettingsCard
          state={state}
          autoCompactOptions={autoCompactOptions}
          availableModels={state.available ?? []}
          onStateChange={setState}
        />
      ),
    },
    {
      id: "quickstart",
      label: t("claude.quickstart"),
      body: <ClaudeCodeQuickstartSection manualEnv={buildManualEnv(state)} />,
    },
    {
      id: "smallFast",
      label: t("claude.smallFastModel"),
      body: (
        <SmallFastModelSetting
          value={state.smallFastModel}
          tierHaikuModel={state.tierModels?.haiku}
          options={modelOptions}
          onChange={smallFastModel => setState({ ...state, smallFastModel })}
        />
      ),
    },
    {
      id: "modelMap",
      label: t("claude.modelMap"),
      body: <ClaudeCodeModelMapSection rows={rows} onRowsChange={setRows} />,
    },
    {
      id: "aliases",
      label: t("claude.aliases"),
      body: <ClaudeCodeAliasesSection aliases={state.aliases} />,
    },
  ];
  const selected = sections.find(s => s.id === selectedSection) ?? sections[0]!;
  const sectionEditable = selectedSection === "settings"
    || selectedSection === "smallFast"
    || selectedSection === "modelMap";

  return (
    <div className="claudecode-workspace-shell">
      <div className="page-head">
        <h2>{t("claude.pageTitle")}</h2>
        {sectionEditable && (
          <div className="claudecode-workspace-save">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => { void save(); }}>
              {t("common.save")}
            </button>
          </div>
        )}
      </div>
      <p className="page-sub">{t("claude.subtitle")}</p>
      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}
      <div className="claudecode-workspace-root">
        <aside className="claudecode-workspace-rail" aria-label={t("claude.pageTitle")}>
          <div className="claudecode-workspace-rail-list">
            {sections.map(s => (
              <button
                key={s.id}
                type="button"
                className={`claudecode-workspace-rail-row${selectedSection === s.id ? " claudecode-workspace-rail-row--selected" : ""}`}
                onClick={() => setSelectedSection(s.id)}
                aria-current={selectedSection === s.id ? "true" : undefined}
              >
                <span className="claudecode-workspace-rail-name">{s.label}</span>
              </button>
            ))}
          </div>
        </aside>
        <section className="claudecode-workspace-main" aria-label={selected.label}>
          <div className="ccw-body">{selected.body}</div>
        </section>
      </div>
    </div>
  );
}
