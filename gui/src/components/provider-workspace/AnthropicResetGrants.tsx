/**
 * Claude usage-reset ticket badge and spend dialog for Anthropic OAuth rows.
 *
 * Mirrors GrokResetCoupons with one deliberate difference in recovery. Anthropic
 * treats a repeated request id as the same claim (the Claude Code client retries
 * an unconfirmed claim with the same id for ten minutes), so after an unknown
 * outcome this dialog keeps the operation id and offers exactly one action that
 * posts: a retry of that same id. It never mints a new id while one is
 * unresolved, and it resumes an unresolved attempt the server still holds even
 * after a page reload.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, type TFn, type TKey } from "../../i18n/shared";
import { IconAlert, IconTicket } from "../../icons";
import { daysUntil, formatCreditDate, formatCreditDateTime } from "../codex-account-pool-utils";
import {
  spendableGrant,
  unspentResets,
  type AnthropicGrantEntry,
  type AnthropicResetGrant,
  type AnthropicResetGrantController,
  type AnthropicResetGrantSnapshot,
  type AnthropicSpendOutcome,
} from "../../hooks/useAnthropicResetGrants";

function newOperationId(): string | undefined {
  const api = globalThis.crypto;
  if (api && typeof api.randomUUID === "function") return api.randomUUID();
  if (api && typeof api.getRandomValues === "function") {
    const bytes = api.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }
  return undefined;
}

const SETTLED_KEYS: Record<string, TKey> = {
  reset: "anthropicGrant.resultReset",
  already_used: "anthropicGrant.resultAlreadyUsed",
  not_limited: "anthropicGrant.resultNotLimited",
  cooldown: "anthropicGrant.resultCooldown",
  ineligible: "anthropicGrant.resultIneligible",
  unavailable: "anthropicGrant.resultUnavailable",
  rate_limited: "anthropicGrant.resultRateLimited",
  auth_error: "anthropicGrant.resultAuthError",
};

const REFUSED_KEYS: Record<string, TKey> = {
  grant_not_usable: "anthropicGrant.notUsableNow",
  operation_identity_mismatch: "anthropicGrant.identityMismatch",
  unresolved_prior_operation: "anthropicGrant.unresolvedPrior",
  unknown_outcome_expired: "anthropicGrant.expired",
  session_required: "anthropicGrant.sessionRequired",
  ledger_busy: "anthropicGrant.journalBusy",
  ledger_unavailable: "anthropicGrant.journalBusy",
  ledger_capacity: "anthropicGrant.journalBusy",
  auth_failed: "anthropicGrant.resultAuthError",
};

/** Ticket badge on an Anthropic account row. Muted at zero, amber when a reset is spendable. */
export function AnthropicGrantBadge({ entry, onClick, t }: {
  entry: AnthropicGrantEntry | undefined;
  onClick: () => void;
  t: TFn;
}) {
  if (entry === undefined || entry.status === "loading") {
    return (
      <span className="badge badge-muted codex-ticket-badge-slot" aria-hidden="true">
        <IconTicket width={12} />0
      </span>
    );
  }
  const count = entry.status === "ready" ? unspentResets(entry.snapshot) : null;
  const spendable = entry.status === "ready" && spendableGrant(entry.snapshot) !== undefined;
  const label = count === null
    ? t("anthropicGrant.badgeErrorAria")
    : t("anthropicGrant.badgeAria", { count: String(count) });
  return (
    <button
      type="button"
      className={`badge ${spendable ? "badge-amber" : "badge-muted"} badge-clickable`}
      data-anthropic-grant-badge={count === null ? "error" : String(count)}
      onClick={event => { event.stopPropagation(); onClick(); }}
      aria-label={label}
      title={label}
    >
      <IconTicket width={12} />
      {count === null ? <IconAlert width={11} /> : count}
    </button>
  );
}

const WINDOW_KEYS = {
  five_hour: "anthropicGrant.windowFiveHour",
  seven_day: "anthropicGrant.windowWeekly",
  seven_day_overage_included: "anthropicGrant.windowOverage",
} as const satisfies Record<string, TKey>;

