import { useState } from "react";
import { useT } from "../../i18n/shared";
import { IconRefresh } from "../../icons";
import { accountQuotaFromReport, currentAccountQuotaReport, formatQuotaSourceLabel, type ProviderQuotaReportView } from "../../provider-workspace/report";
import { formatRelativeTime, relativeTimeLabelsFromT } from "../../provider-workspace/usage";
import ProviderAccountQuota from "./ProviderAccountQuota";
import type { AccountQuotaReading } from "./types";

export default function ProviderCurrentQuota({ report, reading, onRefreshQuota }: {
  report?: ProviderQuotaReportView;
  reading?: AccountQuotaReading;
  onRefreshQuota?: () => Promise<boolean>;
}) {
  const t = useT();
  const current = currentAccountQuotaReport(report);
  const rowOwnsReading = reading !== undefined && (
    reading.quotaMode !== undefined || reading.quota !== undefined
    || reading.quotaUnavailable !== undefined || reading.quotaPending !== undefined
  );
  const effective: AccountQuotaReading = rowOwnsReading ? reading : {
    quota: accountQuotaFromReport(current),
    ...(current?.observed === true ? { quotaMode: "passive" } : {}),
  };
  const quota = accountQuotaFromReport({ quota: effective.quota });
  const [refreshing, setRefreshing] = useState(false);
  const [result, setResult] = useState<boolean | null>(null);
  const refresh = async () => {
    if (!onRefreshQuota || refreshing) return;
    setRefreshing(true);
    setResult(null);
    try { setResult(await onRefreshQuota()); }
    catch { setResult(false); }
    finally { setRefreshing(false); }
  };
  return <section className="pws-usage-block" aria-label={t("pws.currentAccountUsage")}>
    <div className="pws-usage-block-head">
      <h3 className="pws-section-title">{t("pws.currentAccountUsage")}</h3>
      {onRefreshQuota && effective.quotaMode !== "unsupported" && <div className="pws-quota-refresh">
        {result !== null && <span role="status" className={result ? "pws-status-ok" : "pws-status-warn"}>
          {t(result ? "pws.quotaCheckCompleted" : "codexAuth.quotaRefreshFailed")}
        </span>}
        <button type="button" className="btn btn-ghost btn-sm" disabled={refreshing} onClick={() => { void refresh(); }}>
          <IconRefresh width={14} height={14} aria-hidden="true" />{" "}
          {t(refreshing ? "codexAuth.refreshingQuota" : "codexAuth.refreshQuota")}
        </button>
      </div>}
    </div>
    <ProviderAccountQuota {...effective} />
    {quota && !effective.quotaUnavailable && effective.quotaMode !== "unsupported" && <dl className="pws-kv pws-usage-meta">
      {!rowOwnsReading && current?.source?.trim() && <div className="pws-kv-row">
        <dt>{t("pws.stats.source")}</dt><dd>{formatQuotaSourceLabel(current.source)}</dd>
      </div>}
      <div className="pws-kv-row"><dt>{t("pws.stats.quotaUpdated")}</dt>
        <dd>{formatRelativeTime(quota.updatedAt, relativeTimeLabelsFromT(t))}</dd></div>
    </dl>}
  </section>;
}
