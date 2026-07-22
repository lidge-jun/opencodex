/**
 * ProviderAuthPanel — OAuth accounts, API-key pool, and forward-auth
 * embedding for the workspace Settings tab (WP091). Consumes WP040+WP060
 * handlers via props-down; no internal auth machinery.
 */
import { useState } from "react";
import { useT } from "../../i18n";
import { IconLock, IconExternal, IconTrash } from "../../icons";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { oauthAccountDisplayLabel, providerAuthSurface } from "../../provider-workspace/auth";
import CodexAccountPool from "../CodexAccountPool";
import type { AccountLoadState, OAuthAccountRow, ApiKeyRow, LoginHint, ProviderAuthHandlers } from "./types";

export default function ProviderAuthPanel({
  item, apiBase, oauth, accounts = [], keys = [], accountLoadState = "ready",
  switchingAccountId = null, busy = false, loginHint, authHandlers, onCodexActiveNeedsReauthChange,
}: {
  item: WorkspaceItem;
  apiBase: string;
  oauth?: { loggedIn: boolean; email?: string; error?: string };
  accounts?: OAuthAccountRow[];
  keys?: ApiKeyRow[];
  accountLoadState?: AccountLoadState;
  switchingAccountId?: string | null;
  busy?: boolean;
  loginHint?: LoginHint | null;
  authHandlers?: ProviderAuthHandlers;
  onCodexActiveNeedsReauthChange?: (needs: boolean) => void;
}) {
  const t = useT();
  const [addingKey, setAddingKey] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);

  const surface = providerAuthSurface({ ...item, hasApiKey: item.hasApiKey || keys.length > 0 });
  const isOauth = surface === "oauth-accounts";
  const isKeyAuth = surface === "api-keys";

  if (surface === "codex-accounts") {
    return (
      <section className="pwi-section pwi-auth-section" aria-label={t("pws.availableAccounts")}>
        <h3 className="pwi-section-title">{t("pws.availableAccounts")}</h3>
        <div className="pwi-auth-body">
          <CodexAccountPool apiBase={apiBase} embedded onActiveNeedsReauthChange={onCodexActiveNeedsReauthChange} />
        </div>
      </section>
    );
  }

  if (!surface || !authHandlers) return null;

  const hintForThis = loginHint?.provider === item.name ? loginHint : null;
  const loggedIn = accounts.length > 0 || oauth?.loggedIn === true;
  const activeReauthAccount = accounts.find(a => a.active && a.needsReauth);
  const activeNeedsReauth = Boolean(activeReauthAccount);

  const submitKey = async () => {
    const key = newKey.trim();
    if (!key) return;
    setKeyBusy(true);
    const ok = await authHandlers.onAddApiKey(item.name, key);
    setKeyBusy(false);
    if (ok) { setNewKey(""); setAddingKey(false); }
  };

  return (
    <section className="pwi-section pwi-auth-section" aria-label={isOauth ? t("pws.availableAccounts") : t("pws.apiKeys")}>
      <h3 className="pwi-section-title">{isOauth ? t("pws.availableAccounts") : t("pws.apiKeys")}</h3>
      <div className="pwi-auth-body">
        {isOauth && (
          <>
            <div className="pwi-auth-status-row">
              <span className={`pwi-auth-dot ${activeNeedsReauth ? "pwi-auth-dot--warn" : loggedIn ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
              <span className="pwi-auth-status-text">
                {loggedIn
                  ? (accounts.length > 0 ? t("pws.loggedInTitle") : (oauth?.email ?? t("pws.loggedInTitle")))
                  : (oauth?.error || t("pws.notLoggedInTitle"))}
              </span>
              <span className="pwi-auth-actions">
                {activeReauthAccount && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void authHandlers.onReauth(item.name, activeReauthAccount.id)}>
                    {t("pws.reauthenticate")}
                  </button>
                )}
                {loggedIn ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void authHandlers.onLogout(item.name)}>{t("prov.logout")}</button>
                ) : (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void authHandlers.onLogin(item.name, false)}>
                    {busy ? <span className="pwi-spin-inline" aria-hidden="true" /> : <IconLock style={{ width: 13, height: 13 }} aria-hidden="true" />}
                    {busy ? t("prov.waitingBrowser") : t("prov.login")}
                  </button>
                )}
              </span>
            </div>
            {busy && hintForThis && (
              <div className="pwi-auth-wait">
                <span className="pwi-spin-inline" aria-hidden="true" />
                <div className="pwi-auth-wait-copy">
                  <div className="pwi-auth-wait-title">{t("prov.waitingBrowser")}</div>
                  {hintForThis.deviceCode && (
                    <div className="pwi-device-code-wrap">
                      <span>{t("prov.deviceCode")}</span>
                      <code className="pwi-device-code">{hintForThis.deviceCode}</code>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => {
                        navigator.clipboard.writeText(hintForThis.deviceCode ?? "").then(() => {
                          setDeviceCodeCopied(true);
                          setTimeout(() => setDeviceCodeCopied(false), 2500);
                        }).catch(() => {});
                      }}>{deviceCodeCopied ? t("prov.codeCopied") : t("prov.copyCode")}</button>
                    </div>
                  )}
                  {hintForThis.url && (
                    <a href={hintForThis.url} target="_blank" rel="noreferrer" className="pwi-auth-open-link">
                      <IconExternal style={{ width: 13, height: 13 }} /> {t("prov.didntOpen")}
                    </a>
                  )}
                  {authHandlers.onCancelLogin && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void authHandlers.onCancelLogin?.(item.name)}>
                      {t("common.cancel")}
                    </button>
                  )}
                </div>
              </div>
            )}
            {accountLoadState === "loading" && accounts.length === 0 && (
              <div className="pwi-auth-state" role="status">
                <span className="pwi-spin-inline" aria-hidden="true" />
                {t("pws.accountsLoading")}
              </div>
            )}
            {accountLoadState === "error" && (
              <div className="pwi-auth-state pwi-auth-state--error" role="alert">
                <span>{t("pws.accountsLoadFailed")}</span>
                {authHandlers.onRetryAccounts && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void authHandlers.onRetryAccounts?.(item.name)}>
                    {t("pws.retryAccounts")}
                  </button>
                )}
              </div>
            )}
            {accounts.length > 0 && (
              <div className="pwi-auth-list" role="list">
                {accounts.map(account => {
                  const label = oauthAccountDisplayLabel(accounts, account, t);
                  const switching = switchingAccountId === account.id;
                  return (
                  <div key={account.id} className={`pwi-auth-row${account.active ? " pwi-auth-row--active" : ""}`} role="listitem">
                    <button type="button" className="pwi-auth-row-main"
                      onClick={() => { if (!account.active && !account.needsReauth && !switchingAccountId) void authHandlers.onSwitchAccount(item.name, account); }}
                      aria-current={account.active ? "true" : undefined}
                      aria-label={`${label}${account.active ? ` — ${t("pws.accountCurrent")}` : ""}`}
                      disabled={Boolean(account.needsReauth || (switchingAccountId && !switching))}>
                      <span className={`pwi-auth-dot ${account.needsReauth ? "pwi-auth-dot--warn" : account.active ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                      <span className="pwi-auth-row-copy">
                        <span className="pwi-auth-row-label">{label}</span>
                        <span className="pwi-auth-row-secondary">{[account.email, `${t("prov.accountId")}: ${account.id}`].filter(Boolean).join(" · ")}</span>
                      </span>
                      {account.needsReauth && <span className="badge badge-amber">{t("pws.reauth")}</span>}
                      {account.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                      {switching && <span className="badge badge-muted">{t("pws.accountSwitching")}</span>}
                    </button>
                    {account.needsReauth && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy || Boolean(switchingAccountId)}
                        onClick={() => void authHandlers.onReauth(item.name, account.id)}
                      >
                        {t("pws.reauthenticate")}
                      </button>
                    )}
                    <button type="button" className="btn btn-ghost btn-sm"
                      onClick={() => void authHandlers.onEditAlias(item.name, "oauth", account.id, account.alias)}>
                      {t("prov.editAlias")}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm pwi-auth-row-remove"
                      aria-label={`${t("common.remove")} — ${label}`}
                      title={`${t("common.remove")} — ${label}`}
                      disabled={Boolean(switchingAccountId)}
                      onClick={() => void authHandlers.onRemoveAccount(item.name, account)}>
                      <IconTrash style={{ width: 13, height: 13 }} aria-hidden="true" />
                    </button>
                  </div>
                  );
                })}
              </div>
            )}
            {accountLoadState === "ready" && loggedIn && accounts.length === 0 && (
              <div className="pwi-auth-state pwi-auth-state--empty">{t("pws.noAccounts")}</div>
            )}
            {loggedIn && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }}
                onClick={() => void authHandlers.onLogin(item.name, true)} disabled={busy || Boolean(switchingAccountId)}>
                {t("pws.addAccount")}
              </button>
            )}
          </>
        )}

        {isKeyAuth && (
          <>
            {keys.length > 0 && (
              <div className="pwi-auth-list" role="list">
                {keys.map(entry => (
                  <div key={entry.id} className={`pwi-auth-row${entry.active ? " pwi-auth-row--active" : ""}`} role="listitem">
                    <button type="button" className="pwi-auth-row-main"
                      onClick={() => void authHandlers.onSwitchApiKey(item.name, entry)}
                      disabled={entry.active}>
                      <span className={`pwi-auth-dot ${entry.active ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                      <span className="pwi-auth-row-copy">
                        <span className="pwi-auth-row-label">{entry.label ?? entry.masked}</span>
                        {entry.label && <code className="pwi-auth-row-secondary">{entry.masked} · {t("prov.accountId")}: {entry.id}</code>}
                      </span>
                      {entry.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm"
                      onClick={() => void authHandlers.onEditAlias(item.name, "api-key", entry.id, entry.label)}>
                      {t("prov.editAlias")}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm pwi-auth-row-remove"
                      aria-label={`${t("common.remove")} — ${entry.label ?? entry.masked}`}
                      title={`${t("common.remove")} — ${entry.label ?? entry.masked}`}
                      onClick={() => void authHandlers.onRemoveApiKey(item.name, entry)}>
                      <IconTrash style={{ width: 13, height: 13 }} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {addingKey ? (
              <div className="pwi-auth-add-key">
                <input className="input" type="password" value={newKey} onChange={e => setNewKey(e.target.value)}
                  placeholder={t("modal.apiKeyPlaceholder")} autoComplete="off" disabled={keyBusy} />
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void submitKey()} disabled={keyBusy || !newKey.trim()}>
                  {keyBusy ? t("pws.saving") : t("pws.addKey")}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAddingKey(false); setNewKey(""); }}>{t("common.cancel")}</button>
              </div>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }}
                onClick={() => setAddingKey(true)}>{t("pws.addKey")}</button>
            )}
          </>
        )}

      </div>
    </section>
  );
}
