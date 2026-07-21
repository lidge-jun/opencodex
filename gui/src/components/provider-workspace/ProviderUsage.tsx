/**
 * ProviderUsage — the usage tab (WP090): 30-day request/token metrics plus
 * rate-limit windows on the WP070 stacked QuotaBars.
 */
import { useT, useI18n } from "../../i18n";
import QuotaBars from "../QuotaBars";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { formatRelativeTime, relativeTimeLabelsFromT, formatRequestCount, formatTokenCount } from "../../provider-workspace/usage";
import { accountQuotaFromReport, formatQuotaSourceLabel, type ProviderQuotaReportView } from "../../provider-workspace/report";
import type { ProviderUsageTotals } from "./types";

export default function ProviderUsage({ item, usageTotals, quotaReport }: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
}) {
  const t = useT();
  const { locale } = useI18n();
  const timeLabels = relativeTimeLabelsFromT(t);
  const hasUsage = usageTotals?.requests !== undefined;
  const quota = accountQuotaFromReport(quotaReport);
  void item;
  return (
    <div className="pws-section">
      <div className="pws-usage-block">
        <h3 className="pws-section-title">{t("pws.usageLast30d")}</h3>
        {hasUsage ? (
          <div className="pws-usage-metrics" role="group" aria-label={t("pws.usageLast30d")}>
            <div className="pws-usage-metric">
              <span className="pws-usage-metric-value">{formatRequestCount(usageTotals?.requests, locale)}</span>
              <span className="muted pws-usage-metric-label">{t("pws.metricRequests")}</span>
            </div>
            <div className="pws-usage-metric">
              <span className="pws-usage-metric-value">{formatTokenCount(usageTotals?.totalTokens, locale)}</span>
              <span className="muted pws-usage-metric-label">{t("pws.metricTokens")}</span>
            </div>
          </div>
        ) : (
          <p className="muted">{t("pws.usageUnavailable")}</p>
        )}
      </div>
      <div className="pws-usage-block">
        <h3 className="pws-section-title">{t("pws.rateLimits")}</h3>
        {quota ? (
          <>
            <QuotaBars quota={quota} plan={null} threshold={80} t={t} layout="stacked" />
            <dl className="pws-kv pws-usage-meta">
              {quotaReport?.source?.trim() && (
                <div className="pws-kv-row">
                  <dt>{t("pws.stats.source")}</dt>
                  <dd>{formatQuotaSourceLabel(quotaReport.source)}</dd>
                </div>
              )}
              <div className="pws-kv-row">
                <dt>{t("pws.stats.quotaUpdated")}</dt>
                <dd>{formatRelativeTime(quotaReport?.updatedAt, timeLabels)}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="muted">{t("pws.quotaUnavailable")}</p>
        )}
      </div>
    </div>
  );
}
