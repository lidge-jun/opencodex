/**
 * ProviderDialogs — confirmation and warning dialogs for the workspace
 * Settings tab (WP091): remove provider, unsaved-leave, JSON save-before-leave.
 */
import { useEffect, useRef, type RefObject } from "react";
import { useT } from "../../i18n/shared";

/** Every open overlay layer the dashboard renders: native modal dialogs, modal cards, confirmations. */
const OVERLAY_LAYERS = "dialog[open], .modal-overlay, .dialog-backdrop";

/**
 * Is this layer the one Escape belongs to? A native modal <dialog> sits in the browser's top layer
 * above any in-page overlay, so it wins; otherwise the last overlay in document order is on top.
 */
function isTopmostLayer(layer: Element): boolean {
  const open = [...document.querySelectorAll(OVERLAY_LAYERS)]
    .filter(node => node.tagName !== "DIALOG" || (node as HTMLDialogElement).open);
  const modals = open.filter(node => node.tagName === "DIALOG");
  return (modals.length > 0 ? modals[modals.length - 1] : open[open.length - 1]) === layer;
}

/**
 * Escape cancels a confirmation (#8849). These are plain alertdialogs, not native <dialog>s, so
 * nothing else maps the key. Only the topmost layer acts: a confirmation left open beneath the
 * Add Provider modal or a native dialog ignores the key (and does not prevent it), and a page that
 * stacks one over Add Provider tells that modal to leave Escape alone, so one keystroke closes
 * exactly one layer.
 */
function useEscapeToCancel(layer: RefObject<HTMLElement | null>, onCancel: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!layer.current || !isTopmostLayer(layer.current)) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layer, onCancel, enabled]);
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
  const layer = useRef<HTMLDivElement>(null);
  useEscapeToCancel(layer, onCancel);
  return (
    <div ref={layer} className="dialog-backdrop" onClick={onCancel}>
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
  const layer = useRef<HTMLDivElement>(null);
  // A save in flight cannot be abandoned from the keyboard, as the Save button is disabled too.
  useEscapeToCancel(layer, onCancel, !saving);
  return (
    <div ref={layer} className="dialog-backdrop" onClick={onCancel}>
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
