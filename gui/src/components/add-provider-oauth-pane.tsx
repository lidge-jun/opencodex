import { IconLock } from "../icons";
import { useT } from "../i18n/shared";
import { LoginUrlBlock } from "./login-url-block";
import type { CatalogPreset } from "./provider-catalog/provider-presets";

export function AddProviderOAuthPane({
  preset,
  oauthSupported,
  oauthBusy,
  oauthMsg,
  oauthMsgTone,
  oauthUrl,
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
        <button type="button" className="btn btn-primary" onClick={() => onRequestLogin(preset.oauthProvider!)} disabled={oauthBusy}
          style={{ width: "100%", padding: "12px 16px" }}>
          <IconLock />{oauthBusy ? t("modal.waitingBrowser") : t("modal.logInWith", { label: preset.label })}
        </button>
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
      {oauthBusy && <LoginUrlBlock url={oauthUrl} />}
      {oauthBusy && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div className="muted text-label">
            {t("prov.pasteRedirectHint")}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={manualCode}
              onChange={e => onManualCodeChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && preset.oauthProvider) {
                  e.preventDefault();
                  onSubmitManualCode(preset.oauthProvider);
                }
              }}
              placeholder={t("prov.pasteRedirect")}
              aria-label={t("prov.pasteRedirect")}
              disabled={manualCodeBusy}
              className="input text-label"
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-ghost"
              type="button"
              disabled={manualCodeBusy || !manualCode.trim() || !preset.oauthProvider}
              onClick={() => preset.oauthProvider && onSubmitManualCode(preset.oauthProvider)}
            >
              {manualCodeBusy ? t("prov.pasteSubmitting") : t("prov.pasteSubmit")}
            </button>
          </div>
          {manualCodeMsg && (
            <div className="text-label" style={{ color: manualCodeOk ? "var(--accent-hover)" : "var(--amber)" }}>
              {manualCodeMsg}
            </div>
          )}
        </div>
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
