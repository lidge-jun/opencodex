import { useState } from "react";
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
  const [drift, setDrift] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

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
      className="modal-overlay"
      open
      style={{ display: "flex", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
      aria-labelledby="integration-restore-title"
      onCancel={event => { event.preventDefault(); onClose(); }}
    >
      <div className="modal-card integration-restore-dialog">
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
