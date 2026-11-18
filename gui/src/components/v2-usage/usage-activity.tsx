import { createPortal } from "react-dom";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { Locale, TFn } from "../../i18n/shared";
import { formatTokens } from "../../format-tokens";
import { modelLabel } from "../../model-display";
import { SegmentedControl } from "@/components/ui-v2/segmented-control";
import { cn } from "@/lib/utils";
import {
  chartTipPosition, dayDetail, formatCalendarDate, niceCeiling,
  type Heatmap, type HeatmapCell, type UsageDay,
} from "./usage-model";

/*
 * Daily activity: one large chart (React Bits Pro dashboard-10). Short windows read best as
 * bars on a labelled axis; the long ones (available history, a custom interval) open on the
 * calendar heatmap. Either view is one click away whatever the window.
 */

export type ActivityView = "bars" | "calendar";

function UsageChartOverlay({ anchor, className, children }: { anchor: DOMRect; className: string; children: ReactNode }) {
  return createPortal(
    <div className={`${className} chart-overlay`} role="tooltip" style={chartTipPosition(anchor)}>{children}</div>,
    document.body,
  );
}

function DayBars({ bars, locale, t }: { bars: UsageDay[]; locale: Locale; t: TFn }) {
  const [active, setActive] = useState<{ date: string; anchor: DOMRect } | null>(null);
  const ceiling = niceCeiling(Math.max(0, ...bars.map(day => day.totalTokens)));
  const ticks = [ceiling, ceiling / 2, 0];
  const activeDay = bars.find(day => day.date === active?.date);
  const few = bars.length <= 7;
  // Roughly eight date labels however many bars there are, always including the latest day.
  const every = Math.max(1, Math.ceil(bars.length / 8));
  const showLabel = (index: number) => few || (bars.length - 1 - index) % every === 0;
  // On a narrow chart only every other label fits; the rest return once there is room.
  const coarse = (index: number) => few || (bars.length - 1 - index) % (every * 2) === 0;
  const label = (date: string) => new Intl.DateTimeFormat(locale, few ? { weekday: "short" } : { month: "numeric", day: "numeric" })
    .format(new Date(`${date}T12:00:00`));
  const show = (day: UsageDay, element: HTMLElement) => setActive({ date: day.date, anchor: element.getBoundingClientRect() });

  return (
    <div className="@container flex flex-col gap-2">
      <div className="flex gap-3">
        <div className="-my-2 flex h-[220px] w-12 shrink-0 flex-col justify-between text-right text-[11px] text-fg-subtle tabular-nums" aria-hidden="true">
          {ticks.map(tick => <span key={tick}>{formatTokens(tick, locale)}</span>)}
        </div>
        <div className="relative h-[220px] min-w-0 flex-1">
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden="true">
            {ticks.map(tick => <span key={tick} className={cn("block h-px w-full", tick === 0 ? "bg-line-strong" : "bg-line")} />)}
          </div>
          <div
            className={cn("daybars absolute inset-0 flex h-auto items-stretch p-0", bars.length > 40 ? "gap-px" : few ? "gap-3" : "gap-1")}
            role="group"
            aria-label={t("usage.section.heatmap")}
          >
            {bars.map(day => {
              const pct = Math.max(0, Math.min(100, (day.totalTokens / ceiling) * 100));
              const selected = active?.date === day.date;
              return (
                <button
                  type="button"
                  key={day.date}
                  className="daybar group relative flex h-full min-w-0 flex-1 cursor-pointer flex-col items-center justify-end gap-0 rounded-[4px] p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight"
                  aria-label={dayDetail(day, locale, t)}
                  onFocus={event => show(day, event.currentTarget)}
                  onBlur={() => setActive(current => current?.date === day.date ? null : current)}
                  onPointerEnter={event => show(day, event.currentTarget)}
                  onPointerDown={event => show(day, event.currentTarget)}
                  onPointerLeave={event => {
                    if (event.pointerType !== "touch" && document.activeElement !== event.currentTarget) {
                      setActive(current => current?.date === day.date ? null : current);
                    }
                  }}
                >
                  <span className="absolute inset-x-0 inset-y-0 rounded-[4px] bg-transparent transition-colors group-hover:bg-surface-2/60" aria-hidden="true" />
                  {few && day.totalTokens > 0 && (
                    <span className="daybar-count absolute left-1/2 -translate-x-1/2 text-[11px] font-medium text-fg-muted tabular-nums"
                      style={{ bottom: `calc(${pct}% + 4px)` }}>
                      {formatTokens(day.totalTokens, locale)}
                    </span>
                  )}
                  <span
                    className={cn(
                      "relative block w-full max-w-12 rounded-t-[3px] transition-colors",
                      day.totalTokens > 0 ? "min-h-[2px]" : "min-h-0",
                      selected ? "bg-fg" : "bg-fg/70 group-hover:bg-fg",
                    )}
                    style={{ height: `${pct}%` }}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flex gap-3" aria-hidden="true">
        <div className="w-12 shrink-0" />
        <div className={cn("flex min-w-0 flex-1", bars.length > 40 ? "gap-px" : few ? "gap-3" : "gap-1")}>
          {bars.map((day, index) => (
            <span key={day.date} className="daybar-label relative min-w-0 flex-1 text-center text-[11px] text-fg-subtle tabular-nums">
              {showLabel(index) && (
                <span className={cn(!few && "absolute left-1/2 -translate-x-1/2 whitespace-nowrap", !coarse(index) && "hidden @xl:inline")}>{label(day.date)}</span>
              )}
            </span>
          ))}
        </div>
      </div>
      {active && activeDay && (
        <UsageChartOverlay className="daybar-tip" anchor={active.anchor}>
          <div className="daybar-tip-date">{formatCalendarDate(activeDay.date, locale)}</div>
          <div className="daybar-tip-row">
            <span>{t("usage.heatmap.tooltipRequests", { requests: activeDay.requests })}</span>
            <span className="daybar-tip-val">{t("usage.heatmap.tooltipTokens", { tokens: formatTokens(activeDay.totalTokens, locale) })}</span>
          </div>
          {activeDay.models.slice(0, 8).map(model => (
            <div key={`${model.provider}/${model.model}`} className="daybar-tip-row">
              <span className="daybar-tip-name">{modelLabel(model.model)}</span>
              <span className="daybar-tip-val">{formatTokens(model.totalTokens, locale)}</span>
            </div>
          ))}
        </UsageChartOverlay>
      )}
    </div>
  );
}

/** Short month names in the viewer's language ("Jan", "1월", "janv.", …), not a fixed English list. */
const monthFormat = (locale: Locale) => new Intl.DateTimeFormat(locale, { month: "short" });

function CalendarHeatmap({ heatmap, locale, t }: { heatmap: Heatmap; locale: Locale; t: TFn }) {
  const heatmapRef = useRef<HTMLDivElement | null>(null);
  const cells = useMemo(() => heatmap.weeks.flat().filter(cell => cell.date), [heatmap]);
  const [selectedDate, setSelectedDate] = useState(() => cells.at(-1)?.date ?? "");
  const [tip, setTip] = useState<{ date: string; anchor: DOMRect } | null>(null);
  const hintId = useId();
  const rovingDate = cells.some(cell => cell.date === selectedDate) ? selectedDate : (cells.at(-1)?.date ?? "");

  const selectCell = (cell: HeatmapCell, element: HTMLElement) => {
    setSelectedDate(cell.date);
    setTip({ date: cell.date, anchor: element.getBoundingClientRect() });
  };

  const onCellKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, cell: HeatmapCell) => {
    const index = cells.findIndex(candidate => candidate.date === cell.date);
    const offset = event.key === "ArrowUp" ? -1
      : event.key === "ArrowDown" ? 1
        : event.key === "ArrowLeft" ? -7
          : event.key === "ArrowRight" ? 7
            : 0;
    if (!offset || index < 0) return;
    event.preventDefault();
    const next = cells[Math.max(0, Math.min(cells.length - 1, index + offset))]!;
    setSelectedDate(next.date);
    const element = heatmapRef.current?.querySelector<HTMLElement>(`[data-date="${next.date}"]`);
    if (element) {
      element.focus();
      setTip({ date: next.date, anchor: element.getBoundingClientRect() });
    }
  };

  useEffect(() => {
    const element = heatmapRef.current;
    if (!element) return;
    const pinRight = () => { element.scrollLeft = element.scrollWidth; };
    pinRight();
    const observer = new ResizeObserver(pinRight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [heatmap]);

  const rovingCell = cells.find(cell => cell.date === rovingDate);
  return (
    <div className="heatmap usage-v2-heatmap" ref={heatmapRef}>
      <div className="heatmap-months" style={{ gridTemplateColumns: `28px repeat(${heatmap.weeks.length}, calc(var(--hm-cell) + var(--hm-gap)))` }}>
        <span className="heatmap-day-spacer" />
        {heatmap.months.map(month => (
          <span key={`${month.month}-${month.col}`} className="heatmap-month" style={{ gridColumn: month.col + 2 }}>
            {monthFormat(locale).format(new Date(2000, month.month, 1))}
          </span>
        ))}
      </div>
      <div className="heatmap-body">
        <div className="heatmap-days">
          <span /><span>{t("usage.dayMon")}</span><span /><span>{t("usage.dayWed")}</span><span /><span>{t("usage.dayFri")}</span><span />
        </div>
        <div
          className="heatmap-grid"
          role="group"
          aria-labelledby="usage-heatmap-title"
          aria-describedby={hintId}
          style={{ gridTemplateColumns: `repeat(${heatmap.weeks.length}, var(--hm-cell))` }}
        >
          {heatmap.weeks.map((week, weekIndex) => (
            <div key={week[0]?.date || `week-${weekIndex}`} className="heatmap-week">
              {week.map((cell, dayIndex) => cell.date ? (
                <button
                  type="button"
                  key={cell.date}
                  className={`heatmap-cell heatmap-cell-${cell.level}`}
                  data-date={cell.date}
                  tabIndex={rovingDate === cell.date ? 0 : -1}
                  aria-label={dayDetail(cell, locale, t)}
                  onFocus={event => selectCell(cell, event.currentTarget)}
                  onBlur={() => setTip(current => current?.date === cell.date ? null : current)}
                  onKeyDown={event => onCellKeyDown(event, cell)}
                  onPointerEnter={event => selectCell(cell, event.currentTarget)}
                  onPointerDown={event => selectCell(cell, event.currentTarget)}
                  onPointerLeave={event => {
                    if (event.pointerType !== "touch" && document.activeElement !== event.currentTarget) {
                      setTip(current => current?.date === cell.date ? null : current);
                    }
                  }}
                />
              ) : (
                <span key={`pad-${weekIndex}-${dayIndex}`} className="heatmap-cell heatmap-cell-0" aria-hidden="true" />
              ))}
            </div>
          ))}
        </div>
      </div>
      <span id={hintId} className="sr-only">{t("usage.heatmap.keyboardLabel")}</span>
      <span className="sr-only" aria-live="polite">{rovingCell ? dayDetail(rovingCell, locale, t) : ""}</span>
      {tip && (() => {
        const cell = cells.find(candidate => candidate.date === tip.date);
        if (!cell?.date) return null;
        return (
          <UsageChartOverlay className="heatmap-tip" anchor={tip.anchor}>
            <div className="heatmap-tip-date">{formatCalendarDate(cell.date, locale)}</div>
            <div className="heatmap-tip-val">{t("usage.heatmap.tooltipTokens", { tokens: formatTokens(cell.totalTokens, locale) })}</div>
            <div className="heatmap-tip-req muted">{t("usage.heatmap.tooltipRequests", { requests: cell.requests })}</div>
          </UsageChartOverlay>
        );
      })()}
      <div className="heatmap-legend muted">
        <span>{t("usage.heatmap.less")}</span>
        {[0, 1, 2, 3, 4].map(level => <span key={level} className={`heatmap-cell heatmap-cell-${level}`} />)}
        <span>{t("usage.heatmap.more")}</span>
      </div>
    </div>
  );
}

export function UsageHeatmapPanel({
  defaultView,
  heatmap,
  bars,
  totalTokens,
  locale,
  t,
}: {
  defaultView: ActivityView;
  heatmap: Heatmap;
  bars: UsageDay[];
  totalTokens: number;
  locale: Locale;
  t: TFn;
}) {
  const [view, setView] = useState<ActivityView>(defaultView);
  return (
    <section className="flex flex-col gap-4 rounded-[12px] bg-surface p-5 ring-1 ring-line" aria-labelledby="usage-heatmap-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id="usage-heatmap-title" className="m-0 text-[15px] font-semibold text-fg">{t("usage.section.heatmap")}</h3>
          <span className="text-[13px] text-fg-muted tabular-nums">
            {t("usageV2.chartCaption", { tokens: formatTokens(totalTokens, locale) })}
          </span>
        </div>
        <SegmentedControl
          size="sm"
          aria-label={t("usageV2.chartView")}
          value={view}
          onChange={setView}
          items={[
            { value: "bars", label: t("usageV2.viewBars") },
            { value: "calendar", label: t("usageV2.viewCalendar") },
          ]}
        />
      </div>
      {view === "bars"
        ? <DayBars bars={bars} locale={locale} t={t} />
        : <CalendarHeatmap heatmap={heatmap} locale={locale} t={t} />}
    </section>
  );
}
