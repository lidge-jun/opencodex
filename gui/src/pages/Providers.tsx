import { useCallback, useEffect, useRef, useState } from "react";
import AddProviderModal from "../components/AddProviderModal";
import AddCodexAccountModal from "../components/AddCodexAccountModal";
import OAuthTosWarningModal from "../components/OAuthTosWarningModal";
import ProviderWorkspaceShell, { type AddProviderIntent } from "../components/provider-workspace/ProviderWorkspaceShell";
import ProviderDetails from "../components/provider-workspace/ProviderDetails";
import { RemoveConfirmDialog, UnsavedLeaveDialog } from "../components/provider-workspace/ProviderDialogs";
import type { WorkspaceProvider } from "../provider-workspace/catalog";
import type { ProviderUpdatePatch } from "../components/provider-workspace/types";
import { oauthTosRisk } from "../oauth-tos-risk";
import { Notice } from "../ui";
import { IconPlus } from "../icons";
import { useT } from "../i18n";
import type { AccountQuota } from "../codex-quota-utils";
import { providerIconSrc, formatProviderDisplayName } from "../provider-icons";
import { apiErrorMessage } from "../api-error";
import { useProviderAccountPools } from "../hooks/useProviderAccountPools";
import { useJsonConfigEditor } from "../hooks/useJsonConfigEditor";
import { OAuthPanel } from "../components/providers/OAuthPanel";
import { ProviderCardList } from "../components/providers/ProviderCardList";

interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, { adapter: string; baseUrl: string; hasApiKey?: boolean; hasHeaders?: boolean; defaultModel?: string; models?: string[]; liveModels?: boolean; authMode?: string; keyOptional?: boolean; disabled?: boolean; note?: string; codexAccountMode?: "direct" | "pool" }>;
}

