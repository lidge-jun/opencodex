import { useCallback, useEffect, useRef } from "react";
import { useT } from "../i18n/shared";

export function RemoveComboDialog({
  model,
  onCancel,
  onConfirm,
}: {
  model: string;
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
      aria-labelledby="cwi-remove-title"
      onCancel={handleCancel}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onCancel} />
      <div className="modal-card pwi-remove-confirm-card" onClick={(e) => e.stopPropagation()}>
        <h3 id="cwi-remove-title" className="pwi-remove-confirm-title">
          {t("cws.removeConfirmTitle", { model })}
        </h3>
        <p className="muted pwi-remove-confirm-desc">{t("cws.removeConfirmDesc")}</p>
        <div className="pwi-remove-confirm-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="btn pwi-remove-confirm-danger" onClick={onConfirm}>{t("common.remove")}</button>
        </div>
      </div>
    </dialog>
  );
}

export function UnsavedLeaveDialog({
  onKeep,
  onDiscard,
}: {
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    onKeep();
  }, [onKeep]);

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="cwi-unsaved-title"
      onCancel={handleCancel}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onKeep} />
      <div className="modal-card pwi-json-unsaved-card" onClick={(e) => e.stopPropagation()}>
        <h3 id="cwi-unsaved-title" className="pwi-json-unsaved-title">{t("cws.unsavedTitle")}</h3>
        <p className="muted pwi-json-unsaved-desc">{t("cws.unsavedDesc")}</p>
        <div className="pwi-json-unsaved-actions">
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="cwi-unsaved-keep"
            onClick={onKeep}
          >
            {t("cws.keepEditing")}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            data-testid="cwi-unsaved-discard"
            onClick={onDiscard}
          >
            {t("common.discard")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
