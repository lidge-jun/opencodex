import type { TFn } from "../../i18n";
import { IconExternal, IconLink, IconLock, IconPlus } from "../../icons";

interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, { adapter: string; baseUrl: string; hasApiKey?: boolean; hasHeaders?: boolean; defaultModel?: string; models?: string[]; liveModels?: boolean; authMode?: string; keyOptional?: boolean; disabled?: boolean; note?: string; codexAccountMode?: "direct" | "pool" }>;
}

interface OAuthStatus { loggedIn: boolean; email?: string; error?: string; done?: boolean; needsReauth?: boolean; activeAccountId?: string | null }

export interface OAuthPanelProps {
  t: TFn;
  oauthProviders: string[];
  keyProviders: string[];
  oauthStatus: Record<string, OAuthStatus>;
  busy: string | null;
  loginInfo: { provider: string; url?: string; instructions?: string; deviceCode?: string } | null;
  linkCopied: boolean;
  deviceCodeCopied: boolean;
  manualCode: string;
  manualCodeBusy: boolean;
  manualCodeMsg: string;
  config: Config | null;
  setLinkCopied: (v: boolean) => void;
  setDeviceCodeCopied: (v: boolean) => void;
  setManualCode: (v: string) => void;
  cancelLoginOAuth: (provider: string) => void;
  logoutOAuth: (provider: string) => void;
  submitManualCode: (provider: string) => void;
  providerIconSrc: (name: string) => string | undefined;
  oauthLabel: (id: string) => string;
  onAddProvider: (intent: { tier?: "accounts" | "paid"; custom?: boolean }) => void;
}

