/**
 * ProviderUsage — the usage tab (WP090): 30-day cost/request/token metrics,
 * per-model cost breakdown table, and rate-limit windows on QuotaBars.
 */
import { Fragment, useMemo, useState } from "react";
import { useT, useI18n } from "../../i18n/shared";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { formatRequestCount, formatTokenCount, formatCostUsd } from "../../provider-workspace/usage";
import type { ProviderQuotaReportView } from "../../provider-workspace/report";
import type { AccountQuotaReading, ProviderUsageTotals, ProviderModelUsageRow } from "./types";
import ProviderCurrentQuota from "./ProviderCurrentQuota";

export default function ProviderUsage({ item, usageTotals, quotaReport, currentQuotaReading, quotaIdentity, modelUsage, onRefreshQuota }: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  currentQuotaReading?: AccountQuotaReading;
  quotaIdentity?: string;
  modelUsage?: ProviderModelUsageRow[];
  /** Force a fresh quota read; omitted when the page cannot drive one. */
  onRefreshQuota?: () => Promise<boolean>;
}) {
  const t = useT();
  const { locale } = useI18n();
  const hasUsage = usageTotals?.requests !== undefined;
  const [expandedModel, setExpandedModel] = useState<string | null>(null);

  const sortedModels = useMemo(() => {
    if (!modelUsage?.length) return [];
    return modelUsage.toSorted((a, b) => b.totalTokens - a.totalTokens);
  }, [modelUsage]);

  const providerCost = useMemo(() => {
    if (!sortedModels.length) return undefined;
    let total = 0;
    let hasCost = false;
    for (const m of sortedModels) {
      if (m.estimatedCostUsd !== undefined) {
        total += m.estimatedCostUsd;
        hasCost = true;
      }
    }
    return hasCost ? total : undefined;
  }, [sortedModels]);

  return (
    <div className="pws-section">
      <div className="pws-usage-block">
        <h3 className="pws-section-title">{t("pws.usageLast30d")}</h3>
        {hasUsage ? (
          <>
            <div className="pws-usage-metrics pws-usage-metrics-3" role="group" aria-label={t("pws.usageLast30d")}>
              <div className="pws-usage-metric">
                <span className="pws-usage-metric-value mono">{formatCostUsd(providerCost, locale)}</span>
                <span className="muted pws-usage-metric-label">{t("pws.estimatedCost")}</span>
              </div>
              <div className="pws-usage-metric">
                <span className="pws-usage-metric-value">{formatRequestCount(usageTotals?.requests, locale)}</span>
                <span className="muted pws-usage-metric-label">{t("pws.metricRequests")}</span>
              </div>
              <div className="pws-usage-metric">
                <span className="pws-usage-metric-value">{formatTokenCount(usageTotals?.totalTokens, locale)}</span>
                <span className="muted pws-usage-metric-label">{t("pws.metricTokens")}</span>
              </div>
            </div>
            <p className="muted pws-cost-disclaimer">{t("pws.costDisclaimer")}</p>
          </>
        ) : (
          <p className="muted">{t("pws.usageUnavailable")}</p>
        )}
      </div>

      {sortedModels.length > 0 && (
        <div className="pws-usage-block">
          <h3 className="pws-section-title">{t("pws.modelBreakdown")}</h3>
          <div className="tbl-wrap">
            <table className="pws-model-table">
              <thead>
                <tr>
                  <th>{t("pws.col.model")}</th>
                  <th className="num">{t("pws.col.cost")}</th>
                  <th className="num">{t("pws.col.tokens")}</th>
                  <th className="num">{t("pws.col.requests")}</th>
                  <th>{t("pws.col.share")}</th>
                </tr>
              </thead>
              <tbody>
                {sortedModels.map(row => {
                  const key = row.model;
                  const isExpanded = expandedModel === key;
                  return (
                    <Fragment key={key}>
                      <tr className="pws-model-row">
                        <td className="mono">
                          <button
                            type="button"
                            className="pws-model-expand"
                            aria-expanded={isExpanded}
                            onClick={() => setExpandedModel(isExpanded ? null : key)}
                          >
                            {row.model}
                          </button>
                          {row.hasUnresolvedRequestedModel && (
                            <div className="muted pws-model-attribution">{t("pws.unresolvedRequestedModel")}</div>
                          )}
                        </td>
                        <td className="num mono">{formatCostUsd(row.estimatedCostUsd, locale)}</td>
                        <td className="num mono">{formatTokenCount(row.totalTokens, locale)}</td>
                        <td className="num">{row.requests}</td>
                        <td>
                          <div className="pws-share-bar">
                            <div className="pws-share-bar-fill" style={{ width: `${Math.round(row.shareRatio * 100)}%` }} />
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="pws-model-detail">
                          <td colSpan={5}>
                            <div className="pws-model-detail-grid">
                              <div>
                                <span className="muted">{t("pws.tokenInput")}</span>
                                <span className="mono"> {formatTokenCount(row.inputTokens, locale)}</span>
                              </div>
                              <div>
                                <span className="muted">{t("pws.tokenOutput")}</span>
                                <span className="mono"> {formatTokenCount(row.outputTokens, locale)}</span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ProviderCurrentQuota key={`${item.name}:${quotaIdentity ?? ""}`} report={quotaReport} reading={currentQuotaReading} onRefreshQuota={onRefreshQuota} />
    </div>
  );
}
