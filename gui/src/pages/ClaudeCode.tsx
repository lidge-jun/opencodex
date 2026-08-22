import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Notice, Switch } from "../ui";
import { useI18n, useT, LOCALES } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import { readSessionListCacheEntry, writeSessionListCacheEntry } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
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
import { AUTO_COMPACT_WINDOW_DEFAULT, formatCompactWindow, newClientId, type ClaudeCodeState, type MapRow } from "./claude-code-types";
import { SmallFastModelSetting } from "./claude-code-settings";

export { AutoConnectSetting, SmallFastModelSetting } from "./claude-code-settings";

type CachedClaudeCode = { state: ClaudeCodeState; rows: MapRow[] };

export default function ClaudeCode({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang ?? "en";
  const cacheKey = `ocx.claude-code.v1:${apiBase}`;
  const resourceKey = `claude-code:${apiBase}`;
  const cachedEntry = useMemo(() => readSessionListCacheEntry<CachedClaudeCode>(cacheKey), [cacheKey]);
  const cached = cachedEntry?.data ?? null;
  const [draftState, setState] = useState<ClaudeCodeState | null>(() => cached?.state ?? null);
  const [draftRows, setRows] = useState<MapRow[]>(() => cached?.rows ?? []);
  const [hasDraftRows, setHasDraftRows] = useState(Boolean(cached));
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  const [selectedSection, setSelectedSection] = useState("settings");
  /*
   * The connection switch moved here from the sidebar's Claude nav row, which
   * had made a navigation entry the owner of a mutation — and left it homeless
   * once the three integration pages collapsed into one.
   *
   * It keeps the sidebar's IMMEDIATE semantics rather than becoming another
   * draft: the Settings card below commits on Save, and quietly changing this
   * control's meaning would be worse than moving it. The in-flight ref
   * serializes rapid clicks so three taps cannot become three PUTs.
   */
  const [connectionPending, setConnectionPending] = useState(false);
  const connectionInFlight = useRef(false);

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
    writeSessionListCacheEntry(cacheKey, next);
    return next;
  }, [apiBase, cacheKey, t]);

  const codeResource = useDataSurface<CachedClaudeCode>(
    resourceKey,
    [apiBase],
    fetchCode,
    {
      isEmpty: () => false,
      enabled: active,
      initialData: cached ?? undefined,
      initialDataCachedAt: cachedEntry?.cachedAt ?? null,
      staleAfterMs: 60_000,
    },
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
  // pickers. "" means "use the runtime default"; a saved off-ladder value is surfaced as
  // its own option. The default itself is on the ladder so the empty choice and the
  // explicit one are visibly the same number.
  const autoCompactOptions = useMemo(() => {
    const ladder = [
      100_000, 200_000, 250_000, 300_000, 350_000, 400_000, 500_000, 600_000, 750_000,
      AUTO_COMPACT_WINDOW_DEFAULT, 900_000, 1_000_000,
    ].sort((a, b) => a - b);
    // Compact SI-style units (1M / 350k) — technical number format, not prose.
    const current = state?.autoCompactWindow ?? null;
    const values = current !== null && !ladder.includes(current) ? [...ladder, current].sort((a, b) => a - b) : ladder;
    return [
      // The label carries the number instead of hardcoding it in nine locale files, which
      // is how "350k (default)" survived a default change.
      { value: "", label: t("claude.autoCompactDefault", { value: formatCompactWindow(AUTO_COMPACT_WINDOW_DEFAULT, localeTag) }) },
      ...values.map(value => ({ value: String(value), label: formatCompactWindow(value, localeTag) })),
    ];
  }, [state?.autoCompactWindow, t, localeTag]);

  /**
   * Immediate connection toggle. Waits for the response instead of flipping
   * optimistically: this writes the user's Claude settings file, so a switch
   * that showed "on" after a failed PUT would be lying about their config.
   */
  const toggleConnection = async () => {
    if (!state || connectionInFlight.current) return;
    connectionInFlight.current = true;
    setConnectionPending(true);
    setStatus("");
    const next = !state.enabled;
    try {
      const response = await fetch(`${apiBase}/api/claude-code`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      await readJsonOrThrow(response, t("claude.saveFailed"));
      setState({ ...state, enabled: next });
      codeResource.refresh();
    } catch (error) {
      setOk(false);
      setStatus(error instanceof Error && error.message ? error.message : t("claude.networkError"));
    } finally {
      connectionInFlight.current = false;
      setConnectionPending(false);
    }
  };

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

  const sections: Array<{ id: string; label: string; meta?: string; body: ReactNode }> = [
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
      meta: String(rows.length),
      body: <ClaudeCodeModelMapSection rows={rows} onRowsChange={(nextRows) => {
        setHasDraftRows(true);
        setRows(nextRows);
      }} />,
    },
    {
      id: "aliases",
      label: t("claude.aliases"),
      meta: String(state.aliases.length),
      body: <ClaudeCodeAliasesSection aliases={state.aliases} />,
    },
  ];
  const selected = sections.find(s => s.id === selectedSection) ?? sections[0]!;
  const sectionEditable = selectedSection === "settings"
    || selectedSection === "smallFast"
    || selectedSection === "modelMap";

  return (
    <div className="claudecode-workspace-shell">
      {/* Page title/subtitle live on Claude.tsx above the Code/Desktop strip. */}
      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}
      {loadState.showError && <Notice tone="err">{t("claude.loadFail")}</Notice>}
      {state && (
        <div className="claudecode-connection-head">
          <span id="claudecode-connection-label">{t("claude.enabledLabel")}</span>
          <Switch
            on={state.enabled}
            onClick={() => void toggleConnection()}
            disabled={connectionPending}
            label={t("claude.toggleAria")}
          />
        </div>
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
          <div className="ccw-main-head">
            <h3 className="ccw-main-title">
              {selected.label}
              {selected.meta != null ? <span className="count">{selected.meta}</span> : null}
            </h3>
            <div
              className="claudecode-workspace-save"
              data-visible={sectionEditable ? "true" : "false"}
            >
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!sectionEditable}
                tabIndex={sectionEditable ? 0 : -1}
                aria-hidden={!sectionEditable}
                onClick={() => { void save(); }}
              >
                {t("common.save")}
              </button>
            </div>
          </div>
          <div className="ccw-body">{selected.body}</div>
        </section>
      </div>
    </div>
  );
}
