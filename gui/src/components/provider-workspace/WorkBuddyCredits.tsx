import type { WorkBuddyCreditBalance } from "../../../../src/providers/workbuddy-credit-balance";
import { useI18n } from "../../i18n/shared";
import QuotaBars from "../QuotaBars";

export function WorkBuddyCredits({ credits, updatedAt }: { credits: WorkBuddyCreditBalance; updatedAt: number }) {
  const { t, locale } = useI18n();
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const quantity = (value: number) => t("quota.workbuddy.amount", { amount: number(value) });
  const percent = credits.total > 0 ? Math.min(100, credits.used / credits.total * 100) : 0;
  return <div data-workbuddy-credits>
    <div className="pws-capacity-recovery">
      <span>{t("quota.creditsBalance")}</span>
      <strong>{quantity(credits.remaining)}</strong>
    </div>
    {/* These bars are a local display projection, never a server quota/routing window. */}
    <QuotaBars quota={{ updatedAt, customWindows: [{ label: t("quota.totalSubscriptionCredits"), percent }] }}
      threshold={80} t={t} layout="stacked" />
    <div className="pws-capacity-details">
      <div className="pws-capacity-recovery"><span>{t("quota.workbuddy.usage", {
        used: number(credits.used), total: number(credits.total),
      })}</span></div>
      {credits.groups.filter(group => group.total > 0 || group.remaining > 0).map(group => <div className="pws-capacity-recovery" key={group.kind}>
        <span>{t(`quota.workbuddy.${group.kind}`)}</span>
        <strong>{quantity(group.remaining)} / {number(group.total)}</strong>
      </div>)}
      {credits.frozen > 0 && <div className="pws-capacity-recovery">
        <span>{t("quota.workbuddy.frozen")}</span><strong>{quantity(credits.frozen)}</strong>
      </div>}
      {credits.expiring && <p className="muted">{t("quota.workbuddy.expiring", {
        amount: number(credits.expiring.amount),
        date: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(credits.expiring.at),
      })}</p>}
    </div>
  </div>;
}
