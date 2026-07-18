import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AddProviderModal from "../components/AddProviderModal";
import ProviderWorkspaceShell, { type AddProviderIntent } from "../components/provider-workspace/ProviderWorkspaceShell";
import ProviderDetails from "../components/provider-workspace/ProviderDetails";
import type { WorkspaceProvider } from "../provider-workspace/catalog";
import type { ProviderUpdatePatch } from "../components/provider-workspace/types";
import type { AccountLoadState } from "../components/provider-workspace/types";
import { oauthAccountDisplayLabel } from "../provider-workspace/auth";
import { Notice } from "../ui";
import { IconPlus, IconTrash, IconLock, IconExternal, IconPower, IconChevron, IconLink } from "../icons";
import { useT } from "../i18n";
import type { AccountQuota } from "../codex-quota-utils";
import QuotaBars from "../components/QuotaBars";
import { providerIconSrc } from "../provider-icons";

interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, { adapter: string; baseUrl: string; hasApiKey?: boolean; hasHeaders?: boolean; defaultModel?: string; authMode?: string; keyOptional?: boolean; disabled?: boolean; note?: string; codexAccountMode?: "direct" | "pool" }>;
}

interface OAuthStatus { loggedIn: boolean; email?: string; error?: string; done?: boolean }
interface ProviderQuotaReport { provider: string; quota: AccountQuota; source: string; updatedAt: number }
interface OAuthAccount { id: string; email?: string; active: boolean; needsReauth?: boolean; expiresAt?: number }
interface ApiKeyEntry { id: string; label?: string; masked: string; active: boolean }
type OpenAiAccountMode = "pool" | "direct";

function resolvedOpenAiAccountMode(provider: Config["providers"][string]): OpenAiAccountMode {
  return provider.codexAccountMode === "direct" ? "direct" : "pool";
}

// Friendly labels for the OAuth providers the proxy supports.
const OAUTH_LABELS: Record<string, string> = {
  xai: "xAI (Grok)",
  anthropic: "Anthropic (Claude)",
  kimi: "Kimi (Moonshot)",
};
const oauthLabel = (id: string) => OAUTH_LABELS[id] ?? id;

