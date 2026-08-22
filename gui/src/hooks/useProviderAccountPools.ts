import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { AccountLoadState } from "../components/provider-workspace/types";
import { accountNeedsReauth } from "../oauth-health-display";
import type { AccountQuota } from "../codex-quota-utils";
import { oauthAccountDisplayLabel } from "../provider-workspace/auth";

export interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, { adapter: string; baseUrl: string; hasApiKey?: boolean; hasHeaders?: boolean; defaultModel?: string; models?: string[]; liveModels?: boolean; upstreamHttpVersion?: "auto" | "http1.1" | "h1" | "http2" | "h2"; authMode?: string; keyOptional?: boolean; disabled?: boolean; note?: string; codexAccountMode?: "direct" | "pool" }>;
}

export interface OAuthStatus { loggedIn: boolean; email?: string; error?: string; done?: boolean; needsReauth?: boolean; activeAccountId?: string | null }
export interface OAuthAccount {
  id: string;
  alias?: string;
  email?: string;
  active: boolean;
  needsReauth?: boolean;
  expiresAt?: number;
  health?: { status: "healthy" | "cooldown" | "reauth_required" | "warning"; reason?: string; until?: string };
  healthLabel?: string;
  healthSummary?: string;
  healthAction?: string;
  /** Per-account rate limits (providers that report usage per credential, e.g. anthropic). */
  quota?: AccountQuota | null;
  /** Set when the per-account probe could not reach upstream (expired login, 429, network). */
  quotaUnavailable?: boolean;
}
export interface ApiKeyEntry { id: string; label?: string; masked: string; active: boolean }

/** Pure aggregate map used by Providers overview / rail attention state. */
export function buildActiveAccountNeedsReauthMap(
  accountSets: Record<string, { activeAccountId: string | null; accounts: OAuthAccount[] }>,
  codexActiveNeedsReauth = false,
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const [provider, set] of Object.entries(accountSets)) {
    const active = set.accounts.find(a => a.active) ?? set.accounts.find(a => a.id === set.activeAccountId);
    if (accountNeedsReauth(active)) map[provider] = true;
  }
  if (codexActiveNeedsReauth) map.openai = true;
  return map;
}

