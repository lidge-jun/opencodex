import type { CodexAccountEntry } from "../codex-account-pool-types";
import type { CodexAccountModeState } from "../../codex-multi-state";
import type { TFn } from "../../i18n/shared";
import { oauthHealthIsCooldown, oauthHealthShowsReauth } from "../../oauth-health-display";
import AccountQuotaMeters from "./account-quota-meters";
import { servingAccount } from "./serving-account";
import { StatusDot } from "./surface";

/*
 * The first thing on the Codex page: which account is serving, and how much it has left.
 * Shaped after the React Bits Pro `dashboard-5` plan frame — name and plan on the left, the
 * remaining-quota meters beside it — so the answer reads before any setting does.
 */
export function ServingSummary({ accounts, activeId, mode, threshold, loading, t }: {
  accounts: readonly CodexAccountEntry[];
  activeId: string | null;
  mode: CodexAccountModeState | null;
  threshold: number;
  loading: boolean;
  t: TFn;
}) {
  if (accounts.length === 0) return null;
  const account = servingAccount(accounts, activeId, mode);
  if (!account) {
    return (
      <section className="acc-serving ui-v2 flex items-center gap-3 rounded-[12px] bg-surface px-5 py-4 ring-1 ring-line" aria-label={t("accountsV2.servingNow")}>
        <StatusDot tone="warn" />
        <p className="m-0 text-[14px] font-medium text-fg">{t("accountsV2.servingNone")}</p>
      </section>
    );
  }
  const needsReauth = Boolean(account.needsReauth) || oauthHealthShowsReauth(account.health?.status);
  const cooldown = oauthHealthIsCooldown(account.health?.status);
  const name = account.isMain ? (account.alias ?? (account.email || t("codexAuth.appLogin"))) : (account.alias ?? account.email);
  return (
    <section className="acc-serving ui-v2 grid gap-x-8 gap-y-4 rounded-[12px] bg-surface px-5 py-4 ring-1 ring-line md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)] md:items-center"
      aria-label={t("accountsV2.servingNow")}>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2 text-[12px] leading-4 font-medium text-fg-muted">
          <StatusDot tone={needsReauth || cooldown ? "warn" : "ok"} />
          {t("accountsV2.servingNow")}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <strong className="min-w-0 truncate text-[17px] leading-6 font-semibold tracking-[-0.015em] text-fg">{name}</strong>
          {account.plan && <span className="acc-chip">{account.plan}</span>}
          {account.isMain && <span className="acc-chip">{t("codexAuth.mainAccount")}</span>}
        </span>
        <span className="text-[12.5px] leading-[18px] text-fg-muted">
          {needsReauth ? t("codexAuth.tokenExpired")
            : mode === "direct" ? t("accountsV2.servingDirect") : t("accountsV2.servingPool")}
        </span>
      </div>
      <div className="min-w-0">
        {account.quota == null && !loading ? (
          <p className="m-0 text-[13px] text-fg-subtle">{t("accountsV2.quotaUnknown")}</p>
        ) : (
          <AccountQuotaMeters
            quota={account.quota}
            plan={account.plan}
            threshold={account.autoSwitchThresholdOverride ?? threshold}
            t={t}
            pending={account.quota == null}
            size="hero"
          />
        )}
      </div>
    </section>
  );
}
