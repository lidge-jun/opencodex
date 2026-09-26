/**
 * QuotaSummaryBar — always-visible provider quota strip above every page.
 *
 * Self-contained on purpose: App mounts it with one line, and it owns its own read of
 * `/api/provider-quotas` (the same endpoint and 60s cadence Combos uses). It never forces
 * `?refresh=1`, so it adds no upstream quota probes beyond the server's own TTL.
 *
 * The strip is one row at every width. When the chips do not fit, the row scrolls sideways and
 * « / » buttons page it. Each chip is a link to that provider's Accounts tab
 * (`#providers?provider=<name>&tab=accounts`); hovering or keyboard-focusing it shows the
 * per-window detail, and on touch the first tap shows the detail and the second one navigates.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useDataSurface } from "../../data-surface";
import { useI18n, type Locale, type TFn } from "../../i18n/shared";
import { formatProviderDisplayName } from "../../provider-icons";
import { freshQuotaReportsFromResponse, type ProviderQuotaReportView } from "../../provider-workspace/report";
import { openProviderAccounts, providerAccountsHash } from "../../protocol-deep-links";
import { buildQuotaSummary, formatQuotaPercent, type QuotaSummaryRow, type QuotaSummarySeverity, type QuotaSummaryWindow } from "../../quota-summary";
import { formatResetFuture } from "../QuotaBars";
import { publishStickyTop } from "./sticky-top";
import "./quota-summary-bar.css";

interface QuotaSummaryData {
  fetchedAt: number;
  reports: Record<string, ProviderQuotaReportView>;
}

const POLL_MS = 60_000;
/** Gap between the chip and its fixed-position popover, and the popover's viewport margin. */
const POPOVER_GAP = 4;
const VIEWPORT_MARGIN = 8;
/** A « / » press pages the strip by this share of its visible width. */
const PAGE_FRACTION = 0.8;

function formatClock(ms: number, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
  } catch {
    return new Date(ms).toTimeString().slice(0, 5);
  }
}

function windowLabel(window: QuotaSummaryWindow, t: TFn): string {
  return window.labelKey ? t(window.labelKey) : window.label ?? window.id;
}

function severityText(severity: QuotaSummarySeverity, t: TFn): string {
  if (severity === "critical") return t("quotaSummary.critical");
  if (severity === "warn") return t("quotaSummary.warn");
  return "";
}

/** Keyboard focus shows the detail; a mouse click that happens to focus the link does not. */
function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * The list scrolls horizontally, and an `overflow-x: auto` box clips an absolutely positioned
 * child in both axes, so the popover is `position: fixed` and placed from the chip's rect. Any
 * scroll (the list's own, or the page's on mobile where the bar is not sticky) and any resize
 * re-place it so it stays attached to its chip. The mobile stylesheet keeps its own horizontal
 * inset and only reads the vertical coordinate.
 */
function usePopoverPlacement(open: boolean, anchorRef: RefObject<HTMLElement | null>, popoverRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const popover = popoverRef.current;
      if (!anchor || !popover) return;
      const rect = anchor.getBoundingClientRect();
      const width = popover.offsetWidth;
      // clientWidth, not innerWidth: a classic vertical scrollbar would otherwise cover the edge.
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN);
      const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), maxLeft);
      // Unitless: the stylesheet multiplies by 1px.
      popover.style.setProperty("--qs-pop-top", String(Math.round(rect.bottom + POPOVER_GAP)));
      popover.style.setProperty("--qs-pop-left", String(Math.round(left)));
    };
    place();
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, [open, anchorRef, popoverRef]);
}

