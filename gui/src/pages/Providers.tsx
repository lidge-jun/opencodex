import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AddProviderModal from "../components/AddProviderModal";
import AddCodexAccountModal from "../components/AddCodexAccountModal";
import OAuthTosWarningModal from "../components/OAuthTosWarningModal";
import ProviderWorkspaceShell, { type AddProviderIntent } from "../components/provider-workspace/ProviderWorkspaceShell";
import ProviderDetails from "../components/provider-workspace/ProviderDetails";
import { RemoveConfirmDialog, UnsavedLeaveDialog } from "../components/provider-workspace/ProviderDialogs";
import type { WorkspaceProvider } from "../provider-workspace/catalog";
import type { ProviderUpdatePatch } from "../components/provider-workspace/types";
import type { AccountLoadState } from "../components/provider-workspace/types";
import { oauthAccountDisplayLabel } from "../provider-workspace/auth";
import { oauthTosRisk } from "../oauth-tos-risk";
import { Notice } from "../ui";
import { IconPlus, IconTrash, IconLock, IconExternal, IconPower, IconChevron, IconLink } from "../icons";
import { useT } from "../i18n";
import type { AccountQuota } from "../codex-quota-utils";
import QuotaBars from "../components/QuotaBars";
import { providerIconSrc, formatProviderDisplayName } from "../provider-icons";
import { apiErrorMessage } from "../api-error";

interface Config {
  port: number;
  hostname?: string;
  defaultProvider: string;
  codexAutoStart?: boolean;
  websockets?: boolean;
  providers: Record<string, { adapter: string; baseUrl: string; hasApiKey?: boolean; hasHeaders?: boolean; defaultModel?: string; models?: string[]; authMode?: string; keyOptional?: boolean; disabled?: boolean; note?: string; codexAccountMode?: "direct" | "pool"; [key: string]: unknown }>;
}

