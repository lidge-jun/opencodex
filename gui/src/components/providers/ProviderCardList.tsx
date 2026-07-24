import type { Dispatch, SetStateAction } from "react";
import type { TFn } from "../../i18n";
import type { AccountQuota } from "../../codex-quota-utils";
import QuotaBars, { buildQuotaRows } from "../QuotaBars";
import { IconChevron, IconLock, IconPlus, IconPower, IconTrash } from "../../icons";
import { oauthAccountDisplayLabel } from "../../provider-workspace/auth";
import { formatTokenCount, type ProviderUsageTotals } from "../../provider-workspace/usage";

interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, { adapter: string; baseUrl: string; hasApiKey?: boolean; hasHeaders?: boolean; defaultModel?: string; models?: string[]; liveModels?: boolean; authMode?: string; keyOptional?: boolean; disabled?: boolean; note?: string; codexAccountMode?: "direct" | "pool" }>;
}

interface OAuthAccount { id: string; alias?: string; email?: string; active: boolean; needsReauth?: boolean; expiresAt?: number }
interface ApiKeyEntry { id: string; label?: string; masked: string; active: boolean }
interface ProviderQuotaReport { provider: string; quota: AccountQuota; source: string; updatedAt: number }
type OpenAiAccountMode = "pool" | "direct";

export interface ProviderCardListProps {
  t: TFn;
  config: Config;
  quotaReports: Record<string, ProviderQuotaReport>;
  usageTotals: Record<string, ProviderUsageTotals>;
  accountSets: Record<string, { activeAccountId: string | null; accounts: OAuthAccount[] }>;
  keyPools: Record<string, ApiKeyEntry[]>;
  openAccounts: Record<string, boolean>;
  addingKeyFor: string | null;
  newKeyValue: string;
  busy: string | null;
  modeBusy: boolean;
  activeAccountNeedsReauth: Record<string, boolean>;
  setOpenAccounts: Dispatch<SetStateAction<Record<string, boolean>>>;
  setAddingKeyFor: Dispatch<SetStateAction<string | null>>;
  setNewKeyValue: Dispatch<SetStateAction<string>>;
  loginOAuth: (provider: string, addAccount?: boolean, accountId?: string) => void;
  requestLoginOAuth: (provider: string, addAccount?: boolean) => void;
  setOpenAiAccountMode: (mode: OpenAiAccountMode) => void;
  setProviderDisabled: (name: string, disabled: boolean) => void;
  removeProvider: (name: string) => void;
  switchAccount: (provider: string, account: OAuthAccount) => void;
  removeAccount: (provider: string, account: OAuthAccount) => void;
  switchApiKey: (provider: string, entry: ApiKeyEntry) => void;
  removeApiKey: (provider: string, entry: ApiKeyEntry) => void;
  addApiKey: (provider: string) => void;
  providerIconSrc: (name: string) => string | undefined;
  resolvedOpenAiAccountMode: (provider: Config["providers"][string]) => OpenAiAccountMode;
}

