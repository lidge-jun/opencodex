/**
 * ProviderOverviewDashboard — aggregate overview when no provider is selected.
 * Shows summary cards, attention list, per-provider rate limits (QuotaBars stacked),
 * recently-used ranking, and Edit JSON entry.
 */
import { useMemo } from "react";
import { useT, useI18n } from "../../i18n";
import { IconChevron } from "../../icons";
import type { WorkspaceSections, WorkspaceItem } from "../../provider-workspace/catalog";
import { accountQuotaFromReport, type ProviderQuotaReportView } from "../../provider-workspace/report";
import {
  buildAttentionItems,
  buildMostUsedProviders,
  formatRelativeTime,
  formatRequestCount,
  relativeTimeLabelsFromT,
  type ProviderUsageTotals,
} from "../../provider-workspace/usage";
import { maxQuotaUtilisation } from "../QuotaBars";
import { ProviderIcon } from "./ProviderRail";
import { formatProviderDisplayName } from "../../provider-icons";
import QuotaBars from "../QuotaBars";

export default function ProviderOverviewDashboard({
  sections,
  quotaReports,
  usageTotals,
  onSelectProvider,
  onEditConfig,
}: {
  sections: WorkspaceSections;
  quotaReports: Record<string, ProviderQuotaReportView>;
  usageTotals: Record<string, ProviderUsageTotals>;
  onSelectProvider: (name: string) => void;
  onEditConfig?: () => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const timeLabels = relativeTimeLabelsFromT(t);

  const allItems = useMemo(
    () => [...sections.ready, ...sections.needsSetup, ...sections.disabled],
    [sections],
  );
  const knownNames = useMemo(() => new Set(allItems.map(p => p.name)), [allItems]);

  const attentionItems = useMemo(
    () => buildAttentionItems(sections, {}).map(item => ({
      ...item,
      reason: item.reason === "Missing credentials" ? t("pws.missingCredentials") : item.reason,
    })),
    [sections, t],
  );

  /* Rate-limit rows: urgency first (highest utilisation), then name */
  const quotaProviders = useMemo(() => {
    const result: Array<{ item: WorkspaceItem; report: ProviderQuotaReportView; urgency: number }> = [];
    for (const item of allItems) {
      const report = quotaReports[item.name];
      const quota = report ? accountQuotaFromReport(report) : null;
      if (report && quota) {
        result.push({ item, report, urgency: maxQuotaUtilisation(quota) });
      }
    }
    return result.sort((a, b) => b.urgency - a.urgency || a.item.name.localeCompare(b.item.name));
  }, [allItems, quotaReports]);

  /* Recently-used: filter to known provider names and cap at 4 (PR #139 parity) */
  const mostUsed = useMemo(() => {
    const filtered: Record<string, ProviderUsageTotals> = {};
    for (const [name, totals] of Object.entries(usageTotals)) {
      if (knownNames.has(name)) filtered[name] = totals;
    }
    return buildMostUsedProviders(filtered).slice(0, 4);
  }, [usageTotals, knownNames]);

  return (
    <div className="pws-dashboard">
      <div className="pws-dashboard-header">
        <div className="pws-dashboard-header-text">
          <h2 className="pws-dashboard-title">{t("pws.dashboard.title")}</h2>
          <p className="muted pws-dashboard-subtitle">{t("pws.dashboard.subtitle")}</p>
        </div>
        {onEditConfig && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onEditConfig}>
            {t("prov.editJson")}
          </button>
        )}
      </div>

      <div className="pws-dashboard-summary">
        <SummaryCard count={sections.ready.length} label={t("pws.status.ready")} tone="ok" />
        <SummaryCard count={sections.needsSetup.length} label={t("pws.status.needsSetup")} tone="warn" />
        <SummaryCard count={sections.disabled.length} label={t("prov.disabledBadge")} tone="muted" />
      </div>

      {attentionItems.length > 0 && (
        <section className="pws-dashboard-section" aria-label={t("pws.attentionRequired")}>
          <h3 className="pws-dashboard-section-title">{t("pws.attentionRequired")}</h3>
          <div className="pws-dashboard-rows">
            {attentionItems.map(ai => (
              <button
                key={ai.name}
                type="button"
                className="pws-dashboard-row"
                onClick={() => onSelectProvider(ai.name)}
                aria-label={t("pws.attentionAria", { name: ai.name, reason: ai.reason })}
              >
                <ProviderIcon name={ai.name} adapter="" baseUrl="" cls="pws-dashboard-row-icon" />
                <div className="pws-dashboard-row-info">
                  <span className="pws-dashboard-row-name">{formatProviderDisplayName(ai.name)}</span>
                  <span className="pws-dashboard-row-meta muted">{ai.reason}</span>
                </div>
                <IconChevron className="pws-dashboard-row-chevron" aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="pws-dashboard-columns">
        {quotaProviders.length > 0 && (
          <section className="pws-dashboard-section" aria-label={t("pws.dashboard.rateLimits")}>
            <h3 className="pws-dashboard-section-title">{t("pws.dashboard.rateLimits")}</h3>
            <div className="pws-dashboard-rows">
              {quotaProviders.map(({ item, report }) => (
                <button
                  key={item.name}
                  type="button"
                  className="pws-dashboard-row"
                  onClick={() => onSelectProvider(item.name)}
                >
                  <ProviderIcon name={item.name} adapter={item.adapter} baseUrl={item.baseUrl} cls="pws-dashboard-row-icon" />
                  <div className="pws-dashboard-row-info">
                    <span className="pws-dashboard-row-name">{formatProviderDisplayName(item.name)}</span>
                    <span className="pws-dashboard-row-meta muted">
                      {t("pws.dashboard.checkedAgo", { time: formatRelativeTime(report.updatedAt, timeLabels) })}
                    </span>
                  </div>
                  <IconChevron className="pws-dashboard-row-chevron" aria-hidden="true" />
                  <div className="pws-dashboard-row-bars">
                    <QuotaBars
                      quota={accountQuotaFromReport(report)}
                      threshold={80}
                      t={t}
                      layout="stacked"
                    />
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {mostUsed.length > 0 ? (
          <section className="pws-dashboard-section" aria-label={t("pws.dashboard.recentlyUsed")}>
            <h3 className="pws-dashboard-section-title">{t("pws.dashboard.recentlyUsed")}</h3>
            <div className="pws-dashboard-rows">
              {mostUsed.map(provider => (
                <button
                  key={provider.name}
                  type="button"
                  className="pws-dashboard-row"
                  onClick={() => onSelectProvider(provider.name)}
                >
                  <ProviderIcon name={provider.name} adapter="" baseUrl="" cls="pws-dashboard-row-icon" />
                  <span className="pws-dashboard-row-name">{formatProviderDisplayName(provider.name)}</span>
                  <span className="pws-dashboard-row-count muted">
                    {t("pws.dashboard.requests", { count: formatRequestCount(provider.requests, locale) })}
                  </span>
                  <IconChevron className="pws-dashboard-row-chevron" aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        ) : (
          <section className="pws-dashboard-section" aria-label={t("pws.dashboard.recentlyUsed")}>
            <h3 className="pws-dashboard-section-title">{t("pws.dashboard.recentlyUsed")}</h3>
            <p className="muted">{t("pws.dashboard.noUsage")}</p>
          </section>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ count, label, tone }: { count: number; label: string; tone: "ok" | "warn" | "muted" }) {
  return (
    <div className={`pws-dashboard-card pws-dashboard-card--${tone}`}>
      <span className="pws-dashboard-card-count">{count}</span>
      <span className="pws-dashboard-card-label">{label}</span>
    </div>
  );
}
