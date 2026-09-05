import { useT } from "../../i18n/shared";
import { accountQuotaFromReport } from "../../provider-workspace/report";
import { formatRelativeTime, relativeTimeLabelsFromT } from "../../provider-workspace/usage";
import { ProviderCapacityQuota } from "./ProviderCapacityQuota";
import type { AccountQuotaReading } from "./types";

/** The same reading states and credit/window renderer for current and all-account views. */
export default function ProviderAccountQuota({ quota: rawQuota, quotaMode, quotaUnavailable, quotaPending }: AccountQuotaReading) {
  const t = useT();
  const quota = accountQuotaFromReport({ quota: rawQuota });
  if (quotaMode === "unsupported") {
    return <p className="muted" data-quota-state="unsupported">{t("pws.quotaUnsupported")}</p>;
  }
  const pending = quotaMode === "probe" && quotaPending === true;
  const state = quotaUnavailable ? "unavailable" : pending ? "pending" : quota ? "ready" : quotaMode === "passive" ? "unobserved" : "unknown";
  return <div data-quota-state={state}>
    {quotaUnavailable && <p className="muted pwi-auth-acct-quota-stale">{t("pws.accountQuotaUnavailable")}</p>}
    {quota || pending ? (
      <ProviderCapacityQuota
        report={{ quota, updatedAt: quota?.updatedAt, ...(quotaMode === "passive" ? { observed: true } : {}) }}
        pending={pending && !quota}
      />
    ) : !quotaUnavailable && (
      <p className="muted">{t(quotaMode === "passive" ? "pws.quotaUnobserved" : "pws.quotaUnavailable")}</p>
    )}
    {quotaUnavailable && quota && <p className="muted">
      {t("pws.stats.quotaUpdated")}: {formatRelativeTime(quota.updatedAt, relativeTimeLabelsFromT(t))}
    </p>}
  </div>;
}
