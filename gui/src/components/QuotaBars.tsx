import type { TFn } from "../i18n/shared";
import { type AccountQuota, normalizeQuotaForPlan } from "../codex-quota-utils";

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const DAY_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" });

export default function QuotaBars({ quota, plan, threshold, t, className }: {
  quota: AccountQuota | null;
  plan?: string | null;
  threshold: number;
  t: TFn;
  className?: string;
}) {
  const displayQuota = normalizeQuotaForPlan(quota, plan);
  if (!displayQuota) return null;
  const rows = [
    typeof displayQuota.weeklyPercent === "number"
      ? { label: t("codexAuth.weekly"), percent: displayQuota.weeklyPercent, resetAt: displayQuota.weeklyResetAt }
      : null,
    typeof displayQuota.monthlyPercent === "number"
      ? { label: t("codexAuth.monthly"), percent: displayQuota.monthlyPercent, resetAt: displayQuota.monthlyResetAt }
      : null,
    ...(displayQuota.customWindows ?? []),
  ].filter((row): row is { label: string; percent: number; resetAt?: number } => row !== null);
  if (rows.length === 0) return null;
  return (
    <div className={`quota-compact${className ? ` ${className}` : ""}`}>
      {rows.map(row => (
        <QuotaRow
          key={`${row.label}-${row.resetAt ?? "none"}-${row.percent}`}
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
      <div className="bar"><div className={`bar-fill ${color}`} style={{ width: `${clampPercent(percent)}%` }} /></div>
      <span className="quota-val">{Math.round(percent)}%</span>
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
  const time = TIME_FORMATTER.format(date);
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (isToday) return { day: t("codexAuth.today"), time };
  return { day: DAY_FORMATTER.format(date), time };
}
