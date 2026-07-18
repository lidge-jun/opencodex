/**
 * ProviderDialogs — confirmation and warning dialogs for the workspace
 * Settings tab (WP091): remove provider, unsaved-leave, JSON save-before-leave.
 */
import { useT } from "../../i18n";

export function RemoveConfirmDialog({
  providerName, onConfirm, onCancel,
}: {
  providerName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" role="alertdialog" aria-label={t("pws.removeConfirmTitle")} onClick={e => e.stopPropagation()}>
        <h3>{t("pws.removeConfirmTitle")}</h3>
        <p>{t("pws.removeConfirmBody", { name: providerName })}</p>
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
