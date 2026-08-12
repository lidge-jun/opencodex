import { useCallback, useEffect, useRef } from "react";
import { useT } from "../i18n/shared";
import { IconAlert } from "../icons";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import type { CodexAccountModeState } from "../codex-multi-state";

export function CodexAccountSwitchModal({
  confirm,
  mainEmail,
  accountModeState,
  switchingId,
  orderBusy = false,
  onCancel,
  onConfirm,
}: {
  confirm: CodexAccountEntry;
  mainEmail?: string;
  accountModeState: CodexAccountModeState | null;
  switchingId: string | null;
  /**
   * An in-flight selection-order write. It clears the pin this switch would set, so the
   * controller refuses to run the two together and drops the loser without a toast --
   * the button has to be unavailable rather than silently ineffective.
   */
  orderBusy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    onCancel();
  }, [onCancel]);

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="codex-switch-title"
      onCancel={handleCancel}
     
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onCancel} />
      <div className="modal-card" onClick={e => e.stopPropagation()} role="document">
        <h3 id="codex-switch-title">{accountModeState === "direct"
          ? t("codexAuth.preparePoolTitle")
          : confirm.id === "__main__" ? t("codexAuth.switchBack") : t("codexAuth.switchTitle")}</h3>
        <p className="modal-desc">
          {accountModeState === "direct"
            ? t("codexAuth.preparePoolDesc")
            : confirm.id === "__main__" ? t("codexAuth.switchBackDesc") : t("codexAuth.switchDesc")}
        </p>
        <div className="card" style={{ margin: "12px 0" }}>
          <strong>{confirm.id === "__main__" ? (mainEmail || t("codexAuth.codexApp")) : confirm.email}</strong>
          {confirm.plan && <span className="badge badge-green" style={{ marginLeft: 8 }}>{confirm.plan}</span>}
        </div>
        {confirm.id !== "__main__" && (
          <div className="notice-warn"><IconAlert width={14} /> {t("codexAuth.cacheWarning")}</div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("codexAuth.cancel")}</button>
          <button type="button" className="btn btn-primary" disabled={Boolean(switchingId) || orderBusy} onClick={onConfirm}>
            {switchingId ? t("pws.accountSwitching") : t(accountModeState === "direct" ? "codexAuth.prepareForPool" : "codexAuth.setAsNext")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
