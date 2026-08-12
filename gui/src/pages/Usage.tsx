import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n, type TFn, type Locale } from "../i18n/shared";
import { formatProviderDisplayName } from "../provider-icons";
import { formatTokens } from "../format-tokens";
import { formatEstimatedUsdValue as formatUsdEstimate } from "../intl-formatters";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { EmptyState, Notice } from "../ui";
import { modelLabel } from "../model-display";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { SectionTabs } from "../components/section-tabs";
import { sectionAnchorId } from "../section-anchors";

type Range = "all" | "30d" | "7d";
type UsageSurface = "all" | "codex" | "claude" | "grok";

interface UsageSummaryTotals {
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
  estimatedCostUsd?: number;
  pricedRequests?: number;
  unpricedRequests?: number;
  unmeteredRequests?: number;
}

interface UsageDay {
  date: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  totalTokens: number;
  models: UsageDayModel[];
}

interface UsageDayModel {
  model: string;
  provider: string;
  requests: number;
  totalTokens: number;
}

interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
}

interface UsageProvider {
  provider: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  shareRatio: number;
}

interface UsageResponse {
  range: Range;
  surface: UsageSurface;
  since: number | null;
  generatedAt: number;
  summary: UsageSummaryTotals;
  days: UsageDay[];
  models: UsageModel[];
  providers: UsageProvider[];
  historyTruncated: boolean;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
  // Bounds of the rows the bounded reader loaded, before any range or surface filtering.
  // Describes the read, not the query, and is never a completeness claim (#1497).
  // Optional because a dashboard can talk to a proxy that predates these fields.
  snapshotWindowStart?: number | null;
  snapshotWindowEnd?: number | null;
  error?: string;
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

// Stable per-model bar color: hash the provider/model id to a hue so the same model keeps its color
// across days and renders. Saturation/lightness are fixed for a cohesive palette on the dark chart.
function modelColor(model: string, provider: string): string {
  const key = `${provider}/${model}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 55%)`;
}

// Last 7 calendar days (oldest → newest), zero-filled, for the 7d bar chart. The API's `days` only
// carries dates with activity, so missing days are backfilled to 0 to keep a stable 7-bar axis.
function lastSevenDays(days: UsageDay[]): UsageDay[] {
  const byDate = new Map(days.map(d => [d.date, d]));
  const out: UsageDay[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - 6);
  for (let i = 0; i < 7; i++) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const d = byDate.get(iso);
    out.push({
      date: iso,
      requests: d?.requests ?? 0,
      measuredRequests: d?.measuredRequests ?? 0,
      reportedRequests: d?.reportedRequests ?? 0,
      totalTokens: d?.totalTokens ?? 0,
      models: d?.models ?? [],
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function quantileBuckets(values: number[]): number[] {
  const positive = values.filter(v => v > 0).sort((a, b) => a - b);
  if (positive.length === 0) return [0, 0, 0, 0];
  const q = (p: number) => positive[Math.min(positive.length - 1, Math.floor(p * positive.length))];
  return [q(0.25), q(0.5), q(0.75), q(0.95)];
}

function bucketLevel(value: number, buckets: number[]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (value <= buckets[0]) return 1;
  if (value <= buckets[1]) return 2;
  if (value <= buckets[2]) return 3;
  return 4;
}

interface HeatmapCell {
  date: string;
  requests: number;
  totalTokens: number;
  level: 0 | 1 | 2 | 3 | 4;
  dayOfWeek: number;
}

function buildHeatmap(days: UsageDay[]): { weeks: HeatmapCell[][]; months: { label: string; col: number }[]; buckets: number[] } {
  const buckets = quantileBuckets(days.map(d => d.totalTokens));
  const dayMap = new Map(days.map(d => [d.date, d]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  // Align to Sunday
  start.setDate(start.getDate() - start.getDay());

  const weeks: HeatmapCell[][] = [];
  const months: { label: string; col: number }[] = [];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let lastMonthCol = -4;
  let prevMonthIdx = -1;
  let week: HeatmapCell[] = [];
  const cursor = new Date(start);

  while (cursor <= today) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const m = cursor.getMonth();
    if (cursor.getDay() === 0 && m !== prevMonthIdx && weeks.length - lastMonthCol >= 4) {
      months.push({ label: monthNames[m], col: weeks.length });
      lastMonthCol = weeks.length;
      prevMonthIdx = m;
    }
    const d = dayMap.get(iso);
    week.push({
      date: iso,
      requests: d?.requests ?? 0,
      totalTokens: d?.totalTokens ?? 0,
      level: d ? bucketLevel(d.totalTokens, buckets) : 0,
      dayOfWeek: cursor.getDay(),
    });
    if (cursor.getDay() === 6) {
      weeks.push(week);
      week = [];
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  if (week.length > 0) {
    while (week.length < 7) {
      week.push({ date: "", requests: 0, totalTokens: 0, level: 0, dayOfWeek: week.length });
    }
    weeks.push(week);
  }
  return { weeks, months, buckets };
}

function UsageFilters({
  surface,
  range,
  onSurface,
  onRange,
  t,
}: {
  surface: UsageSurface;
  range: Range;
  onSurface: (surface: UsageSurface) => void;
  onRange: (range: Range) => void;
  t: TFn;
}) {
  return (
    <div className="usage-filters">
      <div className="usage-segmented" role="group" aria-label={t("logs.filter.surface.label")}>
        {(["all", "codex", "claude", "grok"] as UsageSurface[]).map(choice => {
          const label = t(`logs.filter.surface.${choice}`);
          return (
            <button
              key={choice}
              type="button"
              className={`usage-segmented-btn usage-source-btn${surface === choice ? " active" : ""}`}
              aria-label={label}
              aria-pressed={surface === choice}
              onClick={() => onSurface(choice)}
            >
              {choice === "codex" && (
                <img className="usage-source-mark" src="/provider-icons/openai.svg" alt="" aria-hidden="true" />
              )}
              {choice === "claude" && (
                <img className="usage-source-mark" src="/provider-icons/claude-color.svg" alt="" aria-hidden="true" />
              )}
              {choice === "grok" && (
                <img className="usage-source-mark usage-source-mark--mono" src="/provider-icons/grok.svg" alt="" aria-hidden="true" />
              )}
              <span className={choice === "all" ? "usage-source-label" : "usage-source-label usage-source-label-collapsible"}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
      <div className="usage-segmented" role="group" aria-label={t("usage.title")}>
        {(["all", "30d", "7d"] as Range[]).map(choice => {
          const label = choice === "all" ? t("usage.range.available") : t(`usage.range.${choice}`);
          return (
            <button
              key={choice}
              type="button"
              className={`usage-segmented-btn${range === choice ? " active" : ""}`}
              aria-label={label}
              aria-pressed={range === choice}
              onClick={() => onRange(choice)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UsageSummaryCards({
  summary,
  activeDays,
  locale,
  t,
}: {
  summary: UsageSummaryTotals;
  activeDays: number;
  locale: Locale;
  t: TFn;
}) {
  return (
    <>
    <div className="usage-cards usage-cards-3x2" role="group" aria-label={t("usage.title")}>
      <div className="stat"><div className="muted">{t("usage.card.requests")}</div><div className="stat-value">{summary.requests}</div></div>
      <div className="stat"><div className="muted">{t("usage.card.measured")}</div><div className="stat-value">{summary.measuredRequests}</div></div>
      <div className="stat"><div className="muted">{t("usage.card.totalTokens")}</div><div className="stat-value">{formatTokens(summary.totalTokens, locale)}</div></div>
      <div className="stat" title={t("usage.card.cachedTokensHint")}>
        <div className="muted">{t("usage.card.cachedTokens")}</div>
        <div className="stat-value">{formatTokens(summary.cacheReadInputTokens ?? summary.cachedInputTokens, locale)}</div>
        {(summary.cacheCreationInputTokens ?? 0) > 0 && (
          <div className="muted text-caption">
            {t("usage.card.cacheWriteTokens")}: {formatTokens(summary.cacheCreationInputTokens ?? 0, locale)}
          </div>
        )}
      </div>
      <div className="stat"><div className="muted">{t("usage.card.coverage")}</div><div className="stat-value">{formatPct(summary.coverageRatio)}</div></div>
      <div className="stat"><div className="muted">{t("usage.card.activeDays")}</div><div className="stat-value">{activeDays}</div></div>
    </div>
      {summary.estimatedCostUsd !== undefined && (
        <div className="usage-cost-row" role="note">
          <span className="muted">{t("usage.cost.total")}</span>
          <span className="stat-value mono usage-cost-value">
            {formatUsdEstimate(summary.estimatedCostUsd, locale)}
          </span>
          <span className="muted text-caption">{t("usage.cost.disclaimer")}</span>
          {((summary.unpricedRequests ?? 0) + (summary.unmeteredRequests ?? 0)) > 0 && (
            <span className="muted text-caption">
              {t("usage.cost.unpricedNote").replace("{count}", String((summary.unpricedRequests ?? 0) + (summary.unmeteredRequests ?? 0)))}
            </span>
          )}
        </div>
      )}
    </>
  );
}

function WeekDayBars({ weekBars, locale, t }: { weekBars: UsageDay[]; locale: Locale; t: TFn }) {
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const max = Math.max(1, ...weekBars.map(day => day.totalTokens));

  return (
    <div className="daybars" role="img" aria-label={t("usage.section.heatmap")}>
      {weekBars.map(day => {
        const percentage = Math.round((day.totalTokens / max) * 100);
        const label = day.date.slice(5);
        return (
          <div
            key={day.date}
            className="daybar"
            onMouseEnter={() => setHoverDay(day.date)}
            onMouseLeave={() => setHoverDay(current => (current === day.date ? null : current))}
          >
            <div className="daybar-track">
              <div
                className="daybar-stack"
                style={{ ["--daybar-scale" as string]: String(Math.max(0, Math.min(1, percentage / 100))) }}
              >
                {day.models.map(model => (
                  <div
                    key={`${model.provider}/${model.model}`}
                    className="daybar-seg"
                    style={{ flexGrow: model.totalTokens, background: modelColor(model.model, model.provider) }}
                  />
                ))}
                {day.models.length === 0 && day.totalTokens > 0 && (
                  <div className="daybar-seg" style={{ flexGrow: 1, background: "var(--green)" }} />
                )}
              </div>
            </div>
            {hoverDay === day.date && day.totalTokens > 0 && (
              <div className="daybar-tip" role="tooltip">
                <div className="daybar-tip-date">{day.date}</div>
                {day.models.slice(0, 8).map(model => (
                  <div key={`${model.provider}/${model.model}`} className="daybar-tip-row">
                    <span className="daybar-tip-swatch" style={{ background: modelColor(model.model, model.provider) }} />
                    <span className="daybar-tip-name">{modelLabel(model.model)}</span>
                    <span className="daybar-tip-val">{formatTokens(model.totalTokens, locale)}</span>
                  </div>
                ))}
              </div>
            )}
            <span className="daybar-count">{formatTokens(day.totalTokens, locale)}</span>
            <span className="daybar-label muted">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function UsageHeatmapPanel({
  range,
  heatmap,
  weekBars,
  locale,
  t,
}: {
  range: Range;
  heatmap: ReturnType<typeof buildHeatmap>;
  weekBars: UsageDay[];
  locale: Locale;
  t: TFn;
}) {
  const heatmapRef = useRef<HTMLDivElement | null>(null);
  const [hoverCell, setHoverCell] = useState<{ weekIndex: number; dayIndex: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const element = heatmapRef.current;
    if (!element) return;
    const pinRight = () => { element.scrollLeft = element.scrollWidth; };
    pinRight();
    const observer = new ResizeObserver(pinRight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [heatmap, range]);

  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="usage-heatmap-title">
      <h3 id="usage-heatmap-title" className="panel-title">{t("usage.section.heatmap")}</h3>
      {range === "7d" ? (
        <WeekDayBars weekBars={weekBars} locale={locale} t={t} />
      ) : (
        <div className="heatmap" ref={heatmapRef} role="img" aria-labelledby="usage-heatmap-title">
          <div className="heatmap-months" style={{ gridTemplateColumns: `28px repeat(${heatmap.weeks.length}, calc(var(--hm-cell) + var(--hm-gap)))` }}>
            <span className="heatmap-day-spacer" />
            {heatmap.months.map(month => (
              <span key={`${month.label}-${month.col}`} className="heatmap-month" style={{ gridColumn: month.col + 2 }}>{month.label}</span>
            ))}
          </div>
          <div className="heatmap-body">
            <div className="heatmap-days">
              <span /><span>{t("usage.dayMon")}</span><span /><span>{t("usage.dayWed")}</span><span /><span>{t("usage.dayFri")}</span><span />
            </div>
            <div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${heatmap.weeks.length}, var(--hm-cell))` }}>
              {heatmap.weeks.map((week, weekIndex) => (
                <div key={week[0]?.date || `week-${weekIndex}`} className="heatmap-week">
                  {week.map((cell, dayIndex) => (
                    <div
                      key={cell.date || `pad-${weekIndex}-${dayIndex}`}
                      className={`heatmap-cell heatmap-cell-${cell.level}`}
                      onMouseEnter={event => {
                        if (!cell.date) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        setHoverCell({ weekIndex, dayIndex, x: rect.left + rect.width / 2, y: rect.top });
                      }}
                      onMouseLeave={() => setHoverCell(current => (
                        current?.weekIndex === weekIndex && current.dayIndex === dayIndex ? null : current
                      ))}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          {hoverCell && (() => {
            const cell = heatmap.weeks[hoverCell.weekIndex]?.[hoverCell.dayIndex];
            if (!cell?.date) return null;
            return (
              <div className="heatmap-tip" role="tooltip" style={{ left: hoverCell.x, top: hoverCell.y }}>
                <div className="heatmap-tip-date">{cell.date}</div>
                <div className="heatmap-tip-val">{t("usage.heatmap.tooltipTokens", { tokens: formatTokens(cell.totalTokens, locale) })}</div>
                <div className="heatmap-tip-req muted">{t("usage.heatmap.tooltipRequests", { requests: cell.requests })}</div>
              </div>
            );
          })()}
          <div className="heatmap-legend muted">
            <span>{t("usage.heatmap.less")}</span>
            {[0, 1, 2, 3, 4].map(level => <span key={level} className={`heatmap-cell heatmap-cell-${level}`} />)}
            <span>{t("usage.heatmap.more")}</span>
          </div>
        </div>
      )}
    </section>
  );
}

function UsageWorkspaceSection({
  title,
  titleId,
  children,
}: {
  title: string;
  titleId: string;
  children: ReactNode;
}) {
  return (
    <section className="usw-section" aria-labelledby={titleId}>
      <h3 id={titleId} className="h-section">{title}</h3>
      {children}
    </section>
  );
}

function UsageModelsTable({
  models,
  modelQuery,
  onModelQuery,
  locale,
  t,
  workspace = false,
}: {
  models: UsageModel[];
  modelQuery: string;
  onModelQuery: (query: string) => void;
  locale: Locale;
  t: TFn;
  workspace?: boolean;
}) {
  const searchLabel = t("usage.search.models");
  const sectionLabel = t("usage.section.models");
  const titleId = "usage-models-title";
  const searchInput = (
    <input
      className="input"
      aria-label={searchLabel}
      placeholder={searchLabel}
      value={modelQuery}
      onChange={event => onModelQuery(event.target.value)}
    />
  );
  const table = (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>{t("logs.col.model")}</th>
            <th>{t("logs.col.provider")}</th>
            <th className="num">{t("usage.col.requests")}</th>
            <th className="num">{t("usage.col.measured")}</th>
            <th className="num">{t("usage.col.tokens")}</th>
            <th>{t("usage.col.share")}</th>
          </tr>
        </thead>
        <tbody>
          {models.map(model => (
            <tr key={`${model.provider}/${model.model}`}>
              <td className="mono">{modelLabel(model.model)}</td>
              <td className="muted">{formatProviderDisplayName(model.provider, t)}</td>
              <td className="num">{model.requests}</td>
              <td className="num">{model.measuredRequests}</td>
              <td className="num mono">{formatTokens(model.totalTokens, locale)}</td>
              <td><div className="usage-bar"><div className="usage-bar-fill" style={{ width: `${Math.round(model.shareRatio * 100)}%` }} /></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (workspace) {
    return (
      <UsageWorkspaceSection title={sectionLabel} titleId={titleId}>
        <div className="usw-section-toolbar">{searchInput}</div>
        {table}
      </UsageWorkspaceSection>
    );
  }

  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby={titleId}>
      <div className="panel-head">
        <h3 id={titleId} className="panel-title">{sectionLabel}</h3>
        {searchInput}
      </div>
      {table}
    </section>
  );
}

function UsageProvidersTable({
  providers,
  locale,
  t,
  workspace = false,
}: {
  providers: UsageProvider[];
  locale: Locale;
  t: TFn;
  workspace?: boolean;
}) {
  const sectionLabel = t("usage.section.providers");
  const titleId = "usage-providers-title";
  const table = (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>{t("logs.col.provider")}</th>
            <th className="num">{t("usage.col.requests")}</th>
            <th className="num">{t("usage.col.measured")}</th>
            <th className="num">{t("usage.col.tokens")}</th>
            <th>{t("usage.col.share")}</th>
          </tr>
        </thead>
        <tbody>
          {providers.map(provider => (
            <tr key={provider.provider}>
              <td className="mono">{formatProviderDisplayName(provider.provider, t)}</td>
              <td className="num">{provider.requests}</td>
              <td className="num">{provider.measuredRequests}</td>
              <td className="num mono">{formatTokens(provider.totalTokens, locale)}</td>
              <td><div className="usage-bar"><div className="usage-bar-fill" style={{ width: `${Math.round(provider.shareRatio * 100)}%` }} /></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (workspace) {
    return (
      <UsageWorkspaceSection title={sectionLabel} titleId={titleId}>
        {table}
      </UsageWorkspaceSection>
    );
  }

  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby={titleId}>
      <h3 id={titleId} className="panel-title">{sectionLabel}</h3>
      {table}
    </section>
  );
}

function UsageCoveragePanel({
  summary,
  t,
  workspace = false,
}: {
  summary: UsageSummaryTotals;
  t: TFn;
  workspace?: boolean;
}) {
  const sectionLabel = t("usage.section.coverage");
  const titleId = "usage-coverage-title";
  const body = (
    <>
      <div className="usage-cards usage-cards-3x2">
        <div className="stat"><div className="muted">{t("usage.coverage.measured")}</div><div className="stat-value">{summary.measuredRequests}</div></div>
        <div className="stat"><div className="muted">{t("usage.coverage.reported")}</div><div className="stat-value">{summary.reportedRequests}</div></div>
        <div className="stat"><div className="muted">{t("usage.coverage.estimated")}</div><div className="stat-value">{summary.estimatedRequests}</div></div>
        <div className="stat"><div className="muted">{t("logs.tokens.unreported")}</div><div className="stat-value">{summary.unreportedRequests}</div></div>
        <div className="stat"><div className="muted">{t("logs.tokens.unsupported")}</div><div className="stat-value">{summary.unsupportedRequests}</div></div>
      </div>
      <p className="muted text-control" style={{ marginTop: 12 }}>{t("usage.coverage.note")}</p>
    </>
  );

  if (workspace) {
    return (
      <UsageWorkspaceSection title={sectionLabel} titleId={titleId}>
        {body}
      </UsageWorkspaceSection>
    );
  }

  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby={titleId}>
      <h3 id={titleId} className="panel-title">{sectionLabel}</h3>
      {body}
    </section>
  );
}

/**
 * Workspace layout for Usage: left rail picks one report section so Overview /
 * Models / Providers / Coverage do not stack into a long scroll.
 */
function UsageWorkspaceBody({
  data,
  heatmap,
  weekBars,
  activeDays,
  filteredModels,
  modelQuery,
  onModelQuery,
  sortedProviders,
  range,
  locale,
  t,
}: {
  data: UsageResponse | null;
  heatmap: ReturnType<typeof buildHeatmap>;
  weekBars: UsageDay[];
  activeDays: number;
  filteredModels: UsageModel[];
  modelQuery: string;
  onModelQuery: (query: string) => void;
  sortedProviders: UsageProvider[];
  range: Range;
  locale: Locale;
  t: TFn;
}) {
  const empty = !!data && data.summary.requests === 0;
  const sections = [
    {
      id: "overview",
      label: t("usage.section.overview"),
      meta: data ? `${data.summary.requests}` : "—",
      body: data ? (
        <>
          <UsageSummaryCards summary={data.summary} activeDays={activeDays} locale={locale} t={t} />
          <UsageHeatmapPanel range={range} heatmap={heatmap} weekBars={weekBars} locale={locale} t={t} />
        </>
      ) : null,
    },
    {
      id: "models",
      label: t("usage.section.models"),
      meta: data ? `${data.models.length}` : "—",
      body: data
        ? <UsageModelsTable models={filteredModels} modelQuery={modelQuery} onModelQuery={onModelQuery} locale={locale} t={t} workspace />
        : null,
    },
    {
      id: "providers",
      label: t("usage.section.providers"),
      meta: data ? `${data.providers.length}` : "—",
      body: data
        ? <UsageProvidersTable providers={sortedProviders} locale={locale} t={t} workspace />
        : null,
    },
    {
      id: "coverage",
      label: t("usage.section.coverage"),
      meta: data ? formatPct(data.summary.coverageRatio) : "—",
      body: data ? <UsageCoveragePanel summary={data.summary} t={t} workspace /> : null,
    },
  ];
  return (
    <div className="usage-workspace-shell">
      <div className="usage-workspace-root">
        {/*
          Every section stays in the document and the page scrolls; the pinned strip scrolls
          to one instead of swapping the panel. Switching by replacement meant only one
          section existed at a time, so the report could not be read by scrolling at all.
        */}
        <SectionTabs
          scope="usage"
          ariaLabel={t("usage.workspace.sections")}
          items={sections.map(s => ({ id: s.id, label: s.label, meta: s.meta }))}
        />
        <section className="usage-workspace-main" aria-label={t("usage.workspace.report")}>
          {empty ? <EmptyState title={t("usage.empty")} /> : sections.map(s => (
            <div key={s.id} id={sectionAnchorId("usage", s.id)} className="usw-body usw-section-block">
              {s.body}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

/** Held usage payloads so provider/surface tab switches skip a cold ~5s refetch. */
const usageMemoryCache = new Map<string, UsageResponse>();

function usageCacheKey(apiBase: string, range: Range, surface: UsageSurface): string {
  return `ocx.usage.v1:${apiBase}:${range}:${surface}`;
}

function readHeldUsage(apiBase: string, range: Range, surface: UsageSurface): UsageResponse | null {
  const key = usageCacheKey(apiBase, range, surface);
  return usageMemoryCache.get(key) ?? readSessionListCache<UsageResponse>(key);
}

function writeHeldUsage(apiBase: string, range: Range, surface: UsageSurface, value: UsageResponse) {
  const key = usageCacheKey(apiBase, range, surface);
  usageMemoryCache.set(key, value);
  writeSessionListCache(key, value);
}

export default function Usage({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<Range>("30d");
  const [surface, setSurface] = useState<UsageSurface>("all");
  const [modelQuery, setModelQuery] = useState("");

  const loadUsage = useCallback(async (signal: AbortSignal): Promise<UsageResponse> => {
    const response = await fetch(`${apiBase}/api/usage?range=${range}&surface=${surface}`, { signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
    const next = await response.json() as UsageResponse;
    writeHeldUsage(apiBase, range, surface, next);
    return next;
  }, [apiBase, range, surface]);

  const resourceKey = usageCacheKey(apiBase, range, surface);
  const cached = readHeldUsage(apiBase, range, surface);
  // Range and surface identify different reports, so the key changes with both. That prevents
  // a force-loading dependency revalidation from ever showing a previous report as this one.
  const resource = useDataSurface<UsageResponse>(
    resourceKey,
    [apiBase, range, surface],
    loadUsage,
    { isEmpty: () => false, initialData: cached ?? undefined },
  );
  const { state } = resource;
  const data = state.data ?? cached ?? null;

  const heatmap = useMemo(() => buildHeatmap(data?.days ?? []), [data?.days]);
  const weekBars = useMemo(() => lastSevenDays(data?.days ?? []), [data?.days]);
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
        <UsageFilters surface={surface} range={range} onSurface={setSurface} onRange={setRange} t={t} />
      </div>
      <p className="page-sub">{t("usage.subtitle")}</p>

      {state.showSkeleton && !data ? (
        <DataSurfaceSkeleton label={t("usage.loading")} rows={5} />
      ) : state.kind === "failed-cold" ? (
        <Notice tone="err">
          {state.error instanceof Error ? `${t("usage.loadError")} ${state.error.message}` : t("usage.loadError")}{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh()}>
            {t("common.retry")}
          </button>
        </Notice>
      ) : (
        <>
          {state.showError && <Notice tone="err">{t("usage.loadError")}</Notice>}
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
            heatmap={heatmap}
            weekBars={weekBars}
            activeDays={activeDays}
            filteredModels={filteredModels}
            modelQuery={modelQuery}
            onModelQuery={setModelQuery}
            sortedProviders={sortedProviders}
            range={range}
            locale={locale}
            t={t}
          />
        </>
      )}
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
