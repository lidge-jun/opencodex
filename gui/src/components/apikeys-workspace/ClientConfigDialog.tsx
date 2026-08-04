/**
 * Detail view for one export client's config (devlog 260802/010).
 *
 * The panel's rows carry the two actions a user actually performs — copy and
 * download. Everything needed to *understand* the payload rather than move it
 * lives here: the config bytes, where the file goes, which env var holds the
 * key, and the merge warning.
 *
 * Nothing behavioral is inherited from the CSS classes. `.modal-overlay` and
 * `.modal-card` supply appearance and scrolling only; the focus trap comes from
 * `showModal()`, and Escape, backdrop dismissal, and focus restoration are each
 * explicit below — the same contract `codex-account-reset-modal.tsx` implements.
 */
import { useCallback, useEffect, useRef } from "react";
import { useT } from "../../i18n/shared";
import { CopyableExample } from "../../pages/api-keys-copy";
import type { ClientConfigEnvelope, ExportClientId } from "./client-config-clients";
import { CLIENT_LABEL_KEYS } from "./client-config-clients";

export default function ClientConfigDialog({
  client,
  envelope,
  json,
  hasKeys,
  onClose,
  onCopy,
  onDownload,
}: {
  client: ExportClientId;
  envelope: ClientConfigEnvelope;
  /** Serialized once by the panel so the dialog and the row copy identical bytes. */
  json: string;
  hasKeys: boolean;
  onClose: () => void;
  onCopy: () => void;
  onDownload: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = `awi-clientconfig-dialog-${client}`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    // Closing on unmount matters: a parent re-render that drops this node while
    // the dialog is open would otherwise leave the top layer occupied.
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    // Escape reaches us as `cancel`. Prevent the default close so React owns the
    // unmount and the caller can restore focus to the trigger.
    event.preventDefault();
    onClose();
  }, [onClose]);

  return (
    <dialog ref={dialogRef} className="modal-overlay" aria-labelledby={titleId} onCancel={handleCancel}>
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onClose} />
      <div className="modal-card awi-clientconfig-dialog" onClick={event => event.stopPropagation()} role="document">
        <div className="modal-head">
          <h3 id={titleId}>{t(CLIENT_LABEL_KEYS[client])}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t("common.close")}</button>
        </div>

        <pre
          className="api-code api-example-pre awi-clientconfig-json"
          tabIndex={0}
          role="group"
          aria-label={t("api.clientConfig.jsonLabel", { client: t(CLIENT_LABEL_KEYS[client]) })}
        >{json}</pre>

        <p className="muted small awi-clientconfig-count">
          {t("api.clientConfig.modelCount", { count: envelope.modelCount })}
        </p>
        {envelope.modelsWithoutLimits > 0 && (
          <p className="muted small awi-clientconfig-degraded">
            {t("api.clientConfig.missingLimits", { count: envelope.modelsWithoutLimits, total: envelope.modelCount })}
          </p>
        )}
        {!hasKeys && (
          // Informational, never blocking: an agent may legitimately want the shape
          // first, so both actions stay enabled.
          <p className="muted small awi-clientconfig-nokey">
            {t("api.clientConfig.noKeyYet", { env: envelope.apiKeyEnv })}
          </p>
        )}

        <div className="awi-clientconfig-line">
          <span className="muted text-label">{t("api.clientConfig.destination")}</span>
          <CopyableExample text={envelope.destination} />
        </div>
        <div className="awi-clientconfig-line">
          <span className="muted text-label">{t("api.clientConfig.envHint")}</span>
          <CopyableExample text={envelope.exportHint} />
        </div>
        <p className="muted small awi-clientconfig-merge">{t("api.clientConfig.mergeWarning")}</p>
        {/* The old <details> is gone — this is the one place the answer lives now,
            so it is a labelled paragraph rather than a fold. */}
        <p className="muted text-label awi-clientconfig-where-title">{t("api.clientConfig.whereDisclosure")}</p>
        <p className="muted small">{t("api.clientConfig.whereBody")}</p>

        <div className="modal-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={onCopy}>
            {t("api.clientConfig.copy")}
          </button>
          <button type="button" className="btn btn-sm" onClick={onDownload}>
            {t("api.clientConfig.download")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
