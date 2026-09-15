import { useEffect } from "react";
import { IconX } from "../icons";
import { useT } from "../i18n/shared";
import { ProviderIcon } from "./provider-workspace/ProviderRail";
import CockpitToolsCard from "./provider-workspace/CockpitToolsCard";

export interface AccountAuthChoiceModalProps {
  provider: string;
  providerLabel: string;
  apiBase: string;
  isOpen: boolean;
  isBusy?: boolean;
  onClose: () => void;
  onContinueOAuth: () => void;
  onImportSuccess?: () => void;
}

export default function AccountAuthChoiceModal({
  provider,
  providerLabel,
  apiBase,
  isOpen,
  isBusy = false,
  onClose,
  onContinueOAuth,
  onImportSuccess,
}: AccountAuthChoiceModalProps) {
  const t = useT();
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-choice-modal-title"
      className="modal-overlay"
      onClick={onClose}
    >
      <div className="modal-card auth-choice-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3 id="auth-choice-modal-title">
              {t("pws.authChoiceModalTitle", { provider: providerLabel })}
            </h3>
            <p className="muted text-label" style={{ marginTop: 2 }}>
              {t("pws.authChoiceModalSubtitle")}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <IconX />
          </button>
        </div>

        <div className="auth-choice-body">
          {/* Method 1: Browser OAuth */}
          <div className="auth-choice-card">
            <div className="auth-choice-card-info">
              <ProviderIcon name={provider} cls="provider-icon provider-icon-sm" />
              <div className="auth-choice-card-text">
                <span className="auth-choice-card-title">{t("pws.antigravityOauthTitle")}</span>
                <span className="auth-choice-card-desc">{t("pws.antigravityOauthDesc")}</span>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={isBusy}
              onClick={() => {
                onClose();
                onContinueOAuth();
              }}
            >
              {isBusy ? t("prov.waitingBrowser") : t("pws.antigravityOauthAction")}
            </button>
          </div>

          {/* Method 2: Cockpit Tools Card */}
          <CockpitToolsCard
            apiBase={apiBase}
            onImportSuccess={onImportSuccess}
          />
        </div>
      </div>
    </div>
  );
}
