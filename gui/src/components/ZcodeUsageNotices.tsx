import { useEffect, useState } from "react";
import { useI18n, useT } from "../i18n/shared";
import { browserTimeZone, formatZcodeLocalTime, zcodeUsageSchedule, ZCODE_CAMPAIGN_SOURCE, ZCODE_USAGE_SOURCE } from "../zcode-usage-schedule";

export default function ZcodeUsageNotices({ viaZcode = true }: { viaZcode?: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  const [now, setNow] = useState(Date.now);
  const schedule = zcodeUsageSchedule(now);
  const zone = browserTimeZone();
  const local = (timestamp: number) => formatZcodeLocalTime(timestamp, locale, zone);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const interval = setInterval(update, 1000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(interval); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, []);
  return <section className="pws-usage-block" aria-label={t("zcodeUsage.title")}>
    <h3 className="pws-section-title">{t("zcodeUsage.title")}</h3>
    <p className="muted">{t("zcodeUsage.zone", { zone })}</p>
    <div role="status">
      <p className={schedule.peak ? "pws-status-warn" : "pws-status-ok"}>
        {t(schedule.peak ? "zcodeUsage.peak" : "zcodeUsage.offPeak", { until: local(schedule.rateChangesAt) })}
      </p>
      {viaZcode && schedule.campaign && <>
        <p className={schedule.flashActive ? "pws-status-ok" : "muted"}>
          {t(schedule.flashActive ? "zcodeUsage.flashActive" : "zcodeUsage.flashNext", {
            start: local(schedule.flashStart), end: local(schedule.flashEnd),
          })}
        </p>
        <p className="muted">{t("zcodeUsage.eligibility")}</p>
      </>}
    </div>
    <p className="muted">{t("zcodeUsage.rules")}</p>
    <a href={ZCODE_USAGE_SOURCE} target="_blank" rel="noreferrer">{t("zcodeUsage.source")}</a>
    {viaZcode && <> · <a href={ZCODE_CAMPAIGN_SOURCE} target="_blank" rel="noreferrer">{t("zcodeUsage.campaignSource")}</a></>}
  </section>;
}
