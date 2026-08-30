/**
 * ProviderCapacityQuota — per-provider quota bars plus the aggregation context the
 * quota API attaches for pooled Codex providers (estimate, excluded accounts, recovery
 * rows, current-account breakdown). Shared by the aggregate dashboard and the
 * single-provider Overview so both surfaces present the same capacity semantics.
 */
import { useT, useI18n, type Locale } from "../../i18n/shared";
import {
  accountQuotaFromReport,
  capacityAggregationFromReport,
  type CapacityWindowView,
  type ProviderQuotaReportView,
} from "../../provider-workspace/report";
import { type QuotaWindowKey } from "../QuotaBars";
import QuotaBars from "../QuotaBars";

function bcp47(locale: Locale): string {
  switch (locale) {
    case "en": return "en-GB";
    case "de": return "de-DE";
    case "fr": return "fr-FR";
    case "ko": return "ko-KR";
    case "zh": return "zh-CN";
    case "zh-TW": return "zh-TW";
    case "ru": return "ru-RU";
    case "ja": return "ja-JP";
    case "tr": return "tr-TR";
    default: {
      const _exhaustive: never = locale;
      return _exhaustive;
    }
  }
}

// `Intl.DateTimeFormat.format()` throws a RangeError on a time value outside ±8.64e15 ms.
// These timestamps come from provider APIs and persisted cache, so one unrepresentable value
// would take down the whole capacity panel. Resolve to null and omit the line instead.
function asDate(value: number): Date | null {
  const date = new Date(value > 10_000_000_000 ? value : value * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function ProviderCapacityQuota({ report, pending }: { report: ProviderQuotaReportView; pending: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  const aggregation = capacityAggregationFromReport(report);
  const primaryQuota = accountQuotaFromReport(report);
  const credits = primaryQuota?.creditsUsd;
  const showsAggregate = aggregation?.presentation === "aggregate";
  const incompleteWindowKeys = new Set<QuotaWindowKey>();
  const incompleteCustomWindowLabels = new Set<string>();
  if (showsAggregate && aggregation) {
    if (aggregation.fiveHour?.incomplete) incompleteWindowKeys.add("fiveHour");
    if (aggregation.weekly?.incomplete) incompleteWindowKeys.add("weekly");
    if (aggregation.monthly?.incomplete) incompleteWindowKeys.add("monthly");
    for (const window of aggregation.customWindows ?? []) {
      if (window.incomplete) incompleteCustomWindowLabels.add(window.label);
    }
  }
  const recoveryRows: Array<{ key: number; label: string; window: CapacityWindowView }> = showsAggregate && aggregation ? [
    ...(aggregation.fiveHour ? [{ key: 0, label: t("codexAuth.fiveHour"), window: aggregation.fiveHour }] : []),
    ...(aggregation.weekly ? [{ key: 1, label: t("codexAuth.weekly"), window: aggregation.weekly }] : []),
    ...(aggregation.monthly ? [{ key: 2, label: t("codexAuth.monthly"), window: aggregation.monthly }] : []),
    ...(aggregation.customWindows ?? []).map((window, index) => ({ key: index + 3, label: window.label, window })),
  ] : [];
  const formatPercent = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  const formatRecoveryAt = (value: number) => {
    const date = asDate(value);
    return date === null ? null : new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  };
  const localeTag = bcp47(locale);
  const formatCredits = (value: number) => new Intl.NumberFormat(localeTag, {
    style: "currency",
    currency: "USD",
  }).format(value);
  const formatPeriodEnd = (value: number) => {
    const date = asDate(value);
    return date === null ? null : new Intl.DateTimeFormat(localeTag, { dateStyle: "medium" }).format(date);
  };
  const periodEnd = credits?.expiresAt === undefined ? null : formatPeriodEnd(credits.expiresAt);

  return (
    <>
      {showsAggregate && <div className="pws-capacity-label">{t("pws.capacity.estimate")}</div>}
      {(primaryQuota || pending) && (
        <QuotaBars
          quota={primaryQuota}
          threshold={80}
          t={t}
          layout="stacked"
          pending={pending}
          incompleteWindowKeys={showsAggregate ? incompleteWindowKeys : undefined}
          incompleteCustomWindowLabels={showsAggregate ? incompleteCustomWindowLabels : undefined}
        />
      )}
      {(credits || aggregation) && (
        <div className="pws-capacity-details">
          {credits && (
            <div className="pws-capacity-recovery">
              <span>{t("quota.creditsBalance")}</span>
              <strong>{formatCredits(credits.remaining)}</strong>
            </div>
          )}
          {periodEnd !== null && (
            <div className="pws-capacity-recovery">
              <span>{t("quota.creditsPeriodEnds", { date: periodEnd })}</span>
            </div>
          )}
          {recoveryRows.flatMap(({ key, label, window }) => {
            const recoveryAt = window.nextRecoveryAt === undefined ? null : formatRecoveryAt(window.nextRecoveryAt);
            return recoveryAt !== null && window.nextRecoveryPercent !== undefined
              ? [<div className="pws-capacity-recovery" key={key}>
                  <span>{t("pws.capacity.nextRecovery")} · {label} · {recoveryAt}</span>
                  <strong>{t("pws.capacity.recoveryShare", { percent: formatPercent(window.nextRecoveryPercent) })}</strong>
                </div>]
              : [];
          })}
          {showsAggregate && aggregation && aggregation.currentAccount?.quota && (
            <div className="pws-capacity-current">
              <span className="pws-capacity-label">
                {t("pws.capacity.currentAccount")}
                {aggregation.currentAccount.plan ? ` · ${aggregation.currentAccount.plan}` : ""}
              </span>
              <QuotaBars quota={aggregation.currentAccount.quota} threshold={80} t={t} layout="stacked" />
            </div>
          )}
          {aggregation && aggregation.incomplete && aggregation.excludedAccounts > 0 && (
            <div className="pws-capacity-incomplete">
              {t("pws.capacity.incomplete", {
                excluded: aggregation.excludedAccounts,
                unknown: aggregation.unknownPlanAccounts,
              })}
            </div>
          )}
          {aggregation && aggregation.partialWindowAccounts > 0 && (
            <div className="pws-capacity-incomplete">
              {t("pws.capacity.partial", { count: aggregation.partialWindowAccounts })}
            </div>
          )}
        </div>
      )}
    </>
  );
}
