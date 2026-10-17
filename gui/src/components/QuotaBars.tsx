import { Fragment, type CSSProperties, type ReactNode } from "react";
import type { Locale, TFn } from "../i18n/shared";
import { useI18n } from "../i18n/shared";
import { IconAlert } from "../icons";
import { type AccountQuota, normalizeQuotaForPlan } from "../codex-quota-utils";

/* Helpers are co-located with QuotaBars for overview sorting / stacked layout. */
/* eslint-disable react-refresh/only-export-components */

export type QuotaWindowKey = "fiveHour" | "weekly" | "monthly";
export type QuotaBarRow = {
  id: string;
  windowKey?: QuotaWindowKey;
  customLabel?: string;
  label: string;
  limitLabel: string;
  percent?: number;
  resetAt?: number;
  used?: number;
  limit?: number;
  isCreditBucket?: boolean;
};

/**
 * Window ordering is computed from RAW wire identities BEFORE localization
 * (ranking on translated labels breaks the moment a locale changes copy):
 * shorter windows first — 5h, weekly, cursor first-party, cursor API, monthly,
 * then subscription credits before other custom windows.
 */

function rawCreditBucketRank(kind: string): number {
  if (kind === "userQuota") return 4.6;
  if (kind === "addOnQuota") return 4.7;
  return 4.8;
}

export function resolveCreditBucketLabel(bucket: { kind: string; label?: string }, t: TFn): string {
  if (bucket.label) return bucket.label;
  switch (bucket.kind) {
    case "userQuota":
      return t("quota.userQuota");
    case "addOnQuota":
      return t("quota.addOnQuota");
    default:
      return bucket.kind;
  }
}
function rawCustomWindowRank(rawLabel: string): number {
  if (rawLabel === "5h") return 0;
  if (rawLabel === "First-party models") return 2;
  if (rawLabel === "API usage") return 3;
  if (rawLabel === "Total subscription credits") return 4.5;
  return 5;
}

const SUBSCRIPTION_CREDITS_LABEL = "Total subscription credits";

function canonicalCustomWindowLabel(rawLabel: string): string {
  return rawLabel.trim().toLowerCase() === SUBSCRIPTION_CREDITS_LABEL.toLowerCase()
    ? SUBSCRIPTION_CREDITS_LABEL
    : rawLabel;
}

/** Coverage metadata carries raw labels, while subscription rows use a canonical identity. */
export function isCustomQuotaWindowIncomplete(
  customLabel: string | undefined,
  incompleteLabels?: ReadonlySet<string>,
): boolean {
  if (customLabel === undefined || !incompleteLabels) return false;
  const canonical = canonicalCustomWindowLabel(customLabel);
  for (const label of incompleteLabels) {
    if (canonicalCustomWindowLabel(label) === canonical) return true;
  }
  return false;
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
  const ranked: Array<{ rank: number; row: Omit<QuotaBarRow, "id"> & { id?: string } }> = [];
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
    const customLabel = canonicalCustomWindowLabel(w.label);
    const localized = localizeCustomQuotaLabel(customLabel, t);
    ranked.push({
      rank: rawCustomWindowRank(customLabel),
      row: {
        id: JSON.stringify([w.modelId ?? null, w.label, w.resetAt ?? null]),
        customLabel,
        label: localized,
        limitLabel: localized,
        percent: w.percent,
        resetAt: w.resetAt,
      },
    });
  }
  if (displayQuota.creditsUsd && typeof displayQuota.creditsUsd.percent === "number") {
    const hasSubscriptionCreditsCustom = displayQuota.customWindows?.some(
      w => w.modelId === undefined && canonicalCustomWindowLabel(w.label) === SUBSCRIPTION_CREDITS_LABEL,
    );
    if (!hasSubscriptionCreditsCustom) {
      const localized = localizeCustomQuotaLabel(SUBSCRIPTION_CREDITS_LABEL, t);
      ranked.push({
        rank: rawCustomWindowRank(SUBSCRIPTION_CREDITS_LABEL),
        row: {
          customLabel: SUBSCRIPTION_CREDITS_LABEL,
          label: localized,
          limitLabel: localized,
          percent: displayQuota.creditsUsd.percent,
          resetAt: displayQuota.creditsUsd.expiresAt,
        },
      });
    }
  }
  for (const bucket of displayQuota.creditBuckets ?? []) {
    const rawLabel = bucket.label || (bucket.kind === "userQuota" ? "Plan Credits" : bucket.kind === "addOnQuota" ? "Add-on Pack" : bucket.kind);
    const localized = resolveCreditBucketLabel(bucket, t);
    ranked.push({
      rank: rawCreditBucketRank(bucket.kind),
      row: {
        customLabel: rawLabel,
        label: localized,
        limitLabel: localized,
        percent: bucket.percent,
        used: bucket.used,
        limit: bucket.limit,
        isCreditBucket: true,
      },
    });
  }
  const identities = new Map<string, number>();
  return ranked.sort((a, b) => a.rank - b.rank).map(({ row }) => {
    const identity = row.id ?? row.windowKey ?? row.customLabel!;
    const ordinal = identities.get(identity) ?? 0;
    identities.set(identity, ordinal + 1);
    return { ...row, id: JSON.stringify([identity, ordinal]) };
  });
}

