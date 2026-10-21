import type { AccountPauseReason } from "../../src/types/account-auto-pause";
import type { Locale, TFn, TKey } from "./i18n/shared";

const REASON_KEYS = {
  oauth_organization_disabled: "accountPause.reason.organizationDisabled",
  account_permission_denied: "accountPause.reason.permissionDenied",
  subscription_inactive: "accountPause.reason.subscriptionInactive",
  subscription_expired: "accountPause.reason.subscriptionExpired",
  plan_downgraded: "accountPause.reason.planDowngraded",
} satisfies Record<AccountPauseReason, TKey>;

/** Display fixed reason labels and timestamps in the selected dashboard language. */
export function formatAccountPauseTooltip(
  t: TFn, locale: Locale, details: { reason: string; pausedAt: number },
): string {
  const reason = Object.hasOwn(REASON_KEYS, details.reason)
    ? t(REASON_KEYS[details.reason as AccountPauseReason]) : t("codexAuth.paused");
  const date = new Date(details.pausedAt);
  return Number.isNaN(date.getTime()) ? reason : t("accountPause.tooltip", { reason, date: date.toLocaleString(locale) });
}
