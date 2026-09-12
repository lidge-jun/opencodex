/**
 * Full-text popup for a catalog row's provider note.
 *
 * The catalog clamps a note to two lines, because a few of them are paragraphs: the
 * `opencode-free` note is ~1100 characters and `meta-muse` is longer still, and at the
 * modal width either one fills the entire 360px scroll viewport, so the row it belongs
 * to becomes the only row a user can see.
 *
 * Native `<dialog>` + `showModal()`, deliberately the same shape as
 * `OAuthTosWarningModal`: it gives focus trapping and a backdrop for free, and — the
 * part a hand-rolled overlay does not get — it restores focus to the control that
 * opened it when it closes. It is rendered as a sibling of the add-provider overlay
 * rather than inside it, so there is no dialog nested in a dialog's DOM.
 */
import { useCallback, useEffect, useId, useRef } from "react";
import { useT } from "../../i18n/shared";
import { IconX } from "../../icons";
import { ProviderIcon } from "../provider-workspace/ProviderRail";

export default function ProviderNoteModal({
  providerId,
  label,
  adapter,
  note,
  onClose,
}: {
  providerId: string;
  label: string;
  adapter: string;
  note: string;
  onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement as HTMLElement | null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  // Native <dialog> fires "cancel" on Escape — forward it so this popup closes first
  // and the add-provider modal underneath stays open.
  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    onClose();
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="modal-overlay"
      onCancel={handleCancel}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onClose} />
      <div className="modal-card provider-note-card" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3 id={titleId} className="provider-note-title">
            <ProviderIcon name={providerId} adapter={adapter} cls="provider-icon provider-icon-sm" />
            {label}
          </h3>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={t("common.close")} onClick={onClose}>
            <IconX />
          </button>
        </div>
        <div id={bodyId} className="provider-note-body">
          <code className="chip">{adapter}</code>
          <p className="modal-desc provider-note-text">{note}</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t("common.close")}</button>
        </div>
      </div>
    </dialog>
  );
}