/** Max utilisation across known windows (for sorting providers by urgency). */
export function maxQuotaUtilisation(quota: AccountQuota | null): number {
  if (!quota) return -1;
  const vals = [quota.fiveHourPercent, quota.weeklyPercent, quota.monthlyPercent]
    .filter((n): n is number => typeof n === "number");
  for (const w of quota.customWindows ?? []) {
    if (w.modelId !== undefined) continue;
    if (typeof w.percent === "number") vals.push(w.percent);
  }
  const hasSubscriptionCreditsCustom = quota.customWindows?.some(
    w => w.modelId === undefined && canonicalCustomWindowLabel(w.label) === SUBSCRIPTION_CREDITS_LABEL,
  );
  if (!hasSubscriptionCreditsCustom && typeof quota.creditsUsd?.percent === "number") {
    vals.push(quota.creditsUsd.percent);
  }
  for (const b of quota.creditBuckets ?? []) {
    if (typeof b.percent === "number") vals.push(b.percent);
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
    case "vi":
      return "vi-VN";
    case "pt":
      return "pt-BR";
    default: {
      const _exhaustive: never = locale;
      return _exhaustive;
    }
  }
}

/** Display-only exhaustion cutoff (adopted with rationale: rounding shows 100%). */
export function isQuotaExhausted(percent?: number): boolean {
  return typeof percent === "number" && percent >= 99.5;
}

export function isQuotaWarn(percent?: number, threshold: number = 80): boolean {
  return typeof percent === "number" && threshold > 0 && percent >= threshold;
}

export function quotaBarTone(percent?: number, threshold: number = 80): "bar-green" | "bar-warn" {
  return isQuotaWarn(percent, threshold) || isQuotaExhausted(percent) ? "bar-warn" : "bar-green";
}

/** Tiny usage still shows a visible bar (min ~4%) so 0–2% isn't invisible; 0 stays 0. */
export function barWidth(percent?: number): number {
  if (typeof percent !== "number") return 0;
  const clamped = Math.max(0, Math.min(100, percent));
  if (clamped <= 0) return 0;
  return Math.max(4, Math.round(clamped));
}

/**
 * Faithful proportion for credit buckets without forcing the 4% visibility floor.
 * Clamped between 0 and 100; positive values below 1 keep their exact ratio.
 */
export function creditBarWidth(percent?: number): number {
  if (typeof percent !== "number") return 0;
  const clamped = Math.max(0, Math.min(100, percent));
  if (clamped <= 0) return 0;
  return clamped;
}

export function barFillStyle(percent: number, isCreditBucket?: boolean): CSSProperties {
  const width = isCreditBucket ? creditBarWidth(percent) : barWidth(percent);
  return { ["--bar-scale" as string]: String(width / 100) };
}

/**
 * How long ago an observation was taken, bucketed.
 *
 * Coarse on purpose: a passively observed quota is only as precise as the moment it was
 * seen, and a to-the-second age would imply a freshness the number does not have.
 * Negative elapsed (clock skew between the proxy that wrote it and this browser) reads as
 * just-now rather than as a negative age.
 */
export function formatObservedAge(observedAt: number, t: TFn, now = Date.now()): string | null {
  const elapsed = now - observedAt;
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return null;
  // Units go through t(): the suffix is copy, and "m"/"h"/"d" do not survive translation.
  if (elapsed < 60 * 60_000) return t("quota.ageMinutes").replace("{n}", String(Math.floor(elapsed / 60_000)));
  if (elapsed < 24 * 60 * 60_000) return t("quota.ageHours").replace("{n}", String(Math.floor(elapsed / (60 * 60_000))));
  return t("quota.ageDays").replace("{n}", String(Math.floor(elapsed / (24 * 60 * 60_000))));
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
  observedAt,
  afterWeekly,
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
  /**
   * When set, state how old these numbers are.
   *
   * Set ONLY for a passively observed quota, where the value arrives as a side effect of
   * a real request and nothing refreshes it. A probed provider re-reads on its own TTL,
   * so an age line there would be noise; here its absence would let a days-old reading
   * look live.
   */
  observedAt?: number;
  /** Compact-only slot after Week, or after the last row when Week is absent. */
  afterWeekly?: ReactNode;
}) {
  const { locale } = useI18n();
  const rows = buildQuotaRows(quota, plan, t);
  // Rendered above the bars in both layouts. Null age (under a minute, or no observation)
  // renders nothing rather than "just now", which would be one more thing to read.
  const observedAge = observedAt === undefined ? null : formatObservedAge(observedAt, t);
  const observedLine = observedAge === null ? null : (
    <p className="quota-observed muted" title={t("quota.observedHint")}>
      {t("quota.observedAgo").replace("{age}", observedAge)}
    </p>
  );
  if (rows.length === 0) {
    if (!pending) return layout === "compact" && afterWeekly ? (
      <div className={`codex-account-quota-slot quota-compact${className ? ` ${className}` : ""}`}>{afterWeekly}</div>
    ) : null;
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
        {observedLine}
        {rows.map(row => (
          <StackedQuotaRow
            key={row.id}
            row={row}
            threshold={threshold}
            t={t}
            locale={locale}
            incomplete={row.windowKey
              ? incompleteWindowKeys?.has(row.windowKey) === true
              : isCustomQuotaWindowIncomplete(row.customLabel, incompleteCustomWindowLabels)}
          />
        ))}
      </div>
    );
  }
  return (
    <div className={`codex-account-quota-slot quota-compact${className ? ` ${className}` : ""}`}>
      {observedLine}
      {rows.map(row => (
        <Fragment key={row.id}>
          <QuotaRow
            credits={row.customLabel === SUBSCRIPTION_CREDITS_LABEL || Boolean(row.isCreditBucket)}
            label={row.label}
            percent={row.percent}
            resetAt={row.resetAt}
            threshold={threshold}
            t={t}
            locale={locale}
            used={row.used}
            limit={row.limit}
            isCreditBucket={row.isCreditBucket}
          />
          {row.windowKey === "weekly" && afterWeekly}
        </Fragment>
      ))}
      {!rows.some(row => row.windowKey === "weekly") && afterWeekly}
    </div>
  );
}