function GrantItem({ grant, snapshot, isNext, locale, t }: {
  grant: AnthropicResetGrant;
  snapshot: AnthropicResetGrantSnapshot;
  isNext: boolean;
  locale: string;
  t: TFn;
}) {
  const days = grant.endsAt ? daysUntil(grant.endsAt) : null;
  const note = grant.paused ? t("anthropicGrant.paused")
    : !grant.usableNow ? t("anthropicGrant.notUsable")
      : grant.useRequiresLimit && !snapshot.atLimit ? t("anthropicGrant.requiresLimit")
        : null;
  return (
    <div className={`credit-item${isNext ? " credit-next" : ""}`} data-anthropic-grant={grant.id}>
      <div className="credit-item-head">
        <IconTicket width={13} />
        <span className="credit-item-label">{grant.label || grant.id}</span>
        <span className="badge badge-muted text-micro anthropic-grant-count">
          {t("anthropicGrant.resetsLeft", { left: String(grant.resetsLeft), total: String(grant.resetsTotal) })}
        </span>
      </div>
      <div className="credit-item-dates">
        {grant.startsAt && <span>{t("anthropicGrant.validFrom", { date: formatCreditDate(grant.startsAt, locale) })}</span>}
        {grant.endsAt && days !== null && (
          <span className={days <= 7 ? "credit-urgent" : ""}>
            {t("anthropicGrant.expires", { date: formatCreditDateTime(grant.endsAt, locale), days: String(days) })}
          </span>
        )}
      </div>
      {grant.clears.length > 0 && (
        <div className="anthropic-grant-windows">
          {grant.clears.map(window => (
            <span key={window} className="anthropic-grant-window">
              {t(WINDOW_KEYS[window], { percent: String(grant.percentUsed[window] ?? 0) })}
            </span>
          ))}
        </div>
      )}
      {note && <div className="faint text-caption anthropic-grant-note">{note}</div>}
    </div>
  );
}

type Outcome = { tone: "ok" | "warn"; key: TKey; count?: string };
type Held = { grantId: string; operationId: string };

function outcomeOf(result: AnthropicSpendOutcome): Outcome {
  if (result.kind === "settled") {
    // A replay reports the stored code like a fresh answer would, so a replayed
    // refusal never reads as a success.
    if (result.replayed && result.code === "reset") return { tone: "ok", key: "anthropicGrant.replayed" };
    return {
      tone: result.code === "reset" ? "ok" : "warn",
      key: SETTLED_KEYS[result.code] ?? "anthropicGrant.failed",
      count: result.resetsLeft === null ? "?" : String(result.resetsLeft),
    };
  }
  return { tone: "warn", key: REFUSED_KEYS[result.code] ?? "anthropicGrant.failed" };
}

/**
 * Refusals that settle a held attempt for good. Any other refusal of a same-id
 * retry (journal busy, auth, session) leaves the attempt open, so the dialog
 * keeps holding it rather than offering a fresh id.
 */
const RELEASES_HELD = new Set(["unknown_outcome_expired", "operation_identity_mismatch"]);

