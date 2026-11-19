import { IconLock } from "../icons";
import { useT } from "../i18n/shared";
import { LoginHint } from "./login-url-block";
import type { BrowserLaunch } from "../oauth-browser-launch";
import { OpenBrowserPrefToggle } from "./open-browser-pref-toggle";
import type { CatalogPreset } from "./provider-catalog/provider-presets";
import { oauthLabel } from "../pages/providers-shared";
import { sharedLoginRow } from "./shared-login-row";

export function AddProviderOAuthPane({
  preset,
  oauthSupported,
  oauthBusy,
  oauthMsg,
  oauthMsgTone,
  oauthUrl,
  oauthDeviceCode,
  oauthInstructions,
  oauthBrowserLaunch,
  manualCode,
  manualCodeBusy,
  manualCodeMsg,
  manualCodeOk,
  ownerLoggedIn = false,
  saving = false,
  error = "",
  onRequestLogin,
  onUseExistingLogin,
  onCancelLogin,
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
  oauthBrowserLaunch?: BrowserLaunch;
  manualCode: string;
  manualCodeBusy: boolean;
  manualCodeMsg: string;
  manualCodeOk: boolean;
  /** A shared-login preset whose owner login is already signed in adds its row without a new login. */
  ownerLoggedIn?: boolean;
  saving?: boolean;
  error?: string;
  onRequestLogin: (providerId: string) => void;
  onUseExistingLogin?: () => void;
  onCancelLogin: (providerId: string) => void;
  onUseApiKeyInstead: () => void;
  onManualCodeChange: (value: string) => void;
  onSubmitManualCode: (providerId: string) => void;
  onBack: () => void;
}) {
  const t = useT();
  const sharedRow = sharedLoginRow(preset);
  const ownerLabel = sharedRow ? oauthLabel(preset.oauthProvider!) : preset.label;
  const reuseLogin = sharedRow !== undefined && ownerLoggedIn && onUseExistingLogin !== undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="muted text-control">{preset.note ?? t("modal.oauthDefaultNote")}</div>
      {sharedRow && (
        <div className="muted text-control">{t("modal.sharedLoginNote", { label: preset.label, provider: ownerLabel })}</div>
      )}
      {reuseLogin ? (
        <button type="button" className="btn btn-primary" onClick={onUseExistingLogin} disabled={saving || oauthBusy}
          style={{ width: "100%", padding: "12px 16px" }}>
          <IconLock />{t("modal.addWithExistingLogin", { label: preset.label, provider: ownerLabel })}
        </button>
      ) : oauthSupported.includes(preset.oauthProvider ?? "") ? (
        <>
          <button type="button" className="btn btn-primary" onClick={() => onRequestLogin(preset.oauthProvider!)} disabled={oauthBusy}
            style={{ width: "100%", padding: "12px 16px" }}>
            <IconLock />{oauthBusy ? t("modal.waitingBrowser") : t("modal.logInWith", { label: ownerLabel })}
          </button>
          {!oauthBusy && <OpenBrowserPrefToggle />}
        </>
      ) : (
        <div className="text-control" style={{ color: "var(--amber)", background: "var(--amber-soft)", border: "1px solid var(--amber)", borderRadius: "var(--radius-sm)", padding: "10px 12px" }}>
          {t("modal.oauthComingSoon", { label: preset.label })}
        </div>
      )}
      {error && <div className="text-label" style={{ color: "var(--amber)" }}>{error}</div>}
      {oauthMsg && (!oauthBusy || oauthMsg !== oauthInstructions) && (
        <div className="text-label" style={{ color: oauthMsgTone === "warn" ? "var(--amber)" : "var(--accent-hover)" }}>
          {oauthMsg}
        </div>
      )}
      {oauthBusy && (
        <LoginHint
          providerId={preset.oauthProvider}
          hint={{ url: oauthUrl, deviceCode: oauthDeviceCode, instructions: oauthInstructions, browserLaunch: oauthBrowserLaunch }}
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
        {oauthBusy && preset.oauthProvider && (
          <button type="button" className="btn btn-ghost" onClick={() => onCancelLogin(preset.oauthProvider!)}>
            {t("common.cancel")}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onBack}>{t("modal.back")}</button>
      </div>
    </div>
  );
}
