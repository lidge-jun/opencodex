/**
 * Modal shown before starting OAuth for providers whose subscription tokens
 * are restricted (or risky) when used outside the official client.
 */
import { useEffect, useId, useRef, useState } from "react";
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const submittedRef = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const level = oauthTosRisk(providerId);

  // Capture-phase Escape so a parent modal (e.g. Add Provider) does not also close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  // Focus first control on open; restore on close.
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog) {
      const focusable = dialog.querySelector<HTMLElement>(
        "input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      focusable?.focus();
    }
    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

  // Unmarked provider: render nothing (callers must gate with oauthTosRisk).
  if (!level) return null;

  const handleContinue = () => {
    if (!acknowledged || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitted(true);
    onContinue();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="modal-overlay"
      onClick={onCancel}
      style={{ zIndex: 60 }}
    >
      <div
        ref={dialogRef}
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
            {t(oauthTosRiskBodyKey(level), { provider: providerLabel })}
          </p>
        </div>
        <p className="muted text-label" style={{ marginTop: 12 }}>
          {t("oauthTos.saferPath")}
        </p>
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
    </div>
  );
}
