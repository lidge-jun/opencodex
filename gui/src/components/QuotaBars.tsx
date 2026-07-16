import type { TFn } from "../i18n";
import { type AccountQuota, normalizeQuotaForPlan } from "../codex-quota-utils";

/* Helpers are co-located with QuotaBars for overview sorting / stacked layout. */
/* eslint-disable react-refresh/only-export-components */

export type QuotaBarRow = { label: string; limitLabel: string; percent: number; resetAt?: number };

export function buildQuotaRows(quota: AccountQuota | null, plan: string | null | undefined, t: TFn): QuotaBarRow[] {
  const displayQuota = normalizeQuotaForPlan(quota, plan);
  if (!displayQuota) return [];
  const rows: (QuotaBarRow | null)[] = [
    typeof displayQuota.weeklyPercent === "number"
      ? {
          label: t("codexAuth.weekly"),
          limitLabel: t("quota.weeklyLimit"),
          percent: displayQuota.weeklyPercent,
          resetAt: displayQuota.weeklyResetAt,
        }
      : null,
    typeof displayQuota.monthlyPercent === "number"
      ? {
          label: t("codexAuth.monthly"),
          limitLabel: t("quota.monthlyLimit"),
          percent: displayQuota.monthlyPercent,
          resetAt: displayQuota.monthlyResetAt,
        }
      : null,
    ...(displayQuota.customWindows ?? []).map(w => ({
      label: w.label,
      limitLabel: w.label,
      percent: w.percent,
      resetAt: w.resetAt,
    })),
  ];
  return rows.filter((row): row is QuotaBarRow => row !== null);
}

/** Max utilisation across known windows (for sorting providers by urgency). */
export function maxQuotaUtilisation(quota: AccountQuota | null): number {
  if (!quota) return -1;
  const vals = [quota.weeklyPercent, quota.monthlyPercent]
    .filter((n): n is number => typeof n === "number");
  for (const w of quota.customWindows ?? []) {
    if (typeof w.percent === "number") vals.push(w.percent);
  }
  return vals.length ? Math.max(...vals) : -1;
}

export default function QuotaBars({ quota, plan, threshold, t, className, layout = "compact" }: {
  quota: AccountQuota | null;
  plan?: string | null;
  threshold: number;
  t: TFn;
  className?: string;
  /** compact = classic one-line rows; stacked = overview cards with clear reset copy */
  layout?: "compact" | "stacked";
}) {
  const rows = buildQuotaRows(quota, plan, t);
  if (rows.length === 0) return null;
  if (layout === "stacked") {
    return (
      <div className={`quota-stacked${className ? ` ${className}` : ""}`}>
        {rows.map((row, index) => (
          <StackedQuotaRow key={`${row.limitLabel}-${index}`} row={row} threshold={threshold} t={t} />
        ))}
      </div>
    );
  }
  return (
    <div className={`quota-compact${className ? ` ${className}` : ""}`}>
      {rows.map((row, index) => (
        <QuotaRow
          key={`${row.label}-${index}`}
          label={row.label}
          percent={row.percent}
          resetAt={row.resetAt}
          threshold={threshold}
          t={t}
        />
      ))}
    </div>
  );
}

function barWidth(percent: number): number {
  const clamped = Math.max(0, Math.min(100, percent));
  // Tiny usage still shows a visible bar (min ~4%) so 0–2% isn't invisible.
  if (clamped <= 0) return 0;
  return Math.max(4, Math.round(clamped));
}

function QuotaRow({ label, percent, resetAt, threshold, t }: {
  label: string;
  percent: number;
  resetAt?: number;
  threshold: number;
  t: TFn;
}) {
  const color = threshold > 0 && percent >= threshold ? "bar-amber" : "bar-green";
  const reset = formatResetAt(resetAt, t);
  return (
    <div className="quota-row">
      <span className="quota-label">{label}</span>
      <span className="quota-reset-label">{t("codexAuth.resets")}</span>
      <span className="quota-reset-day">{reset.day}</span>
      <span className="quota-reset-time">{reset.time}</span>
      <div className="bar"><div className={`bar-fill ${color}`} style={{ width: `${barWidth(percent)}%` }} /></div>
      <span className="quota-val">{Math.round(percent)}%</span>
    </div>
  );
}

function StackedQuotaRow({ row, threshold, t }: { row: QuotaBarRow; threshold: number; t: TFn }) {
  const color = threshold > 0 && row.percent >= threshold ? "bar-amber" : "bar-green";
  const resetText = formatResetFuture(row.resetAt, t);
  return (
    <div className="quota-stacked-row">
      <div className="quota-stacked-head">
        <span className="quota-stacked-limit">{row.limitLabel}</span>
        <span className="quota-stacked-reset muted">{resetText}</span>
      </div>
      <div className="quota-stacked-bar-row">
        <div className="bar quota-stacked-bar">
          <div className={`bar-fill ${color}`} style={{ width: `${barWidth(row.percent)}%` }} />
        </div>
        <span className="quota-stacked-used">{t("quota.usedPercent", { pct: Math.round(row.percent) })}</span>
      </div>
    </div>
  );
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatResetAt(resetAt: number | undefined, t: TFn): { day: string; time: string } {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return { day: "", time: "" };
  const ms = resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt;
  const date = new Date(ms);
  const now = new Date();
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (isToday) return { day: t("codexAuth.today"), time };
  const day = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "2-digit" }).format(date);
  return { day, time };
}

/** Future-facing reset copy: "Resets in 2 h" near-term; absolute "Resets 23.07., 18:08" beyond that. */
export function formatResetFuture(resetAt: number | undefined, t: TFn, now = Date.now()): string {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return "";
  const ms = resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt;
  const delta = ms - now;
  const absoluteWhen = () => {
    const date = new Date(ms);
    return new Intl.DateTimeFormat(undefined, {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date);
  };
  if (delta <= 0) {
    // Already due — still show absolute time
    return t("quota.resetsAt", { when: absoluteWhen() });
  }
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return t("quota.resetsRelativeMinutes", { n: Math.max(1, minutes) });
  const hours = Math.round(minutes / 60);
  // Day-scale windows need a concrete date+time; "in 7 d" hides when the clock flips.
  if (hours < 36) return t("quota.resetsRelativeHours", { n: hours });
  return t("quota.resetsAt", { when: absoluteWhen() });
}

void clampPercent;
