import { IconLock } from "../icons";
import { useT } from "../i18n/shared";
import { LoginHint } from "./login-url-block";
import { OpenBrowserPrefToggle } from "./open-browser-pref-toggle";
import type { CatalogPreset } from "./provider-catalog/provider-presets";

export function AddProviderOAuthPane({
  preset,
  oauthSupported,
  oauthBusy,
  oauthMsg,
  oauthMsgTone,
  oauthUrl,
  oauthDeviceCode,
  oauthInstructions,
  manualCode,
  manualCodeBusy,
  manualCodeMsg,
  manualCodeOk,
  onRequestLogin,
  onUseApiKeyInstead,
  onManualCodeChange,
  onSubmitManualCode,
  onBack,
}: {
  preset: CatalogPreset;
  oauthSupported: string[];
  oauthBusy: boolean;
  oauthMsg: string;
  oauthMsgTone: "ok" | "warn";
  oauthUrl: string;
  oauthDeviceCode?: string;
  oauthInstructions?: string;
  manualCode: string;
  manualCodeBusy: boolean;
  manualCodeMsg: string;
  manualCodeOk: boolean;
  onRequestLogin: (providerId: string) => void;
  onUseApiKeyInstead: () => void;
  onManualCodeChange: (value: string) => void;
  onSubmitManualCode: (providerId: string) => void;
  onBack: () => void;
}) {
  const t = useT();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="muted text-control">{preset.note ?? t("modal.oauthDefaultNote")}</div>
      {oauthSupported.includes(preset.oauthProvider ?? "") ? (
        <>
          <button type="button" className="btn btn-primary" onClick={() => onRequestLogin(preset.oauthProvider!)} disabled={oauthBusy}
            style={{ width: "100%", padding: "12px 16px" }}>
            <IconLock />{oauthBusy ? t("modal.waitingBrowser") : t("modal.logInWith", { label: preset.label })}
          </button>
          {!oauthBusy && <OpenBrowserPrefToggle />}
        </>
      ) : (
        <div className="text-control" style={{ color: "var(--amber)", background: "var(--amber-soft)", border: "1px solid var(--amber)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}>
          {t("modal.oauthComingSoon", { label: preset.label })}
        </div>
      )}
      {oauthMsg && (
        <div className="text-label" style={{ color: oauthMsgTone === "warn" ? "var(--amber)" : "var(--accent-hover)" }}>
          {oauthMsg}
        </div>
      )}
      {oauthBusy && (
        <LoginHint
          hint={{ url: oauthUrl, deviceCode: oauthDeviceCode, instructions: oauthInstructions }}
          paste={{
            value: manualCode,
            busy: manualCodeBusy,
            disabled: !preset.oauthProvider,
            message: manualCodeMsg,
            ok: manualCodeOk,
            onChange: onManualCodeChange,
            onSubmit: () => { if (preset.oauthProvider) onSubmitManualCode(preset.oauthProvider); },
          }}
        />
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 2 }}>
        <button type="button" className="link-btn" onClick={onUseApiKeyInstead}>
          {t("modal.useApiKeyInstead")}
        </button>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost" onClick={onBack}>{t("modal.back")}</button>
      </div>
    </div>
  );
}
