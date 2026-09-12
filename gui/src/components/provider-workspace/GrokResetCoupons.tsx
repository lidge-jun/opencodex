/**
 * Grok reset-coupon badge and redemption dialog for xAI OAuth account rows.
 *
 * The dialog is deliberately conservative about the one irreversible thing it
 * does. It always names the coupon it is spending, it holds one client-minted
 * operation id per confirmation, and when a redemption aborts it stops posting
 * entirely: the route re-executes a redemption whose journal record is still
 * open, so a retry after a timeout can spend a second coupon.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, type Locale, type TFn, type TKey } from "../../i18n/shared";
import { IconAlert, IconTicket } from "../../icons";
import { daysUntil, formatCreditDate, formatCreditDateTime } from "../codex-account-pool-utils";
import type { GrokCouponEntry, GrokResetCoupon, GrokResetCouponController } from "../../hooks/useGrokResetCoupons";

function couponsOf(entry: GrokCouponEntry | undefined): GrokResetCoupon[] {
  return entry?.status === "ready" ? entry.coupons : [];
}

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
  // Without an id the journal cannot recognise a repeat, so the dialog refuses
  // rather than letting the route mint a fresh id per attempt.
  return undefined;
}

const FAILURE_KEYS: Record<string, TKey> = {
  auth_failed: "grokCoupon.authFailed",
  no_account: "grokCoupon.noAccount",
  no_coupons_available: "grokCoupon.noneAvailable",
  operation_id_owned_by_another_account: "grokCoupon.identityMismatch",
  capacity: "grokCoupon.capacity",
  unavailable: "grokCoupon.capacity",
  network: "grokCoupon.networkError",
  redeem_failed: "grokCoupon.redeemFailed",
};

/** Ticket badge on an xAI account row. Muted at zero, amber when redeemable. */
export function GrokCouponBadge({ entry, onClick, t }: {
  entry: GrokCouponEntry | undefined;
  onClick: () => void;
  t: TFn;
}) {
  if (entry === undefined || entry.status === "loading") {
    // Reserve the width so the row does not shift when the count lands. Same
    // aria-hidden placeholder the Codex ticket badge uses.
    return (
      <span className="badge badge-muted codex-ticket-badge-slot" aria-hidden="true">
        <IconTicket width={12} />0
      </span>
    );
  }
  const count = entry.status === "ready" ? entry.coupons.length : null;
  const label = count === null
    ? t("grokCoupon.badgeErrorAria")
    : t("grokCoupon.badgeAria", { count: String(count) });
  return (
    <button
      type="button"
      className={`badge ${count ? "badge-amber" : "badge-muted"} badge-clickable`}
      data-grok-coupon-badge={count === null ? "error" : String(count)}
      onClick={event => { event.stopPropagation(); onClick(); }}
      aria-label={label}
      title={label}
    >
      <IconTicket width={12} />
      {count === null ? <IconAlert width={11} /> : count}
    </button>
  );
}

function GrokCouponItem({ coupon, index, isNext, locale, t }: {
  coupon: GrokResetCoupon;
  index: number;
  isNext: boolean;
  locale: Locale;
  t: TFn;
}) {
  const days = coupon.validityEnd ? daysUntil(coupon.validityEnd) : null;
  return (
    <div className={`credit-item${isNext ? " credit-next" : ""}`}>
      <div className="credit-item-head">
        <IconTicket width={13} />
        <span className="credit-item-label">
          {isNext ? t("grokCoupon.couponNext") : t("grokCoupon.couponLabel", { n: String(index + 1) })}
        </span>
        {isNext && (
          <span className="badge badge-amber text-micro" style={{ padding: "1px 6px" }}>
            {t("grokCoupon.couponNextBadge")}
          </span>
        )}
      </div>
      <div className="credit-item-dates">
        {coupon.validityStart && <span>{t("grokCoupon.validFrom", { date: formatCreditDate(coupon.validityStart, locale) })}</span>}
        {days !== null && (
          <span className={days <= 7 ? "credit-urgent" : ""}>
            {t("grokCoupon.expires", { date: formatCreditDateTime(coupon.validityEnd, locale), days: String(days) })}
          </span>
        )}
      </div>
    </div>
  );
}

type Outcome = { tone: "ok" | "warn"; key: TKey };

