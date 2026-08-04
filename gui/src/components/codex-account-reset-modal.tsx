import { useCallback, useEffect, useRef } from "react";
import { useI18n } from "../i18n/shared";
import { IconAlert, IconTicket } from "../icons";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import { CodexCreditItem } from "./codex-account-pool-helpers";
import { formatCreditDate } from "./codex-account-pool-utils";

export function CodexAccountResetModal({
  resetPopup,
  resetConfirm,
  creditDetails,
  creditDetailsLoading,
  redeeming,
  onClose,
  onShowConfirm,
  onCancelConfirm,
  onRedeem,
}: {
  resetPopup: CodexAccountEntry;
  resetConfirm: boolean;
  creditDetails: { granted_at: string; expires_at: string }[] | null;
  creditDetailsLoading: boolean;
  redeeming: boolean;
  onClose: () => void;
  onShowConfirm: () => void;
  onCancelConfirm: () => void;
  onRedeem: () => void;
}) {
  const { locale, t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    onClose();
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="codex-reset-title"
      onCancel={handleCancel}
     
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onClose} />
      <div className="modal-card" onClick={e => e.stopPropagation()} role="document">
        {!resetConfirm ? (
          <>
            <h3 id="codex-reset-title"><IconTicket width={16} /> {t("codexAuth.resetCreditsTitle")}</h3>
            <div className="card-sub">{resetPopup.email}{resetPopup.plan ? ` · ${resetPopup.plan}` : ""}</div>
            <div style={{ margin: "16px 0" }}>
              {(resetPopup.quota?.resetCredits ?? 0) > 0 ? (
                <>
                  <p style={{ marginBottom: 12 }}>{t("codexAuth.resetCreditsAvailable", { count: String(resetPopup.quota?.resetCredits ?? 0) })}</p>
                  {creditDetailsLoading && <p className="faint text-label">{t("common.loading")}</p>}
                  {creditDetails && creditDetails.length > 0 && (
                    <div className="credit-list">
                      {creditDetails.map((c, i) => (
                        <CodexCreditItem key={`${c.granted_at}:${c.expires_at}`} index={i} grantedAt={c.granted_at} expiresAt={c.expires_at} isNext={i === 0} locale={locale} t={t} />
                      ))}
                    </div>
                  )}
                  <button type="button" className="btn btn-primary" style={{ marginTop: 12, width: "100%" }}
                    onClick={onShowConfirm} disabled={redeeming}>
                    {t("codexAuth.useOneCredit")}
                  </button>
                  <p className="card-sub text-caption" style={{ marginTop: 8, textAlign: "center" }}>{t("codexAuth.fifoNote")}</p>
                </>
              ) : (
                <>
                  <p className="faint">{t("codexAuth.noResetCredits")}</p>
                  <p className="modal-desc">{t("codexAuth.earnCreditsHint")}</p>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div className="confirm-icon"><IconAlert width={22} /></div>
              <h3 id="codex-reset-title">{t("codexAuth.confirmResetTitle")}</h3>
              <p className="modal-desc">{t("codexAuth.confirmResetDesc", { count: String(resetPopup.quota?.resetCredits ?? 0) })}</p>
              {creditDetails && creditDetails[0] && (
                <p className="faint text-label">
                  {t("codexAuth.confirmWhichCredit", { date: formatCreditDate(creditDetails[0].granted_at, locale) })}
                </p>
              )}
              <p className="faint text-label">{t("codexAuth.irreversible")}</p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onCancelConfirm}>{t("codexAuth.cancel")}</button>
              <button type="button" className="btn btn-primary" onClick={onRedeem} disabled={redeeming}>
                {redeeming ? t("codexAuth.redeeming") : t("codexAuth.useCredit")}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
