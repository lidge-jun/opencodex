/**
 * ProviderDialogs — confirmation and warning dialogs for the workspace
 * Settings tab (WP091): remove provider, unsaved-leave, JSON save-before-leave.
 */
import { useEffect } from "react";
import { useT } from "../../i18n/shared";

/**
 * Escape cancels a confirmation (#8849). These are plain alertdialogs, not native <dialog>s, so
 * nothing else maps the key; a page that stacks one over the Add Provider modal also tells that
 * modal to leave Escape alone, so one keystroke closes exactly this layer.
 */
function useEscapeToCancel(onCancel: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, enabled]);
}

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
  useEscapeToCancel(onCancel);
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
  // A save in flight cannot be abandoned from the keyboard, as the Save button is disabled too.
  useEscapeToCancel(onCancel, !saving);
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
