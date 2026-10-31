import { useCallback, useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ChartHistogramIcon } from "@hugeicons/core-free-icons";
import { useI18n, type TFn, type Locale } from "../i18n/shared";
import { readUsageResponseJson, UsageReadFailedError } from "../usage-summary-resource";
import { UsageIncompleteNotice } from "../components/usage-incomplete-notice";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { Notice } from "../ui";
import { IconAlert } from "../icons";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { sectionAnchorId } from "../section-anchors";
import { parseUsageTimeRange, type UsageRangeError, type UsageTimeWindow } from "../usage-time-range";
import { Button } from "@/components/ui-v2/button";
import {
  buildHeatmap, lastDays,
  type Range, type UsageDay, type UsageModel, type UsageProvider, type UsageResponse, type UsageSurface,
} from "../components/v2-usage/usage-model";
import { UsageSummaryCards } from "../components/v2-usage/usage-metrics";
import { UsageHeatmapPanel } from "../components/v2-usage/usage-activity";
import { UsageCoveragePanel, UsageModelsTable, UsageProvidersTable } from "../components/v2-usage/usage-breakdown";
import {
  UsageAppliedWindow, UsageFilters, UsageRangePanel, UsageRangeToggle, UsageScopeControl, UsageToolbarRow,
} from "../components/v2-usage/usage-toolbar";
import UsageCompanionView from "./usage-companion-view";
import { readUsageTab, selectUsageTab, usageTabKeyDown } from "./usage-tab-keydown";

class UsageWindowMismatchError extends Error {}

/** Empty report: say so plainly, and when a filter is narrowing it, say that too. */
function UsageEmpty({ filtered, t }: { filtered: boolean; t: TFn }) {
  return (
    <div className="ui-v2 flex flex-col items-center justify-center gap-1 rounded-[12px] bg-surface px-6 py-14 text-center ring-1 ring-line">
      <span className="mb-2 grid size-10 place-items-center rounded-control bg-raised text-fg-muted shadow-sm ring-1 ring-line dark:bg-surface-2" aria-hidden="true">
        <HugeiconsIcon icon={ChartHistogramIcon} size={20} strokeWidth={1.8} />
      </span>
      <p className="m-0 max-w-[48ch] text-[15px] font-medium text-fg text-balance">{t("usage.empty")}</p>
      {filtered && <p className="m-0 max-w-[48ch] text-[13px] text-fg-muted">{t("usageV2.emptyFiltered")}</p>}
    </div>
  );
}

/**
 * The report in reading order: the four headline figures, the daily chart, then the
 * breakdowns. Each section is an anchor (`#usage-section-<id>`), so links into the report keep
 * landing on the right block even though the page no longer carries a section strip.
 */
function UsageWorkspaceBody({
  data,
  range,
  customWindow,
  bars,
  activeDays,
  filteredModels,
  modelQuery,
  onModelQuery,
  sortedProviders,
  filtered,
  locale,
  t,
}: {
  data: UsageResponse | null;
  range: Range;
  customWindow: boolean;
  bars: UsageDay[];
  activeDays: number;
  filteredModels: UsageModel[];
  modelQuery: string;
  onModelQuery: (query: string) => void;
  sortedProviders: UsageProvider[];
  filtered: boolean;
  locale: Locale;
  t: TFn;
}) {
  const heatmap = useMemo(() => buildHeatmap(data?.days ?? [], customWindow), [data?.days, customWindow]);
  if (!data) return null;
  if (data.summary.requests === 0) return <UsageEmpty filtered={filtered} t={t} />;
  // Short presets open on bars; available history and custom intervals open on the calendar.
  const defaultView = customWindow || range === "all" ? "calendar" : "bars";
  const sections = [
    {
      id: "overview",
      body: (
        <>
          <UsageSummaryCards summary={data.summary} days={bars} activeDays={activeDays} locale={locale} t={t} />
          <UsageHeatmapPanel key={`${range}:${customWindow}`} defaultView={defaultView} heatmap={heatmap} bars={bars}
            totalTokens={data.summary.totalTokens} locale={locale} t={t} />
        </>
      ),
    },
    {
      id: "models",
      body: <UsageModelsTable models={filteredModels} totalModels={data.models.length} modelQuery={modelQuery} onModelQuery={onModelQuery} locale={locale} t={t} />,
    },
    { id: "providers", body: <UsageProvidersTable providers={sortedProviders} locale={locale} t={t} /> },
    { id: "coverage", body: <UsageCoveragePanel summary={data.summary} locale={locale} t={t} /> },
  ];
  return (
    <div className="usage-workspace-root">
      <section className="usage-workspace-main flex flex-col gap-4" aria-label={t("usage.workspace.report")}>
        {sections.map(s => (
          <div key={s.id} id={sectionAnchorId("usage", s.id)} className="usw-body usw-section-block flex flex-col gap-4">
            {s.body}
          </div>
        ))}
      </section>
    </div>
  );
}

