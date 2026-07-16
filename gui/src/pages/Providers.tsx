import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AddProviderModal from "../components/AddProviderModal";
import ProviderWorkspace from "../components/ProviderWorkspace";
import { Notice } from "../ui";
import { useT } from "../i18n";
import type { AccountQuota } from "../codex-quota-utils";
import "../styles-provider-workspace.css";

interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, { adapter: string; baseUrl: string; hasApiKey?: boolean; hasHeaders?: boolean; defaultModel?: string; authMode?: string; keyOptional?: boolean; freeTier?: boolean; disabled?: boolean; note?: string }>;
}

interface OAuthStatus { loggedIn: boolean; email?: string; error?: string; done?: boolean }
interface ProviderQuotaReport { provider: string; quota: AccountQuota; source: string; updatedAt: number }
interface OAuthAccount { id: string; email?: string; active: boolean; needsReauth?: boolean; expiresAt?: number }
interface ApiKeyEntry { id: string; label?: string; masked: string; active: boolean }

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
  const [adding, setAdding] = useState(false);
  const [addIntent, setAddIntent] = useState<{ tier?: "free" | "paid" | "accounts"; custom?: boolean }>({});
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  const [statusOk, setStatusOk] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
  const [quotaReports, setQuotaReports] = useState<Record<string, ProviderQuotaReport>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loginInfo, setLoginInfo] = useState<{ provider: string; url?: string; instructions?: string } | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [manualCodeBusy, setManualCodeBusy] = useState(false);
  const [manualCodeMsg, setManualCodeMsg] = useState("");
  const [accountSets, setAccountSets] = useState<Record<string, { activeAccountId: string | null; accounts: OAuthAccount[] }>>({});
  const [keyPools, setKeyPools] = useState<Record<string, ApiKeyEntry[]>>({});
  /** Raw JSON editor as a modal over the workspace (does not leave workspace layout). */
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false);
  /** Snapshot of draft when the JSON editor opened — used for dirty detection. */
  const jsonBaselineRef = useRef("");
  const aliveRef = useRef(true);
  /** Bumped to invalidate an in-flight OAuth poll (Cancel / close modal). */
  const loginEpochRef = useRef(0);

  const notify = (msg: string, ok: boolean) => { setStatus(msg); setStatusOk(ok); };

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/config`);
      const data = await res.json();
      setConfig(data);
      // Never overwrite the draft while the JSON editor is open — that cleared dirty state
      // and made leave-prompts skip after a background refresh.
      if (!jsonEditorOpen) {
        setDraft(JSON.stringify(data, null, 2));
      }
    } catch {
      notify(t("prov.loadConfigFail"), false);
    }
  }, [apiBase, t, jsonEditorOpen]);

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
      const res = await fetch(`${apiBase}/api/provider-quotas${refresh ? "?refresh=1" : ""}`);
      if (!res.ok) return;
      const data = await res.json() as { reports?: ProviderQuotaReport[] };
      setQuotaReports(Object.fromEntries((data.reports ?? []).map(report => [report.provider, report])));
    } catch {
      /* keep last good reports — do not wipe on transient network blips */
    }
  }, [apiBase]);

  // Multiauth: per-provider logged-in account lists for the card dropdowns (oauth cards only;
  // the Codex/ChatGPT passthrough pool has its own page).
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

  // Key pools for every key-auth provider (even without a key yet — so "Add API key" works).
  const keyCardProviders = useMemo(
    () => config
      ? Object.entries(config.providers)
          .filter(([, p]) => p.authMode !== "oauth" && p.authMode !== "forward" && p.authMode !== "local")
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

  const saveConfig = async (): Promise<boolean> => {
    try {
      const parsed = JSON.parse(draft);
      const res = await fetch(`${apiBase}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (res.ok) {
        notify(t("prov.saved"), true);
        setJsonEditorOpen(false);
        jsonBaselineRef.current = draft;
        fetchConfig();
        fetchProviderQuotas(true);
        return true;
      }
      // Full PUT may be disabled on newer proxies — surface the error body when present.
      const data = await res.json().catch(() => ({})) as { error?: string };
      notify(data.error || t("prov.saveFailed"), false);
      return false;
    } catch {
      notify(t("prov.invalidJson"), false);
      return false;
    }
  };

  const openJsonEditor = () => {
    const baseline = config ? JSON.stringify(config, null, 2) : draft;
    // Snapshot first so the first render with open=true already has a stable baseline.
    jsonBaselineRef.current = baseline;
    setDraft(baseline);
    setJsonEditorOpen(true);
  };

  /** Discard edits and leave the JSON pane. */
  const closeJsonEditor = () => {
    setJsonEditorOpen(false);
    const baseline = config ? JSON.stringify(config, null, 2) : jsonBaselineRef.current;
    jsonBaselineRef.current = baseline;
    setDraft(baseline);
  };

  /** Reset draft to the open-time baseline without closing. */
  const restoreJsonEditor = () => {
    setDraft(jsonBaselineRef.current);
  };

  // Compare against ref every render while open (ref is stable; draft state drives updates).
  const jsonIsDirty = jsonEditorOpen && draft !== jsonBaselineRef.current;

  const handleAddApiKey = async (provider: string, key: string): Promise<boolean> => {
    const res = await fetch(`${apiBase}/api/providers/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: provider, key }),
    });
    if (res.ok) {
      notify(t("prov.keyAdded", { name: provider }), true);
      fetchKeyPools(keyCardProviders.includes(provider) ? keyCardProviders : [...keyCardProviders, provider]);
      fetchConfig();
      fetchProviderQuotas(true);
      return true;
    }
    const data = await res.json().catch(() => ({}));
    notify(data.error || t("prov.keyAddFail"), false);
    return false;
  };

  const cancelOAuthLogin = async (provider?: string | null) => {
    const p = (provider ?? busy)?.trim();
    loginEpochRef.current += 1;
    setBusy(null);
    setLoginInfo(null);
    setManualCode("");
    setManualCodeMsg("");
    if (!p) return;
    await fetch(`${apiBase}/api/oauth/login/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: p }),
    }).catch(() => {});
  };

  const loginOAuth = async (provider: string, addAccount = false) => {
    const epoch = ++loginEpochRef.current;
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
      if (loginEpochRef.current !== epoch) return;
      if (!res.ok) { notify(data.error || t("prov.loginFailStart", { provider: oauthLabel(provider) }), false); return; }
      // The server opens the browser itself (popup-safe). Show the URL + paste fallback.
      if (data.url || data.instructions) setLoginInfo({ provider, url: data.url, instructions: data.instructions });
      const baselineCount = accountSets[provider]?.accounts.length ?? 0;
      // Poll until the loopback callback (or device flow / manual paste) completes.
      for (let i = 0; i < 150 && aliveRef.current && loginEpochRef.current === epoch; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (loginEpochRef.current !== epoch) return;
        const s: (OAuthStatus & { accounts?: OAuthAccount[] }) | null = await fetch(`${apiBase}/api/oauth/status?provider=${provider}`).then(r => r.json()).catch(() => null);
        if (loginEpochRef.current !== epoch) return;
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
          // Soft-cancel from cancelLoginFlow — no error toast.
          if (s.error === "Login cancelled") break;
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          notify(t("prov.loginError", { provider: oauthLabel(provider), error: s.error }), false);
          setLoginInfo(null);
          break;
        }
      }
    } catch {
      if (loginEpochRef.current === epoch) {
        notify(t("prov.loginRequestFail", { provider: oauthLabel(provider) }), false);
      }
    } finally {
      if (aliveRef.current && loginEpochRef.current === epoch) {
        setBusy(null);
        setLoginInfo(null);
      }
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

  const updateProvider = async (
    name: string,
    patch: {
      adapter?: string;
      baseUrl?: string;
      defaultModel?: string;
      apiKey?: string;
      authMode?: string;
      note?: string;
      disabled?: boolean;
    },
  ): Promise<{ ok: boolean; error?: string }> => {
    const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({})) as { error?: string };
    if (res.ok) {
      notify(t("pws.savedName", { name }), true);
      fetchConfig();
      fetchOauth();
      fetchProviderQuotas(true);
      return { ok: true };
    }
    const err = data.error || t("pws.updateFailed", { name });
    notify(err, false);
    return { ok: false, error: err };
  };

  if (!config) {
    return (
      <div className="providers-workspace-shell">
        {status && (
          <div className="providers-workspace-shell-banner">
            <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>
          </div>
        )}
        <div className="muted" style={{ padding: "24px 20px" }}>
          {status ? null : t("prov.loadingConfig")}
        </div>
      </div>
    );
  }

  return (
    <div className="providers-workspace-shell">
      {status && (
        <div className="providers-workspace-shell-banner">
          <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>
        </div>
      )}
      <div className="providers-workspace-shell-body">
        <ProviderWorkspace
          providers={config.providers}
          apiBase={apiBase}
          defaultProvider={config.defaultProvider}
          onAddProvider={(intent) => {
            setAddIntent(intent ?? {});
            setAdding(true);
          }}
          onEditConfig={openJsonEditor}
          jsonEditor={{
            open: jsonEditorOpen,
            draft,
            isDirty: jsonIsDirty,
            onDraftChange: setDraft,
            onSave: () => saveConfig(),
            onClose: closeJsonEditor,
            onRestore: restoreJsonEditor,
          }}
          onSetDisabled={setProviderDisabled}
          onRemoveProvider={removeProvider}
          onUpdateProvider={updateProvider}
          quotaReports={quotaReports}
          oauthStatus={oauthStatus}
          accountSets={accountSets}
          keyPools={keyPools}
          busyProvider={busy}
          loginHint={loginInfo}
          authHandlers={{
            onLogin: (provider, addAccount) => { void loginOAuth(provider, !!addAccount); },
            onCancelLogin: (provider) => { void cancelOAuthLogin(provider); },
            onLogout: (provider) => { void logoutOAuth(provider); },
            onSwitchAccount: (provider, account) => { void switchAccount(provider, account); },
            onRemoveAccount: (provider, account) => { void removeAccount(provider, account); },
            onAddApiKey: handleAddApiKey,
            onSwitchApiKey: (provider, entry) => { void switchApiKey(provider, entry); },
            onRemoveApiKey: (provider, entry) => { void removeApiKey(provider, entry); },
          }}
        />
      </div>
      {adding && (
        <AddProviderModal
          apiBase={apiBase}
          existingNames={Object.keys(config.providers)}
          initialCustom={!!addIntent.custom}
          initialTier={addIntent.tier ?? "free"}
          onClose={() => {
            if (busy) void cancelOAuthLogin(busy);
            setAdding(false);
            setAddIntent({});
          }}
          onAdded={(name) => {
            setAdding(false);
            setAddIntent({});
            notify(t("prov.added", { name, cmd: "ocx sync" }), true);
            fetchConfig();
            fetchOauth();
            fetchProviderQuotas(true);
          }}
          accountRows={[
            ...oauthProviders.map(id => ({ id, label: oauthLabel(id), kind: "oauth" as const })),
            ...Object.entries(config.providers)
              .filter(([name, prov]) =>
                prov.hasApiKey
                && prov.authMode !== "oauth"
                && prov.authMode !== "forward"
                && !oauthProviders.includes(name))
              .map(([name, prov]) => ({
                id: name,
                label: name,
                kind: "key" as const,
                statusLabel: prov.keyOptional && !prov.hasApiKey ? t("pws.freeTier") : t("prov.hasApiKey"),
              })),
          ]}
          accountStatus={oauthStatus}
          accountBusy={busy}
          accountLoginHint={loginInfo}
          onAccountLogin={(provider) => { void loginOAuth(provider); }}
          onAccountCancelLogin={(provider) => { void cancelOAuthLogin(provider); }}
          onAccountLogout={(provider) => { void logoutOAuth(provider); }}
          accountManualCode={manualCode}
          onAccountManualCodeChange={setManualCode}
          onAccountManualCodeSubmit={(provider) => { void submitManualCode(provider); }}
          accountManualCodeBusy={manualCodeBusy}
          accountManualCodeMsg={manualCodeMsg}
        />
      )}
    </div>
  );
}
