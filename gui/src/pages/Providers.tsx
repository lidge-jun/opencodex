import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import AddProviderModal from "../components/AddProviderModal";
import { Notice } from "../ui";
import { IconPlus, IconTrash, IconLock, IconExternal, IconPower, IconChevron, IconLink } from "../icons";
import { useT } from "../i18n/shared";
import type { TFn } from "../i18n/shared";
import type { AccountQuota } from "../codex-quota-utils";
import QuotaBars from "../components/QuotaBars";
import { providerIconSrc } from "../provider-icons";

interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, { adapter: string; baseUrl: string; hasApiKey?: boolean; hasHeaders?: boolean; defaultModel?: string; authMode?: string; keyOptional?: boolean; disabled?: boolean; note?: string }>;
}

interface OAuthStatus { loggedIn: boolean; email?: string; error?: string; done?: boolean }
interface ProviderQuotaReport { provider: string; quota: AccountQuota; source: string; updatedAt: number }
interface OAuthAccount { id: string; email?: string; active: boolean; needsReauth?: boolean; expiresAt?: number }
interface ApiKeyEntry { id: string; label?: string; masked: string; active: boolean }

const OAUTH_LABELS: Record<string, string> = {
  xai: "xAI (Grok)",
  anthropic: "Anthropic (Claude)",
  kimi: "Kimi (Moonshot)",
};
const oauthLabel = (id: string) => OAUTH_LABELS[id] ?? id;

interface StatusState { msg: string; ok: boolean }
type StatusAction = { type: "set"; msg: string; ok: boolean } | { type: "clear" };
function statusReducer(state: StatusState, action: StatusAction): StatusState {
  switch (action.type) {
    case "set": return { msg: action.msg, ok: action.ok };
    case "clear": return { msg: "", ok: false };
    default:
      return state;
  }
}

interface LoginFlowState {
  busy: string | null;
  loginInfo: { provider: string; url?: string; instructions?: string } | null;
  linkCopied: boolean;
  manualCode: string;
  manualCodeBusy: boolean;
  manualCodeMsg: string;
}

const initialLoginFlow: LoginFlowState = {
  busy: null,
  loginInfo: null,
  linkCopied: false,
  manualCode: "",
  manualCodeBusy: false,
  manualCodeMsg: "",
};

type LoginFlowAction =
  | { type: "begin"; provider: string }
  | { type: "setInfo"; info: LoginFlowState["loginInfo"] }
  | { type: "setLinkCopied"; value: boolean }
  | { type: "setManualCode"; value: string }
  | { type: "setManualCodeBusy"; value: boolean }
  | { type: "setManualCodeMsg"; value: string }
  | { type: "finish" }
  | { type: "clearInfo" };

function loginFlowReducer(state: LoginFlowState, action: LoginFlowAction): LoginFlowState {
  switch (action.type) {
    case "begin":
      return { ...initialLoginFlow, busy: action.provider };
    case "setInfo":
      return { ...state, loginInfo: action.info };
    case "setLinkCopied":
      return { ...state, linkCopied: action.value };
    case "setManualCode":
      return { ...state, manualCode: action.value };
    case "setManualCodeBusy":
      return { ...state, manualCodeBusy: action.value };
    case "setManualCodeMsg":
      return { ...state, manualCodeMsg: action.value };
    case "finish":
      return { ...initialLoginFlow };
    case "clearInfo":
      return { ...state, loginInfo: null, manualCode: "", manualCodeMsg: "" };
    default:
      return state;
  }
}

