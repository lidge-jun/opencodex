import type { Locale, TFn } from "../i18n";
import { useI18n } from "../i18n";
import { IconAlert } from "../icons";
import { type AccountQuota, normalizeQuotaForPlan } from "../codex-quota-utils";

/* Helpers are co-located with QuotaBars for overview sorting / stacked layout. */
/* eslint-disable react-refresh/only-export-components */

export type QuotaBarRow = { label: string; limitLabel: string; percent: number; resetAt?: number };

export function buildQuotaRows(quota: AccountQuota | null, plan: string | null | undefined, t: TFn): QuotaBarRow[] {
  const displayQuota = normalizeQuotaForPlan(quota, plan);
  if (!displayQuota) return [];
  const rows: (QuotaBarRow | null)[] = [
    typeof displayQuota.fiveHourPercent === "number"
      ? {
          label: t("codexAuth.fiveHour"),
          limitLabel: t("quota.fiveHourLimit"),
          percent: displayQuota.fiveHourPercent,
          resetAt: displayQuota.fiveHourResetAt,
        }
      : null,
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
    ...(displayQuota.customWindows ?? [])
      .slice()
      .sort((a, b) => customWindowBaseRank(a.label) - customWindowBaseRank(b.label))
      .map(w => {
        const localized = localizeCustomQuotaLabel(w.label, t);
        return {
          label: localized,
          limitLabel: localized,
          percent: w.percent,
          resetAt: w.resetAt,
        };
      }),
  ];
  // Prefer shorter windows first (5h before weekly), including custom labels like "5 hour".
  return rows
    .filter((row): row is QuotaBarRow => row !== null)
    .sort((a, b) => quotaWindowRank(a) - quotaWindowRank(b));
}

function localizeCustomQuotaLabel(label: string, t: TFn): string {
  switch (label) {
    case "First-party models":
      return t("quota.cursorFirstParty");
    case "API usage":
      return t("quota.cursorApiUsage");
    default:
      return label;
  }
}

function customWindowBaseRank(label: string): number {
  switch (label) {
    case "First-party models":
      return 0;
    case "API usage":
      return 1;
    default:
      return 50;
  }
}

function quotaWindowRank(row: QuotaBarRow): number {
  const s = `${row.label} ${row.limitLabel}`.toLowerCase();
  // Anthropic reports the short window as customWindows label "5h" (not fiveHourPercent).
  if (s.includes("5h") || s.includes("five hour") || s.includes("5-stunden") || s.includes("5 stunden")) return 0;
  if (s.includes("week") || s.includes("wochen")) return 1;
  // Cursor linked pools (also match localized labels).
  if (
    s.includes("first-party")
    || s.includes("first party")
    || s.includes("erstanbieter")
    || s.includes("자사")
    || s.includes("官方")
  ) return 2;
  if (s.includes("api")) return 3;
  if (s.includes("month") || s.includes("monat") || /\b30\b/.test(s)) return 4;
  return 5;
}

/** Max utilisation across known windows (for sorting providers by urgency). */
export function maxQuotaUtilisation(quota: AccountQuota | null): number {
  if (!quota) return -1;
  const vals = [quota.fiveHourPercent, quota.weeklyPercent, quota.monthlyPercent]
    .filter((n): n is number => typeof n === "number");
  for (const w of quota.customWindows ?? []) {
    if (typeof w.percent === "number") vals.push(w.percent);
  }
  return vals.length ? Math.max(...vals) : -1;
}

function bcp47(locale: Locale): string {
  switch (locale) {
    case "en":
      return "en-GB";
    case "de":
      return "de-DE";
    case "ko":
      return "ko-KR";
    case "zh":
      return "zh-CN";
    default: {
      const _exhaustive: never = locale;
      return _exhaustive;
    }
  }
}

function isQuotaExhausted(percent: number): boolean {
  return percent >= 99.5;
}

function isQuotaWarn(percent: number, threshold: number): boolean {
  return threshold > 0 && percent >= threshold;
}

