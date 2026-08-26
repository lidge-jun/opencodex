import type { CSSProperties } from "react";
import type { Locale, TFn } from "../i18n/shared";
import { useI18n } from "../i18n/shared";
import { IconAlert } from "../icons";
import { type AccountQuota, normalizeQuotaForPlan } from "../codex-quota-utils";

/* Helpers are co-located with QuotaBars for overview sorting / stacked layout. */
/* eslint-disable react-refresh/only-export-components */

export type QuotaWindowKey = "fiveHour" | "weekly" | "monthly";
export type QuotaBarRow = {
  windowKey?: QuotaWindowKey;
  customLabel?: string;
  label: string;
  limitLabel: string;
  percent: number;
  resetAt?: number;
};

/**
 * Window ordering is computed from RAW wire identities BEFORE localization
 * (ranking on translated labels breaks the moment a locale changes copy):
 * shorter windows first — 5h, weekly, cursor first-party, cursor API, monthly.
 */
function rawCustomWindowRank(rawLabel: string): number {
  if (rawLabel === "5h") return 0;
  if (rawLabel === "First-party models") return 2;
  if (rawLabel === "API usage") return 3;
  return 5;
}

function localizeCustomQuotaLabel(rawLabel: string, t: TFn): string {
  switch (rawLabel) {
    case "First-party models":
      return t("quota.cursorFirstParty");
    case "API usage":
      return t("quota.cursorApiUsage");
    case "Total subscription credits":
      return t("quota.totalSubscriptionCredits");
    default:
      return rawLabel;
  }
}

export function buildQuotaRows(quota: AccountQuota | null, plan: string | null | undefined, t: TFn): QuotaBarRow[] {
  const displayQuota = normalizeQuotaForPlan(quota, plan);
  if (!displayQuota) return [];
  // Intrinsic ranks for the standard slots; custom windows rank on their RAW labels.
  const ranked: Array<{ rank: number; row: QuotaBarRow }> = [];
  if (typeof displayQuota.fiveHourPercent === "number") {
    ranked.push({
      rank: 0,
      row: {
        windowKey: "fiveHour",
        label: t("codexAuth.fiveHour"),
        limitLabel: t("quota.fiveHourLimit"),
        percent: displayQuota.fiveHourPercent,
        resetAt: displayQuota.fiveHourResetAt,
      },
    });
  }
  if (typeof displayQuota.weeklyPercent === "number") {
    ranked.push({
      rank: 1,
      row: {
        windowKey: "weekly",
        label: t("codexAuth.weekly"),
        limitLabel: t("quota.weeklyLimit"),
        percent: displayQuota.weeklyPercent,
        resetAt: displayQuota.weeklyResetAt,
      },
    });
  }
  if (typeof displayQuota.monthlyPercent === "number") {
    ranked.push({
      rank: 4,
      row: {
        windowKey: "monthly",
        label: t("codexAuth.monthly"),
        limitLabel: t("quota.monthlyLimit"),
        percent: displayQuota.monthlyPercent,
        resetAt: displayQuota.monthlyResetAt,
      },
    });
  }
  for (const w of displayQuota.customWindows ?? []) {
    const localized = localizeCustomQuotaLabel(w.label, t);
    ranked.push({
      rank: rawCustomWindowRank(w.label),
      row: {
        customLabel: w.label,
        label: localized,
        limitLabel: localized,
        percent: w.percent,
        resetAt: w.resetAt,
      },
    });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map(entry => entry.row);
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
    case "fr":
      return "fr-FR";
    case "ko":
      return "ko-KR";
    case "zh":
      return "zh-CN";
    case "zh-TW":
      return "zh-TW";
    case "ru":
      return "ru-RU";
    case "ja":
      return "ja-JP";
    case "tr":
      return "tr-TR";
    default: {
      const _exhaustive: never = locale;
      return _exhaustive;
    }
  }
}

