/**
 * ProviderOverviewDashboard — aggregate overview when no provider is selected.
 * Shows summary cards, attention list, per-provider rate limits (QuotaBars stacked),
 * recently-used ranking, and Edit JSON entry.
 */
import { useMemo, useState } from "react";
import { useT, useI18n } from "../../i18n/shared";
import { IconAlert, IconChevron, IconRefresh } from "../../icons";
import type { WorkspaceSections, WorkspaceItem } from "../../provider-workspace/catalog";
import {
  accountQuotaFromReport,
  capacityAggregationFromReport,
  type ProviderQuotaReportView,
} from "../../provider-workspace/report";
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
import { ProviderCapacityQuota } from "./ProviderCapacityQuota";

export default function ProviderOverviewDashboard({
  sections,
  quotaReports,
  usageTotals,
  usageLoading = false,
  quotasLoading = false,
  onSelectProvider,
  onEditConfig,
  onRefreshAllQuotas,
}: {
  sections: WorkspaceSections;
  quotaReports: Record<string, ProviderQuotaReportView>;
  usageTotals: Record<string, ProviderUsageTotals>;
  usageLoading?: boolean;
  quotasLoading?: boolean;
  onSelectProvider: (name: string) => void;
  onEditConfig?: () => void;
  /** Force a fresh read of every provider's quota; omitted when the page cannot drive one. */
  onRefreshAllQuotas?: () => Promise<boolean>;
}) {
  const t = useT();
  const { locale } = useI18n();
  const timeLabels = relativeTimeLabelsFromT(t);
  const [refreshingQuotas, setRefreshingQuotas] = useState(false);
  const [refreshResult, setRefreshResult] = useState<{ ok: boolean; text: string } | null>(null);

  /*
   * Same contract as the per-provider control in ProviderUsage: the reported result
   * comes from the settled promise, not from the click. `fetchProviderQuotas(true)` is a
   * synchronous state bump, so a button that resolved on its own would claim success
   * while the stale numbers were still on screen. The disabled guard is not cosmetic
   * either: a second forced read cancels the first effect, and a cancelled read never
   * settles its waiters.
   */
  const refreshAllQuotas = async () => {
    if (!onRefreshAllQuotas || refreshingQuotas) return;
    setRefreshingQuotas(true);
    // Cleared on click so a previous "refreshed" cannot sit under a later failure.
    setRefreshResult(null);
    try {
      const ok = await onRefreshAllQuotas();
      /*
       * "Quota check complete", not "Quotas refreshed". The boolean reports whether the
       * READ succeeded, and the server answers 200 even when an individual upstream probe
       * failed: fetchProviderQuotaReports keeps that provider's last-good row rather than
       * dropping it. Claiming every number is fresh would be exactly the lie this control
       * was built to avoid. Each row carries its own age, which is where per-provider
       * staleness is already visible.
       */
      setRefreshResult({ ok, text: t(ok ? "pws.quotaRefreshDone" : "codexAuth.quotaRefreshFailed") });
    } catch {
      setRefreshResult({ ok: false, text: t("codexAuth.quotaRefreshFailed") });
    } finally {
      setRefreshingQuotas(false);
    }
  };

  const allItems = useMemo(
    () => [...sections.ready, ...sections.needsSetup, ...sections.disabled],
    [sections],
  );
  const knownNames = useMemo(() => new Set(allItems.map(p => p.name)), [allItems]);

  const attention = useMemo(() => buildAttentionItems(sections, {}), [sections]);
  const attentionCount = attention.length;
  const readyReauthCount = useMemo(
    () => sections.ready.filter(p => p.activeNeedsReauth).length,
    [sections],
  );
  const readyCount = sections.ready.length - readyReauthCount;
  const needsAttentionCount = sections.needsSetup.length + readyReauthCount;

  /* Rate-limit rows: urgency first (highest utilisation), then name */
  const quotaProviders = useMemo(() => {
    const result: Array<{ item: WorkspaceItem; report: ProviderQuotaReportView; urgency: number }> = [];
    for (const item of allItems) {
      const report = quotaReports[item.name];
      const quota = report ? accountQuotaFromReport(report) : null;
      const aggregation = report ? capacityAggregationFromReport(report) : null;
      if (report && (quota || aggregation?.presentation === "coverage-only")) {
        result.push({ item, report, urgency: quota ? maxQuotaUtilisation(quota) : -1 });
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
        </div>
        <div className="pws-dashboard-header-actions">
          {refreshResult && (
            <span role="status" className={refreshResult.ok ? "pws-status-ok" : "pws-status-warn"}>
              {refreshResult.text}
            </span>
          )}
          {onRefreshAllQuotas && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={refreshingQuotas}
              onClick={() => { void refreshAllQuotas(); }}
            >
              <IconRefresh width={14} height={14} aria-hidden="true" />
              {" "}
              {refreshingQuotas ? t("codexAuth.refreshingQuota") : t("pws.refreshAllQuotas")}
            </button>
          )}
          {onEditConfig && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onEditConfig}>
              {t("prov.editJson")}
            </button>
          )}
        </div>
      </div>

      <div className="pws-dashboard-summary">
        <SummaryCard count={readyCount} label={t("pws.status.ready")} tone="ok" />
        <SummaryCard
          count={needsAttentionCount}
          label={readyReauthCount > 0 ? t("pws.status.needsAttention") : t("pws.status.needsSetup")}
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
                  <span className="pws-dashboard-row-name">{formatProviderDisplayName(item.name, t)}</span>
                  <span className="pws-dashboard-row-meta muted">{localizeAttentionReason(item.reason)}</span>
                </div>
                <IconChevron className="pws-dashboard-row-chevron" aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="pws-dashboard-columns">
        <section
          className="pws-dashboard-section pws-dashboard-section--rate-limits"
          aria-label={t("pws.dashboard.rateLimits")}
          aria-busy={quotasLoading || undefined}
        >
          <h3 className="pws-dashboard-section-title">{t("pws.dashboard.rateLimits")}</h3>
          {quotaProviders.length > 0 ? (
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
                    <span className="pws-dashboard-row-name">{formatProviderDisplayName(item.name, t)}</span>
                    <span className="pws-dashboard-row-meta muted">
                      {t("pws.dashboard.checkedAgo", { time: formatRelativeTime(report.updatedAt, timeLabels) })}
                    </span>
                  </div>
                  <IconChevron className="pws-dashboard-row-chevron" aria-hidden="true" />
                  <div className="pws-dashboard-row-bars">
                    <ProviderCapacityQuota report={report} pending={quotasLoading && !report.quota} />
                  </div>
                </button>
              ))}
            </div>
          ) : quotasLoading ? (
            <div className="pws-dashboard-rows pws-dashboard-rows--pending" aria-hidden="true">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="pws-dashboard-row pws-dashboard-row--skeleton">
                  <span className="pws-dashboard-row-icon pws-skel" />
                  <div className="pws-dashboard-row-info">
                    <span className="pws-skel pws-skel--name" />
                    <span className="pws-skel pws-skel--meta" />
                  </div>
                  <div className="pws-dashboard-row-bars">
                    <QuotaBars quota={null} threshold={80} t={t} layout="stacked" pending />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted pws-dashboard-empty">{t("pws.dashboard.noRateLimits")}</p>
          )}
        </section>

        <section
          className="pws-dashboard-section pws-dashboard-section--recent"
          aria-label={t("pws.dashboard.recentlyUsed")}
          aria-busy={usageLoading || undefined}
        >
        <details className="pws-dashboard-recent-details">
          <summary className="pws-dashboard-section-title">{t("pws.dashboard.recentlyUsed")}</summary>
          {mostUsed.length > 0 ? (
            <div className="pws-dashboard-rows">
              {mostUsed.map(provider => (
                <button
                  key={provider.name}
                  type="button"
                  className="pws-dashboard-row"
                  onClick={() => onSelectProvider(provider.name)}
                >
                  <ProviderIcon name={provider.name} adapter="" baseUrl="" cls="pws-dashboard-row-icon" />
                  <span className="pws-dashboard-row-name">{formatProviderDisplayName(provider.name, t)}</span>
                  <span className="pws-dashboard-row-count muted">
                    {t("pws.dashboard.requests", { count: formatRequestCount(provider.requests, locale) })}
                  </span>
                  <IconChevron className="pws-dashboard-row-chevron" aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : usageLoading ? (
            <div className="pws-dashboard-rows pws-dashboard-rows--pending" aria-hidden="true">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="pws-dashboard-row pws-dashboard-row--skeleton">
                  <span className="pws-dashboard-row-icon pws-skel" />
                  <span className="pws-skel pws-skel--name" />
                  <span className="pws-skel pws-skel--count" />
                </div>
              ))}
            </div>
          ) : (
            <p className="muted pws-dashboard-empty">{t("pws.dashboard.noUsage")}</p>
          )}
        </details>
        </section>
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