export function OAuthPanel({
  t, oauthProviders, keyProviders, oauthStatus, busy, loginInfo, linkCopied,
  deviceCodeCopied, manualCode, manualCodeBusy, manualCodeMsg, config,
  setLinkCopied, setDeviceCodeCopied, setManualCode,
  cancelLoginOAuth, logoutOAuth, submitManualCode, providerIconSrc, oauthLabel, onAddProvider,
}: OAuthPanelProps) {
  const accountProviders = Array.from(new Set([
    ...oauthProviders,
    ...Object.entries(config?.providers ?? {})
      .filter(([, provider]) => provider.authMode === "forward")
      .map(([name]) => name),
  ]));
  const connectedAccounts = accountProviders.filter(provider => oauthStatus[provider]?.loggedIn || busy === provider);
  const renderProviderRow = (name: string, kind: "account" | "key") => {
    const st = oauthStatus[name] ?? { loggedIn: false };
    const isBusy = busy === name;
    const provider = config?.providers[name];
    const icon = providerIconSrc(name);
    const isForward = provider?.authMode === "forward";
    const keylessFree = provider?.keyOptional === true && !provider?.hasApiKey;
    return (
      <div key={name} className="oauth-row">
        <span className="oauth-name" title={kind === "account" ? oauthLabel(name) : name}>
          <span className="provider-icon provider-icon-sm">{icon && <img src={icon} alt="" aria-hidden="true" />}</span>
          <span className="oauth-name-text">{name}</span>
        </span>
        <span className="oauth-status">
          <span className={`dot ${isBusy ? "dot-amber" : "dot-green"}`} />
          <span className="oauth-email muted">
            {kind === "account" ? (isBusy ? t("prov.waitingBrowser") : st.email ?? t("prov.loggedIn")) : keylessFree ? t("modal.badge.free") : t("prov.hasApiKey")}
          </span>
        </span>
        <span className="oauth-actions">
          {kind === "account" && isForward && <a className="btn btn-ghost btn-sm" href="#codex-auth">{t("prov.manageCodexAccounts")}</a>}
          {kind === "account" && !isForward && !isBusy && <button className="btn btn-ghost btn-sm" onClick={() => logoutOAuth(name)}>{t("prov.logout")}</button>}
          {kind === "account" && isBusy && <button className="btn btn-ghost btn-sm" onClick={() => { void cancelLoginOAuth(name); }}>{t("common.cancel")}</button>}
        </span>
        {kind === "account" && loginInfo?.provider === name && (loginInfo.url || loginInfo.instructions || loginInfo.deviceCode || isBusy) && (
          <span className="oauth-login-hint muted">
            {loginInfo.deviceCode && (
              <span className="oauth-device-code-wrap">
                <span className="oauth-device-code-label">{t("prov.deviceCode")}</span>
                <code className="oauth-device-code">{loginInfo.deviceCode}</code>
                <button className="btn btn-primary btn-sm" type="button" onClick={() => {
                  navigator.clipboard.writeText(loginInfo.deviceCode ?? "").then(() => {
                    setDeviceCodeCopied(true);
                    setTimeout(() => setDeviceCodeCopied(false), 2500);
                  }).catch(() => {});
                }}>{deviceCodeCopied ? t("prov.codeCopied") : t("prov.copyCode")}</button>
              </span>
            )}
            <span className="oauth-login-hint-links">
              {loginInfo.url && <a href={loginInfo.url} target="_blank" rel="noreferrer" className="link-btn"><IconExternal width={14} height={14} />{t("prov.didntOpen")}</a>}
              <button className="link-btn" onClick={() => {
                if (loginInfo.url) navigator.clipboard.writeText(loginInfo.url).then(() => {
                  setLinkCopied(true);
                  setTimeout(() => setLinkCopied(false), 2500);
                }).catch(() => {});
              }}><IconLink width={14} height={14} />{linkCopied ? t("prov.linkCopied") : t("prov.copyLink")}</button>
              {loginInfo.instructions && !loginInfo.deviceCode && <span>{loginInfo.instructions}</span>}
            </span>
            <span className="oauth-login-paste">
              <input className="input" type="text" autoComplete="off" spellCheck={false} value={manualCode} onChange={e => setManualCode(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void submitManualCode(name); } }} placeholder={t("prov.pasteRedirect")} aria-label={t("prov.pasteRedirect")} disabled={manualCodeBusy} />
              <button className="btn btn-ghost btn-sm" type="button" disabled={manualCodeBusy || !manualCode.trim()} onClick={() => void submitManualCode(name)}>{manualCodeBusy ? t("prov.pasteSubmitting") : t("prov.pasteSubmit")}</button>
            </span>
            <span className="text-caption">{manualCodeMsg || t("prov.pasteRedirectHint")}</span>
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="panel provider-connections">
      <div className="row provider-connections-head">
        <IconLock style={{ width: 16, height: 16, color: "var(--accent)" }} />
        <span className="font-semibold">{t("prov.connections")}</span>
      </div>
      <div className="provider-connection-groups">
        <section className="provider-connection-group">
          <header>
            <span>{t("pws.tab.accounts")}</span>
            <button className="btn btn-ghost btn-sm provider-connection-add" type="button" onClick={() => onAddProvider({ tier: "accounts" })}>
              <IconPlus />{t("pws.tab.accounts")}
            </button>
          </header>
          {connectedAccounts.length > 0 ? (
            <div className="oauth-grid">{connectedAccounts.map(name => renderProviderRow(name, "account"))}</div>
          ) : <span className="muted text-label">{t("prov.noConnections")}</span>}
        </section>
        <section className="provider-connection-group">
          <header>
            <span>{t("pws.apiKeys")}</span>
            <button className="btn btn-ghost btn-sm provider-connection-add" type="button" onClick={() => onAddProvider({ tier: "paid" })}>
              <IconPlus />{t("pws.apiKeys")}
            </button>
          </header>
          {keyProviders.length > 0 ? (
            <div className="oauth-grid">{keyProviders.map(name => renderProviderRow(name, "key"))}</div>
          ) : <span className="muted text-label">{t("prov.noConnections")}</span>}
        </section>
        <section className="provider-connection-group provider-connection-group--custom">
          <header><span>{t("modal.customProvider")}</span></header>
          <button className="btn btn-ghost provider-custom-add" type="button" onClick={() => onAddProvider({ custom: true })}>
            <IconPlus />{t("modal.customProvider")}
          </button>
        </section>
      </div>
    </div>
  );
}
