import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useI18n, type TFn, type TKey } from "../i18n/shared";
import { relativeTimeLabelsFromT, formatRelativeTime } from "../provider-workspace/usage";
import { Switch } from "../ui";
import { UsageCompanionChart } from "./usage-companion-chart";
import { desktopShellVersion, hostOs, isDesktopShell, type HostOs } from "../lib/desktop-shell";
import {
  bucketMinutesForWindow,
  companionTimelineQuery,
  companionTimelineProjection,
  buildCompanionSettingsPatch,
  formatCompanionTokens,
  groupCompanionModels,
  toggleCompanionModels,
  type CompanionSettings,
  type CompanionSettingsResponse,
  type UsageTimeline,
} from "./usage-companion-utils";

interface CompanionProvider {
  provider: string;
}

const MENU_METRICS = ["requests", "tokens", "cost", "quota", "none"] as const;
const WINDOWS = [6, 24, 72, 168] as const;
const CHART_STYLES = ["line", "stackedBar"] as const;
const TOKEN_METRICS = ["total", "input", "output", "cached"] as const;
const AGGREGATIONS = ["sum", "average", "max"] as const;
const GROUPINGS = ["model", "modelAccount"] as const;
const MENU_METRIC_KEYS: Record<(typeof MENU_METRICS)[number], TKey> = {
  requests: "usage.companion.menuRequests",
  tokens: "usage.companion.menuTokens",
  cost: "usage.companion.menuCost",
  quota: "usage.companion.menuQuota",
  none: "usage.companion.menuNone",
};
const WINDOW_KEYS: Record<(typeof WINDOWS)[number], TKey> = {
  6: "usage.companion.window6",
  24: "usage.companion.window24",
  72: "usage.companion.window72",
  168: "usage.companion.window168",
};
const TOKEN_METRIC_KEYS: Record<(typeof TOKEN_METRICS)[number], TKey> = {
  total: "usage.companion.metricTotal",
  input: "usage.companion.metricInput",
  output: "usage.companion.metricOutput",
  cached: "usage.companion.metricCached",
};
const SECTION_OPTIONS = [
  ["showToday", "usage.companion.sectionToday"],
  ["showChart", "usage.companion.sectionChart"],
  ["showModels", "usage.companion.sectionModels"],
  ["showCost", "usage.companion.sectionCost"],
  ["showAccounts", "usage.companion.sectionAccounts"],
] as const;
const AGGREGATION_KEYS: Record<(typeof AGGREGATIONS)[number], TKey> = {
  sum: "usage.companion.aggregationSum",
  average: "usage.companion.aggregationAverage",
  max: "usage.companion.aggregationMax",
};
type InstallOs = Exclude<HostOs, "unknown">;

const INSTALL_STEP_KEYS: Record<InstallOs, readonly [TKey, TKey, TKey]> = {
  macos: ["usage.companion.installMacStep1", "usage.companion.installMacStep2", "usage.companion.installMacStep3"],
  windows: ["usage.companion.installWinStep1", "usage.companion.installWinStep2", "usage.companion.installWinStep3"],
  linux: ["usage.companion.installLinuxStep1", "usage.companion.installLinuxStep2", "usage.companion.installLinuxStep3"],
};

const OS_LABEL_KEYS: Record<InstallOs, TKey> = {
  macos: "usage.companion.osMac",
  windows: "usage.companion.osWindows",
  linux: "usage.companion.osLinux",
};

function formatSaveTime(value: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(value);
}

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  return String(value);
}

function OsSelector({
  value,
  onChange,
  t,
}: {
  value: InstallOs;
  onChange: (value: InstallOs) => void;
  t: TFn;
}) {
  return (
    <div className="usage-segmented" role="group" aria-label={t("usage.companion.installOs")}>
      {(Object.keys(OS_LABEL_KEYS) as InstallOs[]).map(os => (
        <button key={os} type="button" className={`usage-segmented-btn${value === os ? " active" : ""}`} aria-pressed={value === os} onClick={() => onChange(os)}>
          {t(OS_LABEL_KEYS[os])}
        </button>
      ))}
    </div>
  );
}