/** Held usage payloads so provider/surface tab switches skip a cold ~5s refetch. */
const usageMemoryCache = new Map<string, UsageResponse>();

type UsageScope = "machine" | "hub";

function usageCacheKey(apiBase: string, range: Range, surface: UsageSurface, connected: boolean, scope: UsageScope, apiKeyId?: string): string {
  return `ocx.usage.v2:${apiBase}:${connected ? "connected" : "standalone"}:${scope}:${apiKeyId ?? ""}:${range}:${surface}`;
}

function readHeldUsage(apiBase: string, range: Range, surface: UsageSurface, connected: boolean, scope: UsageScope, apiKeyId?: string): UsageResponse | null {
  const key = usageCacheKey(apiBase, range, surface, connected, scope, apiKeyId);
  return usageMemoryCache.get(key) ?? readSessionListCache<UsageResponse>(key);
}

function writeHeldUsage(apiBase: string, range: Range, surface: UsageSurface, connected: boolean, scope: UsageScope, apiKeyId: string | undefined, value: UsageResponse) {
  const key = usageCacheKey(apiBase, range, surface, connected, scope, apiKeyId);
  usageMemoryCache.set(key, value);
  writeSessionListCache(key, value);
}

export default function Usage({ apiBase, connected = false, apiKeyId }: { apiBase: string; connected?: boolean; apiKeyId?: string }) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState(readUsageTab);
  useEffect(() => {
    const onHash = () => setTab(readUsageTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [range, setRange] = useState<Range>("30d");
  const [surface, setSurface] = useState<UsageSurface>("all");
  const [scope, setScope] = useState<UsageScope>("machine");
  const [modelQuery, setModelQuery] = useState("");
  const [draftWindow, setDraftWindow] = useState({ since: "", until: "" });
  const [customWindow, setCustomWindow] = useState<UsageTimeWindow | null>(null);
  const [rangeError, setRangeError] = useState<UsageRangeError | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const since = customWindow?.since;
  const until = customWindow?.until;

  const clearCustomWindow = () => {
    setCustomWindow(null);
    setDraftWindow({ since: "", until: "" });
    setRangeError(null);
  };
  const selectRange = (next: Range) => {
    setRange(next);
    clearCustomWindow();
  };
  const applyCustomWindow = () => {
    const result = parseUsageTimeRange(draftWindow.since, draftWindow.until);
    if (result.ok === false) {
      setRangeError(result.error);
      return;
    }
    setRangeError(null);
    setCustomWindow(result.window);
  };

  const loadUsage = useCallback(async (signal: AbortSignal): Promise<UsageResponse> => {
    const query = new URLSearchParams({ range, surface });
    if (connected && scope === "machine" && apiKeyId) query.set("apiKeyId", apiKeyId);
    if (since !== undefined && until !== undefined) {
      query.set("since", String(since));
      query.set("until", String(until));
    }
    const response = await fetch(`${apiBase}/api/usage?${query}`, { signal });
    const next = await readUsageResponseJson<UsageResponse>(response);
    // HTTP 200 alone does not prove an older daemon honored the custom bounds.
    if (since !== undefined && (next?.customWindow !== true || next.since !== since || next.until !== until)) {
      throw new UsageWindowMismatchError();
    }
    if (since === undefined) writeHeldUsage(apiBase, range, surface, connected, scope, apiKeyId, next);
    return next;
  }, [apiBase, apiKeyId, connected, range, scope, surface, since, until]);

  const presetKey = usageCacheKey(apiBase, range, surface, connected, scope, apiKeyId);
  const resourceKey = customWindow ? JSON.stringify([presetKey, since, until]) : presetKey;
  // Arbitrary custom windows belong only to the subscription-scoped resource store.
  const cached = customWindow ? null : readHeldUsage(apiBase, range, surface, connected, scope, apiKeyId);
  // Range and surface identify different reports, so the key changes with both. That prevents
  // a force-loading dependency revalidation from ever showing a previous report as this one.
  const resource = useDataSurface<UsageResponse>(
    resourceKey,
    [apiBase, apiKeyId, connected, range, scope, surface, since, until],
    loadUsage,
    { isEmpty: () => false, initialData: cached ?? undefined },
  );
  const { state } = resource;
  const data = state.data ?? cached ?? null;

  // The chart, the sparklines and the active-day count all read one series. Presets get a
  // stable zero-filled axis; a custom interval is exactly the civil dates the proxy returned.
  const bars = useMemo(() => {
    const days = data?.days ?? [];
    if (customWindow || range === "all") return days.toSorted((a, b) => a.date.localeCompare(b.date));
    return lastDays(days, range === "7d" ? 7 : 30);
  }, [data?.days, customWindow, range]);
  const activeDays = useMemo(() => (data?.days ?? []).filter(d => d.requests > 0).length, [data?.days]);
  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const models = data?.models ?? [];
    const sorted = models.toSorted((a, b) => b.totalTokens - a.totalTokens);
    if (!q) return sorted.slice(0, 100);
    return sorted.filter(m =>
      m.model.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      (m.resolvedModel ?? "").toLowerCase().includes(q),
    ).slice(0, 100);
  }, [data?.models, modelQuery]);

  const sortedProviders = useMemo(() =>
    (data?.providers ?? []).toSorted((a, b) => b.totalTokens - a.totalTokens),
    [data?.providers],
  );

  return (
    <>
      <div className="page-head usage-head">
        <h2 id="usage-page-title">{t("usage.title")}</h2>
      </div>
      <div className="page-tabs" role="tablist" aria-label={t("nav.usage")}>
        {(["report", "companion"] as const).map(item => (
          <button key={item} type="button" role="tab" id={`usage-tab-${item}`}
            aria-selected={tab === item} aria-controls={`usage-panel-${item}`}
            tabIndex={tab === item ? 0 : -1}
            className={`page-tab${tab === item ? " page-tab--active" : ""}`}
            onClick={() => selectUsageTab(item)} onKeyDown={usageTabKeyDown}>
            {t(item === "report" ? "usage.workspace.report" : "usage.section.companion")}
          </button>
        ))}
      </div>
      {tab === "companion" ? (
        <div role="tabpanel" id="usage-panel-companion" aria-labelledby="usage-tab-companion">
          <UsageCompanionView apiBase={apiBase} providers={data?.providers ?? []} />
        </div>
      ) : <div role="tabpanel" id="usage-panel-report" aria-labelledby="usage-tab-report" className="usage-v2 usage-workspace-shell flex flex-col gap-4">
      <p className="page-sub m-0 text-[13px]">{t("usage.subtitle")}</p>
      {/*
        One toolbar: source, window, and the custom interval as a disclosure at the end of the
        row. An explicit interval is the rare path, so its two date fields open on request; the
        applied interval stays printed under the row so collapsing the form never hides which
        window the totals below actually cover. The hub scope only exists when connected.
      */}
      <section className="usage-range flex flex-col gap-3">
        <UsageToolbarRow>
          <UsageFilters surface={surface} range={customWindow ? null : range} onSurface={setSurface} onRange={selectRange} t={t} />
          <UsageRangeToggle
            open={rangeOpen}
            active={customWindow !== null}
            // A validation failure is only legible next to the fields that caused it, so closing
            // the panel drops it rather than parking an invisible error on the trigger.
            onToggle={() => {
              if (rangeOpen) setRangeError(null);
              setRangeOpen(!rangeOpen);
            }}
            t={t}
          />
          {connected && <div className="ml-auto"><UsageScopeControl scope={scope} onScope={setScope} t={t} /></div>}
          {customWindow && <UsageAppliedWindow window={customWindow} locale={locale} t={t} />}
        </UsageToolbarRow>
        {rangeOpen && (
          <UsageRangePanel
            draft={draftWindow}
            error={rangeError}
            onDraft={patch => {
              setDraftWindow(current => ({ ...current, ...patch }));
              setRangeError(null);
            }}
            onApply={applyCustomWindow}
            onClear={clearCustomWindow}
            t={t}
          />
        )}
      </section>

      {state.showSkeleton && !data ? (
        <DataSurfaceSkeleton label={t("usage.loading")} rows={6} className="usage-v2-skeleton" />
      ) : state.kind === "failed-cold" ? (
        <div className="ui-v2 flex flex-col items-center gap-3 rounded-[12px] bg-surface px-6 py-12 text-center ring-1 ring-line" role="alert">
          <span className="grid size-10 place-items-center rounded-control bg-danger-soft text-danger [&_svg]:size-5" aria-hidden="true"><IconAlert /></span>
          <p className="m-0 max-w-[56ch] text-[14px] text-fg">
            {state.error instanceof UsageWindowMismatchError
              ? `${t("usage.loadError")} ${t("dash.codexRestartMalformed")}`
              : state.error instanceof UsageReadFailedError ? t("usage.loadError")
              : connected ? t("usage.hubOffline") : state.error instanceof Error ? `${t("usage.loadError")} ${state.error.message}` : t("usage.loadError")}
          </p>
          <Button variant="outline" size="sm" onClick={() => resource.refresh()}>{t("common.retry")}</Button>
        </div>
      ) : (
        <>
          {state.showError && (
            <Notice tone="err">
              {t(connected && !(state.error instanceof UsageReadFailedError) ? "usage.hubOffline" : "usage.loadError")}
            </Notice>
          )}
          <UsageIncompleteNotice data={data} />
          {data?.historyTruncated && (
            // Naming the loaded window is the point: without it, `30d` and "Available history"
            // look identical on a busy installation even though both may cover far less than
            // they claim (#1497). `warn` rather than `ok` because a total that silently omits
            // in-range rows is a caveat, not a status update.
            <Notice tone="warn">
              {(() => {
                // Both bounds must be renderable before the detailed wording is used: an older
                // proxy omits the fields entirely, and a hand-edited row can carry a timestamp
                // outside Date's range. Either way the generic string is the honest fallback.
                const start = renderableInstant(data.snapshotWindowStart);
                const end = renderableInstant(data.snapshotWindowEnd);
                return start !== null && end !== null
                  ? t("usage.historyTruncatedWindow", { start, end })
                  : t("usage.historyTruncated");
              })()}
            </Notice>
          )}
          <UsageWorkspaceBody
            data={data}
            range={range}
            customWindow={customWindow !== null}
            bars={bars}
            activeDays={activeDays}
            filteredModels={filteredModels}
            modelQuery={modelQuery}
            onModelQuery={setModelQuery}
            sortedProviders={sortedProviders}
            filtered={surface !== "all" || range !== "all" || customWindow !== null}
            locale={locale}
            t={t}
          />
        </>
      )}
      </div>}
    </>
  );
}
function renderableInstant(value: number | null | undefined): string | null {
  // The reader preserves whatever timestamp a row carries, including hand-edited values far
  // outside Date's supported range. A presence check alone would then render the literal
  // string "Invalid Date" in a notice whose whole job is to be trustworthy, so the bound is
  // only used once it round-trips through Date.
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toLocaleString() : null;
}
