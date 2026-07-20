/**
 * Modal shown before starting OAuth for providers whose subscription tokens
 * are restricted (or risky) when used outside the official client.
 */
import { useEffect, useId, useState } from "react";
import { useT } from "../i18n";
import { IconAlert } from "../icons";
import {
  oauthTosRisk,
  oauthTosRiskBodyKey,
  oauthTosRiskTitleKey,
  type OAuthTosRiskLevel,
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
  const [acknowledged, setAcknowledged] = useState(false);
  const level: OAuthTosRiskLevel = oauthTosRisk(providerId) ?? "elevated";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="modal-overlay"
      onClick={onCancel}
    >
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <h3 id={titleId}>{t(oauthTosRiskTitleKey(level), { provider: providerLabel })}</h3>
        <div className="notice-warn" style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <IconAlert width={16} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
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
            disabled={!acknowledged}
            onClick={onContinue}
          >
            {t("oauthTos.continue")}
          </button>
        </div>
      </div>
    </div>
  );
}