function OauthLoginPanel({
  oauthProviders,
  keyProviders,
  oauthStatus,
  loginFlow,
  config,
  onLogin,
  onLogout,
  onCopyLink,
  onManualCodeChange,
  onSubmitManualCode,
  t,
}: {
  oauthProviders: string[];
  keyProviders: string[];
  oauthStatus: Record<string, OAuthStatus>;
  loginFlow: LoginFlowState;
  config: Config;
  onLogin: (provider: string) => void;
  onLogout: (provider: string) => void;
  onCopyLink: () => void;
  onManualCodeChange: (value: string) => void;
  onSubmitManualCode: (provider: string) => void;
  t: TFn;
}) {
  return (
    <div className="panel panel-accent" style={{ marginBottom: 18 }}>
      <div className="row" style={{ marginBottom: 14 }}>
        <IconLock style={{ width: 16, height: 16, color: "var(--accent)" }} />
        <span className="font-semibold">{t("prov.accountLogin")}</span>
      </div>
      <div className="oauth-grid">
        {oauthProviders.length === 0 && keyProviders.length === 0 && (
          <span className="muted text-control" style={{ gridColumn: "1 / -1" }}>{t("prov.noOauth")}</span>
        )}
        {oauthProviders.map(p => {
          const st = oauthStatus[p] ?? { loggedIn: false };
          const isBusy = loginFlow.busy === p;
          const icon = providerIconSrc(p);
          return (
            <div key={p} className="oauth-row">
              <span className="oauth-name" title={oauthLabel(p)}>
                <span className="provider-icon provider-icon-sm">{icon && <img src={icon} alt="" aria-hidden="true" />}</span>
                <span className="oauth-name-text">{p}</span>
              </span>
              <span className="oauth-status">
                <span className={`dot ${st.loggedIn ? "dot-green" : "dot-muted"}`} />
                {st.loggedIn ? (
                  <span className="oauth-email" style={{ color: "var(--green)" }}>{st.email ?? t("prov.loggedIn")}</span>
                ) : (
                  <span className="oauth-email muted">{t("prov.notLoggedIn")}</span>
                )}
              </span>
              <span className="oauth-actions">
                {st.loggedIn ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onLogout(p)}>{t("prov.logout")}</button>
                ) : (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => onLogin(p)} disabled={isBusy}>
                    {isBusy ? <><span className="spin" />{t("prov.waitingBrowser")}</> : <><IconLock />{t("prov.login")}</>}
                  </button>
                )}
              </span>
              {loginFlow.loginInfo?.provider === p && (loginFlow.loginInfo.url || loginFlow.loginInfo.instructions || isBusy) && (
                <span className="oauth-login-hint muted">
                  <span className="oauth-login-hint-links">
                    {loginFlow.loginInfo.url && <a href={loginFlow.loginInfo.url} target="_blank" rel="noreferrer" className="link-btn" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><IconExternal width={14} height={14} />{t("prov.didntOpen")}</a>}
                    <button type="button" className="link-btn" onClick={onCopyLink} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <IconLink width={14} height={14} />{loginFlow.linkCopied ? t("prov.linkCopied") : t("prov.copyLink")}
                    </button>
                    {loginFlow.loginInfo.instructions && <span>{loginFlow.loginInfo.instructions}</span>}
                  </span>
                  <span className="oauth-login-paste">
                    <input
                      className="input"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={loginFlow.manualCode}
                      onChange={e => onManualCodeChange(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void onSubmitManualCode(p); } }}
                      placeholder={t("prov.pasteRedirect")}
                      aria-label={t("prov.pasteRedirect")}
                      disabled={loginFlow.manualCodeBusy}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={loginFlow.manualCodeBusy || !loginFlow.manualCode.trim()}
                      onClick={() => void onSubmitManualCode(p)}
                    >
                      {loginFlow.manualCodeBusy ? t("prov.pasteSubmitting") : t("prov.pasteSubmit")}
                    </button>
                  </span>
                  <span className="text-caption">{loginFlow.manualCodeMsg || t("prov.pasteRedirectHint")}</span>
                </span>
              )}
            </div>
          );
        })}
        {keyProviders.map(name => {
          const provider = config.providers[name];
          const icon = providerIconSrc(name);
          const keylessFree = provider?.keyOptional === true && !provider?.hasApiKey;
          return (
            <div key={name} className="oauth-row">
              <span className="oauth-name" title={name}>
                <span className="provider-icon provider-icon-sm">{icon && <img src={icon} alt="" aria-hidden="true" />}</span>
                <span className="oauth-name-text">{name}</span>
              </span>
              <span className="oauth-status">
                <span className="dot dot-green" />
                <span className="oauth-email muted">{keylessFree ? "free tier" : t("prov.hasApiKey")}</span>
              </span>
              <span className="oauth-actions" aria-hidden="true" />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProviderCard({
  name,
  prov,
  config,
  quota,
  accountSet,
  keyPool,
  accountsOpen,
  addingKeyFor,
  newKeyValue,
  loginBusy,
  onToggleDisabled,
  onRemove,
  onToggleAccounts,
  onSwitchAccount,
  onRemoveAccount,
  onSwitchApiKey,
  onRemoveApiKey,
  onAddAccount,
  onStartAddKey,
  onCancelAddKey,
  onNewKeyChange,
  onAddApiKey,
  t,
}: {
  name: string;
  prov: Config["providers"][string];
  config: Config;
  quota: AccountQuota | null;
  accountSet?: { activeAccountId: string | null; accounts: OAuthAccount[] };
  keyPool: ApiKeyEntry[];
  accountsOpen: boolean;
  addingKeyFor: string | null;
  newKeyValue: string;
  loginBusy: boolean;
  onToggleDisabled: () => void;
  onRemove: () => void;
  onToggleAccounts: () => void;
  onSwitchAccount: (account: OAuthAccount) => void;
  onRemoveAccount: (account: OAuthAccount) => void;
  onSwitchApiKey: (entry: ApiKeyEntry) => void;
  onRemoveApiKey: (entry: ApiKeyEntry) => void;
  onAddAccount: () => void;
  onStartAddKey: () => void;
  onCancelAddKey: () => void;
  onNewKeyChange: (value: string) => void;
  onAddApiKey: () => void;
  t: TFn;
}) {
  const isDefault = name === config.defaultProvider;
  const isDisabled = prov.disabled === true;
  const icon = providerIconSrc(name);
  const showAccounts = (!!accountSet && accountSet.accounts.length > 0) || keyPool.length > 0;
  const dropdownCount = accountSet?.accounts.length ?? keyPool.length;

  return (
    <div className={`card prov-card${isDisabled ? " prov-card-disabled" : ""}`}>
      <div className="prov-card-main">
        <div className="prov-card-info">
          {icon && <span className="provider-icon"><img src={icon} alt="" aria-hidden="true" /></span>}
          <div className="prov-card-copy">
            <div className="prov-title">
              <span className="font-semibold">{name}</span>
              {isDefault && <span className="badge badge-primary">{t("prov.defaultBadge")}</span>}
              {isDisabled ? <span className="badge badge-muted">{t("prov.disabledBadge")}</span> : <span className="badge badge-green">{t("prov.activeBadge")}</span>}
              {prov.authMode === "oauth" && <span className="badge badge-accent">oauth</span>}
              {prov.authMode === "forward" && <span className="badge badge-amber">passthrough</span>}
              {prov.keyOptional && <span className="badge badge-green">{t("modal.badge.free")}</span>}
            </div>
            <div className="muted prov-meta text-control">
              <code className="chip">{prov.adapter}</code>
              <span>{prov.baseUrl}</span>
              {prov.defaultModel && <span>{prov.defaultModel}</span>}
              {prov.hasApiKey && <span>{t("prov.hasApiKey")}</span>}
              {prov.hasHeaders && <span>{t("prov.hasHeaders")}</span>}
            </div>
            {prov.note && (
              <div className="muted text-label leading-body" style={{ marginTop: 4 }}>
                {prov.note}
              </div>
            )}
          </div>
        </div>
        <div className="provider-actions">
          <button
            type="button"
            className={`btn ${isDisabled ? "btn-primary" : "btn-ghost"} btn-sm`}
            onClick={onToggleDisabled}
            disabled={isDefault}
            title={isDefault ? t("prov.defaultCannotDisable") : undefined}
            aria-label={isDisabled ? t("prov.enableAria", { name }) : t("prov.disableAria", { name })}
          >
            {isDefault ? <IconLock /> : <IconPower />}
            {isDisabled ? t("prov.enable") : t("prov.disable")}
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={onRemove} aria-label={t("sub.removeAria", { m: name })}><IconTrash />{t("common.remove")}</button>
        </div>
      </div>
      {quota && <QuotaBars quota={quota} threshold={80} t={t} className="provider-quota" />}
      {showAccounts && (
        <>
          <button
            type="button"
            className={`prov-accounts-toggle${accountsOpen ? " open" : ""}`}
            onClick={onToggleAccounts}
            aria-expanded={accountsOpen}
            aria-label={t("prov.accountsAria", { name })}
          >
            {t("prov.accounts", { n: String(dropdownCount) })}
            <span className="chev"><IconChevron /></span>
          </button>
          {accountsOpen && (
            <div className="prov-accounts-list">
              {(accountSet?.accounts ?? []).map(account => (
                <div key={account.id} className={`prov-account-row${account.active ? " active" : ""}`}>
                  <button
                    type="button"
                    className="prov-account-row"
                    style={{ flex: 1, border: "none", background: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
                    onClick={() => onSwitchAccount(account)}
                    title={account.active ? undefined : t("prov.accountSwitchTitle")}
                  >
                    <span className={`dot ${account.needsReauth ? "dot-amber" : account.active ? "dot-green" : "dot-muted"}`} />
                    <span className="prov-account-email">{account.email ?? t("prov.accountNoLabel", { id: account.id })}</span>
                    {account.needsReauth && <span className="badge badge-amber">{t("prov.accountReauth")}</span>}
                    {account.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                  </button>
                  <button
                    type="button"
                    className="prov-account-remove"
                    aria-label={t("prov.accountRemoveAria", { email: account.email ?? account.id })}
                    onClick={() => onRemoveAccount(account)}
                  >
                    <IconTrash style={{ width: 13, height: 13 }} />
                  </button>
                </div>
              ))}
              {keyPool.map(entry => (
                <div key={entry.id} className={`prov-account-row${entry.active ? " active" : ""}`}>
                  <button
                    type="button"
                    className="prov-account-row"
                    style={{ flex: 1, border: "none", background: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
                    onClick={() => onSwitchApiKey(entry)}
                    title={entry.active ? undefined : t("prov.keySwitchTitle")}
                  >
                    <span className={`dot ${entry.active ? "dot-green" : "dot-muted"}`} />
                    <span className="prov-account-email mono">{entry.label ? `${entry.label} · ${entry.masked}` : entry.masked}</span>
                    {entry.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                  </button>
                  <button
                    type="button"
                    className="prov-account-remove"
                    aria-label={t("prov.keyRemoveAria", { key: entry.label ?? entry.masked })}
                    onClick={() => onRemoveApiKey(entry)}
                  >
                    <IconTrash style={{ width: 13, height: 13 }} />
                  </button>
                </div>
              ))}
              {accountSet ? (
                <button type="button" className="prov-account-row prov-account-add" onClick={onAddAccount} disabled={loginBusy}>
                  {loginBusy ? <><span className="spin" />{t("prov.waitingBrowser")}</> : <><IconPlus style={{ width: 13, height: 13 }} />{t("prov.accountAdd")}</>}
                </button>
              ) : addingKeyFor === name ? (
                <div className="prov-account-row prov-account-keyform">
                  <input
                    className="input input-sm mono"
                    type="password"
                    autoFocus
                    placeholder={t("prov.keyPlaceholder")}
                    value={newKeyValue}
                    onChange={e => onNewKeyChange(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") onAddApiKey();
                      if (e.key === "Escape") onCancelAddKey();
                    }}
                  />
                  <button type="button" className="btn btn-primary btn-sm" onClick={onAddApiKey} disabled={!newKeyValue.trim()}>{t("common.save")}</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={onCancelAddKey}>{t("common.cancel")}</button>
                </div>
              ) : (
                <button type="button" className="prov-account-row prov-account-add" onClick={onStartAddKey}>
                  <IconPlus style={{ width: 13, height: 13 }} />{t("prov.keyAdd")}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Providers({ apiBase }: { apiBase: string }) {
  const page = useProvidersPage(apiBase);
  if (!page.config) return <div className="muted">{page.t("prov.loadingConfig")}</div>;
  const { config, ...rest } = page;
  return <ProvidersPageContent config={config} {...rest} />;
}

function useProvidersPage(apiBase: string) {
  const t = useT();
  const [config, setConfig] = useState<Config | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, dispatchStatus] = useReducer(statusReducer, { msg: "", ok: false });
  const [loginFlow, dispatchLogin] = useReducer(loginFlowReducer, initialLoginFlow);
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
  const [quotaReports, setQuotaReports] = useState<Record<string, ProviderQuotaReport>>({});
  const [accountSets, setAccountSets] = useState<Record<string, { activeAccountId: string | null; accounts: OAuthAccount[] }>>({});
  const [openAccounts, setOpenAccounts] = useState<Record<string, boolean>>({});
  const [keyPools, setKeyPools] = useState<Record<string, ApiKeyEntry[]>>({});
  const [addingKeyFor, setAddingKeyFor] = useState<string | null>(null);
  const [newKeyValue, setNewKeyValue] = useState("");
  const aliveRef = useRef(true);

  const notify = (msg: string, ok: boolean) => { dispatchStatus({ type: "set", msg, ok }); };

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/config`);
      const data = await res.json();
      setConfig(data);
      setDraft(JSON.stringify(data, null, 2));
    } catch {
      notify(t("prov.loadConfigFail"), false);
    }
  }, [apiBase, t]);

  const fetchOauth = useCallback(async () => {
    try {
      const provs: string[] = (await fetch(`${apiBase}/api/oauth/providers`).then(r => r.json())).providers ?? [];
      setOauthProviders(provs);
      const entries = await Promise.all(provs.map(async p => {
        const s = await fetch(`${apiBase}/api/oauth/status?provider=${p}`).then(r => r.json()).catch(() => ({ loggedIn: false }));
        return [p, s] as const;
      }));
      setOauthStatus(Object.fromEntries(entries));
    } catch { /* ignore */ }
  }, [apiBase]);

  const fetchProviderQuotas = useCallback(async (refresh = false) => {
    try {
      const data = await fetch(`${apiBase}/api/provider-quotas${refresh ? "?refresh=1" : ""}`).then(r => r.json()) as { reports?: ProviderQuotaReport[] };
      setQuotaReports(Object.fromEntries((data.reports ?? []).map(report => [report.provider, report])));
    } catch {
      setQuotaReports({});
    }
  }, [apiBase]);

  const fetchAccountSets = useCallback(async (providers: string[]) => {
    const entries = await Promise.all(providers.map(async p => {
      const data = await fetch(`${apiBase}/api/oauth/accounts?provider=${p}`).then(r => r.json()).catch(() => null) as { activeAccountId?: string | null; accounts?: OAuthAccount[] } | null;
      return [p, { activeAccountId: data?.activeAccountId ?? null, accounts: data?.accounts ?? [] }] as const;
    }));
    setAccountSets(Object.fromEntries(entries));
  }, [apiBase]);

  const switchAccount = async (provider: string, account: OAuthAccount) => {
    if (account.active) return;
    const res = await fetch(`${apiBase}/api/oauth/accounts/active`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, accountId: account.id }),
    });
    if (res.ok) {
      notify(t("prov.accountSwitched", { email: account.email ?? account.id }), true);
      fetchAccountSets(Object.keys(accountSets));
      fetchOauth();
      fetchProviderQuotas(true);
    } else {
      const data = await res.json().catch(() => ({}));
      notify(data.error || t("prov.accountSwitchFail"), false);
    }
  };

  const fetchKeyPools = useCallback(async (providers: string[]) => {
    const entries = await Promise.all(providers.map(async name => {
      const data = await fetch(`${apiBase}/api/providers/keys?name=${encodeURIComponent(name)}`).then(r => r.json()).catch(() => null) as { keys?: ApiKeyEntry[] } | null;
      return [name, data?.keys ?? []] as const;
    }));
    setKeyPools(Object.fromEntries(entries));
  }, [apiBase]);

  const switchApiKey = async (provider: string, entry: ApiKeyEntry) => {
    if (entry.active) return;
    const res = await fetch(`${apiBase}/api/providers/keys/active`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: provider, id: entry.id }),
    });
    if (res.ok) {
      notify(t("prov.keySwitched", { key: entry.label ?? entry.masked }), true);
      fetchKeyPools(Object.keys(keyPools));
      fetchProviderQuotas(true);
    } else {
      const data = await res.json().catch(() => ({}));
      notify(data.error || t("prov.keySwitchFail"), false);
    }
  };

  const removeApiKey = async (provider: string, entry: ApiKeyEntry) => {
    if (!window.confirm(t("prov.keyRemoveConfirm", { key: entry.label ?? entry.masked }))) return;
    const res = await fetch(`${apiBase}/api/providers/keys?name=${encodeURIComponent(provider)}&id=${encodeURIComponent(entry.id)}`, { method: "DELETE" });
    if (res.ok) {
      notify(t("prov.keyRemoved", { key: entry.label ?? entry.masked }), true);
      fetchKeyPools(Object.keys(keyPools));
      fetchConfig();
      fetchProviderQuotas(true);
    }
  };

  const addApiKey = async (provider: string) => {
    const key = newKeyValue.trim();
    if (!key) return;
    const res = await fetch(`${apiBase}/api/providers/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: provider, key }),
    });
    if (res.ok) {
      notify(t("prov.keyAdded", { name: provider }), true);
      setNewKeyValue("");
      setAddingKeyFor(null);
      const poolKeys = new Set(Object.keys(keyPools));
      poolKeys.add(provider);
      fetchKeyPools([...poolKeys]);
      fetchConfig();
      fetchProviderQuotas(true);
    } else {
      const data = await res.json().catch(() => ({}));
      notify(data.error || t("prov.keyAddFail"), false);
    }
  };

  const removeAccount = async (provider: string, account: OAuthAccount) => {
    if (!window.confirm(t("prov.accountRemoveConfirm", { email: account.email ?? account.id }))) return;
    const res = await fetch(`${apiBase}/api/oauth/accounts?provider=${provider}&id=${encodeURIComponent(account.id)}`, { method: "DELETE" });
    if (res.ok) {
      notify(t("prov.accountRemoved", { email: account.email ?? account.id }), true);
      fetchAccountSets(Object.keys(accountSets));
      fetchOauth();
      fetchProviderQuotas(true);
    }
  };

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void fetchConfig();
      void fetchOauth();
      void fetchProviderQuotas();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [fetchConfig, fetchOauth, fetchProviderQuotas]);

  const oauthCardProviders = useMemo(() => {
    if (!config) return [];
    const names: string[] = [];
    for (const [n, p] of Object.entries(config.providers)) {
      if (p.authMode === "oauth") names.push(n);
    }
    return names;
  }, [config]);

  useEffect(() => {
    if (oauthCardProviders.length === 0) return;
    const timeout = window.setTimeout(() => {
      void fetchAccountSets(oauthCardProviders);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [fetchAccountSets, oauthCardProviders]);

  const keyCardProviders = useMemo(() => {
    if (!config) return [];
    const names: string[] = [];
    for (const [n, p] of Object.entries(config.providers)) {
      if (p.hasApiKey && p.authMode !== "oauth" && p.authMode !== "forward") names.push(n);
    }
    return names;
  }, [config]);

  useEffect(() => {
    if (keyCardProviders.length === 0) return;
    const timeout = window.setTimeout(() => {
      void fetchKeyPools(keyCardProviders);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [fetchKeyPools, keyCardProviders]);

  const oauthProviderSet = useMemo(() => new Set(oauthProviders), [oauthProviders]);

  const keyProviders = useMemo(() => {
    if (!config) return [];
    const names: string[] = [];
    for (const [name, prov] of Object.entries(config.providers)) {
      if (prov.hasApiKey && prov.authMode !== "oauth" && prov.authMode !== "forward" && !oauthProviderSet.has(name)) {
        names.push(name);
      }
    }
    return names;
  }, [config, oauthProviderSet]);

  const saveConfig = async () => {
    try {
      const parsed = JSON.parse(draft);
      const res = await fetch(`${apiBase}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (res.ok) {
        notify(t("prov.saved"), true);
        setEditing(false);
        fetchConfig();
        fetchProviderQuotas(true);
      } else {
        notify(t("prov.saveFailed"), false);
      }
    } catch {
      notify(t("prov.invalidJson"), false);
    }
  };

  const loginOAuth = async (provider: string, addAccount = false) => {
    dispatchLogin({ type: "begin", provider });
    dispatchStatus({ type: "clear" });
    try {
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addAccount ? { provider, addAccount: true } : { provider }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error || t("prov.loginFailStart", { provider: oauthLabel(provider) }), false); return; }
      if (data.url || data.instructions) dispatchLogin({ type: "setInfo", info: { provider, url: data.url, instructions: data.instructions } });
      const baselineCount = accountSets[provider]?.accounts.length ?? 0;
      for (let i = 0; i < 150 && aliveRef.current; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const s: (OAuthStatus & { accounts?: OAuthAccount[] }) | null = await fetch(`${apiBase}/api/oauth/status?provider=${provider}`).then(r => r.json()).catch(() => null);
        if (!s) continue;
        const completed = addAccount
          ? ((s.accounts?.length ?? 0) > baselineCount || (s.done === true && !s.error))
          : s.loggedIn;
        if (completed) {
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          notify(t("prov.loginOk", { provider: oauthLabel(provider), cmd: "ocx sync" }), true);
          dispatchLogin({ type: "clearInfo" });
          fetchConfig();
          const accountKeys = new Set(Object.keys(accountSets));
          accountKeys.add(provider);
          fetchAccountSets([...accountKeys]);
          fetchProviderQuotas(true);
          break;
        }
        if (s.error) {
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          notify(t("prov.loginError", { provider: oauthLabel(provider), error: s.error }), false);
          dispatchLogin({ type: "clearInfo" });
          break;
        }
      }
    } catch {
      notify(t("prov.loginRequestFail", { provider: oauthLabel(provider) }), false);
    } finally {
      if (aliveRef.current) dispatchLogin({ type: "finish" });
    }
  };

  const submitManualCode = async (provider: string) => {
    const input = loginFlow.manualCode.trim();
    if (!input || loginFlow.manualCodeBusy) return;
    dispatchLogin({ type: "setManualCodeBusy", value: true });
    dispatchLogin({ type: "setManualCodeMsg", value: "" });
    try {
      const res = await fetch(`${apiBase}/api/oauth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, input }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        dispatchLogin({ type: "setManualCodeMsg", value: t("prov.pasteFail", { error: data.error || res.statusText }) });
        return;
      }
      dispatchLogin({ type: "setManualCode", value: "" });
      dispatchLogin({ type: "setManualCodeMsg", value: t("prov.pasteOk") });
    } catch {
      dispatchLogin({ type: "setManualCodeMsg", value: t("prov.pasteFail", { error: "network error" }) });
    } finally {
      if (aliveRef.current) dispatchLogin({ type: "setManualCodeBusy", value: false });
    }
  };

  const logoutOAuth = async (provider: string) => {
    await fetch(`${apiBase}/api/oauth/logout?provider=${provider}`, { method: "POST" }).catch(() => {});
    setOauthStatus(prev => ({ ...prev, [provider]: { loggedIn: false } }));
    notify(t("prov.logoutOk", { provider: oauthLabel(provider) }), true);
    fetchConfig();
    fetchProviderQuotas(true);
  };

  const removeProvider = async (name: string) => {
    if (!window.confirm(t("prov.removeConfirm", { name }))) return;
    const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    if (res.ok) { notify(t("prov.removed", { name }), true); fetchConfig(); fetchOauth(); fetchProviderQuotas(true); }
    else notify(t("prov.removeFail", { name }), false);
  };

  const setProviderDisabled = async (name: string, disabled: boolean) => {
    const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
    if (res.ok) {
      notify(disabled ? t("prov.disabled", { name }) : t("prov.enabled", { name }), true);
      fetchConfig();
      fetchOauth();
      fetchProviderQuotas(true);
      return;
    }
    const data = await res.json().catch(() => ({}));
    notify(data.error || (disabled ? t("prov.disableFail", { name }) : t("prov.enableFail", { name })), false);
  };

  const copyLoginLink = () => {
    if (loginFlow.loginInfo?.url) {
      navigator.clipboard.writeText(loginFlow.loginInfo.url).then(() => {
        dispatchLogin({ type: "setLinkCopied", value: true });
        setTimeout(() => dispatchLogin({ type: "setLinkCopied", value: false }), 2500);
      }).catch(() => {});
    }
  };

  return {
    t,
    config,
    editing,
    setEditing,
    adding,
    setAdding,
    draft,
    setDraft,
    status,
    loginFlow,
    oauthProviders,
    oauthStatus,
    quotaReports,
    accountSets,
    openAccounts,
    setOpenAccounts,
    keyPools,
    addingKeyFor,
    newKeyValue,
    keyProviders,
    saveConfig,
    loginOAuth,
    logoutOAuth,
    removeProvider,
    setProviderDisabled,
    copyLoginLink,
    dispatchLogin,
    submitManualCode,
    switchAccount,
    switchApiKey,
    removeApiKey,
    addApiKey,
    removeAccount,
    notify,
    setNewKeyValue,
    setAddingKeyFor,
    fetchConfig,
    fetchOauth,
    fetchProviderQuotas,
    apiBase,
  };
}

function ProvidersPageContent({
  t,
  config,
  editing,
  setEditing,
  adding,
  setAdding,
  draft,
  setDraft,
  status,
  loginFlow,
  oauthProviders,
  oauthStatus,
  quotaReports,
  accountSets,
  openAccounts,
  setOpenAccounts,
  keyPools,
  addingKeyFor,
  newKeyValue,
  keyProviders,
  saveConfig,
  loginOAuth,
  logoutOAuth,
  removeProvider,
  setProviderDisabled,
  copyLoginLink,
  dispatchLogin,
  submitManualCode,
  switchAccount,
  switchApiKey,
  removeApiKey,
  addApiKey,
  removeAccount,
  notify,
  setNewKeyValue,
  setAddingKeyFor,
  fetchConfig,
  fetchOauth,
  fetchProviderQuotas,
  apiBase,
}: Omit<ReturnType<typeof useProvidersPage>, "config"> & { config: Config }) {
  return (
    <>
      <div className="page-head">
        <h2>{t("nav.providers")}</h2>
        <div className="row">
          {editing ? (
            <>
              <button type="button" className="btn btn-primary" onClick={saveConfig}>{t("common.save")}</button>
              <button type="button" className="btn btn-ghost" onClick={() => { setEditing(false); setDraft(JSON.stringify(config, null, 2)); }}>{t("common.cancel")}</button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}><IconPlus />{t("prov.add")}</button>
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)}>{t("prov.editJson")}</button>
            </>
          )}
        </div>
      </div>
      <p className="page-sub">{t("prov.subtitle")}</p>

      {status.msg && <Notice tone={status.ok ? "ok" : "err"}>{status.msg}</Notice>}

      <OauthLoginPanel
        oauthProviders={oauthProviders}
        keyProviders={keyProviders}
        oauthStatus={oauthStatus}
        loginFlow={loginFlow}
        config={config}
        onLogin={p => void loginOAuth(p)}
        onLogout={p => void logoutOAuth(p)}
        onCopyLink={copyLoginLink}
        onManualCodeChange={value => dispatchLogin({ type: "setManualCode", value })}
        onSubmitManualCode={p => void submitManualCode(p)}
        t={t}
      />

      {editing ? (
        <textarea
          className="input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          style={{ height: 400 }}
          aria-label={t("prov.editJson")}
        />
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="muted text-control" style={{ marginBottom: 4 }}>
            {t("prov.port")}: <code className="chip">{config.port}</code> · {t("prov.default")}: <code className="chip">{config.defaultProvider}</code>
          </div>
          {Object.entries(config.providers).map(([name, prov]) => (
            <ProviderCard
              key={name}
              name={name}
              prov={prov}
              config={config}
              quota={quotaReports[name]?.quota ?? null}
              accountSet={prov.authMode === "oauth" ? accountSets[name] : undefined}
              keyPool={prov.authMode !== "oauth" && prov.authMode !== "forward" && prov.hasApiKey ? (keyPools[name] ?? []) : []}
              accountsOpen={openAccounts[name] === true}
              addingKeyFor={addingKeyFor}
              newKeyValue={newKeyValue}
              loginBusy={loginFlow.busy === name}
              onToggleDisabled={() => void setProviderDisabled(name, !prov.disabled)}
              onRemove={() => void removeProvider(name)}
              onToggleAccounts={() => setOpenAccounts(prev => ({ ...prev, [name]: !prev[name] }))}
              onSwitchAccount={account => void switchAccount(name, account)}
              onRemoveAccount={account => void removeAccount(name, account)}
              onSwitchApiKey={entry => void switchApiKey(name, entry)}
              onRemoveApiKey={entry => void removeApiKey(name, entry)}
              onAddAccount={() => void loginOAuth(name, true)}
              onStartAddKey={() => { setAddingKeyFor(name); setNewKeyValue(""); }}
              onCancelAddKey={() => { setAddingKeyFor(null); setNewKeyValue(""); }}
              onNewKeyChange={setNewKeyValue}
              onAddApiKey={() => void addApiKey(name)}
              t={t}
            />
          ))}
        </div>
      )}
      {adding && (
        <AddProviderModal
          apiBase={apiBase}
          existingNames={Object.keys(config.providers)}
          onClose={() => setAdding(false)}
          onAdded={(name) => { setAdding(false); notify(t("prov.added", { name, cmd: "ocx sync" }), true); fetchConfig(); fetchOauth(); fetchProviderQuotas(true); }}
        />
      )}
    </>
  );
}
