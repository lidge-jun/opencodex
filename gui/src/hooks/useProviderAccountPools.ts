import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { AccountLoadState, AccountQuotaReading } from "../components/provider-workspace/types";
import { createBoundedFetch } from "../bounded-fetch";
import { accountNeedsReauth } from "../oauth-health-display";
import { oauthAccountDisplayLabel } from "../provider-workspace/auth";

export interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, { adapter: string; baseUrl: string; hasApiKey?: boolean; hasHeaders?: boolean; defaultModel?: string; models?: string[]; liveModels?: boolean; upstreamHttpVersion?: "auto" | "http1.1" | "h1" | "http2" | "h2"; authMode?: string; keyOptional?: boolean; disabled?: boolean; note?: string; codexAccountMode?: "direct" | "pool" }>;
}

export interface OAuthStatus { loggedIn: boolean; email?: string; error?: string; done?: boolean; needsReauth?: boolean; activeAccountId?: string | null }
export interface OAuthAccount extends AccountQuotaReading {
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
}
export interface ApiKeyEntry extends AccountQuotaReading { id: string; label?: string; masked: string; active: boolean }

type QuotaRow = AccountQuotaReading & { id: string };
const supportsQuotaRead = (row: AccountQuotaReading) => row.quotaMode === "probe" || row.quotaMode === "passive";

function mergeQuotaRows<T extends QuotaRow>(rows: T[], previous: T[], enriched: boolean): T[] {
  const prior = new Map(previous.map(row => [row.id, row]));
  return rows.map(row => {
    const supported = supportsQuotaRead(row);
    // Legacy/unknown mode must not acquire synthetic flags that would override
    // a provider report or imply that a quota probe is supported.
    if (!supported && row.quotaMode !== "unsupported") return { ...row, quotaMode: undefined, quotaPending: undefined };
    // Only surviving credential IDs can retain omitted data. Explicit null is an
    // authoritative invalidation, including failed/expired credential readings.
    const retain = supported && (!enriched || row.quotaUnavailable === true);
    return {
      ...row,
      quota: row.quotaMode === "unsupported" ? null : row.quota !== undefined ? row.quota : retain ? prior.get(row.id)?.quota : undefined,
      quotaPending: !enriched && row.quotaMode === "probe",
      quotaUnavailable: enriched ? row.quotaUnavailable === true : false,
    };
  });
}

