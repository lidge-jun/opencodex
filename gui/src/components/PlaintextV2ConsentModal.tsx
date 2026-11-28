/**
 * Consent dialog for the 'v2-plaintext' sub-agent surface.
 *
 * The mode sends native v2 collaboration task text to ChatGPT without the encryption
 * marker, so entering it requires an explicit acknowledgement on the same PUT. The
 * checkbox is that acknowledgement: nothing is written until it is checked and the
 * operator confirms. It deliberately replaces the base/v2 warning dialog for this
 * mode, so one confirmation covers the experimental/plaintext notice and the usual
 * "v1 is the reliable default" guidance instead of asking twice in a row.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { IconAlert } from "../icons";

export default function PlaintextV2ConsentModal({
  busy = false,
  onConfirm,
  onDismiss,
}: {
  busy?: boolean;
  /** Checkbox checked plus confirm clicked: send the mode with its acknowledgement. */
  onConfirm: () => void;
  /** Escape or backdrop: abandon the selection, keep the stored mode. */
  onDismiss: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  // Open as a native modal dialog — focus trapping and the backdrop come from the platform.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    // Escape could otherwise close the dialog over a request that then lands anyway.
    if (busy) return;
    onDismiss();
  }, [busy, onDismiss]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="modal-overlay"
      data-plaintext-v2-consent
      onCancel={handleCancel}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} disabled={busy} onClick={() => { if (!busy) onDismiss(); }} />
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3 id={titleId}>{t("plaintextV2.title")}</h3>
        <div
          id={bodyId}
          className="notice-warn"
          style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "flex-start" }}
        >
          <IconAlert width={16} height={16} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
          <div className="modal-desc" style={{ margin: 0 }}>
            <p style={{ margin: 0 }}>{t("plaintextV2.body")}</p>
            <p style={{ margin: "8px 0 0" }}>{t("plaintextV2.caveat")}</p>
            <p style={{ margin: "8px 0 0" }}>{t("plaintextV2.scope")}</p>
          </div>
        </div>
        <label className="modal-desc" style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={busy}
            onChange={e => setAcknowledged(e.currentTarget.checked)}
            style={{ marginTop: 3 }}
          />
          <span>{t("plaintextV2.acknowledge")}</span>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onDismiss}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !acknowledged} onClick={onConfirm}>
            {t("plaintextV2.confirm")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
