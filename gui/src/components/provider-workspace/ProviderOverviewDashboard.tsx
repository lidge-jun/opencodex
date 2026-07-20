/**
 * ProviderOverviewDashboard — aggregate overview when no provider is selected.
 * Shows summary cards, attention list, per-provider rate limits (QuotaBars stacked),
 * recently-used ranking, and Edit JSON entry.
 */
import { useMemo } from "react";
import { useT, useI18n } from "../../i18n";
import { IconAlert, IconChevron } from "../../icons";
import type { WorkspaceSections, WorkspaceItem } from "../../provider-workspace/catalog";
import { accountQuotaFromReport, type ProviderQuotaReportView } from "../../provider-workspace/report";
import {
  attentionReasonKey,
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

  const attention = useMemo(() => buildAttentionItems(sections, {}), [sections]);
  const attentionCount = attention.length;
  const reauthCount = useMemo(
    () => sections.needsSetup.filter(p => p.activeNeedsReauth).length,
    [sections],
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

  const localizeAttentionReason = (reason: string) => {
    const key = attentionReasonKey(reason);
    if (key === "reauth") return t("pws.attention.reauth");
    if (key === "missing") return t("pws.attention.missingCredentials");
    return reason;
  };

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
        <SummaryCard
          count={sections.needsSetup.length}
          label={reauthCount > 0 ? t("pws.status.needsAttention") : t("pws.status.needsSetup")}
          tone="warn"
        />
        <SummaryCard count={sections.disabled.length} label={t("prov.disabledBadge")} tone="muted" />
      </div>

      {attentionCount > 0 && (
        <section className="pws-dashboard-section pws-dashboard-attention" aria-label={t("pws.attentionTitle")}>
          <h3 className="pws-dashboard-section-title">
            <IconAlert style={{ width: 14, height: 14 }} aria-hidden="true" />
            {t("pws.attentionTitle")}
          </h3>
          <div className="pws-dashboard-rows">
            {attention.map(item => (
              <button
                key={`${item.name}:${item.reason}`}
                type="button"
                className="pws-dashboard-row pws-dashboard-row--attention"
                onClick={() => onSelectProvider(item.name)}
              >
                <ProviderIcon name={item.name} adapter="" baseUrl="" cls="pws-dashboard-row-icon" />
                <div className="pws-dashboard-row-info">
                  <span className="pws-dashboard-row-name">{formatProviderDisplayName(item.name)}</span>
                  <span className="pws-dashboard-row-meta muted">{localizeAttentionReason(item.reason)}</span>
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
