/**
 * Modal shown before starting OAuth for providers whose subscription tokens
 * are restricted (or risky) when used outside the official client.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { IconAlert } from "../icons";
import { oauthTosCopyKeys, oauthTosRisk } from "../oauth-tos-risk";

export default function OAuthTosWarningModal({
  providerId,
  providerLabel,
  onCancel,
  onContinue,
}: {
  providerId: string;
  providerLabel: string;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const bodyId = useId();
  const conditionsId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submittedRef = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const level = oauthTosRisk(providerId);

  // Open as a native modal dialog — provides focus trapping and backdrop for free.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // Native <dialog> fires "cancel" on Escape — forward it to our handler.
  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault();
    onCancel();
  }, [onCancel]);

  // Unmarked provider: render nothing (callers must gate with oauthTosRisk).
  if (!level) return null;

  const copy = oauthTosCopyKeys(providerId, level);
  const danger = copy.tone === "danger";
  // A multi-line conditions string is a checklist; render each line as its own item.
  const conditionLines = copy.conditions ? t(copy.conditions).split("\n").filter(line => line.trim()) : [];

  const handleContinue = () => {
    if (!acknowledged || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitted(true);
    onContinue();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={copy.conditions ? `${bodyId} ${conditionsId}` : bodyId}
      className="modal-overlay"
      onCancel={handleCancel}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onCancel} />
      <div
        className={danger ? "modal-card oauth-tos-card oauth-tos-card--danger" : "modal-card"}
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: danger ? 520 : 460 }}
      >
        {danger ? (
          <h3 id={titleId} className="oauth-tos-danger-title">
            <IconAlert width={22} height={22} aria-hidden="true" />
            <span>{t(copy.title, { provider: providerLabel })}</span>
          </h3>
        ) : (
          <h3 id={titleId}>{t(copy.title, { provider: providerLabel })}</h3>
        )}
        <div
          id={bodyId}
          className={danger ? "notice-err oauth-tos-danger-body" : "notice-warn"}
          style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "flex-start" }}
        >
          <IconAlert width={16} height={16} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
          <p className="modal-desc" style={{ margin: 0 }}>
            {t(copy.body, { provider: providerLabel })}
          </p>
        </div>
        {conditionLines.length > 1 && (
          <ul id={conditionsId} className="oauth-tos-conditions">
            {conditionLines.map(line => <li key={line}>{line}</li>)}
          </ul>
        )}
        {conditionLines.length === 1 && (
          <p id={conditionsId} className="modal-desc" style={{ marginTop: 12 }}>
            {conditionLines[0]}
          </p>
        )}
        {copy.saferPath && (
          <p className={danger ? "oauth-tos-safer text-label" : "muted text-label"} style={{ marginTop: 12 }}>
            {t(copy.saferPath)}
          </p>
        )}
        <label
          className={danger ? "oauth-tos-ack oauth-tos-ack--danger" : "oauth-tos-ack"}
          style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 14 }}
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={e => setAcknowledged(e.target.checked)}
            style={{ marginTop: 3 }}
            aria-required="true"
          />
          <span className="text-label">{t(copy.acknowledge)}</span>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={danger ? "btn btn-primary oauth-tos-continue--danger" : "btn btn-primary"}
            disabled={!acknowledged || submitted}
            onClick={handleContinue}
          >
            {t(copy.continue)}
          </button>
        </div>
      </div>
    </dialog>
  );
}
