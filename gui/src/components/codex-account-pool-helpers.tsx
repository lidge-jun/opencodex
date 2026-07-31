import type { Locale, TFn } from "../i18n/shared";
import { IconTicket } from "../icons";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import { daysUntil, formatCreditDate, formatCreditDateTime } from "./codex-account-pool-utils";

export function CodexCreditItem({ index, grantedAt, expiresAt, isNext, locale, t }: {
  index: number; grantedAt: string; expiresAt: string; isNext: boolean; locale: Locale; t: TFn;
}) {
  const days = daysUntil(expiresAt);
  const urgent = days <= 7;
  return (
    <div className={`credit-item${isNext ? " credit-next" : ""}`}>
      <div className="credit-item-head">
        <IconTicket width={13} />
        <span className="credit-item-label">
          {isNext ? t("codexAuth.creditNext") : t("codexAuth.creditLabel", { n: String(index + 1) })}
        </span>
        {isNext && <span className="badge badge-amber text-micro" style={{ padding: "1px 6px" }}>{t("codexAuth.creditNextBadge")}</span>}
      </div>
      <div className="credit-item-dates">
        <span>{t("codexAuth.creditGranted", { date: formatCreditDate(grantedAt, locale) })}</span>
        <span className={urgent ? "credit-urgent" : ""}>{t("codexAuth.creditExpires", { date: formatCreditDateTime(expiresAt, locale), days: String(days) })}</span>
      </div>
    </div>
  );
}

export function CodexTicketBadge({ account, onClick, t }: { account: CodexAccountEntry; onClick: () => void; t: TFn }) {
  const credits = account.quota?.resetCredits;
  // Reserve badge width while WHAM quota is still null so the card-head does not grow
  // when resetCredits arrives (0 or N). Quota loaded without resetCredits → no badge.
  if (account.quota == null) {
    return (
      <span className="badge badge-muted codex-ticket-badge-slot" aria-hidden="true">
        <IconTicket width={12} />0
      </span>
    );
  }
  if (credits === undefined) return null;
  const hasCredits = typeof credits === "number" && credits > 0;
  return (
    <button type="button"
      className={`badge ${hasCredits ? "badge-amber" : "badge-muted"} badge-clickable`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={t("codexAuth.resetCreditsAria", { count: String(credits) })}
    >
      <IconTicket width={12} />
      {credits}
    </button>
  );
}

/** Equal-width Pause / Resume / Saving label so the button does not grow on toggle. */
export function CodexPauseToggleLabel({
  t,
  paused,
  saving,
}: {
  t: TFn;
  paused: boolean;
  saving: boolean;
}) {
  const pause = t("codexAuth.pause");
  const resume = t("codexAuth.resume");
  const savingLabel = t("common.saving");
  const visible = saving ? savingLabel : paused ? resume : pause;
  // Proportional fonts: ch is approximate, but avoids the height bugs of hidden
  // multi-line measure stacks / ::before sizers.
  const minCh = Math.max(pause.length, resume.length, savingLabel.length);
  return (
    <span className="codex-auth-pause-label" style={{ minWidth: `${minCh}ch` }}>
      {visible}
    </span>
  );
}
