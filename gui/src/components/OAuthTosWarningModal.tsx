/**
 * Modal shown before starting OAuth for providers whose subscription tokens
 * are restricted (or risky) when used outside the official client.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n";
import { IconAlert } from "../icons";
import {
  oauthTosRisk,
  oauthTosRiskBodyKey,
  oauthTosRiskTitleKey,
} from "../oauth-tos-risk";

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

  const normalizedProviderId = providerId.trim().toLowerCase();
  const bodyKey = normalizedProviderId === "anthropic"
    ? "oauthTos.anthropicBody"
    : oauthTosRiskBodyKey(level);
  const showApiKeySaferPath =
    normalizedProviderId === "anthropic"
    || normalizedProviderId === "google-antigravity";

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
       aria-describedby={bodyId}
      className="modal-overlay"
      onCancel={handleCancel}
      onClick={onCancel}
      onKeyDown={e => {
        if (e.key !== "Tab") return;
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = dialog.querySelectorAll<HTMLElement>(
          "input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        );
        if (focusable.length === 0) return;
        const first = focusable.item(0);
        const last = focusable.item(focusable.length - 1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      <div
        className="modal-card"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 460 }}
      >
        <h3 id={titleId}>{t(oauthTosRiskTitleKey(level), { provider: providerLabel })}</h3>
        <div
          id={bodyId}
          className="notice-warn"
          style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "flex-start" }}
        >
          <IconAlert width={16} height={16} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
          <p className="modal-desc" style={{ margin: 0 }}>
            {t(bodyKey, { provider: providerLabel })}
          </p>
        </div>
        {showApiKeySaferPath && (
          <p className="muted text-label" style={{ marginTop: 12 }}>
            {t("oauthTos.saferPath")}
          </p>
        )}
        <label className="oauth-tos-ack" style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 14 }}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={e => setAcknowledged(e.target.checked)}
            style={{ marginTop: 3 }}
            aria-required="true"
          />
          <span className="text-label">{t("oauthTos.acknowledge")}</span>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!acknowledged || submitted}
            onClick={handleContinue}
          >
            {t("oauthTos.continue")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
