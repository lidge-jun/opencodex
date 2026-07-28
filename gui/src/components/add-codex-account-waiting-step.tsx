import { useT } from "../i18n/shared";
import { LoginUrlBlock } from "./login-url-block";
import type { StatusTone } from "./add-codex-account-reducer";

export function AddCodexAccountWaitingStep({
  reauthAccountId,
  authUrl,
  manualCode,
  manualCodeBusy,
  manualCodeWaiting,
  statusNotice,
  statusTone,
  flowId,
  error,
  onManualCodeChange,
  onSubmitManualCode,
  onClose,
}: {
  reauthAccountId?: string;
  authUrl: string;
  manualCode: string;
  manualCodeBusy: boolean;
  manualCodeWaiting: boolean;
  statusNotice: string;
  statusTone: StatusTone;
  flowId: string | null;
  error: string;
  onManualCodeChange: (value: string) => void;
  onSubmitManualCode: () => void;
  onClose: () => void;
}) {
  const t = useT();

  return (
    <>
      <h3 style={{ marginBottom: 4 }}>{reauthAccountId ? t("codexAuth.reauthenticate") : t("codexAuth.oauthLogin")}</h3>
      <p className="modal-desc">{t("codexAuth.oauthWaiting")}</p>
      <LoginUrlBlock url={authUrl} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
        <div className="muted text-label">{t("prov.pasteRedirectHint")}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={manualCode}
            onChange={e => onManualCodeChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmitManualCode();
              }
            }}
            placeholder={t("prov.pasteRedirect")}
            aria-label={t("prov.pasteRedirect")}
            disabled={manualCodeBusy || manualCodeWaiting}
            className="input text-label"
            style={{ flex: 1 }}
          />
          <button
            className="btn btn-ghost"
            type="button"
            disabled={manualCodeBusy || manualCodeWaiting || !manualCode.trim() || !flowId}
            onClick={onSubmitManualCode}
          >
            {manualCodeBusy ? t("codexAuth.oauthSubmittingCode") : t("prov.pasteSubmit")}
          </button>
        </div>
      </div>
      {statusNotice && (
        <div
          className={statusTone === "warn" ? "notice-warn" : "notice notice-ok"}
          role="status"
          aria-live="polite"
          style={{ marginTop: 12 }}
        >
          {statusNotice}
        </div>
      )}
      {error && <div className="notice notice-err" style={{ marginTop: 12 }}>{error}</div>}
      <div style={{ textAlign: "center", padding: "24px 0" }}>
        <span className="spin" style={{ width: 24, height: 24 }} />
      </div>
      <button type="button" className="btn btn-ghost" onClick={onClose} style={{ width: "100%" }}>
        {t("codexAuth.cancel")}
      </button>
    </>
  );
}
