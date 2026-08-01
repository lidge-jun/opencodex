import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Notice } from "../ui";
import { useI18n, useT, LOCALES } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton, DataSurfaceStatus } from "../components/data-surface";
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

export default function ClaudeCode({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang ?? "en";
  const cacheKey = `ocx.claude-code.v1:${apiBase}`;
  const cached = useMemo(() => seedClaudeCode(cacheKey), [cacheKey]);
  const [draftState, setState] = useState<ClaudeCodeState | null>(() => cached?.state ?? null);
  const [draftRows, setRows] = useState<MapRow[]>(() => cached?.rows ?? []);
  const [hasDraftRows, setHasDraftRows] = useState(Boolean(cached));
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [selectedSection, setSelectedSection] = useState("settings");

  const fetchCode = useCallback(async (signal: AbortSignal): Promise<CachedClaudeCode> => {
    const res = await fetch(`${apiBase}/api/claude-code`, { signal });
    const r = await readJsonOrThrow<ClaudeCodeState & { modelMap?: Record<string, string> }>(
      res,
      t("claude.loadFail"),
    );
    if (!r) throw new Error(t("claude.loadFail"));
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
    const next = { state: nextState, rows: nextRows };
    if (signal.aborted) throw new Error("Claude Code request aborted");
    // This is the only server-owned draft replacement. Keeping it at the successful read
    // boundary preserves the existing save→reload behavior without a synchronization effect.
    setState(nextState);
    setRows(nextRows);
    setHasDraftRows(true);
    writeSessionListCache(cacheKey, next);
    return next;
  }, [apiBase, cacheKey, t]);

  const codeResource = useDataSurface<CachedClaudeCode>(
    `claude-code:${apiBase}`,
    [apiBase],
    fetchCode,
    { isEmpty: () => false, enabled: active },
  );
  const loadState = codeResource.state;
  const data = loadState.data ?? cached;
  const state = draftState ?? data?.state ?? null;
  const rows = hasDraftRows ? draftRows : data?.rows ?? draftRows;

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
      codeResource.refresh();
    } catch (error) {
      setOk(false);
      setStatus(error instanceof Error && error.message ? error.message : t("claude.networkError"));
    }
  };

  // A hidden Code tab remains mounted for draft preservation, but must not advertise a
  // disabled fetch as loading before the user ever opens it.
  if (loadState.kind === "disabled" && !data) return null;
  if (loadState.showSkeleton && !data) {
    return <DataSurfaceSkeleton label={t("claude.loading")} rows={3} />;
  }
  if (loadState.kind === "failed-cold") {
    const reason = loadState.error instanceof Error ? loadState.error.message : t("claude.loadFail");
    return (
      <div className="claudecode-workspace-shell">
        <Notice tone="err">{reason}</Notice>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => codeResource.refresh()}>{t("common.retry")}</button>
      </div>
    );
  }
  if (!state) return null;

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
      body: <ClaudeCodeModelMapSection rows={rows} onRowsChange={(nextRows) => {
        setHasDraftRows(true);
        setRows(nextRows);
      }} />,
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
      {loadState.showError && <Notice tone="err">{t("claude.loadFail")}</Notice>}
      {loadState.refreshing && (
        <DataSurfaceStatus live={!loadState.showError}>{t("claude.loading")}</DataSurfaceStatus>
      )}
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