export function AnthropicResetGrantModal({ accountId, accountLabel, entry, controller, onClose }: {
  accountId: string;
  accountLabel: string;
  entry: AnthropicGrantEntry | undefined;
  controller: AnthropicResetGrantController;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState<Held | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  /** Set by an unknown outcome; while it holds, the only post is a same-id retry. */
  const [held, setHeld] = useState<Held | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (confirming) primaryRef.current?.focus();
  }, [confirming]);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    event.preventDefault();
    onClose();
  }, [onClose]);

  const snapshot = entry?.status === "ready" ? entry.snapshot : null;
  const pending = snapshot?.pendingOperation;
  // An attempt the server still holds (for example after a reload) is resumed,
  // never replaced by a new id. The server only reports attempts still inside
  // their retry window, so no clock check is needed here.
  const unresolved: Held | null = held
    ?? (pending ? { grantId: pending.grantId, operationId: pending.operationId } : null);
  const next = snapshot ? spendableGrant(snapshot) : undefined;

  const startConfirm = () => {
    if (!next || unresolved) return;
    const operationId = newOperationId();
    if (!operationId) {
      setOutcome({ tone: "warn", key: "anthropicGrant.noOperationId" });
      return;
    }
    setOutcome(null);
    setConfirming({ grantId: next.id, operationId });
  };

  const post = async (request: Held) => {
    if (busy) return;
    const retryingHeld = unresolved !== null && unresolved.operationId === request.operationId;
    setBusy(true);
    const result = await controller.spend(accountId, request);
    setBusy(false);
    setConfirming(null);
    if (result.kind === "unknown" || (result.kind === "refused" && retryingHeld && !RELEASES_HELD.has(result.code))) {
      setHeld(request);
      setOutcome(result.kind === "refused" ? outcomeOf(result) : null);
      return;
    }
    setHeld(null);
    setOutcome(outcomeOf(result));
    if (result.kind === "refused") void controller.refresh(accountId);
  };

  const recheck = async () => {
    if (checking) return;
    setChecking(true);
    await controller.refresh(accountId);
    setChecking(false);
  };

  const message = (result: Outcome) => (
    <p
      className={result.tone === "ok" ? "pws-status-ok" : "pws-status-warn"}
      role={result.tone === "ok" ? "status" : "alert"}
      style={{ marginTop: 12 }}
    >
      {t(result.key, { count: result.count ?? "" })}
    </p>
  );

  const confirmGrant = confirming && snapshot ? snapshot.grants.find(grant => grant.id === confirming.grantId) : undefined;
  const total = snapshot ? unspentResets(snapshot) : 0;

  return (
    <dialog ref={dialogRef} className="modal-overlay" aria-labelledby="anthropic-grant-title" onCancel={handleCancel}>
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onClose} />
      <div className="modal-card" onClick={event => event.stopPropagation()} role="document">
        {unresolved ? (
          <>
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div className="confirm-icon"><IconAlert width={22} /></div>
              <h3 id="anthropic-grant-title">{t("anthropicGrant.title")}</h3>
              <p className="pws-status-warn" role="alert">{t("anthropicGrant.unknownOutcome")}</p>
              {outcome && message(outcome)}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>{t("common.close")}</button>
              <button type="button" className="btn btn-ghost" onClick={() => { void recheck(); }} disabled={checking || busy}>
                {checking ? t("anthropicGrant.checking") : t("anthropicGrant.checkResult")}
              </button>
              <button type="button" className="btn btn-primary" data-anthropic-grant-retry
                onClick={() => { void post(unresolved); }} disabled={busy || checking}>
                {busy ? t("anthropicGrant.redeeming") : t("anthropicGrant.retrySame")}
              </button>
            </div>
          </>
        ) : confirming ? (
          <>
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div className="confirm-icon"><IconAlert width={22} /></div>
              <h3 id="anthropic-grant-title">{t("anthropicGrant.confirmTitle")}</h3>
              <p className="modal-desc">{t("anthropicGrant.confirmDesc")}</p>
              {confirmGrant && (
                <p className="faint text-label">{t("anthropicGrant.confirmWhich", { label: confirmGrant.label || confirmGrant.id })}</p>
              )}
              <p className="faint text-label">{t("anthropicGrant.irreversible")}</p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)} disabled={busy}>
                {t("common.cancel")}
              </button>
              <button ref={primaryRef} type="button" className="btn btn-primary" data-anthropic-grant-confirm
                onClick={() => { void post(confirming); }} disabled={busy}>
                {busy ? t("anthropicGrant.redeeming") : t("anthropicGrant.redeem")}
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 id="anthropic-grant-title"><IconTicket width={16} /> {t("anthropicGrant.title")}</h3>
            <div className="card-sub">{accountLabel}</div>
            <div style={{ margin: "16px 0" }}>
              {entry === undefined || entry.status === "loading" ? (
                <p className="faint text-label">{t("common.loading")}</p>
              ) : entry.status === "error" ? (
                <>
                  <p className="faint" role="alert">
                    {t(entry.reason === "auth" ? "anthropicGrant.loadFailedAuth" : "anthropicGrant.loadFailed")}
                  </p>
                  <button type="button" className="btn btn-ghost" style={{ marginTop: 12 }}
                    onClick={() => { void controller.refresh(accountId); }}>
                    {t("anthropicGrant.retry")}
                  </button>
                </>
              ) : !entry.snapshot.eligible ? (
                <p className="faint">{t("anthropicGrant.ineligible")}</p>
              ) : entry.snapshot.grants.length > 0 ? (
                <>
                  <p style={{ marginBottom: 12 }}>{t("anthropicGrant.available", { count: String(total) })}</p>
                  <div className="credit-list">
                    {entry.snapshot.grants.map(grant => (
                      <GrantItem key={grant.id} grant={grant} snapshot={entry.snapshot}
                        isNext={grant.id === next?.id} locale={locale} t={t} />
                    ))}
                  </div>
                  <button type="button" className="btn btn-primary" data-anthropic-grant-use
                    style={{ marginTop: 12, width: "100%" }} onClick={startConfirm} disabled={!next || busy}>
                    {t("anthropicGrant.useOne")}
                  </button>
                  <p className="card-sub text-caption" style={{ marginTop: 8, textAlign: "center" }}>{t("anthropicGrant.desc")}</p>
                </>
              ) : (
                <>
                  <p className="faint">{t("anthropicGrant.none")}</p>
                  <p className="modal-desc">{t("anthropicGrant.desc")}</p>
                </>
              )}
              {outcome && message(outcome)}
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