function quotaBarTone(percent: number, threshold: number): "bar-green" | "bar-warn" {
  return isQuotaWarn(percent, threshold) || isQuotaExhausted(percent) ? "bar-warn" : "bar-green";
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
  const { locale } = useI18n();
  const rows = buildQuotaRows(quota, plan, t);
  if (rows.length === 0) return null;
  if (layout === "stacked") {
    return (
      <div className={`quota-stacked${className ? ` ${className}` : ""}`}>
        {rows.map((row, index) => (
          <StackedQuotaRow key={`${row.limitLabel}-${index}`} row={row} threshold={threshold} t={t} locale={locale} />
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
          locale={locale}
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

function QuotaRow({ label, percent, resetAt, threshold, t, locale }: {
  label: string;
  percent: number;
  resetAt?: number;
  threshold: number;
  t: TFn;
  locale: Locale;
}) {
  const exhausted = isQuotaExhausted(percent);
  const warn = isQuotaWarn(percent, threshold);
  const color = quotaBarTone(percent, threshold);
  const reset = formatResetAt(resetAt, t, locale);
  return (
    <div className={`quota-row${warn ? " quota-row--warn" : ""}${exhausted ? " quota-row--exhausted" : ""}`}>
      <span className="quota-label">{label}</span>
      <span className="quota-reset-label">{t("codexAuth.resets")}</span>
      <span className="quota-reset-day">{reset.day}</span>
      <span className="quota-reset-time">{reset.time}</span>
      <div className="bar"><div className={`bar-fill ${color}`} style={{ width: `${barWidth(percent)}%` }} /></div>
      <span
        className={`quota-val${warn ? " quota-val--warn" : ""}`}
        title={exhausted ? t("quota.limitReached") : undefined}
      >
        {warn && <IconAlert width={12} height={12} aria-hidden="true" />}
        {Math.round(percent)}%
        {exhausted ? ` · ${t("quota.limitReached")}` : ""}
      </span>
    </div>
  );
}

function StackedQuotaRow({ row, threshold, t, locale }: {
  row: QuotaBarRow;
  threshold: number;
  t: TFn;
  locale: Locale;
}) {
  const exhausted = isQuotaExhausted(row.percent);
  const warn = isQuotaWarn(row.percent, threshold);
  const color = quotaBarTone(row.percent, threshold);
  const resetText = formatResetFuture(row.resetAt, t, locale);
  return (
    <div className={`quota-stacked-row${warn ? " quota-stacked-row--warn" : ""}${exhausted ? " quota-stacked-row--exhausted" : ""}`}>
      <div className="quota-stacked-head">
        <span className="quota-stacked-limit">{row.limitLabel}</span>
        <span className="quota-stacked-reset muted">{resetText}</span>
      </div>
      <div className="quota-stacked-bar-row">
        <div className="bar quota-stacked-bar">
          <div className={`bar-fill ${color}`} style={{ width: `${barWidth(row.percent)}%` }} />
        </div>
        <span className={`quota-stacked-used${warn ? " quota-stacked-used--warn" : ""}`}>
          {t("quota.usedPercent", { pct: Math.round(row.percent) })}
        </span>
      </div>
      {exhausted && (
        <div className="quota-stacked-limit-reached" role="status">
          <IconAlert width={12} height={12} aria-hidden="true" />
          {t("quota.limitReached")}
        </div>
      )}
    </div>
  );
}

function formatResetAt(resetAt: number | undefined, t: TFn, locale: Locale): { day: string; time: string } {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return { day: "", time: "" };
  const ms = resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt;
  const date = new Date(ms);
  const now = new Date();
  const tag = bcp47(locale);
  const time = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (isToday) return { day: t("codexAuth.today"), time };
  const day = new Intl.DateTimeFormat(tag, { day: "numeric", month: "short" }).format(date);
  return { day, time };
}

/** Future-facing reset copy: today/tomorrow when close; include year when not this year. */
export function formatResetFuture(
  resetAt: number | undefined,
  t: TFn,
  locale: Locale = "en",
  now = Date.now(),
): string {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return "";
  const ms = resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt;
  const date = new Date(ms);
  const tag = bcp47(locale);
  const time = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const nowDate = new Date(now);
  const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfTarget - startOfToday) / 86_400_000);

  if (dayDiff === 0 && ms >= now) {
    return t("quota.resetsToday", { time });
  }
  if (dayDiff === 1) {
    return t("quota.resetsTomorrow", { time });
  }

  const includeYear = date.getFullYear() !== nowDate.getFullYear();
  const dateStr = new Intl.DateTimeFormat(tag, {
    day: "numeric",
    month: "short",
    ...(includeYear ? { year: "numeric" as const } : {}),
  }).format(date);

  if (ms <= now) {
    return t("quota.resetsAt", { date: dateStr, time, when: `${dateStr}, ${time}` });
  }

  const minutes = Math.round((ms - now) / 60_000);
  if (minutes < 60) return t("quota.resetsRelativeMinutes", { n: Math.max(1, minutes) });
  const hours = Math.round(minutes / 60);
  // Same calendar day already handled; near-term hours still useful across midnight edge cases.
  if (hours < 12 && dayDiff === 0) return t("quota.resetsRelativeHours", { n: Math.max(1, hours) });

  return t("quota.resetsAt", { date: dateStr, time, when: `${dateStr}, ${time}` });
}
