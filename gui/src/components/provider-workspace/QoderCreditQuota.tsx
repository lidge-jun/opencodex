import { useI18n, useT } from "../../i18n/shared";
import "./qoder-credit-quota.css";
import { accountQuotaFromReport } from "../../provider-workspace/report";
import QuotaBars from "../QuotaBars";
import ProviderAccountQuota from "./ProviderAccountQuota";
import type { AccountQuotaReading } from "./types";

/** Qoder key-card display only. Keep the shared quota renderers unchanged. */
export default function QoderCreditQuota(reading: AccountQuotaReading) {
  const t = useT();
  const { locale } = useI18n();
  const quota = accountQuotaFromReport({ quota: reading.quota });
  if (reading.quotaMode === "unsupported" || reading.quotaUnavailable || !quota?.creditBuckets?.length) {
    return <ProviderAccountQuota {...reading} />;
  }

  const format = new Intl.NumberFormat(locale);
  const buckets = [...quota.creditBuckets].sort(
    (a, b) => (a.kind === "userQuota" ? 0 : a.kind === "addOnQuota" ? 1 : 2)
      - (b.kind === "userQuota" ? 0 : b.kind === "addOnQuota" ? 1 : 2),
  );
  return (
    <div className="quota-stacked qoder-credit-quota" data-quota-state="ready">
      {buckets.map((bucket, index) => (
        <div key={`${bucket.kind}-${index}`}>
          <QuotaBars
            quota={{ updatedAt: quota.updatedAt, creditBuckets: [bucket] }}
            threshold={80}
            t={t}
            layout="compact"
          />
          <div className="pws-capacity-recovery">
            {bucket.percent !== undefined && (
              <span>{`${format.format(bucket.used)} / ${format.format(bucket.limit)}`}</span>
            )}
            {bucket.remaining !== undefined && (
              <strong>{t("codexAuth.creditsRemaining")} {format.format(bucket.remaining)}</strong>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
