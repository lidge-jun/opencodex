import { HugeiconsIcon } from "@hugeicons/react";
import { SecurityCheckIcon } from "@hugeicons/core-free-icons";
import { useT } from "../../i18n/shared";
import { Notice } from "../../ui";
import { cn } from "../../lib/utils";

/*
 * Context-sharing consent as its own callout: the advisor cannot run without it, so it is not
 * one more row in the form. The state badge says whether it is given; the cost, privacy and
 * disclosure notes stay folded underneath (the checkbox itself never is).
 */
export function AdvisorConsentCallout({ agreed, disabled, onChange }: {
  agreed: boolean;
  disabled: boolean;
  onChange: (agreed: boolean) => void;
}) {
  const t = useT();
  return (
    <section aria-labelledby="advisor-consent-title"
      className={cn("advisor-consent flex flex-col gap-3 rounded-card p-4 ring-1 ring-inset",
        agreed ? "bg-surface ring-line" : "bg-warning-soft ring-warning/25")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-[8px]", agreed ? "bg-raised text-fg" : "bg-raised text-warning")} aria-hidden="true">
          <HugeiconsIcon icon={SecurityCheckIcon} size={16} strokeWidth={1.8} />
        </span>
        <h3 id="advisor-consent-title" className="m-0 text-[15px] leading-5 font-semibold text-fg">{t("proxyV2.consentTitle")}</h3>
        <span className={cn("ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold",
          agreed ? "bg-success-soft text-success" : "bg-raised text-warning")}>
          {agreed ? t("proxyV2.consentGiven") : t("proxyV2.consentNeeded")}
        </span>
      </div>
      <label className="flex cursor-pointer items-start gap-3 rounded-control bg-raised p-3 ring-1 ring-line">
        <input
          type="checkbox"
          className="advisor-consent-check mt-0.5 size-4 shrink-0 cursor-pointer"
          checked={agreed}
          disabled={disabled}
          aria-label={t("advisor.consent.label")}
          onChange={event => onChange(event.target.checked)}
        />
        <span className="text-[13px] leading-[19px] text-fg">{t("advisor.consent.label")}</span>
      </label>
      {/* Collapsed by default: three stacked warnings buried the settings below them. The
          consent checkbox and its required notice stay visible, so folding them hides no gate. */}
      <details className="advisor-notices pv2-more">
        <summary>{t("advisor.notices")}</summary>
        <div className="flex flex-col gap-2">
          <Notice tone="warn">{t("advisor.costNote")}</Notice>
          <Notice tone="warn">{t("advisor.privacyNote")}</Notice>
          <Notice tone="warn">{t("advisor.disclosure")}</Notice>
        </div>
      </details>
    </section>
  );
}