function Segment<T extends string | number>({
  label,
  value,
  options,
  optionLabel,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  optionLabel: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <div className="usage-companion-control">
      <span className="field-label">{label}</span>
      <div className="usage-segmented" role="group" aria-label={label}>
        {options.map(option => (
          <button key={String(option)} type="button" className={`usage-segmented-btn${option === value ? " active" : ""}`} aria-pressed={option === value} onClick={() => onChange(option)}>
            {optionLabel(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

function SelectControl<T extends string>({
  label,
  value,
  options,
  optionLabel,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  optionLabel: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <label className="usage-companion-control">
      <span className="field-label">{label}</span>
      <select value={value} onChange={event => onChange(event.target.value as T)}>
        {options.map(option => <option key={option} value={option}>{optionLabel(option)}</option>)}
      </select>
    </label>
  );
}

function useVisible(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible || !ref.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "240px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref, visible]);
  return visible;
}

export default function UsageCompanionPanel({
  apiBase,
  providers,
  onSettingsLoaded,
}: {
  apiBase: string;
  providers: readonly CompanionProvider[];
  onSettingsLoaded?: (metric: CompanionSettings["menuBarMetric"]) => void;
}) {
  const { t, locale } = useI18n();
  const rootRef = useRef<HTMLElement>(null);
  const visible = useVisible(rootRef);
  const [response, setResponse] = useState<CompanionSettingsResponse | null>(null);
  const [settings, setSettings] = useState<CompanionSettings | null>(null);
  const [timeline, setTimeline] = useState<UsageTimeline | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveBaseline = useRef<CompanionSettings | null>(null);
  const timelineRequest = useRef<AbortController | null>(null);
  const saveStateRef = useRef(saveState);
  const settingsRef = useRef(settings);
  const knownTotalsRef = useRef(new Map<string, number>());
  const [knownTotals, setKnownTotals] = useState<Map<string, number>>(new Map());
  const [installOs, setInstallOs] = useState<InstallOs>(() => {
    const detected = hostOs();
    return detected === "unknown" ? "macos" : detected;
  });

  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const loadSettings = useCallback(async () => {
    setSettingsError(null);
    try {
      const result = await fetch(`${apiBase}/api/companion/settings`);
      if (!result.ok) throw new Error(`${result.status} ${result.statusText}`.trim());
      const next = await result.json() as CompanionSettingsResponse;
      setResponse(next);
      setFetchedAt(Date.now());
      setSettings(next.settings);
      saveBaseline.current = next.settings;
      onSettingsLoaded?.(next.settings.menuBarMetric);
    } catch (error) {
      setSettingsError(errorMessage(error));
    }
  }, [apiBase, onSettingsLoaded]);

  useEffect(() => {
    if (!visible || response) return;
    const timer = setTimeout(() => void loadSettings(), 0);
    return () => clearTimeout(timer);
  }, [loadSettings, response, visible]);

  useEffect(() => {
    if (!visible) return;
    const interval = setInterval(() => {
      if (saveStateRef.current === "saving") return;
      if (settingsRef.current && saveBaseline.current !== settingsRef.current) return;
      void loadSettings();
    }, 60_000);
    return () => clearInterval(interval);
  }, [loadSettings, visible]);

  const chartQuery = useMemo(() => {
    if (!settings) return null;
    return companionTimelineQuery(settings);
  }, [settings]);

  const loadTimeline = useCallback(async () => {
    if (!chartQuery) return;
    timelineRequest.current?.abort();
    const controller = new AbortController();
    timelineRequest.current = controller;
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      const result = await fetch(`${apiBase}/api/usage/timeline?${chartQuery}`, { signal: controller.signal });
      if (!result.ok) throw new Error(`${result.status} ${result.statusText}`.trim());
      const raw = await result.json() as UsageTimeline;
      const next = settings ? companionTimelineProjection(raw, settings) : raw;
      setTimeline(next);
      setAvailableModels(next.availableModels);
      const currentTotals = new Map<string, number>();
      for (const series of next.series) {
        currentTotals.set(series.id, (currentTotals.get(series.id) ?? 0) + series.total);
      }
      for (const [id, total] of currentTotals) {
        knownTotalsRef.current.set(id, total);
      }
      setKnownTotals(new Map(knownTotalsRef.current));
    } catch (error) {
      if (!controller.signal.aborted) setTimelineError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setTimelineLoading(false);
    }
  }, [settings, apiBase, chartQuery]);

  useEffect(() => {
    if (!visible || !chartQuery) return;
    const timer = setTimeout(() => void loadTimeline(), 250);
    const interval = setInterval(() => void loadTimeline(), 60_000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      timelineRequest.current?.abort();
    };
  }, [chartQuery, loadTimeline, visible]);

  const updateSettings = useCallback((patch: Partial<CompanionSettings>) => {
    if (response?.corrupt) return;
    setSettings(current => current ? { ...current, ...patch } : current);
    setSaveState("saving");
    setSaveError(null);
  }, [response?.corrupt]);

  useEffect(() => {
    if (response?.corrupt || !settings || !saveBaseline.current || saveBaseline.current === settings || saveState !== "saving") return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const patch = buildCompanionSettingsPatch(settings, availableModels);
        const result = await fetch(`${apiBase}/api/companion/settings`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ settings: patch }),
        });
        const body = await result.json() as CompanionSettingsResponse | { error?: string };
        if (!result.ok) throw new Error(body && "error" in body && body.error ? body.error : `${result.status} ${result.statusText}`.trim());
        setResponse(body as CompanionSettingsResponse);
        setFetchedAt(Date.now());
        setSettings((body as CompanionSettingsResponse).settings);
        saveBaseline.current = (body as CompanionSettingsResponse).settings;
        setSaveState("saved");
      } catch (error) {
        setSaveError(errorMessage(error));
        setSaveState("error");
      }
    }, 300);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [apiBase, availableModels, response?.corrupt, saveState, settings]);

  const availableModelsRef = useRef(availableModels);
  useEffect(() => {
    availableModelsRef.current = availableModels;
  }, [availableModels]);

  // Leaving the view (switching to the Usage report tab, navigating away) unmounts the panel, and
  // the cleanup above cancels an edit still inside the 300 ms autosave delay. Send that edit now;
  // `keepalive` lets the request outlive the unmount. A duplicate of an in-flight save is the same
  // settings and harmless.
  useEffect(() => () => {
    const pending = settingsRef.current;
    if (!pending || !saveBaseline.current || saveBaseline.current === pending || saveStateRef.current !== "saving") return;
    void fetch(`${apiBase}/api/companion/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: buildCompanionSettingsPatch(pending, availableModelsRef.current) }),
      keepalive: true,
    }).catch(() => {
      // The panel is gone; the next visit reloads whatever the server kept.
    });
  }, [apiBase]);

  const reset = useCallback(async () => {
    setSaveState("saving");
    setSaveError(null);
    try {
      const result = await fetch(`${apiBase}/api/companion/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      if (!result.ok) throw new Error(`${result.status} ${result.statusText}`.trim());
      await loadSettings();
      setSaveState("saved");
    } catch (error) {
      setSaveError(errorMessage(error));
      setSaveState("error");
    }
  }, [apiBase, loadSettings]);

  const openInBrowser = useCallback(async () => {
    try {
      const path = location.hash ? `/${location.hash}` : "/#/usage";
      const result = await fetch(`${apiBase}/api/companion/open-in-browser`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!result.ok) throw new Error(`${result.status} ${result.statusText}`.trim());
    } catch (error) {
      setSaveError(errorMessage(error));
    }
  }, [apiBase]);

  if (settingsError) {
    return <section ref={rootRef} className="usage-companion-panel"><p role="alert">{t("usage.companion.settingsUnavailable")}</p><button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadSettings()}>{t("common.retry")}</button></section>;
  }
  const current = settings;
  if (!current) {
    return <section ref={rootRef} className="usage-companion-panel" aria-busy="true"><div className="usage-companion-loading">{t("common.loading")}</div></section>;
  }
  const providerNames = providers.map(provider => provider.provider).filter((provider, index, all) => all.indexOf(provider) === index).toSorted();
  const selectedModels = current.models ?? availableModels;
  const selectedModelSet = new Set(selectedModels);
  const modelGroups = groupCompanionModels(availableModels, knownTotals);
  const hiddenProviderSet = new Set(current.hiddenProviders);
  const saveMessage = saveState === "saved" && response?.updatedAt
    ? t("usage.companion.saved", { time: formatSaveTime(response.updatedAt, locale) })
    : saveState === "error" ? t("usage.companion.saveFailed", { error: saveError ?? "" }) : "";
  return (
    <section ref={rootRef} className="usage-companion-panel">
      {response?.corrupt && <div className="usage-companion-save-status is-error" role="alert">
        <span>{t("usage.companion.corrupt")}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reset()} disabled={saveState === "saving"}>{t("usage.companion.corruptReset")}</button>
      </div>}
      <div className="usage-companion-header">
        <div>
          <h3 className="panel-title">{t("usage.companion.title")}</h3>
          <p className="card-sub">{t("usage.companion.description")}</p>
        </div>
        <a className="btn btn-ghost btn-sm" href="https://opencodex.me/guides/macos-menu-bar/" target="_blank" rel="noreferrer">{t("usage.companion.installGuide")}</a>
      </div>
      {(() => {
        const lastSeenAt = response?.companion?.lastSeenAt ?? null;
        const connected = lastSeenAt !== null && fetchedAt !== null && fetchedAt - lastSeenAt <= 10 * 60 * 1000;
        const age = lastSeenAt === null || fetchedAt === null ? "" : formatRelativeTime(lastSeenAt, relativeTimeLabelsFromT(t), fetchedAt);
        const shell = isDesktopShell();
        const shellVersion = desktopShellVersion() ?? __APP_VERSION__;
        const stepKeys = INSTALL_STEP_KEYS[installOs];
        const steps = (
          <ol className="usage-companion-install-steps">
            <li>{t(stepKeys[0])} <a className="btn btn-ghost btn-sm" href="https://github.com/lidge-jun/opencodex/releases/latest" target="_blank" rel="noreferrer">{t("common.github")}</a></li>
            <li>{t(stepKeys[1])}</li>
            <li>{t(stepKeys[2])}</li>
          </ol>
        );
        const installCommand = installOs === "macos"
          ? <code className="usage-companion-install-command">xattr -d com.apple.quarantine /Applications/OpenCodex.app</code>
          : installOs === "linux"
            ? <code className="usage-companion-install-command">chmod +x OpenCodex-*.AppImage</code>
            : null;
        const installGuidance = (
          <details>
            <summary>{t("usage.companion.installAnother")}</summary>
            <OsSelector value={installOs} onChange={setInstallOs} t={t} />
            {steps}
            {installCommand}
          </details>
        );
        if (shell) {
          return (
            <div className="usage-companion-install usage-companion-install--shell">
              <p>{t("usage.companion.runningInDesktop", { version: shellVersion })}</p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openInBrowser()}>{t("usage.companion.openInBrowser")}</button>
              {installGuidance}
            </div>
          );
        }
        return connected ? (
          <div className="usage-companion-install usage-companion-install--connected">
            <div className="usage-companion-install-status"><span className="usage-companion-install-dot" aria-hidden="true" />{t(response?.companion?.kind === "desktop" ? "usage.companion.connectedDesktop" : "usage.companion.connected", { age })}</div>
            {installGuidance}
          </div>
        ) : (
          <details className="usage-companion-install" open>
            <summary>{t("usage.companion.installTitle")}</summary>
            {lastSeenAt !== null && <p className="usage-companion-install-last-seen muted text-caption">{t("usage.companion.lastSeen", { age })}</p>}
            {lastSeenAt === null && <p className="usage-companion-install-last-seen muted text-caption">{t("usage.companion.notConnected")}</p>}
            <OsSelector value={installOs} onChange={setInstallOs} t={t} />
            {steps}
            {installCommand}
          </details>
        );
      })()}
      <UsageCompanionChart timeline={timeline} chartStyle={current.chartStyle} hours={current.chartHours} loading={timelineLoading} error={timelineError} onRetry={() => void loadTimeline()} locale={locale} t={t} />
      {modelGroups.length > 0 && <section className="usage-companion-models">
        <div className="usage-companion-models-header">
          <div>
            <span className="field-label">{t("usage.companion.modelsOnChart")}</span>
            <span className="usage-companion-models-count text-caption muted">{t("usage.companion.modelsCount", { selected: selectedModels.length, total: availableModels.length })}</span>
          </div>
          {current.models !== null && <button type="button" className="btn btn-ghost btn-sm" onClick={() => updateSettings({ models: null })} disabled={response?.corrupt}>{t("usage.companion.modelsShowAll")}</button>}
        </div>
        <div className="usage-companion-models-list">
          {modelGroups.map(group => {
            const selectedCount = group.models.filter(model => selectedModelSet.has(model.id)).length;
            const groupOn = selectedCount === group.models.length;
            return <div key={group.provider} className="usage-companion-model-group">
              <div className="usage-companion-model-group-header">
                <span className="usage-companion-model-provider">{group.provider}</span>
                <span className="usage-companion-model-chip mono text-caption">{group.models.length}</span>
                <Switch
                  on={groupOn}
                  mixed={selectedCount > 0 && !groupOn}
                  onClick={() => updateSettings({ models: toggleCompanionModels(current.models, availableModels, group.models.map(model => model.id), !groupOn) })}
                  disabled={response?.corrupt}
                  label={group.provider}
                  title={group.provider}
                />
              </div>
              {group.models.map(model => {
                const on = selectedModelSet.has(model.id);
                return <div key={model.id} className={`usage-companion-model-row${on ? "" : " is-off"}`}>
                  <Switch
                    on={on}
                    onClick={() => updateSettings({ models: toggleCompanionModels(current.models, availableModels, [model.id], !on) })}
                    disabled={response?.corrupt}
                    label={model.id}
                    title={model.id}
                  />
                  <code className="mono text-control">{model.id}</code>
                  <span className="usage-companion-model-total muted text-caption">{knownTotals.has(model.id) ? formatCompanionTokens(model.total) : "—"}</span>
                </div>;
              })}
            </div>;
          })}
        </div>
      </section>}
      <fieldset className="usage-companion-controls" disabled={response?.corrupt}>
        <Segment label={t("usage.companion.menuBarShows")} value={current.menuBarMetric} options={MENU_METRICS} optionLabel={value => t(MENU_METRIC_KEYS[value])} onChange={value => updateSettings({ menuBarMetric: value })} />
        <Segment label={t("usage.companion.window")} value={current.chartHours} options={WINDOWS} optionLabel={value => t(WINDOW_KEYS[value])} onChange={value => updateSettings({ chartHours: value, bucketMinutes: bucketMinutesForWindow(value) })} />
        <Segment label={t("usage.companion.style")} value={current.chartStyle} options={CHART_STYLES} optionLabel={value => value === "line" ? t("usage.companion.styleLine") : t("usage.companion.styleStacked")} onChange={value => updateSettings({ chartStyle: value })} />
        <SelectControl label={t("usage.companion.metric")} value={current.tokenMetric} options={TOKEN_METRICS} optionLabel={value => t(TOKEN_METRIC_KEYS[value])} onChange={value => updateSettings({ tokenMetric: value })} />
        <SelectControl label={t("usage.companion.groupBy")} value={current.chartGrouping} options={GROUPINGS} optionLabel={value => value === "model" ? t("usage.companion.groupModel") : t("usage.companion.groupAccount")} onChange={value => updateSettings({ chartGrouping: value })} />
        <fieldset className="usage-companion-switches">
          <legend className="field-label">{t("usage.companion.popoverSections")}</legend>
          {SECTION_OPTIONS.map(([key, label]) => (
            <div key={key} className="usage-companion-switch">
              <span>{t(label)}</span>
              <button type="button" className={`toggle ${current[key] ? "on" : ""}`} aria-label={t(label)} aria-pressed={current[key]} onClick={() => updateSettings({ [key]: !current[key] })}><span className="toggle-knob" /></button>
            </div>
          ))}
        </fieldset>
        <details className="usage-companion-advanced">
          <summary>{t("usage.companion.advanced")}</summary>
          <div className="usage-companion-advanced-body">
            <SelectControl label={t("usage.companion.aggregation")} value={current.aggregation} options={AGGREGATIONS} optionLabel={value => t(AGGREGATION_KEYS[value])} onChange={value => updateSettings({ aggregation: value })} />
            <label className="usage-companion-control">
              <span className="field-label">{t("usage.companion.menuText")}</span>
              <input value={current.menuBarTemplate ?? ""} onChange={event => updateSettings({ menuBarTemplate: event.target.value })} maxLength={200} />
              <span className="muted text-caption">{t("usage.companion.placeholders")} <code>{"{requests} {totalTokens} {inputTokens} {outputTokens} {costUsd} {quotaPercent}"}</code></span>
            </label>
            {providerNames.length > 0 && <fieldset className="usage-companion-check-list"><legend className="field-label">{t("usage.companion.hideProviders")}</legend>{providerNames.map(provider => <label key={provider}><input type="checkbox" checked={hiddenProviderSet.has(provider)} onChange={event => updateSettings({ hiddenProviders: event.target.checked ? [...current.hiddenProviders, provider] : current.hiddenProviders.filter(item => item !== provider) })} /> <span>{provider}</span></label>)}</fieldset>}
          </div>
        </details>
      </fieldset>
      <div className={`usage-companion-save-status${saveState === "error" ? " is-error" : ""}`} role={saveState === "error" ? "alert" : "status"}>
        {saveMessage || "\u00a0"}
        {saveState === "error" && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSaveState("saving"); }}>{t("common.retry")}</button>}
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reset()}>{t("usage.companion.reset")}</button>
      <p className="muted text-caption">{t("usage.companion.footer")}</p>
    </section>
  );
}
