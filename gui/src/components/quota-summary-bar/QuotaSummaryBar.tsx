/**
 * QuotaSummaryBar — always-visible provider quota strip above every page.
 *
 * Self-contained on purpose: App mounts it with one line, and it owns its own read of
 * `/api/provider-quotas` (the same endpoint and 60s cadence Combos uses). It never forces
 * `?refresh=1`, so it adds no upstream quota probes beyond the server's own TTL.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useDataSurface } from "../../data-surface";
import { useI18n, type Locale, type TFn } from "../../i18n/shared";
import { formatProviderDisplayName } from "../../provider-icons";
import { freshQuotaReportsFromResponse, type ProviderQuotaReportView } from "../../provider-workspace/report";
import { buildQuotaSummary, formatQuotaPercent, type QuotaSummaryRow, type QuotaSummarySeverity, type QuotaSummaryWindow } from "../../quota-summary";
import { formatResetFuture } from "../QuotaBars";
import "./quota-summary-bar.css";

interface QuotaSummaryData {
  fetchedAt: number;
  reports: Record<string, ProviderQuotaReportView>;
}

const POLL_MS = 60_000;

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

function QuotaSummaryItem({ row, t, locale }: { row: QuotaSummaryRow; t: TFn; locale: Locale }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLLIElement>(null);
  const popoverId = useId();
  const open = hovered || pinned;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setPinned(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setPinned(false); setHovered(false); }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const { headline } = row;
  const warning = severityText(row.severity, t);
  return (
    <li
      ref={rootRef}
      className={`quota-summary-item quota-summary-item--${row.severity}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className="quota-summary-chip"
        aria-expanded={open}
        aria-controls={popoverId}
        title={`${row.label} · ${windowLabel(headline, t)}`}
        onClick={() => {
          // A click while pinned must close the popover even though the pointer still hovers the chip.
          if (pinned) { setPinned(false); setHovered(false); } else { setPinned(true); }
        }}
      >
        <span className="quota-summary-name">{row.label}</span>
        <span className="quota-summary-pct">{formatQuotaPercent(headline.percent)}</span>
        {warning && <span className="quota-summary-flag" aria-hidden="true">!</span>}
        {warning && <span className="sr-only">{warning}</span>}
      </button>
      {open && (
        <div id={popoverId} className="quota-summary-popover" role="group" aria-label={row.label}>
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
          {row.updatedAt !== undefined && (
            <div className="quota-summary-popover-foot">
              {t(row.observed ? "quotaSummary.observedAt" : "quotaSummary.dataAt", { time: formatClock(row.updatedAt, locale) })}
            </div>
          )}
        </div>
      )}
    </li>
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
    <section className="quota-summary-bar" aria-label={t("quotaSummary.aria")}>
      <ul className="quota-summary-list">
        {rows.map(row => <QuotaSummaryItem key={row.provider} row={row} t={t} locale={locale} />)}
      </ul>
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
