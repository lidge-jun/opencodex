/**
 * ProviderDialogs — confirmation and warning dialogs for the workspace
 * Settings tab (WP091): remove provider, unsaved-leave, JSON save-before-leave.
 */
import { useEffect, useRef } from "react";
import { useT } from "../../i18n/shared";

export function RemoveConfirmDialog({
  providerName, defaultProviderName, onConfirm, onCancel,
}: {
  providerName: string;
  /** The automatic replacement when deleting the current default provider. */
  defaultProviderName: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" role="alertdialog" aria-label={t("pws.removeConfirmTitle")} onClick={e => e.stopPropagation()}>
        <h3>{t("pws.removeConfirmTitle")}</h3>
        <p>{defaultProviderName
          ? t("pws.removeDefaultConfirmBody", { name: providerName, defaultProvider: defaultProviderName })
          : t("pws.removeConfirmBody", { name: providerName })}</p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>{t("pws.removeConfirm")}</button>
        </div>
      </div>
    </div>
  );
}

export function UnsavedLeaveDialog({
  onSave, onDiscard, onCancel, saving = false,
}: {
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  saving?: boolean;
}) {
  const t = useT();
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" role="alertdialog" aria-label={t("pws.unsavedLeaveTitle")} onClick={e => e.stopPropagation()}>
        <h3>{t("pws.unsavedLeaveTitle")}</h3>
        <p>{t("pws.unsavedLeaveBody")}</p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-ghost" onClick={onDiscard}>{t("pws.discardSettings")}</button>
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? t("pws.saving") : t("pws.saveSettings")}
          </button>
        </div>
      </div>
    </div>
  );
}


export function RemoveAccountConfirmDialog({
  accountLabel,
  onConfirm,
  onCancel,
  removing = false,
}: {
  accountLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  removing?: boolean;
}) {
  const t = useT();
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  const onCancelRef = useRef(onCancel);
  useEffect(() => { onCancelRef.current = onCancel; });

  useEffect(() => {
    cancelBtnRef.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !removing) {
        e.preventDefault();
        onCancelRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [removing]);

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={t("pws.removeAccountConfirmTitle")} onClick={e => e.stopPropagation()}>
        <h3>{t("pws.removeAccountConfirmTitle")}</h3>
        <p>
          {t("prov.accountRemoveConfirm", { email: accountLabel })}
        </p>
        <div className="dialog-actions">
          <button ref={cancelBtnRef} type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={removing}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={onConfirm} disabled={removing}>
            {t("common.remove")}
          </button>
        </div>
      </div>
    </div>
  );
}