function QuotaRow({
  credits,
  label,
  percent,
  resetAt,
  threshold,
  t,
  locale,
  used,
  limit,
  isCreditBucket,
}: {
  credits?: boolean;
  label: string;
  percent?: number;
  resetAt?: number;
  threshold: number;
  t: TFn;
  locale: Locale;
  used?: number;
  limit?: number;
  isCreditBucket?: boolean;
}) {
  const isNoQuota = Boolean(isCreditBucket && used === 0 && limit === 0);
  const hasPercent = typeof percent === "number" && !isNoQuota;
  const exhausted = !isNoQuota && isQuotaExhausted(percent);
  const warn = !isNoQuota && isQuotaWarn(percent, threshold);
  const color = quotaBarTone(percent, threshold);
  const reset = formatResetAt(resetAt, t, locale);
  const resetTitle = reset.day || reset.time
    ? `${t("codexAuth.resets")} ${reset.day} ${reset.time}`.replace(/\s+/g, " ").trim()
    : undefined;
  const hasReset = reset.day !== "" || reset.time !== "";
  const tag = bcp47(locale);
  return (
    <div className={`quota-row${credits ? " quota-row--credits" : ""}${warn ? " quota-row--warn" : ""}${exhausted ? " quota-row--exhausted" : ""}`}>
      <span className="quota-label" title={resetTitle}>{label}</span>
      <span className="quota-reset-label">{hasReset ? t("codexAuth.resets") : ""}</span>
      <span className="quota-reset-day">{reset.day}</span>
      <span className="quota-reset-time">{reset.time}</span>
      <div className="bar" title={resetTitle}>
        {hasPercent && <div className={`bar-fill ${color}`} style={barFillStyle(percent!, isCreditBucket)} />}
      </div>
      <span
        className={`quota-val${warn ? " quota-val--warn" : ""}`}
        title={exhausted ? t("quota.limitReached") : resetTitle}
        aria-label={resetTitle}
      >
        {warn && <IconAlert width={12} height={12} aria-hidden="true" />}
        {isNoQuota ? (
          t("quota.noQuota")
        ) : hasPercent ? (
          <>
            {`${Math.round(percent!)}%`}
            {exhausted ? ` · ${t("quota.limitReached")}` : ""}
          </>
        ) : (
          used !== undefined && limit !== undefined ? `${new Intl.NumberFormat(tag).format(used)} / ${new Intl.NumberFormat(tag).format(limit)}` : ""
        )}
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
  const isNoQuota = Boolean(row.isCreditBucket && row.used === 0 && row.limit === 0);
  const hasPercent = typeof row.percent === "number" && !isNoQuota;
  const exhausted = !isNoQuota && isQuotaExhausted(row.percent);
  const warn = !isNoQuota && isQuotaWarn(row.percent, threshold);
  const color = quotaBarTone(row.percent, threshold);
  const resetText = formatResetFuture(row.resetAt, t, locale);
  const tag = bcp47(locale);
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
        {isNoQuota ? (
          <span className="quota-stacked-used muted">
            {t("quota.noQuota")}
          </span>
        ) : hasPercent ? (
          <>
            <div className="bar quota-stacked-bar">
              <div className={`bar-fill ${color}`} style={barFillStyle(row.percent!, row.isCreditBucket)} />
            </div>
            <span className={`quota-stacked-used${warn ? " quota-stacked-used--warn" : ""}`}>
              {t("quota.usedPercent", { pct: Math.round(row.percent!) })}
            </span>
          </>
        ) : (
          row.used !== undefined && row.limit !== undefined ? (
            <span className="quota-stacked-used">
              {`${new Intl.NumberFormat(tag).format(row.used)} / ${new Intl.NumberFormat(tag).format(row.limit)}`}
            </span>
          ) : null
        )}
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