function unavailableQuotaRows<T extends QuotaRow>(rows: T[]): T[] {
  return rows.map(row => supportsQuotaRead(row)
    ? { ...row, quotaUnavailable: true, quotaPending: false }
    : row);
}

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
  const requestsRef = useRef(new Set<AbortController>());
  const mountedRef = useRef(true);
  const serverRef = useRef(apiBase);
  useEffect(() => {
    const generations = accountRequestGenerationRef.current;
    const requests = requestsRef.current;
    mountedRef.current = true;
    const serverChanged = serverRef.current !== apiBase;
    serverRef.current = apiBase;
    if (serverChanged) void Promise.resolve().then(() => {
      if (!mountedRef.current || serverRef.current !== apiBase) return;
      setAccountSets({});
      setKeyPools({});
      setAccountLoadStates({});
    });
    return () => {
      mountedRef.current = false;
      for (const key of Object.keys(generations)) generations[key] += 1;
      for (const controller of requests) controller.abort();
      requests.clear();
    };
  }, [apiBase]);
  // Provider lists this instance has already fetched for. The deferred loads below are deliberately
  // uncancellable, and StrictMode double-invokes their effects, so dedupe by list identity here.
  const accountSetsKeyRef = useRef<string | null>(null);
  const keyPoolsKeyRef = useRef<string | null>(null);
  const switchingAccountRef = useRef<{ provider: string; accountId: string } | null>(null);

  const readRoster = useCallback(async <T,>(url: string): Promise<T> => {
    const bounded = createBoundedFetch(20_000);
    requestsRef.current.add(bounded.controller);
    try {
      const response = await fetch(url, { signal: bounded.signal });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json() as T;
      if (bounded.signal.aborted) throw new Error("Quota roster deadline exceeded");
      return data;
    } finally {
      bounded.clear();
      requestsRef.current.delete(bounded.controller);
    }
  }, []);

  const fetchAccountSets = useCallback(async (providers: string[], refresh = false): Promise<boolean> => {
    if (!aliveRef.current || !mountedRef.current || serverRef.current !== apiBase) return false;
    const uniqueProviders = [...new Set(providers)];
    setAccountLoadStates(current => {
      const next = { ...current };
      for (const provider of uniqueProviders) next[provider] = "loading";
      return next;
    });
    const results = await Promise.all(uniqueProviders.map(async provider => {
      const key = `oauth:${provider}`;
      const generation = (accountRequestGenerationRef.current[key] ?? 0) + 1;
      accountRequestGenerationRef.current[key] = generation;
      const currentRequest = () => aliveRef.current && mountedRef.current && serverRef.current === apiBase && accountRequestGenerationRef.current[key] === generation;
      const url = `${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}`;
      try {
        // Cheap local read first so account switch / reauth / remove controls appear
        // even when Anthropic's usage endpoint is slow or timing out.
        const data = await readRoster<{ activeAccountId?: string | null; accounts?: OAuthAccount[] }>(url);
        if (!Array.isArray(data.accounts)) throw new Error("Invalid account roster");
        if (!currentRequest()) return false;
        const rows = data.accounts;
        setAccountSets(current => currentRequest() ? { ...current, [provider]: {
          activeAccountId: data.activeAccountId ?? null,
          accounts: mergeQuotaRows(rows, current[provider]?.accounts ?? [], false),
        } } : current);
        setAccountLoadStates(current => currentRequest() ? { ...current, [provider]: "ready" } : current);
        if (!rows.some(supportsQuotaRead)) return true;

        const enrich = async (): Promise<boolean> => {
          try {
            const quotaData = await readRoster<{ activeAccountId?: string | null; accounts?: OAuthAccount[] }>(`${url}&quota=1${refresh ? "&refresh=1" : ""}`);
            if (!Array.isArray(quotaData.accounts)) throw new Error("Invalid account quota roster");
            if (!currentRequest()) return false;
            const enriched = quotaData.accounts;
            setAccountSets(current => currentRequest() ? {
              ...current,
              [provider]: {
                activeAccountId: quotaData.activeAccountId ?? data.activeAccountId ?? null,
                accounts: mergeQuotaRows(enriched, current[provider]?.accounts ?? [], true),
              },
            } : current);
            return !enriched.some(row => row.quotaUnavailable === true);
          } catch {
            if (!currentRequest()) return false;
            setAccountSets(current => currentRequest() && current[provider] ? {
              ...current, [provider]: { ...current[provider], accounts: unavailableQuotaRows(current[provider].accounts) },
            } : current);
            return false;
          }
        };
        if (refresh) return await enrich();
        void enrich();
        return true;
      } catch {
        if (!currentRequest()) return false;
        setAccountLoadStates(current => currentRequest() ? { ...current, [provider]: "error" } : current);
        setAccountSets(current => currentRequest() && current[provider] ? {
          ...current, [provider]: { ...current[provider], accounts: unavailableQuotaRows(current[provider].accounts) },
        } : current);
        return false;
      }
    }));
    return results.every(Boolean);
  }, [aliveRef, apiBase, readRoster]);

  const fetchKeyPools = useCallback(async (providers: string[], refresh = false): Promise<boolean> => {
    if (!aliveRef.current || !mountedRef.current || serverRef.current !== apiBase) return false;
    const results = await Promise.all([...new Set(providers)].map(async name => {
      const key = `key:${name}`;
      const generation = (accountRequestGenerationRef.current[key] ?? 0) + 1;
      accountRequestGenerationRef.current[key] = generation;
      const currentRequest = () => aliveRef.current && mountedRef.current && serverRef.current === apiBase && accountRequestGenerationRef.current[key] === generation;
      const url = `${apiBase}/api/providers/keys?name=${encodeURIComponent(name)}`;
      const failed = () => {
        if (currentRequest()) setKeyPools(current => currentRequest()
          ? { ...current, [name]: unavailableQuotaRows(current[name] ?? []) } : current);
        return false;
      };
      try {
        const data = await readRoster<{ keys?: ApiKeyEntry[] }>(url);
        if (!Array.isArray(data.keys)) throw new Error("Invalid key roster");
        if (!currentRequest()) return false;
        const rows = data.keys;
        setKeyPools(current => currentRequest() ? { ...current, [name]: mergeQuotaRows(rows, current[name] ?? [], false) } : current);
        if (!rows.some(supportsQuotaRead)) return true;
        const enrich = async (): Promise<boolean> => {
          try {
            const data = await readRoster<{ keys?: ApiKeyEntry[] }>(`${url}&quota=1${refresh ? "&refresh=1" : ""}`);
            if (!Array.isArray(data.keys)) throw new Error("Invalid key quota roster");
            if (!currentRequest()) return false;
            const enriched = data.keys;
            setKeyPools(current => currentRequest() ? { ...current, [name]: mergeQuotaRows(enriched, current[name] ?? [], true) } : current);
            return !enriched.some(row => row.quotaUnavailable === true);
          } catch { return failed(); }
        };
        if (refresh) return await enrich();
        void enrich();
        return true;
      } catch { return failed(); }
    }));
    return results.every(Boolean);
  }, [apiBase, aliveRef, readRoster]);

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
    const key = `${apiBase}:${oauthCardProviders.join(",")}`;
    if (accountSetsKeyRef.current === key) return;
    accountSetsKeyRef.current = key;
    void Promise.resolve().then(() => { void fetchAccountSets(oauthCardProviders); });
  }, [apiBase, fetchAccountSets, oauthCardProviders]);

  const keyCardProviders = useMemo(
    () => config ? Object.entries(config.providers).filter(([, p]) => p.hasApiKey && p.authMode !== "oauth" && p.authMode !== "forward").map(([n]) => n) : [],
    [config],
  );
  useEffect(() => {
    if (keyCardProviders.length === 0) return;
    const key = `${apiBase}:${keyCardProviders.join(",")}`;
    if (keyPoolsKeyRef.current === key) return;
    keyPoolsKeyRef.current = key;
    void Promise.resolve().then(() => { void fetchKeyPools(keyCardProviders); });
  }, [apiBase, fetchKeyPools, keyCardProviders]);

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