interface OAuthStatus { loggedIn: boolean; email?: string; error?: string; done?: boolean; needsReauth?: boolean; activeAccountId?: string | null }
interface ProviderQuotaReport { provider: string; quota: AccountQuota; source: string; updatedAt: number }
interface OAuthAccount { id: string; alias?: string; email?: string; active: boolean; needsReauth?: boolean; expiresAt?: number }
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
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState("");
  const [statusOk, setStatusOk] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
  const [quotaReports, setQuotaReports] = useState<Record<string, ProviderQuotaReport>>({});
  const [usageTotals, setUsageTotals] = useState<Record<string, { requests?: number; totalTokens?: number }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [loginInfo, setLoginInfo] = useState<{ provider: string; url?: string; instructions?: string; deviceCode?: string } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [deviceCodeCopied, setDeviceCodeCopied] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [manualCodeBusy, setManualCodeBusy] = useState(false);
  const [manualCodeMsg, setManualCodeMsg] = useState("");
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
  const [removeConfirmName, setRemoveConfirmName] = useState<string | null>(null);
  /** ChatGPT/Codex login from Add Provider → Accounts (uses /api/codex-auth, not /api/oauth). */
  const [codexLoginOpen, setCodexLoginOpen] = useState(false);
  const [modelsRefreshToken, setModelsRefreshToken] = useState(0);
  const [oauthTosPending, setOauthTosPending] = useState<{ provider: string; addAccount: boolean } | null>(null);
  const [codexActiveNeedsReauth, setCodexActiveNeedsReauth] = useState(false);
  const aliveRef = useRef(true);
  const removeBusyRef = useRef(false);
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

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/usage?range=30d`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { providers?: Array<{ provider: string; requests: number; totalTokens?: number }> } | null) => {
        if (cancelled || !data) return;
        setUsageTotals(Object.fromEntries((data.providers ?? []).map(row => [row.provider, { requests: row.requests, totalTokens: row.totalTokens }])));
      })
      .catch(() => {});
    return () => { cancelled = true; };
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

  const pools = useProviderAccountPools({
    apiBase, t: t as unknown as Parameters<typeof useProviderAccountPools>[0]["t"],
    config, oauthStatus, aliveRef,
    notify: (msg, ok) => { setStatus(msg); setStatusOk(!!ok); },
    fetchConfig, fetchOauth, fetchProviderQuotas, codexActiveNeedsReauth,
  });
  const {
    accountSets, accountLoadStates, switchingAccount, openAccounts, keyPools, addingKeyFor, newKeyValue,
    setOpenAccounts, setAddingKeyFor, setNewKeyValue, fetchAccountSets,
    switchAccount, switchApiKey, removeApiKey, addApiKeyValue, addApiKey, editCredentialAlias,
    removeAccount, keyCardProviders, activeAccountNeedsReauth,
  } = pools;
  const jsonEditor = useJsonConfigEditor({
    apiBase, config,
    notify: (msg, ok) => { setStatus(msg); setStatusOk(!!ok); },
    fetchConfig, fetchProviderQuotas, onSaved: () => setModelsRefreshToken(n => n + 1),
    t: t as unknown as Parameters<typeof useJsonConfigEditor>[0]["t"],
  });
  const {
    editing, setEditing, draft, setDraft, jsonEditorOpen, jsonSaving, jsonLeaveOpen,
    saveConfig, openJsonEditor, discardJsonEditor, requestCloseJsonEditor, restoreJsonEditor,
    jsonIsDirty, setJsonLeaveOpen,
  } = jsonEditor;

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
      if (data.url || data.instructions || data.deviceCode) {
        setLoginInfo({ provider, url: data.url, instructions: data.instructions, deviceCode: data.deviceCode });
      }
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
            <button className="btn btn-primary" onClick={() => { setAddIntent(null); setAdding(true); }}><IconPlus />{t("prov.add")}</button>
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
              modelUsage={data.modelUsage}
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
                onEditAlias: editCredentialAlias,
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
              <button className="btn btn-primary" onClick={() => { setAddIntent(null); setAdding(true); }}><IconPlus />{t("prov.add")}</button>
              <button className="btn btn-ghost" onClick={() => setEditing(true)}>{t("prov.editJson")}</button>
            </>
          )}
        </div>
      </div>
      <p className="page-sub">{t("prov.subtitle")}</p>

      {status && <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>}

      <OAuthPanel
        t={t} oauthProviders={oauthProviders} keyProviders={keyCardProviders}
        oauthStatus={accountLoginStatus} busy={busy} loginInfo={loginInfo}
        linkCopied={linkCopied} deviceCodeCopied={deviceCodeCopied}
        manualCode={manualCode} manualCodeBusy={manualCodeBusy} manualCodeMsg={manualCodeMsg}
        config={config} setLinkCopied={setLinkCopied}
        setDeviceCodeCopied={setDeviceCodeCopied} setManualCode={setManualCode}
        cancelLoginOAuth={cancelLoginOAuth}
        logoutOAuth={logoutOAuth} submitManualCode={submitManualCode}
        providerIconSrc={providerIconSrc} oauthLabel={oauthLabel}
        onAddProvider={intent => { setAddIntent(intent); setAdding(true); }}
      />

      {editing ? (
        <textarea
          className="input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          style={{ height: 400 }}
        />
      ) : (
        <ProviderCardList
          t={t} config={config} quotaReports={quotaReports} usageTotals={usageTotals}
          accountSets={accountSets} keyPools={keyPools} openAccounts={openAccounts}
          addingKeyFor={addingKeyFor} newKeyValue={newKeyValue}
          busy={busy} modeBusy={modeBusy} activeAccountNeedsReauth={activeAccountNeedsReauth}
          setOpenAccounts={setOpenAccounts} setAddingKeyFor={setAddingKeyFor}
          setNewKeyValue={setNewKeyValue} loginOAuth={loginOAuth}
          requestLoginOAuth={requestLoginOAuth} setOpenAiAccountMode={setOpenAiAccountMode}
          setProviderDisabled={setProviderDisabled} removeProvider={removeProvider}
          switchAccount={switchAccount} removeAccount={removeAccount}
          switchApiKey={switchApiKey} removeApiKey={removeApiKey} addApiKey={addApiKey}
          providerIconSrc={providerIconSrc}
          resolvedOpenAiAccountMode={resolvedOpenAiAccountMode}
        />
      )}
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
          onAdded={(name) => { setAdding(false); setAddIntent(null); notify(t("prov.added", { name, cmd: "ocx sync" }), true); fetchConfig(); fetchOauth(); fetchProviderQuotas(true); setModelsRefreshToken(n => n + 1); }}
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
