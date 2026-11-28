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
  grantBlocker,
  grantSelectable,
  spendableGrant,
  unspentResets,
  type AnthropicGrantBlocker,
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

const CLEARS_KEYS = {
  five_hour: "anthropicGrant.clearsFiveHour",
  seven_day: "anthropicGrant.clearsWeekly",
  seven_day_overage_included: "anthropicGrant.clearsOverage",
} as const satisfies Record<string, TKey>;

const BLOCKER_KEYS = {
  paused: "anthropicGrant.paused",
  not_usable: "anthropicGrant.notUsable",
  exhausted: "anthropicGrant.exhausted",
  not_limited: "anthropicGrant.requiresLimit",
} as const satisfies Record<AnthropicGrantBlocker, TKey>;

/** An ISO time only when it parses; anything else is shown as absent rather than "Invalid Date". */
function validTime(iso: string | null): string | null {
  return iso !== null && !Number.isNaN(Date.parse(iso)) ? iso : null;
}

function grantName(grant: AnthropicResetGrant): string {
  return grant.label || grant.id;
}

function clearedWindows(grant: AnthropicResetGrant, locale: string, t: TFn): string {
  const names = grant.clears.map(window => t(CLEARS_KEYS[window]));
  try {
    return new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

/** One grant as a radio option. Unusable grants stay visible, disabled, with their reason. */
function GrantOption({ grant, snapshot, checked, tabStop, selectable, optionRef, onSelect, onKeyDown, locale, t }: {
  grant: AnthropicResetGrant;
  snapshot: AnthropicResetGrantSnapshot;
  checked: boolean;
  tabStop: boolean;
  selectable: boolean;
  optionRef: (element: HTMLDivElement | null) => void;
  onSelect: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  locale: string;
  t: TFn;
}) {
  const startsAt = validTime(grant.startsAt);
  const endsAt = validTime(grant.endsAt);
  const days = endsAt ? daysUntil(endsAt) : null;
  const blocker = grantBlocker(snapshot, grant);
  const note = blocker ? t(BLOCKER_KEYS[blocker]) : null;
  return (
    <div
      ref={optionRef}
      role="radio"
      aria-checked={checked}
      aria-disabled={selectable ? undefined : true}
      tabIndex={tabStop ? 0 : -1}
      className={`credit-item anthropic-grant-option${checked ? " credit-next" : ""}`}
      data-anthropic-grant={grant.id}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <div className="credit-item-head">
        <span className="anthropic-grant-radio" aria-hidden="true" />
        <IconTicket width={13} />
        <span className="credit-item-label">{grantName(grant)}</span>
        <span className="badge badge-muted text-micro anthropic-grant-count">
          {t("anthropicGrant.resetsLeft", { left: String(grant.resetsLeft), total: String(grant.resetsTotal) })}
        </span>
      </div>
      <div className="credit-item-dates">
        {startsAt && <span>{t("anthropicGrant.validFrom", { date: formatCreditDate(startsAt, locale) })}</span>}
        {endsAt && days !== null && (
          <span className={days <= 7 ? "credit-urgent" : ""}>
            {t("anthropicGrant.expires", { date: formatCreditDateTime(endsAt, locale), days: String(days) })}
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
/** The confirm step keeps the grant it was opened for, so a reload cannot swap what it names. */
type Confirming = Held & { grant: AnthropicResetGrant };

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
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  /** The grant the user picked; null follows the default. Ignored once it stops being selectable. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const optionRefs = useRef(new Map<string, HTMLDivElement>());
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  /** Set by an unknown outcome; while it holds, the only post is a same-id retry. */
  const [held, setHeld] = useState<Held | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // The row's badge may have been read long ago. Re-read on open so an attempt another
  // tab or process left open shows its retry screen instead of a picker for a new one.
  // The list stays on screen meanwhile, but nothing can be spent until the read lands.
  const { refresh } = controller;
  const [opening, setOpening] = useState(true);
  useEffect(() => {
    let live = true;
    void refresh(accountId, { keepSnapshot: true }).catch(() => undefined).finally(() => { if (live) setOpening(false); });
    return () => { live = false; };
  }, [accountId, refresh]);

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
  const picked = snapshot && selectedId !== null
    ? snapshot.grants.find(grant => grant.id === selectedId && grantSelectable(snapshot, grant))
    : undefined;
  const selected = picked ?? (snapshot ? spendableGrant(snapshot) : undefined);
  // Nothing may change which grant an attempt uses once one is open or being confirmed.
  const locked = unresolved !== null || busy || confirming !== null;

  // A reload can pause, exhaust or drop the grant being confirmed. Its id was never
  // posted, so leave the confirm step and make the user choose again.
  const confirmLive = confirming && snapshot ? snapshot.grants.find(grant => grant.id === confirming.grantId) : undefined;
  const confirmStale = confirming !== null && snapshot !== null && (!confirmLive || !grantSelectable(snapshot, confirmLive));
  if (confirmStale && !busy) {
    // Adjusting state during render (guarded, so it settles in one pass) rather than in an effect.
    setConfirming(null);
    setSelectedId(null);
    setOutcome({ tone: "warn", key: "anthropicGrant.notUsableNow" });
  }

  const select = (grant: AnthropicResetGrant, focus: boolean) => {
    if (locked || !snapshot || !grantSelectable(snapshot, grant)) return;
    setSelectedId(grant.id);
    if (focus) optionRefs.current.get(grant.id)?.focus();
  };

  const onOptionKey = (event: React.KeyboardEvent<HTMLDivElement>, grant: AnthropicResetGrant) => {
    if (!snapshot) return;
    const grants = snapshot.grants;
    const usable = grants.filter(candidate => grantSelectable(snapshot, candidate));
    const from = grants.findIndex(candidate => candidate.id === grant.id);
    const step = (direction: 1 | -1) => {
      for (let offset = 1; offset <= grants.length; offset += 1) {
        const candidate = grants[(((from + direction * offset) % grants.length) + grants.length) % grants.length];
        if (candidate && grantSelectable(snapshot, candidate)) return candidate;
      }
      return undefined;
    };
    let target: AnthropicResetGrant | undefined;
    switch (event.key) {
      case " ":
      case "Enter":
        event.preventDefault();
        select(grant, false);
        return;
      case "ArrowDown":
      case "ArrowRight":
        target = step(1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        target = step(-1);
        break;
      case "Home":
        target = usable[0];
        break;
      case "End":
        target = usable[usable.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    if (target) select(target, true);
  };

  const startConfirm = () => {
    if (opening || !selected || unresolved || !snapshot || !grantSelectable(snapshot, selected)) return;
    const operationId = newOperationId();
    if (!operationId) {
      setOutcome({ tone: "warn", key: "anthropicGrant.noOperationId" });
      return;
    }
    setOutcome(null);
    setConfirming({ grantId: selected.id, operationId, grant: selected });
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

  const confirmEndsAt = confirming ? validTime(confirming.grant.endsAt) : null;
  // One tab stop for the group even when nothing can be chosen, so the reasons stay reachable.
  const tabStopId = selected?.id ?? snapshot?.grants[0]?.id;
  const selectableCount = snapshot ? snapshot.grants.filter(grant => grantSelectable(snapshot, grant)).length : 0;
  // The hint describes the default, so it shows only while the default is what is selected.
  const showPickHint = selectableCount > 1 && selected !== undefined && selected.id === (snapshot ? spendableGrant(snapshot)?.id : undefined);
  const heldGrant = unresolved && snapshot ? snapshot.grants.find(grant => grant.id === unresolved.grantId) : undefined;
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
              {unresolved && (
                <p className="faint text-label">
                  {t("anthropicGrant.confirmWhich", { label: heldGrant ? grantName(heldGrant) : unresolved.grantId })}
                </p>
              )}
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
              <p className="faint text-label" data-anthropic-grant-confirm-which={confirming.grantId}>
                {t("anthropicGrant.confirmWhich", { label: grantName(confirming.grant) })}
              </p>
              {confirmEndsAt && (
                <p className="faint text-label">
                  {t("anthropicGrant.confirmExpires", { date: formatCreditDateTime(confirmEndsAt, locale) })}
                </p>
              )}
              <p className="faint text-label">
                {confirming.grant.clears.length > 0
                  ? t("anthropicGrant.confirmClears", { windows: clearedWindows(confirming.grant, locale, t) })
                  : t("anthropicGrant.confirmClearsUnknown")}
              </p>
              <p className="faint text-label">{t("anthropicGrant.irreversible")}</p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)} disabled={busy}>
                {t("common.cancel")}
              </button>
              <button ref={primaryRef} type="button" className="btn btn-primary" data-anthropic-grant-confirm
                onClick={() => { void post({ grantId: confirming.grantId, operationId: confirming.operationId }); }}
                disabled={busy || snapshot === null || confirmStale}>
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
                  {!entry.snapshot.journalAvailable && (
                    <p className="pws-status-warn" style={{ marginBottom: 12 }}>{t("anthropicGrant.journalBusy")}</p>
                  )}
                  <div className="credit-list" role="radiogroup" aria-label={t("anthropicGrant.chooseLabel")}>
                    {entry.snapshot.grants.map(grant => (
                      <GrantOption key={grant.id} grant={grant} snapshot={entry.snapshot}
                        checked={grant.id === selected?.id}
                        tabStop={grant.id === tabStopId}
                        selectable={grantSelectable(entry.snapshot, grant)}
                        optionRef={element => {
                          if (element) optionRefs.current.set(grant.id, element);
                          else optionRefs.current.delete(grant.id);
                        }}
                        onSelect={() => select(grant, true)}
                        onKeyDown={event => onOptionKey(event, grant)}
                        locale={locale} t={t} />
                    ))}
                  </div>
                  {showPickHint && (
                    <p className="card-sub text-caption" style={{ marginTop: 8 }}>{t("anthropicGrant.pickHint")}</p>
                  )}
                  <button type="button" className="btn btn-primary" data-anthropic-grant-use
                    style={{ marginTop: 12, width: "100%" }} onClick={startConfirm} disabled={!selected || busy || opening}>
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
