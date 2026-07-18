/**
 * ProviderOverviewDashboard — aggregate overview when no provider is selected.
 * Shows summary cards, per-provider rate limits (QuotaBars stacked), and
 * recently-used ranking. Phase 010 of workspace design parity.
 */
import { useMemo } from "react";
import { useT, useI18n } from "../../i18n";
import { IconChevron } from "../../icons";
import type { WorkspaceSections, WorkspaceItem } from "../../provider-workspace/catalog";
import { accountQuotaFromReport, type ProviderQuotaReportView } from "../../provider-workspace/report";
import {
  buildMostUsedProviders,
  formatRelativeTime,
  formatRequestCount,
  relativeTimeLabelsFromT,
  type ProviderUsageTotals,
} from "../../provider-workspace/usage";
import { ProviderIcon } from "./ProviderRail";
import { formatProviderDisplayName } from "../../provider-icons";
import QuotaBars from "../QuotaBars";

export default function ProviderOverviewDashboard({
  sections,
  quotaReports,
  usageTotals,
  onSelectProvider,
}: {
  sections: WorkspaceSections;
  quotaReports: Record<string, ProviderQuotaReportView>;
  usageTotals: Record<string, ProviderUsageTotals>;
  onSelectProvider: (name: string) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const timeLabels = relativeTimeLabelsFromT(t);

  const allItems = useMemo(
    () => [...sections.ready, ...sections.needsSetup, ...sections.disabled],
    [sections],
  );
  const knownNames = useMemo(() => new Set(allItems.map(p => p.name)), [allItems]);

  /* Rate-limit rows: only providers present in sections AND having quota data */
  const quotaProviders = useMemo(() => {
    const result: Array<{ item: WorkspaceItem; report: ProviderQuotaReportView }> = [];
    for (const item of allItems) {
      const report = quotaReports[item.name];
      if (report && accountQuotaFromReport(report)) {
        result.push({ item, report });
      }
    }
    return result;
  }, [allItems, quotaReports]);

  /* Recently-used: filter to known provider names */
  const mostUsed = useMemo(() => {
    const filtered: Record<string, ProviderUsageTotals> = {};
    for (const [name, totals] of Object.entries(usageTotals)) {
      if (knownNames.has(name)) filtered[name] = totals;
    }
    return buildMostUsedProviders(filtered);
  }, [usageTotals, knownNames]);

  return (
    <div className="pws-dashboard">
      <div className="pws-dashboard-header">
        <h2 className="pws-dashboard-title">{t("pws.dashboard.title")}</h2>
        <p className="muted pws-dashboard-subtitle">{t("pws.dashboard.subtitle")}</p>
      </div>

      {/* Summary cards */}
      <div className="pws-dashboard-summary">
        <SummaryCard count={sections.ready.length} label={t("pws.status.ready")} tone="ok" />
        <SummaryCard count={sections.needsSetup.length} label={t("pws.status.needsSetup")} tone="warn" />
        <SummaryCard count={sections.disabled.length} label={t("prov.disabledBadge")} tone="muted" />
      </div>

      {/* Rate limits */}
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

      {/* Recently used */}
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
        <section className="pws-dashboard-section">
          <h3 className="pws-dashboard-section-title">{t("pws.dashboard.recentlyUsed")}</h3>
          <p className="muted">{t("pws.dashboard.noUsage")}</p>
        </section>
      )}
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
