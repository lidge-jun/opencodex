import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useI18n } from "../i18n/shared";
import { UsageCompanionChart } from "./usage-companion-chart";
import {
  bucketMinutesForWindow,
  buildCompanionSettingsPatch,
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

function formatSaveTime(value: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(value);
}

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  return String(value);
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
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
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
  providers: CompanionProvider[];
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveBaseline = useRef<CompanionSettings | null>(null);
  const timelineRequest = useRef<AbortController | null>(null);

  const loadSettings = useCallback(async () => {
    setSettingsError(null);
    try {
      const result = await fetch(`${apiBase}/api/companion/settings`);
      if (!result.ok) throw new Error(`${result.status} ${result.statusText}`.trim());
      const next = await result.json() as CompanionSettingsResponse;
      setResponse(next);
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

  const chartQuery = useMemo(() => {
    if (!settings) return null;
    const query = new URLSearchParams({
      hours: String(settings.chartHours),
      bucketMinutes: String(settings.bucketMinutes),
      metric: settings.tokenMetric,
      aggregation: settings.aggregation,
      grouping: settings.chartGrouping,
    });
    if (settings.models?.length) query.set("models", settings.models.join(","));
    return query;
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
      const next = await result.json() as UsageTimeline;
      setTimeline(next);
      setAvailableModels(next.availableModels);
    } catch (error) {
      if (!controller.signal.aborted) setTimelineError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setTimelineLoading(false);
    }
  }, [apiBase, chartQuery]);

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
    setSettings(current => current ? { ...current, ...patch } : current);
    setSaveState("saving");
    setSaveError(null);
  }, []);

  useEffect(() => {
    if (!settings || !saveBaseline.current || saveBaseline.current === settings || saveState !== "saving") return;
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
  }, [apiBase, availableModels, saveState, settings]);

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
      const next = await result.json() as CompanionSettingsResponse;
      setResponse(next);
      setSettings(next.settings);
      saveBaseline.current = next.settings;
      onSettingsLoaded?.(next.settings.menuBarMetric);
      setSaveState("saved");
    } catch (error) {
      setSaveError(errorMessage(error));
      setSaveState("error");
    }
  }, [apiBase, onSettingsLoaded]);

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
  const hiddenProviderSet = new Set(current.hiddenProviders);
  const saveMessage = saveState === "saved" && response?.updatedAt
    ? t("usage.companion.saved", { time: formatSaveTime(response.updatedAt, locale) })
    : saveState === "error" ? t("usage.companion.saveFailed", { error: saveError ?? "" }) : "";
  return (
    <section ref={rootRef} className="usage-companion-panel">
      <div className="usage-companion-header">
        <div>
          <h3 className="panel-title">{t("usage.companion.title")}</h3>
          <p className="card-sub">{t("usage.companion.description")}</p>
        </div>
        <a className="btn btn-ghost btn-sm" href="https://opencodex.me/guides/macos-menu-bar/" target="_blank" rel="noreferrer">{t("usage.companion.installGuide")}</a>
      </div>
      <UsageCompanionChart timeline={timeline} chartStyle={current.chartStyle} hours={current.chartHours} loading={timelineLoading} error={timelineError} onRetry={() => void loadTimeline()} locale={locale} t={t} />
      <div className="usage-companion-controls">
        <Segment label={t("usage.companion.menuBarShows")} value={current.menuBarMetric} options={MENU_METRICS} optionLabel={value => t(`usage.companion.menu${value[0]!.toUpperCase()}${value.slice(1)}` as never)} onChange={value => updateSettings({ menuBarMetric: value })} />
        <Segment label={t("usage.companion.window")} value={current.chartHours} options={WINDOWS} optionLabel={value => t(`usage.companion.window${value}` as never)} onChange={value => updateSettings({ chartHours: value, bucketMinutes: bucketMinutesForWindow(value) })} />
        <Segment label={t("usage.companion.style")} value={current.chartStyle} options={CHART_STYLES} optionLabel={value => value === "line" ? t("usage.companion.styleLine") : t("usage.companion.styleStacked")} onChange={value => updateSettings({ chartStyle: value })} />
        <SelectControl label={t("usage.companion.metric")} value={current.tokenMetric} options={TOKEN_METRICS} optionLabel={value => t(`usage.companion.metric${value[0]!.toUpperCase()}${value.slice(1)}` as never)} onChange={value => updateSettings({ tokenMetric: value })} />
        <SelectControl label={t("usage.companion.groupBy")} value={current.chartGrouping} options={GROUPINGS} optionLabel={value => value === "model" ? t("usage.companion.groupModel") : t("usage.companion.groupAccount")} onChange={value => updateSettings({ chartGrouping: value })} />
        <fieldset className="usage-companion-switches">
          <legend className="field-label">{t("usage.companion.popoverSections")}</legend>
          {([
            ["showToday", "today"],
            ["showChart", "chart"],
            ["showModels", "models"],
            ["showCost", "cost"],
            ["showAccounts", "accounts"],
          ] as const).map(([key, label]) => (
            <div key={key} className="usage-companion-switch">
              <span>{t(`usage.companion.section${label[0]!.toUpperCase()}${label.slice(1)}` as never)}</span>
              <button type="button" className={`toggle ${current[key] ? "on" : ""}`} aria-label={t(`usage.companion.section${label[0]!.toUpperCase()}${label.slice(1)}` as never)} aria-pressed={current[key]} onClick={() => updateSettings({ [key]: !current[key] })}><span className="toggle-knob" /></button>
            </div>
          ))}
        </fieldset>
        <details className="usage-companion-advanced">
          <summary>{t("usage.companion.advanced")}</summary>
          <div className="usage-companion-advanced-body">
            <SelectControl label={t("usage.companion.aggregation")} value={current.aggregation} options={AGGREGATIONS} optionLabel={value => t(`usage.companion.aggregation${value[0]!.toUpperCase()}${value.slice(1)}` as never)} onChange={value => updateSettings({ aggregation: value })} />
            <label className="usage-companion-control">
              <span className="field-label">{t("usage.companion.menuText")}</span>
              <input value={current.menuBarTemplate ?? ""} onChange={event => updateSettings({ menuBarTemplate: event.target.value })} maxLength={200} />
              <span className="muted text-caption">{t("usage.companion.placeholders")} <code>{"{requests} {totalTokens} {inputTokens} {outputTokens} {costUsd} {quotaPercent}"}</code></span>
            </label>
            {availableModels.length > 0 && <fieldset className="usage-companion-check-list"><legend className="field-label">{t("usage.companion.modelsOnChart")}</legend>{availableModels.map(model => <label key={model}><input type="checkbox" checked={selectedModelSet.has(model)} onChange={event => updateSettings({ models: event.target.checked ? [...selectedModels, model] : selectedModels.filter(item => item !== model) })} /> <span>{model}</span></label>)}</fieldset>}
            {providerNames.length > 0 && <fieldset className="usage-companion-check-list"><legend className="field-label">{t("usage.companion.hideProviders")}</legend>{providerNames.map(provider => <label key={provider}><input type="checkbox" checked={hiddenProviderSet.has(provider)} onChange={event => updateSettings({ hiddenProviders: event.target.checked ? [...current.hiddenProviders, provider] : current.hiddenProviders.filter(item => item !== provider) })} /> <span>{provider}</span></label>)}</fieldset>}
          </div>
        </details>
      </div>
      <div className={`usage-companion-save-status${saveState === "error" ? " is-error" : ""}`} role={saveState === "error" ? "alert" : "status"}>
        {saveMessage || "\u00a0"}
        {saveState === "error" && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSaveState("saving"); }}>{t("common.retry")}</button>}
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void reset()}>{t("usage.companion.reset")}</button>
      <p className="muted text-caption">{t("usage.companion.footer")}</p>
    </section>
  );
}
