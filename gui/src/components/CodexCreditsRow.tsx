import type { CSSProperties } from "react";
import type { CodexCredits } from "../hooks/useCodexAccountPool";
import type { Locale, TFn } from "../i18n/shared";
import "../styles/codex-credits.css";

/** A remaining-credit status, with no denominator or utilisation percentage. */
export default function CodexCreditsRow({ credits, t, locale }: {
  credits?: CodexCredits;
  t: TFn;
  locale: Locale;
}) {
  if (!credits) return null;
  const balance = credits.balance !== undefined && /^\d+(\.\d+)?$/.test(credits.balance)
    ? Number(credits.balance) : undefined;
  const usableBalance = balance !== undefined && Number.isFinite(balance);
  if (!usableBalance && credits.unlimited !== true && credits.overageLimitReached !== true) return null;
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const formattedBalance = usableBalance ? format.format(balance!) : "";
  const overage = credits.overageLimitReached === true;
  const unlimited = credits.unlimited === true;
  const value = overage
    ? `${formattedBalance ? `${formattedBalance} · ` : ""}${t("codexAuth.creditsOverage")}`
    : unlimited ? t("codexAuth.creditsUnlimited") : formattedBalance;
  const full = !overage && (unlimited || (usableBalance && balance! > 0));
  const range = (values?: [number, number]) => values
    ? values.map(n => format.format(n)).join("–") : "—";
  const title = credits.approxLocalMessages || credits.approxCloudMessages
    ? t("codexAuth.creditsApprox", {
        local: range(credits.approxLocalMessages), cloud: range(credits.approxCloudMessages),
      }) : undefined;
  return (
    <div className="quota-row quota-row--codex-credits" title={title}>
      <span className="quota-label">{t("codexAuth.credits")}</span>
      <span className="quota-reset-label">{t("codexAuth.creditsRemaining")}</span>
      <span className="quota-reset-day" />
      <span className="quota-reset-time" />
      <div className="bar" aria-hidden="true">
        <div className="bar-fill bar-green" style={{ "--bar-scale": full ? "1" : "0" } as CSSProperties} />
      </div>
      <span className="quota-val">{value}</span>
    </div>
  );
}