/** Display-only exhaustion cutoff (adopted with rationale: rounding shows 100%). */
export function isQuotaExhausted(percent: number): boolean {
  return percent >= 99.5;
}

export function isQuotaWarn(percent: number, threshold: number): boolean {
  return threshold > 0 && percent >= threshold;
}

export function quotaBarTone(percent: number, threshold: number): "bar-green" | "bar-warn" {
  return isQuotaWarn(percent, threshold) || isQuotaExhausted(percent) ? "bar-warn" : "bar-green";
}

/** Tiny usage still shows a visible bar (min ~4%) so 0–2% isn't invisible; 0 stays 0. */
export function barWidth(percent: number): number {
  const clamped = Math.max(0, Math.min(100, percent));
  if (clamped <= 0) return 0;
  return Math.max(4, Math.round(clamped));
}

function barFillStyle(percent: number): CSSProperties {
  return { ["--bar-scale" as string]: String(barWidth(percent) / 100) };
}

export default function QuotaBars({
  quota,
  plan,
  threshold,
  t,
  className,
  layout = "compact",
  pending = false,
  incompleteWindowKeys,
  incompleteCustomWindowLabels,
}: {
  quota: AccountQuota | null;
  plan?: string | null;
  threshold: number;
  t: TFn;
  className?: string;
  /** compact = classic one-line rows; stacked = overview cards with clear reset copy */
  layout?: "compact" | "stacked";
  /**
   * When quota is still null (soft /accounts before WHAM), reserve the compact
   * bar slot so deferred fill does not shove the page down.
   */
  pending?: boolean;
  /** Optional overview-only coverage status. Other quota surfaces remain unchanged when omitted. */
  incompleteWindowKeys?: ReadonlySet<QuotaWindowKey>;
  incompleteCustomWindowLabels?: ReadonlySet<string>;
}) {
  const { locale } = useI18n();
  const rows = buildQuotaRows(quota, plan, t);
  if (rows.length === 0) {
    if (!pending) return null;
    if (layout === "stacked") {
      return (
        <div className={`quota-stacked quota-stacked--pending${className ? ` ${className}` : ""}`} aria-busy="true" role="status">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="quota-stacked-row quota-stacked-row--skeleton" aria-hidden="true">
              <div className="quota-stacked-head">
                <span className="quota-skel quota-skel--label" style={{ width: 72 }} />
                <span className="quota-skel quota-skel--time" style={{ width: 64 }} />
              </div>
              <div className="quota-stacked-bar-row">
                <span className="quota-skel quota-skel--bar" style={{ height: 6, flex: 1 }} />
                <span className="quota-skel quota-skel--val" style={{ width: 36 }} />
              </div>
            </div>
          ))}
          <span className="sr-only">{t("common.loading")}</span>
        </div>
      );
    }
    // Reserve one compact meter row until real bars paint. Extra windows add
    // height only after WHAM fills them; the default card stays three rows.
    return (
      <div
        className={`codex-account-quota-slot quota-compact quota-compact--pending${className ? ` ${className}` : ""}`}
        aria-busy="true"
        role="status"
      >
        <div className="quota-row quota-row--skeleton" aria-hidden="true">
          <span className="quota-skel quota-skel--label" />
          <span className="quota-skel quota-skel--reset" />
          <span className="quota-skel quota-skel--day" />
          <span className="quota-skel quota-skel--time" />
          <span className="quota-skel quota-skel--bar" />
          <span className="quota-skel quota-skel--val" />
        </div>
        <span className="sr-only">{t("common.loading")}</span>
      </div>
    );
  }
  if (layout === "stacked") {
    return (
      <div className={`quota-stacked${className ? ` ${className}` : ""}`}>
        {rows.map(row => (
          <StackedQuotaRow
            key={row.limitLabel}
            row={row}
            threshold={threshold}
            t={t}
            locale={locale}
            incomplete={row.windowKey
              ? incompleteWindowKeys?.has(row.windowKey) === true
              : row.customLabel !== undefined && incompleteCustomWindowLabels?.has(row.customLabel) === true}
          />
        ))}
      </div>
    );
  }
  return (
    <div className={`codex-account-quota-slot quota-compact${className ? ` ${className}` : ""}`}>
      {rows.map(row => (
        <QuotaRow
          key={row.label}
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
  const resetTitle = reset.day || reset.time
    ? `${t("codexAuth.resets")} ${reset.day} ${reset.time}`.replace(/\s+/g, " ").trim()
    : undefined;
  const hasReset = reset.day !== "" || reset.time !== "";
  return (
    <div className={`quota-row${warn ? " quota-row--warn" : ""}${exhausted ? " quota-row--exhausted" : ""}`}>
      <span className="quota-label" title={resetTitle}>{label}</span>
      <span className="quota-reset-label">{hasReset ? t("codexAuth.resets") : ""}</span>
      <span className="quota-reset-day">{reset.day}</span>
      <span className="quota-reset-time">{reset.time}</span>
      <div className="bar" title={resetTitle}><div className={`bar-fill ${color}`} style={barFillStyle(percent)} /></div>
      <span
        className={`quota-val${warn ? " quota-val--warn" : ""}`}
        title={exhausted ? t("quota.limitReached") : resetTitle}
        aria-label={resetTitle}
      >
        {warn && <IconAlert width={12} height={12} aria-hidden="true" />}
        {Math.round(percent)}%
        {exhausted ? ` · ${t("quota.limitReached")}` : ""}
      </span>
    </div>
  );
}

function StackedQuotaRow({ row, threshold, t, locale, incomplete }: {
  row: QuotaBarRow;
  threshold: number;
  t: TFn;
  locale: Locale;
  incomplete: boolean;
}) {
  const exhausted = isQuotaExhausted(row.percent);
  const warn = isQuotaWarn(row.percent, threshold);
  const color = quotaBarTone(row.percent, threshold);
  const resetText = formatResetFuture(row.resetAt, t, locale);
  return (
    <div className={`quota-stacked-row${warn ? " quota-stacked-row--warn" : ""}${exhausted ? " quota-stacked-row--exhausted" : ""}`}>
      <div className="quota-stacked-head">
        <span className="quota-stacked-limit-group">
          <span className="quota-stacked-limit">{row.limitLabel}</span>
          {incomplete && (
            <span
              className="quota-window-partial"
              role="note"
              aria-label={t("pws.capacity.windowPartialA11y", { window: row.limitLabel })}
              title={t("pws.capacity.windowPartialA11y", { window: row.limitLabel })}
            >
              {t("pws.capacity.windowPartial")}
            </span>
          )}
        </span>
        <span className="quota-stacked-reset muted">{resetText}</span>
      </div>
      <div className="quota-stacked-bar-row">
        <div className="bar quota-stacked-bar">
          <div className={`bar-fill ${color}`} style={barFillStyle(row.percent)} />
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

/** Normalize seconds-or-milliseconds epochs and reject values outside JavaScript Date's range. */
function resetDate(resetAt: number | undefined): { date: Date; ms: number } | null {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return null;
  const ms = resetAt < 10_000_000_000 ? resetAt * 1000 : resetAt;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return { date, ms };
}

function formatResetAt(resetAt: number | undefined, t: TFn, locale: Locale): { day: string; time: string } {
  const normalized = resetDate(resetAt);
  if (!normalized) return { day: "", time: "" };
  const { date } = normalized;
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
  const normalized = resetDate(resetAt);
  if (!normalized) return "";
  const { date, ms } = normalized;
  const tag = bcp47(locale);
  const time = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const nowDate = new Date(now);
  const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfTarget - startOfToday) / 86_400_000);

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
  if (hours < 12 && dayDiff === 0) return t("quota.resetsRelativeHours", { n: Math.max(1, hours) });
  if (dayDiff === 0) return t("quota.resetsToday", { time });

  return t("quota.resetsAt", { date: dateStr, time, when: `${dateStr}, ${time}` });
}