interface OAuthStatus { loggedIn: boolean; email?: string; error?: string; done?: boolean; needsReauth?: boolean; activeAccountId?: string | null }
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
  "google-antigravity": "Google Antigravity",
  "github-copilot": "GitHub Copilot",
  cursor: "Cursor",
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
  // Workspace vs Classic: localStorage is source of truth; hash stays in sync.
  // Leaving Providers (e.g. Models) must not reset a saved workspace preference.
  const [workspaceView, setWorkspaceView] = useState(() => {
    try {
      return localStorage.getItem("ocx-providers-view") === "workspace";
    } catch {
      return false;
    }
  });
  const [workspaceSelected, setWorkspaceSelected] = useState<string | null>(null);
  const [addIntent, setAddIntent] = useState<AddProviderIntent | null>(null);
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false);
  const [jsonBaseline, setJsonBaseline] = useState("");
  const [jsonSaving, setJsonSaving] = useState(false);
  const [jsonLeaveOpen, setJsonLeaveOpen] = useState(false);
  const [removeConfirmName, setRemoveConfirmName] = useState<string | null>(null);
  /** ChatGPT/Codex login from Add Provider → Accounts (uses /api/codex-auth, not /api/oauth). */
  const [codexLoginOpen, setCodexLoginOpen] = useState(false);
  const [modelsRefreshToken, setModelsRefreshToken] = useState(0);
  const [oauthTosPending, setOauthTosPending] = useState<{ provider: string; addAccount: boolean } | null>(null);
  const [codexActiveNeedsReauth, setCodexActiveNeedsReauth] = useState(false);
  const aliveRef = useRef(true);
  const jsonEditorOpenRef = useRef(false);
  const removeBusyRef = useRef(false);
  const accountRequestGenerationRef = useRef<Record<string, number>>({});
  const switchingAccountRef = useRef<{ provider: string; accountId: string } | null>(null);
  const codexReauthGenerationRef = useRef(0);
  const oauthLoginGenerationRef = useRef<Map<string, number>>(new Map());

  const notify = (msg: string, ok: boolean) => { setStatus(msg); setStatusOk(ok); };

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  useEffect(() => {
    const writePref = (workspace: boolean) => {
      try {
        localStorage.setItem("ocx-providers-view", workspace ? "workspace" : "classic");
      } catch {
        /* ignore */
      }
    };
    const readPrefWorkspace = () => {
      try {
        return localStorage.getItem("ocx-providers-view") === "workspace";
      } catch {
        return false;
      }
    };
    const wantedHash = workspaceView ? "providers/workspace" : "providers";
    const onHash = () => {
      const hash = location.hash.replace(/^#\/?/, "");
      // Ignore unrelated routes (Models, Usage, …) — do not clear the preference.
      if (hash === "providers/workspace") {
        setWorkspaceView(true);
        writePref(true);
        return;
      }
      if (hash === "providers") {
        // Bare #providers must not clobber a saved workspace choice (nav race).
        if (readPrefWorkspace()) {
          location.hash = "#providers/workspace";
          return;
        }
        setWorkspaceView(false);
        writePref(false);
      }
    };
    window.addEventListener("hashchange", onHash);
    if (location.hash.replace(/^#\/?/, "") !== wantedHash) {
      location.hash = `#${wantedHash}`;
    }
    return () => window.removeEventListener("hashchange", onHash);
  }, [workspaceView]);
  const toggleWorkspace = () => {
    const next = !workspaceView;
    try {
      localStorage.setItem("ocx-providers-view", next ? "workspace" : "classic");
    } catch {
      /* ignore */
    }
    setWorkspaceView(next);
    location.hash = next ? "#providers/workspace" : "#providers";
  };

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/config`);
      const data = await res.json();
      setConfig(data);
      // Never overwrite the draft while the JSON editor is open — that cleared dirty state.
      if (!jsonEditorOpenRef.current) {
        setDraft(JSON.stringify(data, null, 2));
      }
    } catch {
      notify(t("prov.loadConfigFail"), false);
    }
  }, [apiBase, t]);

  // Load OAuth-capable providers + ChatGPT/Codex pool status (shared by all forward providers).
  const fetchOauth = useCallback(async () => {
    try {
      const provs: string[] = (await fetch(`${apiBase}/api/oauth/providers`).then(r => r.json())).providers ?? [];
      setOauthProviders(provs);
      const [oauthEntries, codexAccounts, codexActive] = await Promise.all([
        Promise.all(provs.map(async p => {
          const s = await fetch(`${apiBase}/api/oauth/status?provider=${p}`).then(r => r.json()).catch(() => ({ loggedIn: false }));
          return [p, s] as const;
        })),
        fetch(`${apiBase}/api/codex-auth/accounts`)
          .then(r => r.ok ? r.json() as Promise<{ accounts?: Array<{ id?: string; email?: string; isMain?: boolean; hasCredential?: boolean; needsReauth?: boolean }> }> : null)
          .catch(() => null),
        fetch(`${apiBase}/api/codex-auth/active`)
          .then(r => r.ok ? r.json() as Promise<{ activeCodexAccountId?: string | null }> : null)
          .catch(() => null),
      ]);
      const next: Record<string, OAuthStatus> = Object.fromEntries(oauthEntries);
      const accounts = codexAccounts?.accounts ?? [];
      const main = accounts.find(a => a.isMain) ?? accounts[0];
      // The synthetic main row always carries hasCredential: true and a placeholder
      // email ("Codex App login") even without a real credential. Only treat it as
      // logged in when it has a real email or a pool account has a credential.
      const mainIsReal = !!main && !!main.email && main.email !== "Codex App login";
      const poolLoggedIn = accounts.some(a => !a.isMain && (a.hasCredential || a.email));
      const codexLoggedIn = mainIsReal || poolLoggedIn;
      const codexEmail = mainIsReal ? main.email : (accounts.find(a => !a.isMain && a.email)?.email ?? undefined);
      // Only flag the ACTIVE account for reauth — stale inactive accounts must not
      // trigger a Models-tab warning when the active/main account is usable.
      const activeId = codexActive?.activeCodexAccountId ?? null;
      const activePoolAccount = activeId && activeId !== "__main__"
        ? accounts.find(a => a.id === activeId)
        : null;
      const codexNeedsReauth = activePoolAccount
        ? Boolean(activePoolAccount.needsReauth)
        : Boolean(main?.needsReauth);
      // Built-in openai (and any other forward row) share the same Codex account pool.
      next.openai = {
        loggedIn: codexLoggedIn,
        email: codexEmail,
        ...(codexNeedsReauth ? { needsReauth: true } : {}),
      };
      setOauthStatus(next);
    } catch { /* ignore */ }
  }, [apiBase]);

  const fetchProviderQuotas = useCallback(async (refresh = false) => {
    try {
      const res = await fetch(`${apiBase}/api/provider-quotas${refresh ? "?refresh=1" : ""}`);
      if (!res.ok) return;
      const data = await res.json() as { reports?: ProviderQuotaReport[] };
      setQuotaReports(prev => {
        const next = { ...prev };
        for (const report of data.reports ?? []) {
          if (report?.provider) next[report.provider] = report;
        }
        return next;
      });
    } catch {
      /* keep last-good */
    }
  }, [apiBase]);

  const fetchCodexActiveReauth = useCallback(async () => {
    const generation = ++codexReauthGenerationRef.current;
    try {
      const [accountsRes, activeRes] = await Promise.all([
        fetch(`${apiBase}/api/codex-auth/accounts`),
        fetch(`${apiBase}/api/codex-auth/active`),
      ]);
      if (!accountsRes.ok || !activeRes.ok) return;
      const accts = await accountsRes.json() as { accounts?: Array<{ id: string; isMain?: boolean; needsReauth?: boolean }> };
      const active = await activeRes.json() as { activeCodexAccountId?: string | null };
      if (!aliveRef.current || codexReauthGenerationRef.current !== generation) return;
      const accounts = accts.accounts ?? [];
      const activeId = active.activeCodexAccountId ?? null;
      const activePoolAccount = activeId && activeId !== "__main__"
        ? accounts.find(a => a.id === activeId)
        : null;
      const needs = activePoolAccount
        ? Boolean(activePoolAccount.needsReauth)
        : Boolean(accounts.find(a => a.isMain)?.needsReauth);
      setCodexActiveNeedsReauth(needs);
    } catch { /* ignore */ }
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
    const results = await Promise.all(uniqueProviders.map(async provider => {
      const generation = (accountRequestGenerationRef.current[provider] ?? 0) + 1;
      accountRequestGenerationRef.current[provider] = generation;
      try {
        const res = await fetch(`${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json() as { activeAccountId?: string | null; accounts?: OAuthAccount[] };
        if (!aliveRef.current || accountRequestGenerationRef.current[provider] !== generation) return true;
        setAccountSets(current => ({
          ...current,
          [provider]: { activeAccountId: data.activeAccountId ?? null, accounts: data.accounts ?? [] },
        }));
        setAccountLoadStates(current => ({ ...current, [provider]: "ready" }));
        return true;
      } catch {
        if (!aliveRef.current || accountRequestGenerationRef.current[provider] !== generation) return true;
        setAccountLoadStates(current => ({ ...current, [provider]: "error" }));
        return false;
      }
    }));
    return results.every(Boolean);
  }, [apiBase]);

  const switchAccount = async (provider: string, account: OAuthAccount) => {
    if (account.active || account.needsReauth || switchingAccountRef.current) return;
    const target = { provider, accountId: account.id };
    switchingAccountRef.current = target;
    setSwitchingAccount(target);
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
      const refreshed = await fetchAccountSets([provider]);
      await Promise.all([fetchOauth(), fetchProviderQuotas(true)]);
      if (!refreshed) {
        notify(t("pws.accountsLoadFailed"), false);
        return;
      }
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
    try {
      const res = await fetch(`${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(account.id)}`, { method: "DELETE" });
      if (!res.ok) {
        notify(t("prov.accountRemoveFail", { email: label }), false);
        return;
      }
      notify(t("prov.accountRemoved", { email: label }), true);
      await fetchAccountSets([provider]);
      await Promise.all([fetchOauth(), fetchProviderQuotas(true)]);
    } catch {
      notify(t("prov.accountRemoveFail", { email: label }), false);
    }
  };

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void fetchConfig();
      void fetchOauth();
      void fetchProviderQuotas();
      void fetchCodexActiveReauth();
    }, 0);
    const iv = window.setInterval(() => { void fetchCodexActiveReauth(); }, 30_000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(iv);
    };
  }, [fetchConfig, fetchOauth, fetchProviderQuotas, fetchCodexActiveReauth]);

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

  const activeAccountNeedsReauth = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const [provider, set] of Object.entries(accountSets)) {
      const active = set.accounts.find(a => a.active) ?? set.accounts.find(a => a.id === set.activeAccountId);
      if (active?.needsReauth) map[provider] = true;
    }
    if (codexActiveNeedsReauth) map.openai = true;
    return map;
  }, [accountSets, codexActiveNeedsReauth]);
  useEffect(() => {
    if (keyCardProviders.length === 0) return;
    const timeout = window.setTimeout(() => {
      void fetchKeyPools(keyCardProviders);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [fetchKeyPools, keyCardProviders]);

  const saveConfig = async (): Promise<boolean> => {
    setJsonSaving(true);
    try {
      const parsed = JSON.parse(draft) as Config;
      if (!parsed.providers || typeof parsed.providers !== "object" || !parsed.defaultProvider || !Object.hasOwn(parsed.providers, parsed.defaultProvider)) {
        notify(t("prov.invalidJson"), false);
        return false;
      }

      // The management API intentionally does not accept a full config PUT: the
      // config returned to the browser masks credentials. Save the editable JSON
      // as individual provider changes instead, so a browser can never erase a
      // key or header that it was not allowed to read.
      const current: Config = config
        ? config
        : await fetch(`${apiBase}/api/config`).then(r => r.json() as Promise<Config>);
      const immutableSettingsChanged = parsed.port !== current.port
        || (parsed.hostname ?? "127.0.0.1") !== (current.hostname ?? "127.0.0.1")
        || (parsed.websockets ?? false) !== (current.websockets ?? false);
      if (immutableSettingsChanged) {
        notify("Port, hostname, and websockets must be changed outside the provider JSON editor.", false);
        return false;
      }

      for (const [name, rawProvider] of Object.entries(parsed.providers)) {
        const provider = { ...rawProvider } as Record<string, unknown>;
        // These values are presentation-only signals returned by GET /api/config.
        delete provider.hasApiKey;
        delete provider.hasHeaders;
        delete provider.note;
        const res = await fetch(`${apiBase}/api/providers`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, provider, setDefault: name === parsed.defaultProvider }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          notify(data.error || t("prov.saveFailed"), false);
          return false;
        }
      }

      // Add/update the next default first, then remove rows absent from the draft.
      for (const name of Object.keys(current.providers)) {
        if (Object.hasOwn(parsed.providers, name)) continue;
        const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          notify(data.error || t("prov.saveFailed"), false);
          return false;
        }
      }

      if ((parsed.codexAutoStart ?? true) !== (current.codexAutoStart ?? true)) {
        const res = await fetch(`${apiBase}/api/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ codexAutoStart: parsed.codexAutoStart === true }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          notify(data.error || t("prov.saveFailed"), false);
          return false;
        }
      }

      notify(t("prov.saved"), true);
      setEditing(false);
      setJsonEditorOpen(false);
      jsonEditorOpenRef.current = false;
      setJsonLeaveOpen(false);
      setJsonBaseline(JSON.stringify(parsed, null, 2));
      fetchConfig();
      fetchProviderQuotas(true);
      setModelsRefreshToken(n => n + 1);
      return true;
    } catch {
      notify(t("prov.invalidJson"), false);
      return false;
    } finally {
      setJsonSaving(false);
    }
  };

  const openJsonEditor = () => {
    const baseline = config ? JSON.stringify(config, null, 2) : draft;
    setJsonBaseline(baseline);
    setDraft(baseline);
    setJsonLeaveOpen(false);
    setJsonEditorOpen(true);
    jsonEditorOpenRef.current = true;
  };

  const discardJsonEditor = () => {
    setJsonLeaveOpen(false);
    setJsonEditorOpen(false);
    jsonEditorOpenRef.current = false;
    const baseline = config ? JSON.stringify(config, null, 2) : jsonBaseline;
    setJsonBaseline(baseline);
    setDraft(baseline);
  };

  const requestCloseJsonEditor = () => {
    if (jsonEditorOpen && draft !== jsonBaseline) {
      setJsonLeaveOpen(true);
      return;
    }
    discardJsonEditor();
  };

  const restoreJsonEditor = () => {
    setDraft(jsonBaseline);
  };

  const jsonIsDirty = jsonEditorOpen && draft !== jsonBaseline;

  const cancelLoginOAuth = useCallback(async (provider: string) => {
    const gen = (oauthLoginGenerationRef.current.get(provider) ?? 0) + 1;
    oauthLoginGenerationRef.current.set(provider, gen);
    try {
      await fetch(`${apiBase}/api/oauth/login/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
    } catch { /* ignore */ }
    if (!aliveRef.current) return;
    if (oauthLoginGenerationRef.current.get(provider) === gen) {
      setBusy(current => current === provider ? null : current);
      setLoginInfo(current => current?.provider === provider ? null : current);
    }
    setManualCode("");
    setManualCodeMsg("");
    notify(t("prov.loginCancelled", { provider: oauthLabel(provider) }), false);
  }, [apiBase, t]);

  const loginOAuth = async (provider: string, addAccount = false, accountId?: string) => {
    const nextGen = (oauthLoginGenerationRef.current.get(provider) ?? 0) + 1;
    oauthLoginGenerationRef.current.set(provider, nextGen);
    const generation = nextGen;
    const reauthTargetId = accountId?.trim() || undefined;
    setBusy(provider);
    setStatus("");
    setLoginInfo(null);
    setManualCode("");
    setManualCodeMsg("");
    try {
      const res = await fetch(`${apiBase}/api/oauth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          ...(addAccount || reauthTargetId ? { addAccount: true } : {}),
          ...(reauthTargetId ? { accountId: reauthTargetId, reauth: true } : {}),
        }),
      });
      const data = await res.json();
      if (oauthLoginGenerationRef.current.get(provider) !== generation || !aliveRef.current) return;
      if (!res.ok) { notify(data.error || t("prov.loginFailStart", { provider: oauthLabel(provider) }), false); return; }
      if (data.url || data.instructions) setLoginInfo({ provider, url: data.url, instructions: data.instructions });
      const baselineCount = accountSets[provider]?.accounts.length ?? 0;
      // Poll until the loopback callback (or device flow / manual paste) completes.
      // Prefer s.done so cancel/timeout/error clear "waiting for browser" instead of hanging.
      let finished = false;
      for (let i = 0; i < 150 && aliveRef.current && oauthLoginGenerationRef.current.get(provider) === generation; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (oauthLoginGenerationRef.current.get(provider) !== generation || !aliveRef.current) return;
        const s: (OAuthStatus & { accounts?: OAuthAccount[] }) | null = await fetch(`${apiBase}/api/oauth/status?provider=${provider}`).then(r => r.json()).catch(() => null);
        if (!s) continue;
        if (s.error) {
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          const cancelled = /cancel/i.test(s.error);
          notify(
            cancelled
              ? t("prov.loginCancelled", { provider: oauthLabel(provider) })
              : t("prov.loginError", { provider: oauthLabel(provider), error: s.error }),
            false,
          );
          setLoginInfo(null);
          finished = true;
          break;
        }
        // For add-account / reauth flows the provider may already be "logged in": wait for a
        // new slot OR flow completion (same-account re-login won't grow count).
        const completed = addAccount || reauthTargetId
          ? ((s.accounts?.length ?? 0) > baselineCount || s.done === true)
          : (s.loggedIn || s.done === true);
        if (completed) {
          setOauthStatus(prev => ({ ...prev, [provider]: s }));
          const target = reauthTargetId
            ? s.accounts?.find(a => a.id === reauthTargetId)
            : s.accounts?.find(a => a.active) ?? s.accounts?.find(a => a.id === s.activeAccountId);
          if (reauthTargetId && !target) {
            notify(t("prov.loginError", { provider: oauthLabel(provider), error: t("prov.reauthAccountMissing") }), false);
            setLoginInfo(null);
            finished = true;
            break;
          }
          if (target?.needsReauth) {
            notify(t("prov.loginError", { provider: oauthLabel(provider), error: t("prov.reauthIdentityMismatch") }), false);
            setLoginInfo(null);
            finished = true;
            break;
          }
          notify(t("prov.loginOk", { provider: oauthLabel(provider), cmd: "ocx sync" }), true);
          setLoginInfo(null);
          setManualCode("");
          setManualCodeMsg("");
          fetchConfig();
          fetchAccountSets(Object.keys(accountSets).includes(provider) ? Object.keys(accountSets) : [...Object.keys(accountSets), provider]);
          fetchProviderQuotas(true);
          setModelsRefreshToken(n => n + 1);
          finished = true;
          break;
        }
      }
      if (!finished && oauthLoginGenerationRef.current.get(provider) === generation && aliveRef.current) {
        // Browser abandoned / never completed — stop waiting and cancel the server flow.
        await fetch(`${apiBase}/api/oauth/login/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider }),
        }).catch(() => {});
        notify(t("prov.loginTimeout", { provider: oauthLabel(provider) }), false);
        setLoginInfo(null);
      }
    } catch {
      if (oauthLoginGenerationRef.current.get(provider) === generation) {
        notify(t("prov.loginRequestFail", { provider: oauthLabel(provider) }), false);
      }
    } finally {
      if (aliveRef.current && oauthLoginGenerationRef.current.get(provider) === generation) setBusy(null);

    }
  };

  const requestLoginOAuth = (provider: string, addAccount = false) => {
    if (busy === provider) return;
    if (oauthTosRisk(provider)) {
      setOauthTosPending({ provider, addAccount });
      return;
    }
    void loginOAuth(provider, addAccount);
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
    try {
      const res = await fetch(`${apiBase}/api/oauth/logout?provider=${encodeURIComponent(provider)}`, { method: "POST" });
      if (!res.ok) {
        notify(t("prov.logoutFail", { provider: oauthLabel(provider) }), false);
        return;
      }
      await Promise.all([
        fetchAccountSets([provider]),
        fetchOauth(),
        fetchConfig(),
        fetchProviderQuotas(true),
      ]);
      setModelsRefreshToken(n => n + 1);
      notify(t("prov.logoutOk", { provider: oauthLabel(provider) }), true);
    } catch {
      notify(t("prov.logoutFail", { provider: oauthLabel(provider) }), false);
    }
  };

  const removeProvider = async (name: string) => {
    setRemoveConfirmName(name);
  };

  const confirmRemoveProvider = async () => {
    const name = removeConfirmName;
    if (!name || removeBusyRef.current) return;
    removeBusyRef.current = true;
    setRemoveConfirmName(null);
    const fallback = t("prov.removeFail", { name });
    try {
      const res = await fetch(`${apiBase}/api/providers?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      if (res.ok) {
        notify(t("prov.removed", { name }), true);
        if (workspaceSelected === name) setWorkspaceSelected(null);
        fetchConfig();
        fetchOauth();
        fetchProviderQuotas(true);
      } else {
        notify(await apiErrorMessage(res, fallback), false);
      }
    } catch {
      notify(fallback, false);
    } finally {
      removeBusyRef.current = false;
    }
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

  const addModalAccountRows = [
    ...Object.entries(config.providers)
      .filter(([, prov]) => prov.authMode === "forward")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name]) => ({
        id: name,
        label: formatProviderDisplayName(name),
        kind: "codex" as const,
        href: "#codex-auth",
      })),
    ...[...oauthProviders]
      .sort((a, b) => a.localeCompare(b))
      .map(id => ({ id, label: oauthLabel(id), kind: "oauth" as const })),
    ...Object.entries(config.providers)
      .filter(([name, prov]) =>
        (prov.hasApiKey || prov.keyOptional)
        && prov.authMode !== "oauth"
        && prov.authMode !== "forward"
        && !oauthProviders.includes(name))
      .map(([name, prov]) => ({
        id: name,
        label: name,
        kind: "key" as const,
        statusLabel: prov.keyOptional && !prov.hasApiKey ? t("modal.badge.free") : t("prov.hasApiKey"),
      })),
  ];

  const isForwardProvider = (name: string) => config.providers[name]?.authMode === "forward";

  const accountLoginStatus: Record<string, OAuthStatus> = { ...oauthStatus };
  const codexStatus = oauthStatus.openai;
  if (codexStatus) {
    for (const [name, prov] of Object.entries(config.providers)) {
      if (prov.authMode === "forward") accountLoginStatus[name] = codexStatus;
    }
  }

  const onAccountLogin = (provider: string) => {
    if (isForwardProvider(provider)) {
      setCodexLoginOpen(true);
      return;
    }
    // API-key rows have no OAuth login path (catalog hides the button).
    if (config.providers[provider]?.authMode === "oauth" || oauthProviders.includes(provider)) {
      requestLoginOAuth(provider);
    }
  };

  const bumpModelsRefresh = () => setModelsRefreshToken(n => n + 1);

  const codexLoginModal = codexLoginOpen ? (
    <AddCodexAccountModal
      apiBase={apiBase}
      onClose={() => setCodexLoginOpen(false)}
      onAdded={() => {
        setCodexLoginOpen(false);
        notify(t("prov.loginOk", { provider: formatProviderDisplayName("openai"), cmd: "ocx sync" }), true);
        void fetchOauth();
        void fetchProviderQuotas(true);
        bumpModelsRefresh();
      }}
    />
  ) : null;

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
          onEditConfig={openJsonEditor}
          jsonEditor={{
            open: jsonEditorOpen,
            draft,
            isDirty: jsonIsDirty,
            onDraftChange: setDraft,
            onSave: () => saveConfig(),
            onClose: requestCloseJsonEditor,
            onRestore: restoreJsonEditor,
          }}
          jsonSaving={jsonSaving}
          modelsRefreshToken={modelsRefreshToken}
          activeAccountNeedsReauth={activeAccountNeedsReauth}
          detail={(item, data) => {
            const loginStatus = accountLoginStatus[item.name] ?? oauthStatus[item.name];
            return (
            <ProviderDetails
              key={item.name}
              item={item}
              usageTotals={data.usageTotals}
              quotaReport={data.quotaReport}
              availableModels={data.availableModels}
              selectedModels={data.selectedModels}
              modelsLoading={data.modelsLoading}
              modelsLoadFailed={data.modelsLoadFailed}
              onRetryModels={data.onRetryModels}
              oauthEmail={loginStatus?.email}
              onDeselect={() => setWorkspaceSelected(null)}
              apiBase={apiBase}
              oauth={loginStatus}
              accounts={accountSets[item.name]?.accounts ?? []}
              keys={keyPools[item.name] ?? []}
              accountLoadState={accountLoadStates[item.name] ?? (item.authMode === "oauth" ? "idle" : "ready")}
              switchingAccountId={switchingAccount?.provider === item.name ? switchingAccount.accountId : null}
              busyProvider={busy}
              loginHint={loginInfo}
              authHandlers={{
                onLogin: requestLoginOAuth,
                onCancelLogin: cancelLoginOAuth,
                onLogout: logoutOAuth,
                onReauth: (provider, accountId) => loginOAuth(provider, true, accountId),
                onSwitchAccount: switchAccount,
                onRemoveAccount: removeAccount,
                onRetryAccounts: async provider => { await fetchAccountSets([provider]); },
                onAddApiKey: addApiKeyValue,
                onSwitchApiKey: switchApiKey,
                onRemoveApiKey: removeApiKey,
              }}
              isDefault={item.name === config.defaultProvider}
              onRemoveProvider={removeProvider}
              onSetDisabled={setProviderDisabled}
              onUpdateProvider={updateProvider}
              onCodexActiveNeedsReauthChange={setCodexActiveNeedsReauth}
            />
            );
          }}
        />
        {adding && (
          <AddProviderModal
            apiBase={apiBase}
            existingNames={Object.keys(config.providers)}
            initialTier={addIntent?.tier}
            initialCustom={addIntent?.custom}
            onClose={() => {
              if (busy) void cancelLoginOAuth(busy);
              setAdding(false);
              setAddIntent(null);
            }}
            onAdded={(name) => { setAdding(false); setAddIntent(null); notify(t("prov.added", { name, cmd: "ocx sync" }), true); fetchConfig(); fetchOauth(); fetchProviderQuotas(true); bumpModelsRefresh(); }}
            accountRows={addModalAccountRows}
            accountStatus={accountLoginStatus}
            accountBusy={busy}
            onAccountLogin={onAccountLogin}
            onAccountCancelLogin={(provider) => { void cancelLoginOAuth(provider); }}
            onAccountLogout={(provider) => { void logoutOAuth(provider); }}
            onOpen={fetchOauth}
          />
        )}
        {codexLoginModal}
        {removeConfirmName && (
          <RemoveConfirmDialog
            providerName={removeConfirmName}
            onCancel={() => setRemoveConfirmName(null)}
            onConfirm={() => { void confirmRemoveProvider(); }}
          />
        )}
        {jsonLeaveOpen && (
          <UnsavedLeaveDialog
            saving={jsonSaving}
            onCancel={() => { if (!jsonSaving) setJsonLeaveOpen(false); }}
            onDiscard={discardJsonEditor}
            onSave={() => { void saveConfig(); }}
          />
        )}
        {oauthTosPending && (
          <OAuthTosWarningModal
            key={`${oauthTosPending.provider}:${oauthTosPending.addAccount ? "add" : "login"}`}
            providerId={oauthTosPending.provider}
            providerLabel={oauthLabel(oauthTosPending.provider)}
            onCancel={() => setOauthTosPending(null)}
            onContinue={() => {
              const pending = oauthTosPending;
              if (!pending) return;
              setOauthTosPending(null);
              void loginOAuth(pending.provider, pending.addAccount);
            }}
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
                  ) : isBusy ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => { void cancelLoginOAuth(p); }}>{t("common.cancel")}</button>
                  ) : (
                    <button className="btn btn-primary btn-sm" onClick={() => requestLoginOAuth(p)} disabled={isBusy}>
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
                      {isBusy && (
                        <button className="btn btn-ghost btn-sm" type="button" onClick={() => void cancelLoginOAuth(p)}>
                          {t("common.cancel")}
                        </button>
                      )}
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
      )}
      {adding && (
        <AddProviderModal
          apiBase={apiBase}
          existingNames={Object.keys(config.providers)}
          onClose={() => {
            if (busy) void cancelLoginOAuth(busy);
            setAdding(false);
          }}
          onAdded={(name) => { setAdding(false); notify(t("prov.added", { name, cmd: "ocx sync" }), true); fetchConfig(); fetchOauth(); fetchProviderQuotas(true); setModelsRefreshToken(n => n + 1); }}
          accountRows={addModalAccountRows}
          accountStatus={accountLoginStatus}
          accountBusy={busy}
          onAccountLogin={onAccountLogin}
          onAccountCancelLogin={(provider) => { void cancelLoginOAuth(provider); }}
          onAccountLogout={(provider) => { void logoutOAuth(provider); }}
          onOpen={fetchOauth}
        />
      )}
      {codexLoginModal}
      {removeConfirmName && (
        <RemoveConfirmDialog
          providerName={removeConfirmName}
          onCancel={() => setRemoveConfirmName(null)}
          onConfirm={() => { void confirmRemoveProvider(); }}
        />
      )}
      {oauthTosPending && (
        <OAuthTosWarningModal
          key={`${oauthTosPending.provider}:${oauthTosPending.addAccount ? "add" : "login"}`}
          providerId={oauthTosPending.provider}
          providerLabel={oauthLabel(oauthTosPending.provider)}
          onCancel={() => setOauthTosPending(null)}
          onContinue={() => {
            const pending = oauthTosPending;
            if (!pending) return;
            setOauthTosPending(null);
            void loginOAuth(pending.provider, pending.addAccount);
          }}
        />
      )}
    </>
  );
}
