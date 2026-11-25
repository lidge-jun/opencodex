import { useEffect, useRef } from "react";
import { useT, type TKey } from "../i18n/shared";
import type { FirstPartyPreview } from "./claude-first-party-preview";

const CHANGE_KEYS: Record<FirstPartyPreview["changes"][number]["change"], TKey> = {
  add: "connections.change.add",
  update: "connections.change.update",
  remove: "connections.change.remove",
};

/**
 * The confirmation step before the CLI first-party switch writes settings.json (catch-up 010,
 * G-002): the keys and change kinds the server's dry run reported, never their values. A modal
 * `<dialog>` like ConsequenceDialog, so the page behind it is inert while it is open.
 */
export default function FirstPartyPreviewDialog({
  preview,
  onAnswer,
}: {
  preview: FirstPartyPreview;
  onAnswer: (confirmed: boolean) => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    cancelRef.current?.focus();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="claude-first-party-preview-title"
      onCancel={event => { event.preventDefault(); onAnswer(false); }}
    >
      <div className="modal-card integration-consequence-dialog" role="document">
        <div className="modal-head">
          <h3 id="claude-first-party-preview-title">{t("connections.preview.title")}</h3>
        </div>
        <div className="integration-consequence-body">
          <p>{t("connections.preview.intro", { path: preview.path })}</p>
          <ul className="connection-restore-list" data-first-party-preview>
            {preview.changes.map(change => (
              <li key={change.key} data-change={change.change}>
                <code>{change.key}</code> <span className="chip">{t(CHANGE_KEYS[change.change])}</span>
              </li>
            ))}
          </ul>
          {preview.applyChecks.length > 0 && <p className="integration-meta">{t("connections.preview.checks")}</p>}
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={() => onAnswer(false)}>
            {t("connections.preview.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onAnswer(true)}>
            {t("connections.preview.confirm")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