export function ProviderCardList({
  t, config, quotaReports, usageTotals, accountSets, keyPools, openAccounts, addingKeyFor,
  newKeyValue, busy, modeBusy, activeAccountNeedsReauth, setOpenAccounts,
  setAddingKeyFor, setNewKeyValue, loginOAuth, requestLoginOAuth,
  setOpenAiAccountMode, setProviderDisabled, removeProvider, switchAccount,
  removeAccount, switchApiKey, removeApiKey, addApiKey, providerIconSrc,
  resolvedOpenAiAccountMode,
}: ProviderCardListProps) {
  return (
    <div className="provider-list">
      <div className="muted text-control provider-list-meta">
        {t("prov.port")}: <code className="chip">{config.port}</code> · {t("prov.default")}: <code className="chip">{config.defaultProvider}</code>
      </div>
      <div className="provider-card-grid">
      {Object.entries(config.providers).map(([name, prov]) => {
        const isDefault = name === config.defaultProvider;
        const isDisabled = prov.disabled === true;
        const quota = quotaReports[name]?.quota ?? null;
        const hasQuotaRows = buildQuotaRows(quota, null, t).length > 0;
        const totalTokens = usageTotals[name]?.totalTokens;
        const icon = providerIconSrc(name);
        const accountSet = prov.authMode === "oauth" ? accountSets[name] : undefined;
        const isKeyAuth = prov.authMode !== "oauth" && prov.authMode !== "forward";
        const keyPool = isKeyAuth && prov.hasApiKey ? (keyPools[name] ?? []) : [];
        const showAccounts = (!!accountSet && accountSet.accounts.length > 0) || keyPool.length > 0;
        const accountsOpen = openAccounts[name] === true;
        const dropdownCount = accountSet?.accounts.length ?? keyPool.length;
        const openAiMode = name === "openai" ? resolvedOpenAiAccountMode(prov) : null;
        const tierDescription = openAiMode === "direct"
          ? t("prov.openaiDirectDesc")
          : openAiMode === "pool"
            ? t("prov.openaiPoolDesc")
            : name === "openai-apikey"
              ? t("prov.openaiApiDesc")
              : prov.note;
        return (
          <div key={name} className={`card prov-card${isDisabled ? " prov-card-disabled" : ""}`}>
            <div className="prov-card-main">
              <div className="prov-card-info">
                {icon && <span className="provider-icon"><img src={icon} alt="" aria-hidden="true" /></span>}
                <div className="prov-card-copy">
                  <div className="prov-title">
                    <span className="font-semibold">{name}</span>
                    {isDefault && <span className="badge badge-primary">{t("prov.defaultBadge")}</span>}
                    {isDisabled ? <span className="badge badge-muted">{t("prov.disabledBadge")}</span> : activeAccountNeedsReauth[name] ? <span className="badge badge-amber">{t("pws.reauth")}</span> : <span className="badge badge-green">{t("prov.activeBadge")}</span>}
                    {prov.authMode === "oauth" && <span className="badge badge-accent">oauth</span>}
                    {openAiMode === "direct" && <span className="badge badge-green">{t("prov.openaiModeDirect")}</span>}
                    {openAiMode === "pool" && <span className="badge badge-accent">{t("prov.openaiModePool")}</span>}
                    {name === "openai-apikey" && <span className="badge badge-muted">{t("modal.badge.apiKey")}</span>}
                    {name !== "openai" && prov.authMode === "forward" && !prov.codexAccountMode && <span className="badge badge-amber">passthrough</span>}
                    {prov.keyOptional && <span className="badge badge-green">{t("modal.badge.free")}</span>}
                  </div>
                  <div className="muted prov-meta text-control">
                    <code className="chip">{prov.adapter}</code>
                    <span>{prov.baseUrl}</span>
                    {prov.defaultModel && <span>{prov.defaultModel}</span>}
                    {prov.hasApiKey && <span>{t("prov.hasApiKey")}</span>}
                    {prov.hasHeaders && <span>{t("prov.hasHeaders")}</span>}
                  </div>
                  {tierDescription && (
                    <div className="muted text-label leading-body" style={{ marginTop: 4 }}>
                      {tierDescription}
                      {openAiMode && <> · <a href="#codex-auth">{t("prov.manageCodexAccounts")}</a></>}
                    </div>
                  )}
                  {openAiMode && (
                    <div className="openai-mode-row">
                      <span id="openai-account-mode-label" className="text-label font-semibold">{t("prov.openaiAccountMode")}</span>
                      <div className="usage-segmented openai-mode-control" role="radiogroup" aria-labelledby="openai-account-mode-label">
                        {(["pool", "direct"] as const).map(mode => (
                          <button
                            key={mode}
                            type="button"
                            role="radio"
                            aria-checked={openAiMode === mode}
                            className={`usage-segmented-btn${openAiMode === mode ? " active" : ""}`}
                            disabled={modeBusy}
                            onClick={() => void setOpenAiAccountMode(mode)}
                          >
                            {t(mode === "pool" ? "prov.openaiModePool" : "prov.openaiModeDirect")}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="provider-actions">
                {activeAccountNeedsReauth[name] && prov.authMode === "oauth" && (
                  <button className="btn btn-primary btn-sm" onClick={() => {
                    const active = accountSets[name]?.accounts.find(a => a.active && a.needsReauth);
                    void loginOAuth(name, true, active?.id);
                  }} disabled={busy === name}>
                    {t("prov.reauthenticate")}
                  </button>
                )}
                {activeAccountNeedsReauth[name] && name === "openai" && (
                  <a className="btn btn-primary btn-sm" href="#codex-auth">{t("prov.reauthenticate")}</a>
                )}
                <button
                  className={`btn ${isDisabled ? "btn-primary" : "btn-ghost"} btn-sm`}
                  onClick={() => setProviderDisabled(name, !isDisabled)}
                  disabled={isDefault}
                  title={isDefault ? t("prov.defaultCannotDisable") : undefined}
                  aria-label={isDisabled ? t("prov.enableAria", { name }) : t("prov.disableAria", { name })}
                >
                  {isDefault ? <IconLock /> : <IconPower />}
                  {isDisabled ? t("prov.enable") : t("prov.disable")}
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => removeProvider(name)} aria-label={t("sub.removeAria", { m: name })}><IconTrash />{t("common.remove")}</button>
              </div>
            </div>
            {(quota || (!hasQuotaRows && totalTokens !== undefined)) && (
              <div className="prov-card-resource">
                {quota && <QuotaBars quota={quota} threshold={80} t={t} className="provider-quota" />}
                {!hasQuotaRows && totalTokens !== undefined && (
                  <div className="provider-usage-fallback">
                    <span>{t("dash.tokens30d")}</span>
                    <strong>{formatTokenCount(totalTokens)}</strong>
                  </div>
                )}
              </div>
            )}
            {showAccounts && (
              <>
                <button
                  className={`prov-accounts-toggle${accountsOpen ? " open" : ""}`}
                  onClick={() => setOpenAccounts(prev => ({ ...prev, [name]: !accountsOpen }))}
                  aria-expanded={accountsOpen}
                  aria-label={t("prov.accountsAria", { name })}
                >
                  {t("prov.accounts", { n: String(dropdownCount) })}
                  <span className="chev"><IconChevron /></span>
                </button>
                {accountsOpen && (
                  <div className="prov-accounts-list">
                    {(accountSet?.accounts ?? []).map(account => {
                      const accountLabel = oauthAccountDisplayLabel(accountSet?.accounts ?? [account], account, t);
                      return (
                      <div
                        key={account.id}
                        className={`prov-account-row${account.active ? " active" : ""}`}
                      >
                        <button
                          type="button"
                          className="prov-account-row-main"
                          onClick={() => { if (!account.needsReauth) void switchAccount(name, account); }}
                          title={account.active || account.needsReauth ? undefined : t("prov.accountSwitchTitle")}
                          disabled={Boolean(account.needsReauth)}
                        >
                          <span className={`dot ${account.needsReauth ? "dot-amber" : account.active ? "dot-green" : "dot-muted"}`} />
                          <span className="prov-account-email">{accountLabel}</span>
                          {account.needsReauth && <span className="badge badge-amber">{t("prov.accountReauth")}</span>}
                          {account.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                        </button>
                        {account.needsReauth && (
                          <button
                            type="button"
                            className="prov-account-reauth"
                            disabled={busy === name}
                            onClick={e => { e.stopPropagation(); void loginOAuth(name, true, account.id); }}
                          >
                            {t("prov.reauthenticate")}
                          </button>
                        )}
                        <button
                          type="button"
                          className="prov-account-remove"
                          aria-label={t("prov.accountRemoveAria", { email: accountLabel })}
                          onClick={e => { e.stopPropagation(); removeAccount(name, account); }}
                        >
                          <IconTrash style={{ width: 13, height: 13 }} />
                        </button>
                      </div>
                      );
                    })}
                    {keyPool.map(entry => (
                      <button
                        key={entry.id}
                        className={`prov-account-row${entry.active ? " active" : ""}`}
                        onClick={() => switchApiKey(name, entry)}
                        title={entry.active ? undefined : t("prov.keySwitchTitle")}
                      >
                        <span className={`dot ${entry.active ? "dot-green" : "dot-muted"}`} />
                        <span className="prov-account-email mono">{entry.label ? `${entry.label} · ${entry.masked}` : entry.masked}</span>
                        {entry.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                        <span
                          className="prov-account-remove"
                          role="button"
                          aria-label={t("prov.keyRemoveAria", { key: entry.label ?? entry.masked })}
                          onClick={e => { e.stopPropagation(); removeApiKey(name, entry); }}
                        >
                          <IconTrash style={{ width: 13, height: 13 }} />
                        </span>
                      </button>
                    ))}
                    {accountSet ? (
                      <button className="prov-account-row prov-account-add" onClick={() => requestLoginOAuth(name, true)} disabled={busy === name}>
                        {busy === name ? <><span className="spin" />{t("prov.waitingBrowser")}</> : <><IconPlus style={{ width: 13, height: 13 }} />{t("prov.accountAdd")}</>}
                      </button>
                    ) : addingKeyFor === name ? (
                      <div className="prov-account-row prov-account-keyform">
                        <input
                          className="input input-sm mono"
                          type="password"
                          autoFocus
                          placeholder={t("prov.keyPlaceholder")}
                          value={newKeyValue}
                          onChange={e => setNewKeyValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === "Enter") addApiKey(name);
                            if (e.key === "Escape") { setAddingKeyFor(null); setNewKeyValue(""); }
                          }}
                        />
                        <button className="btn btn-primary btn-sm" onClick={() => addApiKey(name)} disabled={!newKeyValue.trim()}>{t("common.save")}</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => { setAddingKeyFor(null); setNewKeyValue(""); }}>{t("common.cancel")}</button>
                      </div>
                    ) : (
                      <button className="prov-account-row prov-account-add" onClick={() => { setAddingKeyFor(name); setNewKeyValue(""); }}>
                        <IconPlus style={{ width: 13, height: 13 }} />{t("prov.keyAdd")}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}