function QuotaSummaryItem({ row, t, locale }: { row: QuotaSummaryRow; t: TFn; locale: Locale }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  /** Touch has no hover: the first tap opens the detail here, the second one navigates. */
  const [tapped, setTapped] = useState(false);
  /**
   * After a click the pointer still rests on the chip; keep the detail closed until the pointer
   * leaves or the keyboard focuses the chip afresh. Blur alone must not lift it, or moving focus
   * away would reopen the detail under a pointer that never moved.
   */
  const [suppressed, setSuppressed] = useState(false);
  const rootRef = useRef<HTMLLIElement>(null);
  const chipRef = useRef<HTMLAnchorElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const pointerTypeRef = useRef<string>("");
  const popoverId = useId();
  const open = !suppressed && (hovered || focused || tapped);

  const close = useCallback(() => {
    setHovered(false);
    setFocused(false);
    setTapped(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setTapped(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  usePopoverPlacement(open, chipRef, popoverRef);

  const onPointerEnter = (event: ReactPointerEvent) => {
    if (event.pointerType !== "touch") setHovered(true);
  };
  const onPointerLeave = (event: ReactPointerEvent) => {
    if (event.pointerType !== "touch") setHovered(false);
    setSuppressed(false);
  };
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Modified and middle clicks keep the browser's own link behavior (new tab/window).
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    // Read once and forget, so a later keyboard Enter is never mistaken for a tap.
    const viaTouch = pointerTypeRef.current === "touch";
    pointerTypeRef.current = "";
    if (viaTouch && !open) {
      setTapped(true);
      return;
    }
    close();
    // Only a resting mouse pointer needs the detail held shut; a finger has already lifted, and
    // suppressing there would leave nothing to lift it, making the chip inert to later taps.
    if (!viaTouch) setSuppressed(true);
    openProviderAccounts(row.provider);
  };

  const { headline } = row;
  const warning = severityText(row.severity, t);
  return (
    <li
      ref={rootRef}
      className={`quota-summary-item quota-summary-item--${row.severity}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <a
        ref={chipRef}
        href={`#${providerAccountsHash(row.provider)}`}
        className={`quota-summary-chip${open ? " quota-summary-chip--open" : ""}`}
        aria-describedby={open ? popoverId : undefined}
        onPointerDown={event => { pointerTypeRef.current = event.pointerType; }}
        onFocus={event => {
          if (!isKeyboardFocus(event.currentTarget)) return;
          setSuppressed(false);
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onClick={onClick}
      >
        <span className="quota-summary-name">{row.label}</span>
        <span className="quota-summary-pct">{formatQuotaPercent(headline.percent)}</span>
        {warning && <span className="quota-summary-flag" aria-hidden="true">!</span>}
        {warning && <span className="sr-only">{warning}</span>}
        <span className="sr-only">{t("quotaSummary.openAccounts")}</span>
      </a>
      {open && (
        <div ref={popoverRef} id={popoverId} className="quota-summary-popover" role="tooltip">
          <div className="quota-summary-popover-head">
            <strong>{row.label}</strong>
            {warning && <span className={`quota-summary-badge quota-summary-badge--${row.severity}`}>{warning}</span>}
          </div>
          <table className="quota-summary-table">
            <tbody>
              {row.windows.map(window => (
                <tr key={window.id} className={`quota-summary-row--${window.severity}`}>
                  <th scope="row">{windowLabel(window, t)}</th>
                  <td className="quota-summary-row-pct">{formatQuotaPercent(window.percent)}</td>
                  <td className="quota-summary-row-reset">
                    {window.resetAt !== undefined ? formatResetFuture(window.resetAt, t, locale) : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="quota-summary-popover-foot">
            {row.updatedAt !== undefined && (
              <span>{t(row.observed ? "quotaSummary.observedAt" : "quotaSummary.dataAt", { time: formatClock(row.updatedAt, locale) })}</span>
            )}
            <span className="quota-summary-popover-hint">{t("quotaSummary.openAccounts")}</span>
          </div>
        </div>
      )}
    </li>
  );
}

interface ScrollEdges {
  overflow: boolean;
  atStart: boolean;
  atEnd: boolean;
}

const NO_OVERFLOW: ScrollEdges = { overflow: false, atStart: true, atEnd: true };

/**
 * The provider chips on one scrolling row with « / » paging. Exported for tests; the bar
 * supplies the rows it derived from `/api/provider-quotas`.
 */
export function QuotaSummaryChips({ rows, t, locale }: { rows: QuotaSummaryRow[]; t: TFn; locale: Locale }) {
  const listRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState<ScrollEdges>(NO_OVERFLOW);

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const max = list.scrollWidth - list.clientWidth;
    const next: ScrollEdges = max > 1
      ? { overflow: true, atStart: list.scrollLeft <= 1, atEnd: list.scrollLeft >= max - 1 }
      : NO_OVERFLOW;
    setEdges(previous => (
      previous.overflow === next.overflow && previous.atStart === next.atStart && previous.atEnd === next.atEnd
        ? previous
        : next
    ));
  }, []);

  // Chips can widen without the list box changing size (a new provider, a longer percent, a late
  // web font), so the observer watches every chip as well as the list, and the row signature
  // re-measures on the next frame for chips that arrive with the new rows.
  const rowsKey = rows.map(row => `${row.provider}:${row.label}:${formatQuotaPercent(row.headline.percent)}:${row.severity}`).join("|");
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const frame = requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    observer?.observe(list);
    for (const chip of Array.from(list.children)) observer?.observe(chip);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [measure, rowsKey]);

  const page = (direction: -1 | 1) => {
    const list = listRef.current;
    if (!list) return;
    // Read the live metrics: the stored edges can lag a layout change the observers missed.
    const max = list.scrollWidth - list.clientWidth;
    if (direction < 0 ? list.scrollLeft <= 1 : list.scrollLeft >= max - 1) {
      measure();
      return;
    }
    const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollBy({ left: direction * Math.max(list.clientWidth * PAGE_FRACTION, 80), behavior: reduceMotion ? "auto" : "smooth" });
  };

  // aria-disabled, not disabled: a focused button that becomes disabled drops focus to <body>,
  // so paging to the end with the keyboard would restart Tab order at the top of the page.
  return (
    <div className={`quota-summary-scroller${edges.overflow ? " quota-summary-scroller--overflow" : ""}`}>
      {edges.overflow && (
        <button
          type="button"
          className="quota-summary-scroll quota-summary-scroll--prev"
          aria-label={t("quotaSummary.scrollPrev")}
          title={t("quotaSummary.scrollPrev")}
          aria-disabled={edges.atStart}
          onClick={() => page(-1)}
        >
          <span aria-hidden="true">«</span>
        </button>
      )}
      <ul ref={listRef} className="quota-summary-list" onScroll={measure}>
        {rows.map(row => <QuotaSummaryItem key={row.provider} row={row} t={t} locale={locale} />)}
      </ul>
      {edges.overflow && (
        <button
          type="button"
          className="quota-summary-scroll quota-summary-scroll--next"
          aria-label={t("quotaSummary.scrollNext")}
          title={t("quotaSummary.scrollNext")}
          aria-disabled={edges.atEnd}
          onClick={() => page(1)}
        >
          <span aria-hidden="true">»</span>
        </button>
      )}
    </div>
  );
}

export default function QuotaSummaryBar({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const load = useCallback(async (signal: AbortSignal): Promise<QuotaSummaryData> => {
    const response = await fetch(`${apiBase}/api/provider-quotas`, { signal });
    if (!response.ok) throw new Error("quota summary load failed");
    const body = await response.json() as { reports?: unknown } | null;
    return { fetchedAt: Date.now(), reports: freshQuotaReportsFromResponse(body?.reports) };
  }, [apiBase]);
  const resource = useDataSurface<QuotaSummaryData>(
    `ocx.quota-summary.provider-quotas.v1:${apiBase}`,
    [apiBase],
    load,
    { isEmpty: data => Object.keys(data.reports).length === 0, pollMs: POLL_MS, pauseWhenHidden: true },
  );

  const data = resource.data;
  if (!data) return null;
  const rows = buildQuotaSummary(data.reports, provider => formatProviderDisplayName(provider, t));
  if (rows.length === 0) return null;
  const stale = !resource.lastAttemptOk;

  return (
    <section className="quota-summary-bar" aria-label={t("quotaSummary.aria")} ref={publishStickyTop}>
      <QuotaSummaryChips rows={rows} t={t} locale={locale} />
      <span
        className={`quota-summary-updated${stale ? " quota-summary-updated--stale" : ""}`}
        title={stale ? t("quotaSummary.refreshFailed") : undefined}
      >
        {t("quotaSummary.updated", { time: formatClock(data.fetchedAt, locale) })}
      </span>
      {/*
        Always mounted so the announcement survives the transition: an element that is
        inserted already carrying its text is not reliably read out, so the failure and
        the recovery would otherwise both go unannounced. Only this span is a live
        region — the timestamp beside it changes every 60s and would not stop talking.
      */}
      <span className="sr-only" role="status" aria-live="polite">
        {stale ? t("quotaSummary.refreshFailed") : ""}
      </span>
    </section>
  );
}
