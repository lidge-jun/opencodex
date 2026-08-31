import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { Notice } from "../../ui";
import { describeRefusal, refusalOf } from "./refusal-copy";
import { restoreIntegration, type IntegrationJournalRow } from "./integration-api";

/**
 * Restore confirmation, including the drift second step.
 *
 * The server refuses a restore whose file changed after the snapshot unless
 * `confirmDrift` is set. That refusal is not an error to swallow — it is the
 * only moment the user is told their newer edits are about to be replaced, so
 * it escalates the dialog in place rather than closing it.
 *
 * The modal lifecycle is ConsequenceDialog's, not `<dialog open>`. An open
 * non-modal dialog leaves the page behind it focusable and in the accessibility
 * tree, so Tab walked straight out of a confirmation that is about to overwrite
 * a file, and the inline full-screen style block existed only to fake the
 * backdrop the modal state provides for free.
 */
export default function RestoreDialog({
  apiBase,
  row,
  onClose,
  onRestored,
}: {
  apiBase: string;
  row: IntegrationJournalRow;
  onClose: () => void;
  onRestored: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [drift, setDrift] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    // Duck-typed on purpose: `instanceof HTMLElement` reads a constructor that
    // is not a global in the happy-dom test window, and the overview's own
    // focus-restore uses the same tagName check.
    const active = document.activeElement;
    restoreFocusRef.current = active?.tagName === "BUTTON" ? active as HTMLElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      // The row's button is gone from the DOM in the collapsed case, so this is
      // a best effort: focus returns only if the trigger survived the close.
      restoreFocusRef.current?.focus?.();
    };
  }, []);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    event.preventDefault();
    if (!pending) onClose();
  }, [onClose, pending]);

  const submit = async () => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      await restoreIntegration(apiBase, row.opId, drift);
      onRestored();
      onClose();
    } catch (error) {
      if (refusalOf(error)?.reason === "drift_requires_confirm") {
        // Not a failure: the user has not been asked yet. Ask now.
        setDrift(true);
        setPending(false);
        return;
      }
      // Shared formatter so a residual write — compensation itself failed, the
      // file may be intermediate — is disclosed here too, not only its path.
      setFailure(describeRefusal(t, error));
      setPending(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="integration-restore-title"
      onCancel={handleCancel}
    >
      <button
        type="button"
        className="modal-backdrop-dismiss"
        aria-label={t("common.close")}
        tabIndex={-1}
        onClick={() => { if (!pending) onClose(); }}
      />
      <div className="modal-card integration-restore-dialog" role="document">
        <div className="modal-head">
          <h3 id="integration-restore-title">
            {drift ? t("integrations.restore.driftTitle") : t("integrations.restore.title")}
          </h3>
        </div>
        <div className="modal-desc">
          {drift ? t("integrations.restore.driftBody") : t("integrations.restore.body")}
        </div>
        <p className="integration-path">{row.configPath}</p>
        {failure && <Notice tone="err">{failure}</Notice>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={pending}>
            {pending
              ? t("integrations.restore.pending")
              : drift
                ? t("integrations.restore.confirmDrift")
                : t("integrations.restore.confirm")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
