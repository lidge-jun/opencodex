import { useT } from "../i18n/shared";
import { IconAlert, IconPause, IconPlay, IconX } from "../icons";
import { displayAccountId } from "../lib/privacy";
import AccountPriorityControl, { AccountPriorityBadge } from "./AccountPriorityControl";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import type { CodexAccountModeState } from "../codex-multi-state";
import QuotaBars from "./QuotaBars";
import { CodexPauseToggleLabel, CodexTicketBadge } from "./codex-account-pool-helpers";
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
  onPriorityChange,
  priorityUpdatingId,
  switchingId,
  pinnedId = null,
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
  onPriorityChange: (account: CodexAccountEntry, priority: number) => void;
  priorityUpdatingId: string | null;
  /** In-flight manual switch, which writes the same pin an order write clears. */
  switchingId: string | null;
  /**
   * The account an operator pinned by hand, which is not always the selected one: under
   * round-robin and fill-first the pin caps selection at its own tier while the cursor
   * moves inside that tier. Marking the pinned card rather than the selected one keeps the
   * badge on the account the operator actually chose.
   */
  pinnedId?: string | null;
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
              {a.paused && (
                <span className="badge badge-muted" title={t("codexAuth.pausedHint")}>
                  {t("codexAuth.paused")}
                </span>
              )}
              <AccountPriorityBadge value={a.priority} />
              {a.id === pinnedId && !a.paused && <span className="badge badge-muted">{t("codexAuth.pinned")}</span>}
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
              <button type="button" className="btn btn-ghost btn-sm codex-auth-action-btn" onClick={() => onCopyDoctor(a.id)}>
                <span aria-live="polite">{doctorCopyButtonLabel(t, doctorCopyOutcomeFor?.(a.id))}</span>
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm btn-ghost codex-auth-action-btn"
              onClick={() => onTogglePause(a)}
              disabled={pauseBusy}
              title={a.paused ? t("codexAuth.pausedHint") : undefined}
              aria-label={a.paused ? `${t("codexAuth.resume")}. ${t("codexAuth.pausedHint")}` : t("codexAuth.pause")}
            >
              {a.paused ? <IconPlay width={14} /> : <IconPause width={14} />}
              <CodexPauseToggleLabel
                t={t}
                paused={a.paused}
                saving={pauseUpdatingId === a.id}
              />
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
          <div className="codex-account-identity">
            <div className="codex-account-identity-copy">{a.email}{a.plan ? ` · ${a.plan}` : ""} · {t("prov.accountId")}: {displayAccountId(a.id)}</div>
            <AccountPriorityControl
              value={a.priority}
              selectId={`codex-account-priority-${a.id}`}
              // Every row, not just the one being written: the controller serializes order
              // writes behind one mutation ref, so a second row's pick would come back "busy"
              // and be dropped with no toast. Same global lock the pause button uses.
              // A pending switch counts too — it writes the same pin this clears, so the
              // controller refuses to overlap them, and that refusal is equally silent.
              disabled={priorityUpdatingId !== null || switchingId !== null}
              onChange={(priority) => onPriorityChange(a, priority)}
            />
          </div>
          {healthSummary && (
            <div className="card-sub faint">{healthSummary}</div>
          )}
          {inCooldown && (
            <div className="card-sub faint">{t("pws.healthCooldownHint")}</div>
          )}
          {showReauth
            ? <div className="card-sub faint">{t("codexAuth.tokenExpired")}</div>
            : !inCooldown && (
              <QuotaBars
                quota={a.quota}
                plan={a.plan}
                threshold={threshold}
                t={t}
                pending={a.quota == null}
              />
            )}
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