export function GrokResetCouponModal({ accountId, accountLabel, entry, controller, onClose }: {
  accountId: string;
  accountLabel: string;
  entry: GrokCouponEntry | undefined;
  controller: GrokResetCouponController;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const redeemRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [checking, setChecking] = useState(false);
  /** Set by an aborted redemption; while it holds, the dialog posts nothing. */
  const [unknown, setUnknown] = useState<{ tokenId: string } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const operationIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (confirming) redeemRef.current?.focus();
  }, [confirming]);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    event.preventDefault();
    onClose();
  }, [onClose]);

  const coupons = couponsOf(entry);
  const next = coupons[0];

  const startConfirm = () => {
    if (unknown) return;
    const id = newOperationId();
    if (!id) {
      setOutcome({ tone: "warn", key: "grokCoupon.noOperationId" });
      return;
    }
    operationIdRef.current = id;
    setOutcome(null);
    setConfirming(true);
  };

  const redeem = async () => {
    if (redeeming || unknown) return;
    const operationId = operationIdRef.current;
    if (!next?.tokenId) {
      setOutcome({ tone: "warn", key: "grokCoupon.noneAvailable" });
      return;
    }
    if (!operationId) {
      setOutcome({ tone: "warn", key: "grokCoupon.noOperationId" });
      return;
    }
    setRedeeming(true);
    const result = await controller.redeem(accountId, { tokenId: next.tokenId, operationId });
    setRedeeming(false);
    if (result.ok) {
      operationIdRef.current = undefined;
      setConfirming(false);
      setOutcome({ tone: "ok", key: result.replayed ? "grokCoupon.redeemReplayed" : "grokCoupon.redeemSuccess" });
      return;
    }
    if (result.code === "aborted") {
      // Outcome unknown: hold the id, stop posting, and let the user re-read.
      setUnknown({ tokenId: next.tokenId });
      setOutcome(null);
      void controller.refresh(accountId);
      return;
    }
    if (result.code === "operation_id_owned_by_another_account") operationIdRef.current = undefined;
    setOutcome({ tone: "warn", key: FAILURE_KEYS[result.code] ?? "grokCoupon.redeemFailed" });
  };

  const recheck = async () => {
    if (!unknown || checking) return;
    setChecking(true);
    await controller.refresh(accountId);
    setChecking(false);
  };

  const unresolvedToken = unknown
    ? couponsOf(entry).some(coupon => coupon.tokenId === unknown.tokenId)
    : false;
  const remaining = String(coupons.length);

  const message = (result: Outcome) => (
    <p
      className={result.tone === "ok" ? "pws-status-ok" : "pws-status-warn"}
      role={result.tone === "ok" ? "status" : "alert"}
      style={{ marginTop: 12 }}
    >
      {t(result.key, { count: remaining })}
    </p>
  );

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="grok-coupon-title"
      onCancel={handleCancel}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onClose} />
      <div className="modal-card" onClick={event => event.stopPropagation()} role="document">
        {unknown ? (
          <>
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div className="confirm-icon"><IconAlert width={22} /></div>
              <h3 id="grok-coupon-title">{t("grokCoupon.title")}</h3>
              <p className="pws-status-warn" role="alert">{t("grokCoupon.unknownOutcome")}</p>
              {!checking && (
                <p className="faint text-label">
                  {unresolvedToken ? t("grokCoupon.unresolved") : t("grokCoupon.consumedElsewhere")}
                </p>
              )}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>{t("common.close")}</button>
              <button type="button" className="btn btn-primary" onClick={() => { void recheck(); }} disabled={checking}>
                {checking ? t("grokCoupon.checking") : t("grokCoupon.checkResult")}
              </button>
            </div>
          </>
        ) : !confirming ? (
          <>
            <h3 id="grok-coupon-title"><IconTicket width={16} /> {t("grokCoupon.title")}</h3>
            <div className="card-sub">{accountLabel}</div>
            <div style={{ margin: "16px 0" }}>
              {entry === undefined || entry.status === "loading" ? (
                <p className="faint text-label">{t("common.loading")}</p>
              ) : entry.status === "error" ? (
                <>
                  <p className="faint" role="alert">
                    {t(entry.reason === "auth" ? "grokCoupon.loadFailedAuth" : "grokCoupon.loadFailed")}
                  </p>
                  <button type="button" className="btn btn-ghost" style={{ marginTop: 12 }}
                    onClick={() => { void controller.refresh(accountId); }}>
                    {t("grokCoupon.retry")}
                  </button>
                </>
              ) : coupons.length > 0 ? (
                <>
                  <p style={{ marginBottom: 12 }}>{t("grokCoupon.available", { count: remaining })}</p>
                  <div className="credit-list">
                    {coupons.map((coupon, index) => (
                      <GrokCouponItem key={coupon.tokenId} coupon={coupon} index={index} isNext={index === 0} locale={locale} t={t} />
                    ))}
                  </div>
                  <button type="button" className="btn btn-primary" style={{ marginTop: 12, width: "100%" }}
                    onClick={startConfirm} disabled={redeeming}>
                    {t("grokCoupon.useOne")}
                  </button>
                  <p className="card-sub text-caption" style={{ marginTop: 8, textAlign: "center" }}>{t("grokCoupon.fifoNote")}</p>
                </>
              ) : (
                <>
                  <p className="faint">{t("grokCoupon.none")}</p>
                  <p className="modal-desc">{t("grokCoupon.desc")}</p>
                </>
              )}
              {outcome && message(outcome)}
            </div>
          </>
        ) : (
          <>
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div className="confirm-icon"><IconAlert width={22} /></div>
              <h3 id="grok-coupon-title">{t("grokCoupon.confirmTitle")}</h3>
              <p className="modal-desc">{t("grokCoupon.confirmDesc", { count: remaining })}</p>
              {next?.validityEnd && (
                <p className="faint text-label">
                  {t("grokCoupon.confirmWhich", { date: formatCreditDate(next.validityEnd, locale) })}
                </p>
              )}
              <p className="faint text-label">{t("grokCoupon.irreversible")}</p>
              {outcome && message(outcome)}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={redeeming}>
                {t("common.cancel")}
              </button>
              <button ref={redeemRef} type="button" className="btn btn-primary" onClick={() => { void redeem(); }} disabled={redeeming}>
                {redeeming ? t("grokCoupon.redeeming") : t("grokCoupon.redeem")}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
