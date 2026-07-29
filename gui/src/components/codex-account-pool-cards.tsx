import { useT } from "../i18n/shared";
import { IconAlert, IconPause, IconPlay, IconX } from "../icons";
import { displayAccountId } from "../lib/privacy";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import type { CodexAccountModeState } from "../codex-multi-state";
import QuotaBars from "./QuotaBars";
import { CodexTicketBadge } from "./codex-account-pool-helpers";
import {
  doctorCopyButtonLabel,
  formatOAuthHealthLabel,
  formatOAuthHealthSummary,
  oauthHealthBadgeClass,
  oauthHealthIsCooldown,
  oauthHealthShowsDoctor,
  oauthHealthShowsReauth,
} from "../oauth-health-display";

export function CodexAccountPoolCards({
  pool,
  activeId,
  accountModeState,
  switchActionLabel,
  threshold,
  onOpenReset,
  onSwitch,
  onTogglePause,
  pauseUpdatingId,
  pauseBusy,
  onReauth,
  onEditAlias,
  onRemove,
  onCopyDoctor,
  doctorCopyOutcomeFor,
}: {
  pool: CodexAccountEntry[];
  activeId: string | null;
  accountModeState: CodexAccountModeState | null;
  switchActionLabel: string;
  threshold: number;
  onOpenReset: (account: CodexAccountEntry) => void;
  onSwitch: (account: CodexAccountEntry) => void;
  onTogglePause: (account: CodexAccountEntry) => void;
  pauseUpdatingId: string | null;
  pauseBusy: boolean;
  onReauth: (id: string) => void;
  onEditAlias: (account: CodexAccountEntry) => void;
  onRemove: (id: string) => void;
  onCopyDoctor?: (accountId: string) => void;
  doctorCopyOutcomeFor?: (accountId: string) => "copied" | "unavailable" | null;
}) {
  const t = useT();
  const isNext = (account: CodexAccountEntry) => !account.paused && activeId === account.id;

  return (
    <>
      {pool.map(a => {
        const healthStatus = a.health?.status;
        const showReauth = Boolean(a.needsReauth) || oauthHealthShowsReauth(healthStatus);
        const inCooldown = oauthHealthIsCooldown(healthStatus);
        const healthLabel = formatOAuthHealthLabel(t, a.health);
        const healthSummary = formatOAuthHealthSummary(t, "codex", a.id, a.health);
        return (
        <div key={a.id} className={`card ${isNext(a) ? "card-active" : ""}`} style={{ marginBottom: 8 }}>
          <div className="card-head">
            <span className={`dot ${showReauth ? "dot-amber" : isNext(a) ? "dot-blue" : "dot-muted"}`} />
            <strong>{a.alias ?? a.email}</strong>
            <span className="card-badges">
              {a.plan && <span className="badge badge-green">{a.plan}</span>}
              {a.paused && <span className="badge badge-muted">{t("codexAuth.paused")}</span>}
              <CodexTicketBadge t={t} account={a} onClick={() => onOpenReset(a)} />
              {healthLabel && (
                <span className={oauthHealthBadgeClass(healthStatus)}>{healthLabel}</span>
              )}
              {showReauth && !healthLabel && <span className="badge badge-amber">{t("codexAuth.needsReauth")}</span>}
              {isNext(a) && !showReauth && !inCooldown && (
                <span className="badge badge-primary">
                  {t(accountModeState === "direct" ? "codexAuth.poolPrepared" : "codexAuth.nextSession")}
                </span>
              )}
            </span>
            {!a.paused && !isNext(a) && !showReauth && !inCooldown && (
              <button type="button" className="btn btn-ghost btn-sm codex-account-switch" onClick={() => onSwitch(a)}>
                {switchActionLabel}
              </button>
            )}
            {showReauth && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => onReauth(a.id)}>
                {t("codexAuth.reauthenticate")}
              </button>
            )}
            {onCopyDoctor && oauthHealthShowsDoctor(healthStatus) && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCopyDoctor(a.id)}>
                <span aria-live="polite">{doctorCopyButtonLabel(t, doctorCopyOutcomeFor?.(a.id))}</span>
              </button>
            )}
            <button
              type="button"
              className={`btn btn-sm ${a.paused ? "btn-primary" : "btn-ghost"}`}
              onClick={() => onTogglePause(a)}
              disabled={pauseBusy}
            >
              {a.paused ? <IconPlay width={14} /> : <IconPause width={14} />}
              {pauseUpdatingId === a.id ? t("common.saving") : t(a.paused ? "codexAuth.resume" : "codexAuth.pause")}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void onEditAlias(a)}>
              {t("prov.editAlias")}
            </button>
            <button
              type="button"
              className="btn-icon btn-icon-danger card-right"
              aria-label={`${t("common.remove")} — ${a.email}`}
              title={`${t("common.remove")} — ${a.email}`}
              onClick={e => { e.stopPropagation(); void onRemove(a.id); }}
            >
              <IconX width={14} />
            </button>
          </div>
          <div className="card-sub">{a.email}{a.plan ? ` · ${a.plan}` : ""} · {t("prov.accountId")}: {displayAccountId(a.id)}</div>
          {healthSummary && (
            <div className="card-sub faint">{healthSummary}</div>
          )}
          {a.paused && <div className="card-sub faint">{t("codexAuth.pausedHint")}</div>}
          {inCooldown && (
            <div className="card-sub faint">{t("pws.healthCooldownHint")}</div>
          )}
          {showReauth
            ? <div className="card-sub faint">{t("codexAuth.tokenExpired")}</div>
            : !inCooldown && <QuotaBars quota={a.quota} plan={a.plan} threshold={threshold} t={t} />}
        </div>
        );
      })}
    </>
  );
}

export function CodexAccountPoolReauthBanner({
  onReauth,
}: {
  onReauth: () => void;
}) {
  const t = useT();
  return (
    <div className="notice-warn" style={{ marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <span><IconAlert width={14} /> {t("codexAuth.tokenExpired")}</span>
      <button type="button" className="btn btn-primary btn-sm" onClick={onReauth}>
        {t("codexAuth.reauthenticate")}
      </button>
    </div>
  );
}