export default function Providers({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [config, setConfig] = useState<Config | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  const [statusOk, setStatusOk] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
  const [quotaReports, setQuotaReports] = useState<Record<string, ProviderQuotaReport>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [loginInfo, setLoginInfo] = useState<{ provider: string; url?: string; instructions?: string } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [manualCodeBusy, setManualCodeBusy] = useState(false);
  const [manualCodeMsg, setManualCodeMsg] = useState("");
  const [accountSets, setAccountSets] = useState<Record<string, { activeAccountId: string | null; accounts: OAuthAccount[] }>>({});
  const [accountLoadStates, setAccountLoadStates] = useState<Record<string, AccountLoadState>>({});
  const [switchingAccount, setSwitchingAccount] = useState<{ provider: string; accountId: string } | null>(null);
  const [openAccounts, setOpenAccounts] = useState<Record<string, boolean>>({});
  const [keyPools, setKeyPools] = useState<Record<string, ApiKeyEntry[]>>({});
  const [addingKeyFor, setAddingKeyFor] = useState<string | null>(null);
  const [newKeyValue, setNewKeyValue] = useState("");
  // Workspace view (WP080b): active when the hash carries the /workspace suffix.
  const [workspaceView, setWorkspaceView] = useState(() => location.hash.replace(/^#\/?/, "") === "providers/workspace");
  const [workspaceSelected, setWorkspaceSelected] = useState<string | null>(null);
  const [addIntent, setAddIntent] = useState<AddProviderIntent | null>(null);
  const aliveRef = useRef(true);
  const accountRequestGenerationRef = useRef<Record<string, number>>({});

  const notify = (msg: string, ok: boolean) => { setStatus(msg); setStatusOk(ok); };

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  useEffect(() => {
    const onHash = () => setWorkspaceView(location.hash.replace(/^#\/?/, "") === "providers/workspace");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const toggleWorkspace = () => {
    // The hash is the source of truth so reload/deep-link restores the view.
    location.hash = workspaceView ? "#providers" : "#providers/workspace";
  };

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

  // Load the list of OAuth-capable providers, then each one's login status.
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

  // Multiauth: per-provider logged-in account lists for the card dropdowns (oauth cards only;
  // the Codex/ChatGPT passthrough pool has its own page).
  const fetchAccountSets = useCallback(async (providers: string[]) => {
    const uniqueProviders = [...new Set(providers)];
    setAccountLoadStates(current => {
      const next = { ...current };
      for (const provider of uniqueProviders) next[provider] = "loading";
      return next;
    });
    await Promise.all(uniqueProviders.map(async provider => {
      const generation = (accountRequestGenerationRef.current[provider] ?? 0) + 1;
      accountRequestGenerationRef.current[provider] = generation;
      try {
        const res = await fetch(`${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json() as { activeAccountId?: string | null; accounts?: OAuthAccount[] };
        if (!aliveRef.current || accountRequestGenerationRef.current[provider] !== generation) return;
        setAccountSets(current => ({
          ...current,
          [provider]: { activeAccountId: data.activeAccountId ?? null, accounts: data.accounts ?? [] },
        }));
        setAccountLoadStates(current => ({ ...current, [provider]: "ready" }));
      } catch {
        if (!aliveRef.current || accountRequestGenerationRef.current[provider] !== generation) return;
        setAccountLoadStates(current => ({ ...current, [provider]: "error" }));
      }
    }));
  }, [apiBase]);

  const switchAccount = async (provider: string, account: OAuthAccount) => {
    if (account.active || account.needsReauth || switchingAccount) return;
    setSwitchingAccount({ provider, accountId: account.id });
    const label = oauthAccountDisplayLabel(accountSets[provider]?.accounts ?? [account], account, t);
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, accountId: account.id }),
      });
      if (!res.ok) {
        notify(t("prov.accountSwitchFail"), false);
        return;
      }
      await fetchAccountSets([provider]);
      await Promise.all([fetchOauth(), fetchProviderQuotas(true)]);
      notify(t("prov.accountSwitched", { email: label }), true);
    } catch {
      notify(t("prov.accountSwitchFail"), false);
    } finally {
      if (aliveRef.current) setSwitchingAccount(current => current?.provider === provider && current.accountId === account.id ? null : current);
    }
  };

  // Multi-key pool (API-key twin of OAuth multiauth): list masked keys per key-auth provider.
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

  const addApiKeyValue = async (provider: string, rawKey: string): Promise<boolean> => {
    const key = rawKey.trim();
    if (!key) return false;
    try {
      const res = await fetch(`${apiBase}/api/providers/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: provider, key }),
      });
      if (res.ok) {
        notify(t("prov.keyAdded", { name: provider }), true);
        setAddingKeyFor(null);
        await Promise.all([
          fetchKeyPools(Object.keys(keyPools).includes(provider) ? Object.keys(keyPools) : [...Object.keys(keyPools), provider]),
          fetchConfig(),
          fetchProviderQuotas(true),
        ]);
        return true;
      }
      const data = await res.json().catch(() => ({})) as { error?: string };
      notify(data.error || t("prov.keyAddFail"), false);
      return false;
    } catch {
      notify(t("prov.keyAddFail"), false);
      return false;
    }
  };

  const addApiKey = async (provider: string) => {
    const ok = await addApiKeyValue(provider, newKeyValue);
    if (ok) setNewKeyValue("");
  };

  const removeAccount = async (provider: string, account: OAuthAccount) => {
    const label = oauthAccountDisplayLabel(accountSets[provider]?.accounts ?? [account], account, t);
    if (!window.confirm(t("prov.accountRemoveConfirm", { email: label }))) return;
    const res = await fetch(`${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(account.id)}`, { method: "DELETE" });
    if (res.ok) {
      notify(t("prov.accountRemoved", { email: label }), true);
      await fetchAccountSets([provider]);
      await Promise.all([fetchOauth(), fetchProviderQuotas(true)]);
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

  // Load account sets once config tells us which providers are oauth-backed.
  const oauthCardProviders = useMemo(
    () => config ? Object.entries(config.providers).filter(([, p]) => p.authMode === "oauth").map(([n]) => n) : [],
    [config],
  );
  useEffect(() => {
    if (oauthCardProviders.length === 0) return;
    const timeout = window.setTimeout(() => {
      void fetchAccountSets(oauthCardProviders);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [fetchAccountSets, oauthCardProviders]);

  // Load key pools for key-auth providers that already have a key configured.
  const keyCardProviders = useMemo(
    () => config
      ? Object.entries(config.providers)
          .filter(([, p]) => p.hasApiKey && p.authMode !== "oauth" && p.authMode !== "forward")
          .map(([n]) => n)
      : [],
    [config],
  );
  useEffect(() => {
    if (keyCardProviders.length === 0) return;
    const timeout = window.setTimeout(() => {
      void fetchKeyPools(keyCardProviders);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [fetchKeyPools, keyCardProviders]);

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
    setBusy(provider);
    setStatus("");
    setLoginInfo(null);
    setManualCode("");
    setManualCodeMsg("");
    try {
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addAccount ? { provider, addAccount: true } : { provider }),
      });
      const data = await res.json();
      if (!res.ok) { notify(data.error || t("prov.loginFailStart", { provider: oauthLabel(provider) }), false); return; }
      // The server opens the browser itself (popup-safe). Show the URL + paste fallback.
      if (data.url || data.instructions) setLoginInfo({ provider, url: data.url, instructions: data.instructions });
      const baselineCount = accountSets[provider]?.accounts.length ?? 0;
      // Poll until the loopback callback (or device flow / manual paste) completes.
      for (let i = 0; i < 150 && aliveRef.current; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const s: (OAuthStatus & { accounts?: OAuthAccount[] }) | null = await fetch(`${apiBase}/api/oauth/status?provider=${provider}`).then(r => r.json()).catch(() => null);
        if (!s) continue;
        // For add-account flows the provider is already "logged in": wait for the account count to grow.
        // addAccount: wait for a new slot OR flow completion (same-account re-login won't grow count).
        const completed = addAccount
          ? ((s.accounts?.length ?? 0) > baselineCount || (s.done === true && !s.error))
          : s.loggedIn;
        if (completed) {
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          notify(t("prov.loginOk", { provider: oauthLabel(provider), cmd: "ocx sync" }), true);
          setLoginInfo(null);
          setManualCode("");
          setManualCodeMsg("");
          fetchConfig();
          fetchAccountSets(Object.keys(accountSets).includes(provider) ? Object.keys(accountSets) : [...Object.keys(accountSets), provider]);
          fetchProviderQuotas(true);
          break;
        }
        if (s.error) {
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          notify(t("prov.loginError", { provider: oauthLabel(provider), error: s.error }), false);
          setLoginInfo(null);
          break;
        }
      }
    } catch {
      notify(t("prov.loginRequestFail", { provider: oauthLabel(provider) }), false);
    } finally {
      if (aliveRef.current) setBusy(null);
    }
  };

  /** Paste redirect URL / auth code when the browser cannot hit the loopback callback. */
  const submitManualCode = async (provider: string) => {
    const input = manualCode.trim();
    if (!input || manualCodeBusy) return;
    setManualCodeBusy(true);
    setManualCodeMsg("");
    try {
      const res = await fetch(`${apiBase}/api/oauth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, input }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setManualCodeMsg(t("prov.pasteFail", { error: data.error || res.statusText }));
        return;
      }
      setManualCode("");
      setManualCodeMsg(t("prov.pasteOk"));
    } catch {
      setManualCodeMsg(t("prov.pasteFail", { error: "network error" }));
    } finally {
      if (aliveRef.current) setManualCodeBusy(false);
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

  const updateProvider = async (name: string, patch: ProviderUpdatePatch): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        fetchConfig();
        return { ok: true };
      }
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || "Update failed" };
    } catch {
      return { ok: false, error: "Network error" };
    }
  };

  const setOpenAiAccountMode = async (next: OpenAiAccountMode) => {
    if (modeBusy) return;
    setModeBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/providers?name=openai`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAccountMode: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        notify(data.error || t("prov.openaiModeSaveFailed"), false);
        return;
      }
      setConfig(current => current ? {
        ...current,
        providers: {
          ...current.providers,
          openai: { ...current.providers.openai, codexAccountMode: next },
        },
      } : current);
      notify(t("prov.openaiModeSaved", { mode: t(next === "pool" ? "prov.openaiModePool" : "prov.openaiModeDirect") }), true);
      if (next === "pool") void fetchProviderQuotas(true);
    } catch {
      notify(t("prov.openaiModeSaveFailed"), false);
    } finally {
      if (aliveRef.current) setModeBusy(false);
    }
  };

  if (!config) {
    return (
      <>
        <div className="page-head">
          <h2>{t("nav.providers")}</h2>
        </div>
        {status
          ? <Notice tone="err">{status}</Notice>
          : <div className="muted">{t("prov.loadingConfig")}</div>}
      </>
    );
  }

  // API-key providers shown alongside OAuth logins in the account panel.
  const keyProviders = Object.entries(config.providers)
    .filter(([name, prov]) => (prov.hasApiKey || name === "openai-apikey") && prov.authMode !== "oauth" && prov.authMode !== "forward" && !oauthProviders.includes(name))
    .map(([name]) => name);

  if (workspaceView) {
    return (
      <>
        <div className="page-head">
          <h2>{t("nav.providers")}</h2>
          <div className="row">
            <button className="btn btn-ghost btn-sm" onClick={toggleWorkspace}>{t("pws.classicToggle")}</button>
            <button className="btn btn-primary" onClick={() => setAdding(true)}><IconPlus />{t("prov.add")}</button>
          </div>
        </div>
        {status && <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>}
        <ProviderWorkspaceShell
          providers={config.providers as Record<string, WorkspaceProvider>}
          apiBase={apiBase}
          defaultProvider={config.defaultProvider}
          selectedName={workspaceSelected}
          onSelect={setWorkspaceSelected}
          onAddProvider={intent => { setAddIntent(intent ?? null); setAdding(true); }}
          detail={(item, data) => (
            <ProviderDetails
              key={item.name}
              item={item}
              usageTotals={data.usageTotals}
              quotaReport={data.quotaReport}
              availableModels={data.availableModels}
              selectedModels={data.selectedModels}
              modelsLoading={data.modelsLoading}
              modelsLoadFailed={data.modelsLoadFailed}
              oauthEmail={oauthStatus[item.name]?.email}
              onDeselect={() => setWorkspaceSelected(null)}
              apiBase={apiBase}
              oauth={oauthStatus[item.name]}
              accounts={accountSets[item.name]?.accounts ?? []}
              keys={keyPools[item.name] ?? []}
              accountLoadState={accountLoadStates[item.name] ?? (item.authMode === "oauth" ? "idle" : "ready")}
              switchingAccountId={switchingAccount?.provider === item.name ? switchingAccount.accountId : null}
              busyProvider={busy}
              loginHint={loginInfo}
              authHandlers={{
                onLogin: loginOAuth,
                onLogout: logoutOAuth,
                onSwitchAccount: switchAccount,
                onRemoveAccount: removeAccount,
                onRetryAccounts: provider => fetchAccountSets([provider]),
                onAddApiKey: addApiKeyValue,
                onSwitchApiKey: switchApiKey,
                onRemoveApiKey: removeApiKey,
              }}
              isDefault={item.name === config.defaultProvider}
              onRemoveProvider={removeProvider}
              onSetDisabled={setProviderDisabled}
              onUpdateProvider={updateProvider}
            />
          )}
        />
        {adding && (
          <AddProviderModal
            apiBase={apiBase}
            existingNames={Object.keys(config.providers)}
            initialTier={addIntent?.tier}
            initialCustom={addIntent?.custom}
            onClose={() => { setAdding(false); setAddIntent(null); }}
            onAdded={(name) => { setAdding(false); setAddIntent(null); notify(t("prov.added", { name, cmd: "ocx sync" }), true); fetchConfig(); fetchOauth(); fetchProviderQuotas(true); }}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h2>{t("nav.providers")}</h2>
        <div className="row">
          <button className="btn btn-ghost btn-sm" onClick={toggleWorkspace}>
            {workspaceView ? t("pws.classicToggle") : t("pws.workspaceToggle")}
          </button>
          {editing ? (
            <>
              <button className="btn btn-primary" onClick={saveConfig}>{t("common.save")}</button>
              <button className="btn btn-ghost" onClick={() => { setEditing(false); setDraft(JSON.stringify(config, null, 2)); }}>{t("common.cancel")}</button>
            </>
          ) : (
            <>
              <button className="btn btn-primary" onClick={() => setAdding(true)}><IconPlus />{t("prov.add")}</button>
              <button className="btn btn-ghost" onClick={() => setEditing(true)}>{t("prov.editJson")}</button>
            </>
          )}
        </div>
      </div>
      <p className="page-sub">{t("prov.subtitle")}</p>

      {status && <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>}

      {/* OAuth Login — every OAuth-capable provider, with its live login status. */}
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
            const isBusy = busy === p;
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
                    <button className="btn btn-ghost btn-sm" onClick={() => logoutOAuth(p)}>{t("prov.logout")}</button>
                  ) : (
                    <button className="btn btn-primary btn-sm" onClick={() => loginOAuth(p)} disabled={isBusy}>
                      {isBusy ? <><span className="spin" />{t("prov.waitingBrowser")}</> : <><IconLock />{t("prov.login")}</>}
                    </button>
                  )}
                </span>
                {loginInfo?.provider === p && (loginInfo.url || loginInfo.instructions || isBusy) && (
                  <span className="oauth-login-hint muted">
                    <span className="oauth-login-hint-links">
                      {loginInfo.url && <a href={loginInfo.url} target="_blank" rel="noreferrer" className="link-btn" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><IconExternal width={14} height={14} />{t("prov.didntOpen")}</a>}
                      <button className="link-btn" onClick={() => {
                        if (loginInfo?.url) {
                          navigator.clipboard.writeText(loginInfo.url).then(() => {
                            setLinkCopied(true);
                            setTimeout(() => setLinkCopied(false), 2500);
                          }).catch(() => {});
                        }
                      }} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <IconLink width={14} height={14} />{linkCopied ? t("prov.linkCopied") : t("prov.copyLink")}
                      </button>
                      {loginInfo.instructions && <span>{loginInfo.instructions}</span>}
                    </span>
                    <span className="oauth-login-paste">
                      <input
                        className="input"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={manualCode}
                        onChange={e => setManualCode(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void submitManualCode(p); } }}
                        placeholder={t("prov.pasteRedirect")}
                        aria-label={t("prov.pasteRedirect")}
                        disabled={manualCodeBusy}
                      />
                      <button
                        className="btn btn-ghost btn-sm"
                        type="button"
                        disabled={manualCodeBusy || !manualCode.trim()}
                        onClick={() => void submitManualCode(p)}
                      >
                        {manualCodeBusy ? t("prov.pasteSubmitting") : t("prov.pasteSubmit")}
                      </button>
                    </span>
                    <span className="text-caption">{manualCodeMsg || t("prov.pasteRedirectHint")}</span>
                  </span>
                )}
              </div>
            );
          })}
          {keyProviders.map(name => {
            const provider = config?.providers[name];
            const icon = providerIconSrc(name);
            const keylessFree = provider?.keyOptional === true && !provider?.hasApiKey;
            const missingOpenAiKey = name === "openai-apikey" && !provider?.hasApiKey;
            return (
              <div key={name} className="oauth-row">
                <span className="oauth-name" title={name}>
                  <span className="provider-icon provider-icon-sm">{icon && <img src={icon} alt="" aria-hidden="true" />}</span>
                  <span className="oauth-name-text">{name}</span>
                </span>
                <span className="oauth-status">
                  <span className={`dot ${missingOpenAiKey ? "dot-amber" : "dot-green"}`} />
                  <span className="oauth-email muted">{missingOpenAiKey ? t("prov.openaiApiMissing") : keylessFree ? t("modal.badge.free") : t("prov.hasApiKey")}</span>
                </span>
                <span className="oauth-actions">
                  {missingOpenAiKey && <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>{t("prov.openaiApiSetup")}</button>}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {editing ? (
        <textarea
          className="input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          style={{ height: 400 }}
        />
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="muted text-control" style={{ marginBottom: 4 }}>
            {t("prov.port")}: <code className="chip">{config.port}</code> · {t("prov.default")}: <code className="chip">{config.defaultProvider}</code>
          </div>
          {Object.entries(config.providers).map(([name, prov]) => {
            const isDefault = name === config.defaultProvider;
            const isDisabled = prov.disabled === true;
            const quota = quotaReports[name]?.quota ?? null;
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
                        {isDisabled ? <span className="badge badge-muted">{t("prov.disabledBadge")}</span> : <span className="badge badge-green">{t("prov.activeBadge")}</span>}
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
                {quota && <QuotaBars quota={quota} threshold={80} t={t} className="provider-quota" />}
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
                          <button
                            key={account.id}
                            className={`prov-account-row${account.active ? " active" : ""}`}
                            onClick={() => switchAccount(name, account)}
                            title={account.active ? undefined : t("prov.accountSwitchTitle")}
                          >
                            <span className={`dot ${account.needsReauth ? "dot-amber" : account.active ? "dot-green" : "dot-muted"}`} />
                            <span className="prov-account-email">{accountLabel}</span>
                            {account.needsReauth && <span className="badge badge-amber">{t("prov.accountReauth")}</span>}
                            {account.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                            <span
                              className="prov-account-remove"
                              role="button"
                              aria-label={t("prov.accountRemoveAria", { email: accountLabel })}
                              onClick={e => { e.stopPropagation(); removeAccount(name, account); }}
                            >
                              <IconTrash style={{ width: 13, height: 13 }} />
                            </span>
                          </button>
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
                          <button className="prov-account-row prov-account-add" onClick={() => loginOAuth(name, true)} disabled={busy === name}>
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
