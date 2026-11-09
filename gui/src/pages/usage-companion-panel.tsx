import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useI18n } from "../i18n/shared";
import { hostOs } from "../lib/desktop-shell";
import { Button } from "@/components/ui-v2/button";
import { cn } from "@/lib/utils";
import { UsageCompanionChart } from "./usage-companion-chart";
import { CompanionCard, CompanionInstall, CompanionModels, CompanionSettingsForm, type InstallOs } from "./usage-companion-sections";
import {
  companionTimelineQuery,
  companionTimelineProjection,
  buildCompanionSettingsPatch,
  groupCompanionModels,
  type CompanionSettings,
  type CompanionSettingsResponse,
  type UsageTimeline,
} from "./usage-companion-utils";

interface CompanionProvider {
  provider: string;
}

function formatSaveTime(value: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(value);
}

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message;
  return String(value);
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
    return (
      <section ref={rootRef} className="usage-companion-panel">
        <CompanionCard>
          <div className="flex flex-wrap items-center justify-between gap-3" role="alert">
            <p className="m-0 text-[14px] text-fg">{t("usage.companion.settingsUnavailable")}</p>
            <Button variant="outline" size="sm" onClick={() => void loadSettings()}>{t("common.retry")}</Button>
          </div>
        </CompanionCard>
      </section>
    );
  }
  const current = settings;
  if (!current) {
    return (
      <section ref={rootRef} className="usage-companion-panel" aria-busy="true">
        <div className="usage-companion-loading grid min-h-40 place-items-center rounded-[12px] bg-surface text-[13px] text-fg-muted ring-1 ring-line">{t("common.loading")}</div>
      </section>
    );
  }
  const providerNames = providers.map(provider => provider.provider).filter((provider, index, all) => all.indexOf(provider) === index).toSorted();
  const modelGroups = groupCompanionModels(availableModels, knownTotals);
  const saveMessage = saveState === "saved" && response?.updatedAt
    ? t("usage.companion.saved", { time: formatSaveTime(response.updatedAt, locale) })
    : saveState === "error" ? t("usage.companion.saveFailed", { error: saveError ?? "" }) : "";
  const corrupt = response?.corrupt === true;
  return (
    <section ref={rootRef} className="usage-companion-panel flex flex-col gap-4">
      {corrupt && (
        <div className="usage-companion-save-status is-error flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-danger-soft px-4 py-3 text-[13px] text-danger" role="alert">
          <span>{t("usage.companion.corrupt")}</span>
          <Button variant="outline" size="sm" onClick={() => void reset()} disabled={saveState === "saving"}>{t("usage.companion.corruptReset")}</Button>
        </div>
      )}
      <CompanionInstall response={response} fetchedAt={fetchedAt} installOs={installOs} onInstallOs={setInstallOs}
        onOpenInBrowser={() => void openInBrowser()} t={t} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
        <CompanionCard title={t("usageV2.companionPreview")}>
          <UsageCompanionChart timeline={timeline} chartStyle={current.chartStyle} hours={current.chartHours} loading={timelineLoading} error={timelineError} onRetry={() => void loadTimeline()} locale={locale} t={t} />
          {modelGroups.length > 0 && (
            <CompanionModels groups={modelGroups} current={current} availableModels={availableModels} knownTotals={knownTotals}
              disabled={corrupt} onUpdate={updateSettings} t={t} />
          )}
        </CompanionCard>
        <CompanionCard title={t("usageV2.companionSettings")}>
          <CompanionSettingsForm current={current} disabled={corrupt} providerNames={providerNames} onUpdate={updateSettings} t={t} />
        </CompanionCard>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className={cn("usage-companion-save-status flex min-h-8 items-center gap-2 text-[13px]", saveState === "error" ? "is-error text-danger" : "text-fg-muted")}
          role={saveState === "error" ? "alert" : "status"}>
          {saveMessage || "\u00a0"}
          {saveState === "error" && <Button variant="ghost" size="sm" onClick={() => { setSaveState("saving"); }}>{t("common.retry")}</Button>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => void reset()}>{t("usage.companion.reset")}</Button>
      </div>
      <p className="m-0 px-1 text-xs text-fg-subtle">{t("usage.companion.footer")}</p>
    </section>
  );
}
