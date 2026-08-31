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
  const restoreFallbackRef = useRef<HTMLElement | null>(null);
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
    // The trigger may not survive the restore. A row whose snapshot is consumed
    // re-renders as an `expired` badge with no button (RollbackHistory.tsx:44-46),
    // so the element captured above is detached by the time the cleanup runs and
    // focus lands on <body> — a keyboard user dropped at the top of the document
    // with nothing announced (#3059). Remember the enclosing region too, so there
    // is somewhere to return to that cannot disappear.
    restoreFallbackRef.current =
      (active?.closest?.("section, [role='region'], main") as HTMLElement | null) ?? null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      // Prefer the trigger; fall back to its region when the restore removed it.
      // `isConnected` is the check that matters: a detached node accepts .focus()
      // silently and focus stays on <body>, which is the reported symptom.
      const trigger = restoreFocusRef.current;
      if (trigger?.isConnected) {
        trigger.focus?.();
        return;
      }
      const fallback = restoreFallbackRef.current;
      if (!fallback?.isConnected) return;
      // A region is not focusable by default; -1 makes it programmatically
      // focusable without adding it to the Tab order.
      if (!fallback.hasAttribute("tabindex")) fallback.setAttribute("tabindex", "-1");
      fallback.focus?.();
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