export function useProviderAccountPools(deps: {
  apiBase: string;
  t: (key: string, ...args: unknown[]) => string;
  config: Config | null;
  oauthStatus: Record<string, OAuthStatus>;
  aliveRef: MutableRefObject<boolean>;
  notify: (msg: string, ok?: boolean) => void;
  fetchConfig: () => Promise<void>;
  fetchOauth: () => Promise<void>;
  fetchProviderQuotas: (refresh?: boolean) => Promise<void>;
  codexActiveNeedsReauth: boolean;
}) {
  const {
    apiBase, t, config, aliveRef, notify,
    fetchConfig, fetchOauth, fetchProviderQuotas, codexActiveNeedsReauth,
  } = deps;
  const [accountSets, setAccountSets] = useState<Record<string, { activeAccountId: string | null; accounts: OAuthAccount[] }>>({});
  const [accountLoadStates, setAccountLoadStates] = useState<Record<string, AccountLoadState>>({});
  const [switchingAccount, setSwitchingAccount] = useState<{ provider: string; accountId: string } | null>(null);
  const [openAccounts, setOpenAccounts] = useState<Record<string, boolean>>({});
  const [keyPools, setKeyPools] = useState<Record<string, ApiKeyEntry[]>>({});
  const [addingKeyFor, setAddingKeyFor] = useState<string | null>(null);
  const [newKeyValue, setNewKeyValue] = useState("");
  const accountRequestGenerationRef = useRef<Record<string, number>>({});
  // Provider lists this instance has already fetched for. The deferred loads below are deliberately
  // uncancellable, and StrictMode double-invokes their effects, so dedupe by list identity here.
  const accountSetsKeyRef = useRef<string | null>(null);
  const keyPoolsKeyRef = useRef<string | null>(null);
  const switchingAccountRef = useRef<{ provider: string; accountId: string } | null>(null);

  const fetchAccountSets = useCallback(async (providers: string[]) => {
    const uniqueProviders = [...new Set(providers)];
    setAccountLoadStates(current => {
      const next = { ...current };
      for (const provider of uniqueProviders) next[provider] = "loading";
      return next;
    });
    const results = await Promise.all(uniqueProviders.map(async provider => {
      const generation = (accountRequestGenerationRef.current[provider] ?? 0) + 1;
      accountRequestGenerationRef.current[provider] = generation;
      try {
        // Cheap local read first so account switch / reauth / remove controls appear
        // even when Anthropic's usage endpoint is slow or timing out.
        const res = await fetch(`${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json() as { activeAccountId?: string | null; accounts?: OAuthAccount[] };
        if (!aliveRef.current || accountRequestGenerationRef.current[provider] !== generation) return true;
        setAccountSets(current => ({ ...current, [provider]: { activeAccountId: data.activeAccountId ?? null, accounts: data.accounts ?? [] } }));
        setAccountLoadStates(current => ({ ...current, [provider]: "ready" }));

        // Enrich with per-account rate limits asynchronously (Anthropic reports usage
        // per credential). Failures leave the already-ready account rows untouched.
        void (async () => {
          try {
            const quotaRes = await fetch(`${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}&quota=1`);
            if (!quotaRes.ok) return;
            const quotaData = await quotaRes.json() as { activeAccountId?: string | null; accounts?: OAuthAccount[] };
            if (!aliveRef.current || accountRequestGenerationRef.current[provider] !== generation) return;
            setAccountSets(current => ({
              ...current,
              [provider]: {
                activeAccountId: quotaData.activeAccountId ?? data.activeAccountId ?? null,
                accounts: quotaData.accounts ?? data.accounts ?? [],
              },
            }));
          } catch {
            /* keep local account rows without quota enrichment */
          }
        })();
        return true;
      } catch {
        if (!aliveRef.current || accountRequestGenerationRef.current[provider] !== generation) return true;
        setAccountLoadStates(current => ({ ...current, [provider]: "error" }));
        return false;
      }
    }));
    return results.every(Boolean);
  }, [aliveRef, apiBase]);

  const fetchKeyPools = useCallback(async (providers: string[]) => {
    const entries = await Promise.all(providers.map(async name => {
      const data = await fetch(`${apiBase}/api/providers/keys?name=${encodeURIComponent(name)}`).then(async r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }).catch(() => null) as { keys?: ApiKeyEntry[] } | null;
      return [name, data?.keys ?? []] as const;
    }));
    setKeyPools(Object.fromEntries(entries));
  }, [apiBase]);

  const switchAccount = async (provider: string, account: OAuthAccount) => {
    if (account.active || account.needsReauth || switchingAccountRef.current) return;
    const target = { provider, accountId: account.id };
    switchingAccountRef.current = target;
    setSwitchingAccount(target);
    const label = oauthAccountDisplayLabel(accountSets[provider]?.accounts ?? [account], account, t);
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts/active`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, accountId: account.id }) });
      if (!res.ok) { notify(t("prov.accountSwitchFail"), false); return; }
      const refreshed = await fetchAccountSets([provider]);
      await Promise.all([fetchOauth(), fetchProviderQuotas(true)]);
      if (!refreshed) { notify(t("pws.accountsLoadFailed"), false); return; }
      notify(t("prov.accountSwitched", { email: label }), true);
    } catch {
      notify(t("prov.accountSwitchFail"), false);
    } finally {
      if (switchingAccountRef.current?.provider === target.provider && switchingAccountRef.current.accountId === target.accountId) {
        switchingAccountRef.current = null;
        if (aliveRef.current) setSwitchingAccount(null);
      }
    }
  };

  const switchApiKey = async (provider: string, entry: ApiKeyEntry) => {
    if (entry.active) return;
    const res = await fetch(`${apiBase}/api/providers/keys/active`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: provider, id: entry.id }) });
    if (res.ok) {
      notify(t("prov.keySwitched", { key: entry.label ?? entry.masked }), true);
      void fetchKeyPools(Object.keys(keyPools));
      void fetchProviderQuotas(true);
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
      void fetchKeyPools(Object.keys(keyPools));
      void fetchConfig();
      void fetchProviderQuotas(true);
    }
  };

  const addApiKeyValue = async (provider: string, rawKey: string): Promise<boolean> => {
    const key = rawKey.trim();
    if (!key) return false;
    try {
      const res = await fetch(`${apiBase}/api/providers/keys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: provider, key }) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        notify(data.error || t("prov.keyAddFail"), false);
        return false;
      }
      notify(t("prov.keyAdded", { name: provider }), true);
      setAddingKeyFor(null);
      await Promise.all([
        fetchKeyPools(Object.keys(keyPools).includes(provider) ? Object.keys(keyPools) : [...Object.keys(keyPools), provider]),
        fetchConfig(), fetchProviderQuotas(true),
      ]);
      return true;
    } catch {
      notify(t("prov.keyAddFail"), false);
      return false;
    }
  };

  const addApiKey = async (provider: string) => {
    const ok = await addApiKeyValue(provider, newKeyValue);
    if (ok) setNewKeyValue("");
  };

  const editCredentialAlias = async (provider: string, type: "oauth" | "api-key", id: string, current?: string) => {
    const entered = window.prompt(t("prov.aliasPrompt"), current ?? "");
    if (entered === null) return;
    const alias = entered.trim();
    const response = await fetch(type === "oauth" ? `${apiBase}/api/oauth/accounts/alias` : `${apiBase}/api/providers/keys/alias`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(type === "oauth" ? { provider, accountId: id, alias } : { name: provider, id, alias }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      notify(data.error || t("prov.aliasSaveFailed"), false);
      return;
    }
    if (type === "oauth") await fetchAccountSets([provider]);
    else await fetchKeyPools(Object.keys(keyPools).includes(provider) ? Object.keys(keyPools) : [...Object.keys(keyPools), provider]);
    notify(t("prov.aliasSaved"), true);
  };

  const removeAccount = async (provider: string, account: OAuthAccount) => {
    const label = oauthAccountDisplayLabel(accountSets[provider]?.accounts ?? [account], account, t);
    if (!window.confirm(t("prov.accountRemoveConfirm", { email: label }))) return;
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(account.id)}`, { method: "DELETE" });
      if (!res.ok) { notify(t("prov.accountRemoveFail", { email: label }), false); return; }
      notify(t("prov.accountRemoved", { email: label }), true);
      await fetchAccountSets([provider]);
      await Promise.all([fetchOauth(), fetchProviderQuotas(true)]);
    } catch {
      notify(t("prov.accountRemoveFail", { email: label }), false);
    }
  };

  const oauthCardProviders = useMemo(
    () => config ? Object.entries(config.providers).filter(([, p]) => p.authMode === "oauth").map(([n]) => n) : [],
    [config],
  );
  useEffect(() => {
    if (oauthCardProviders.length === 0) return;
    // Deferred by a microtask, not a timer: a timer had to be cancelled in cleanup, so a mount
    // followed by an immediate unmount (tab switch, provider list churn) issued no request and
    // never retried. A microtask keeps the state update out of the effect body while still
    // guaranteeing the request goes out.
    // Keyed on the provider list because this effect re-runs whenever that memo changes, and
    // StrictMode double-invokes it on mount; an uncancellable microtask would otherwise duplicate.
    const key = oauthCardProviders.join(",");
    if (accountSetsKeyRef.current === key) return;
    accountSetsKeyRef.current = key;
    void Promise.resolve().then(() => { void fetchAccountSets(oauthCardProviders); });
  }, [fetchAccountSets, oauthCardProviders]);

  const keyCardProviders = useMemo(
    () => config ? Object.entries(config.providers).filter(([, p]) => p.hasApiKey && p.authMode !== "oauth" && p.authMode !== "forward").map(([n]) => n) : [],
    [config],
  );
  useEffect(() => {
    if (keyCardProviders.length === 0) return;
    const key = keyCardProviders.join(",");
    if (keyPoolsKeyRef.current === key) return;
    keyPoolsKeyRef.current = key;
    void Promise.resolve().then(() => { void fetchKeyPools(keyCardProviders); });
  }, [fetchKeyPools, keyCardProviders]);

  const activeAccountNeedsReauth = useMemo(
    () => buildActiveAccountNeedsReauthMap(accountSets, codexActiveNeedsReauth),
    [accountSets, codexActiveNeedsReauth],
  );

  return {
    accountSets, accountLoadStates, switchingAccount, openAccounts, keyPools, addingKeyFor, newKeyValue,
    setAccountSets, setAccountLoadStates, setSwitchingAccount, setOpenAccounts, setKeyPools, setAddingKeyFor, setNewKeyValue,
    fetchAccountSets, fetchKeyPools, switchAccount, switchApiKey, removeApiKey, addApiKeyValue, addApiKey, editCredentialAlias, removeAccount,
    oauthCardProviders, keyCardProviders, activeAccountNeedsReauth,
  };
}
