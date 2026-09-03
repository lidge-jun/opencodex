import { useT } from "../i18n/shared";
import { LoginHint } from "./login-url-block";
import type { StatusTone } from "./add-codex-account-reducer";

export function AddCodexAccountWaitingStep({
  reauthAccountId,
  authUrl,
  deviceCode,
  instructions,
  manualCode,
  manualCodeBusy,
  manualCodeWaiting,
  statusNotice,
  statusTone,
  flowId,
  error,
  onSwitchToDevice,
  onManualCodeChange,
  onSubmitManualCode,
  onClose,
}: {
  reauthAccountId?: string;
  authUrl: string;
  /** Short human code when the login is a device flow; empty otherwise. */
  deviceCode?: string;
  instructions?: string;
  manualCode: string;
  manualCodeBusy: boolean;
  manualCodeWaiting: boolean;
  statusNotice: string;
  statusTone: StatusTone;
  flowId: string | null;
  error: string;
  /** Restart this login as a device flow; omitted once one is already running. */
  onSwitchToDevice?: () => void;
  onManualCodeChange: (value: string) => void;
  onSubmitManualCode: () => void;
  onClose: () => void;
}) {
  const t = useT();

  return (
    <>
      <h3 style={{ marginBottom: 4 }}>{reauthAccountId ? t("codexAuth.reauthenticate") : t("codexAuth.oauthLogin")}</h3>
      <p className="modal-desc">{t("codexAuth.oauthWaiting")}</p>
      <LoginHint
        hint={{ url: authUrl, deviceCode, instructions }}
        paste={{
          value: manualCode,
          busy: manualCodeBusy,
          // The submit stays gated while a prior code is still settling, or before
          // the flow id arrives — but the field itself is only disabled while a
          // submission is actually in flight.
          disabled: manualCodeBusy || manualCodeWaiting || !manualCode.trim() || !flowId,
          submittingLabel: t("codexAuth.oauthSubmittingCode"),
          message: "",
          ok: true,
          onChange: onManualCodeChange,
          onSubmit: onSubmitManualCode,
        }}
      />
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
      {onSwitchToDevice && !deviceCode && (
        // Reauth skips the pick step and starts the browser flow on its own, so
        // this is the only place a headless operator can reach the device grant
        // for an existing account.
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onSwitchToDevice}
          style={{ width: "100%", marginTop: 8 }}
        >
          {t("codexAuth.deviceLogin")}
        </button>
      )}
      <div style={{ textAlign: "center", padding: "24px 0" }}>
        <span className="spin" style={{ width: 24, height: 24 }} />
      </div>
      <button type="button" className="btn btn-ghost" onClick={onClose} style={{ width: "100%" }}>
        {t("codexAuth.cancel")}
      </button>
    </>
  );
}
