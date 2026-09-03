import { usageSummary30dResourceKey } from "../usage-summary-resource";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ProviderWorkspaceShell, { type AddProviderIntent } from "../components/provider-workspace/ProviderWorkspaceShell";
import ProviderDetails from "../components/provider-workspace/ProviderDetails";
import type { WorkspaceProvider } from "../provider-workspace/catalog";
import { ensureOpenAiProvider, openAiAccountProviderState, OpenAiEnableError } from "../provider-payload";
import { oauthTosRisk } from "../oauth-tos-risk";
import { ToastNotice, type NoticeTone } from "../ui";
import { IconPlus } from "../icons";
import { useT } from "../i18n/shared";
import { useProviderAccountPools } from "../hooks/useProviderAccountPools";
import { useCodexAccountPool } from "../hooks/useCodexAccountPool";
import { useJsonConfigEditor } from "../hooks/useJsonConfigEditor";
import { useKeyedClientResource } from "../client-resource";
import { readSessionListCache } from "../session-list-cache";
import type { ProvidersConfig } from "./providers-shared";
import { useProvidersOAuth } from "./use-providers-oauth";
import { useProvidersCrud } from "./use-providers-crud";
import { useProvidersFetch } from "./use-providers-fetch";
import { ProvidersPageModals } from "./providers-page-modals";
import { buildAccountLoginStatus, buildAddModalAccountRows } from "./providers-page-utils";
import type { CodexAccountMutationCompletion } from "../codex-account-mutation";

export default function Providers({ apiBase }: { apiBase: string }) {
  const t = useT();
  const configCacheKey = `ocx.providers.config.v1:${apiBase}`;
  const [config, setConfig] = useState<ProvidersConfig | null>(
    () => readSessionListCache<ProvidersConfig>(configCacheKey),
  );
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState("");
  const [statusOk, setStatusOk] = useState(false);
  const [statusTone, setStatusTone] = useState<NoticeTone>("err");
  /** Bumped on every notify so repeated identical success toasts restart the dismiss timer. */
  const [statusRevision, setStatusRevision] = useState(0);
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);
  const [oauthStatus, setOauthStatus] = useState<Record<string, import("./providers-shared").OAuthStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loginInfo, setLoginInfo] = useState<{ provider: string; url?: string; instructions?: string; deviceCode?: string } | null>(null);
  const [workspaceSelected, setWorkspaceSelected] = useState<string | null>(null);
  const [addIntent, setAddIntent] = useState<AddProviderIntent | null>(null);
  const [removeConfirmName, setRemoveConfirmName] = useState<string | null>(null);
  /** ChatGPT/Codex login from Add Provider → Accounts (uses /api/codex-auth, not /api/oauth). */
  const [codexLoginOpen, setCodexLoginOpen] = useState(false);
  const [modelsRefreshToken, setModelsRefreshToken] = useState(0);
  // `accountId` rides along so acknowledging the warning continues the SAME operation.
  // Without it, a reauth that reached the modal would resume as a plain login and target
  // the active account instead of the one the user clicked.
  const [oauthTosPending, setOauthTosPending] = useState<
    { provider: string; addAccount: boolean; accountId?: string } | null
  >(null);
  /** Bumped after OAuth login so ProviderDetails switches to the Accounts tab. */
  const [accountsFocus, setAccountsFocus] = useState<{ token: number; provider: string | null }>({
    token: 0,
    provider: null,
  });
  const aliveRef = useRef(true);
  // Which apiBase this instance has already bootstrapped. StrictMode double-invokes the mount
  // effect and its deferred load is deliberately uncancellable, so the guard lives here.
  const bootstrapKeyRef = useRef<string | null>(null);
  const removeBusyRef = useRef(false);

  const notify = useCallback((msg: string, ok: boolean = true) => {
    setStatus(msg);
    setStatusOk(ok);
    setStatusTone(ok ? "ok" : "err");
    setStatusRevision(revision => revision + 1);
  }, []);

  const clearStatus = useCallback(() => {
    setStatus("");
    setStatusOk(false);
    setStatusTone("err");
  }, []);

  const notifyCodexCompletion = useCallback((completion: CodexAccountMutationCompletion) => {
    if (completion.catalogRefreshPending) {
      setStatus(t("codexAuth.catalogRefreshPending"));
      setStatusOk(false);
      setStatusTone("warn");
      setStatusRevision(revision => revision + 1);
      return;
    }
    notify(t("codexAuth.accountAdded"), true);
  }, [notify, t]);

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  // Success toasts are transient; errors stay until the next notify or dismiss.
  useEffect(() => {
    if (!status || !statusOk) return;
    const timer = window.setTimeout(clearStatus, 4500);
    return () => window.clearTimeout(timer);
  }, [status, statusOk, statusRevision, clearStatus]);

  const revealProviderAccounts = useCallback((provider: string) => {
    setAdding(false);
    setAddIntent(null);
    setWorkspaceSelected(provider);
    setAccountsFocus(previous => ({ token: previous.token + 1, provider }));
  }, []);
  // Providers hash sync is owned by App (passive replaceHash / deliberate navigateHash).

  // Warm the Add Provider catalog cache while the page is open so opening the
  // modal does not wait on a cold /api/provider-presets round-trip (~same key as
  // AddProviderModal). Prefetch usage too so the catalog does not paint alpha then
  // re-rank when the slow usage probe (~5s cold) finally returns.
  useKeyedClientResource(
    `add-provider-presets:${apiBase}`,
    [apiBase],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/provider-presets`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json() as { providers?: unknown[] };
      return Array.isArray(data.providers) && data.providers.length > 0 ? data.providers : null;
    },
  );
  useKeyedClientResource(
    usageSummary30dResourceKey(apiBase),
    [apiBase],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/usage?range=30d`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      return await res.json() as { providers?: Array<{ provider: string; requests: number }> };
    },
    { deadlineMs: 60_000 }, // shared usage-summary key: all four subscribers raise the deadline together
  );
  /*
   * Quota revalidation is driven by an explicit revision, not by anything derived from
   * `accountSets`.
   *
   * The derived key was a sorted `provider:activeAccountId` string, which looked stable but
   * is not: on a cold load each provider's account response arrives separately and fills in
   * its own `activeAccountId`, so the joined string changed once per provider and the shell's
   * quota effect re-ran with it. Measured on this checkout: six `/api/provider-quotas` reads
   * inside 15ms where one answers the question.
   *
   * A counter only moves when something actually invalidates the quotas, so account arrival
   * is silent while every real mutation path still forces a re-read.
   */
  const [quotaRefresh, setQuotaRefresh] = useState({ epoch: 0, force: false });
  const invalidateProviderQuotas = useCallback((force = false) => {
    setQuotaRefresh(previous => ({ epoch: previous.epoch + 1, force }));
  }, []);
  const { fetchConfig, fetchOauth, fetchProviderQuotas } = useProvidersFetch({
    apiBase, t, setConfig, setOauthProviders, setOauthStatus, notify,
    invalidateProviderQuotas,
    configCacheKey,
  });

  // WP3: one Codex account controller for the whole Providers page, shared by the
  // Overview tab and the Accounts tab so a mutation on either is instantly visible on
  // both. Mounting CodexAccountPool twice used to fork this state.
  const codexPool = useCodexAccountPool(apiBase);
  // Single source for Codex reauth health: the controller derives it from the same
  // accounts/active pair this page used to poll on its own 30s timer.
  const codexActiveNeedsReauth = codexPool.activeNeedsReauth;

  // Derive openai login status from the shared Codex controller (no duplicate /accounts).
  const oauthStatusWithCodex = useMemo(() => {
    const accounts = codexPool.accounts;
    if (accounts.length === 0 && codexPool.loadState === "loading") return oauthStatus;
    const main = accounts.find(a => a.isMain) ?? accounts[0];
    const mainIsReal = !!main && !!main.email && main.email !== "Codex App login";
    const poolLoggedIn = accounts.some(a => !a.isMain && (a.hasCredential || a.email));
    const codexLoggedIn = mainIsReal || poolLoggedIn;
    const codexEmail = mainIsReal
      ? main?.email
      : (accounts.find(a => !a.isMain && a.email)?.email ?? undefined);
    return {
      ...oauthStatus,
      openai: {
        loggedIn: codexLoggedIn,
        ...(codexEmail ? { email: codexEmail } : {}),
        ...(codexActiveNeedsReauth ? { needsReauth: true } : {}),
      },
    };
  }, [oauthStatus, codexPool.accounts, codexPool.loadState, codexActiveNeedsReauth]);

  const pools = useProviderAccountPools({
    apiBase, t: t as unknown as Parameters<typeof useProviderAccountPools>[0]["t"],
    config, oauthStatus: oauthStatusWithCodex, aliveRef,
    notify,
    fetchConfig, fetchOauth, fetchProviderQuotas, codexActiveNeedsReauth,
  });
  const {
    accountSets, setAccountSets, accountLoadStates, switchingAccount, keyPools, fetchAccountSets,
    switchAccount, switchApiKey, removeApiKey, addApiKeyValue, editCredentialAlias,
    removeAccount, activeAccountNeedsReauth,
  } = pools;
  const jsonEditor = useJsonConfigEditor({
    apiBase, config,
    notify,
    fetchConfig, fetchProviderQuotas, onSaved: () => setModelsRefreshToken(n => n + 1),
    t: t as unknown as Parameters<typeof useJsonConfigEditor>[0]["t"],
  });
  const {
    draft, setDraft, jsonEditorOpen, jsonSaving, jsonLeaveOpen,
    saveConfig, openJsonEditor, discardJsonEditor, requestCloseJsonEditor, restoreJsonEditor,
    jsonIsDirty, setJsonLeaveOpen,
  } = jsonEditor;

  useEffect(() => {
    // Deferred by a microtask, not a timer. A timer had to be cancelled in cleanup, so navigating
    // away within the same tick dropped both requests with nothing to retry them and the page came
    // back empty on the next visit. A microtask cannot be cancelled, so the requests always go out.
    // Guarded per identity because StrictMode double-invokes this effect on mount and an
    // uncancellable microtask would otherwise bootstrap the page twice.
    // Quotas: workspace shell owns /api/provider-quotas — do not double-fetch on mount.
    if (bootstrapKeyRef.current === apiBase) return;
    bootstrapKeyRef.current = apiBase;
    void Promise.resolve().then(() => {
      void fetchConfig();
      void fetchOauth();
    });
  }, [apiBase, fetchConfig, fetchOauth]);

  const bumpModelsRefresh = () => setModelsRefreshToken(n => n + 1);

  const { cancelLoginOAuth, loginOAuth, logoutOAuth } = useProvidersOAuth({
    apiBase, t, aliveRef, accountSets, setAccountSets,
    setBusy, setStatus, setLoginInfo, setOauthStatus, notify,
    fetchConfig, fetchOauth, fetchAccountSets, fetchProviderQuotas, bumpModelsRefresh,
    onLoginSettled: revealProviderAccounts,
  });

  const { removeProvider, confirmRemoveProvider, setProviderDisabled, setDefaultProvider, updateProvider } = useProvidersCrud({
    apiBase, t, removeBusyRef, workspaceSelected, setWorkspaceSelected, setRemoveConfirmName,
    notify, fetchConfig, fetchOauth, fetchProviderQuotas,
    // Mode PATCHes clear quota caches and thread affinity; the shared controller
    // must re-read /active (with quota) so both tabs show the post-switch state.
    refreshCodexAccount: () => codexPool.load(true),
  });

  /**
   * The single warning-aware entry point for every OAuth login.
   *
   * Reauthentication used to call `loginOAuth` directly, so a user who had already logged
   * in could refresh a high-risk credential without ever seeing the ToS modal — the map
   * gated the first login and nothing after it.
   */
  const requestLoginOAuth = (provider: string, addAccount = false, accountId?: string) => {
    if (busy === provider) return;
    if (oauthTosRisk(provider)) {
      setOauthTosPending({ provider, addAccount, ...(accountId ? { accountId } : {}) });
      return;
    }
    void loginOAuth(provider, addAccount, accountId);
  };

  if (!config) {
    return (
      <>
        <div className="page-head">
          <h2>{t("nav.providers")}</h2>
        </div>
        {status
          ? <ToastNotice tone={statusTone} onDismiss={clearStatus} dismissLabel={t("common.close")}>{status}</ToastNotice>
          : (
            <div className="providers-workspace providers-workspace--boot" aria-busy="true">
              <div className="providers-workspace-rail providers-workspace-rail--boot" aria-hidden="true" />
              <div className="providers-workspace-main">
                <p className="muted"><span className="spin" aria-hidden="true" /> {t("prov.loadingConfig")}</p>
              </div>
            </div>
          )}
      </>
    );
  }

  const addModalAccountRows = buildAddModalAccountRows(config, oauthProviders, t);
  const accountLoginStatus = buildAccountLoginStatus(config, oauthStatusWithCodex);
  const isForwardProvider = (name: string) => config.providers[name]?.authMode === "forward";

  const onAccountLogin = async (provider: string, addAccount = false) => {
    if (provider === "openai") {
      if (busy === "openai") return;
      const configured = config.providers.openai;
      const state = openAiAccountProviderState(configured);
      if (state === "invalid") {
        notify(t("codexAuth.openaiMissing"), false);
        return;
      }
      if (state === "absent" || state === "disabled") {
        setBusy("openai");
        try {
          await ensureOpenAiProvider(apiBase, state);
          await fetchConfig();
        } catch (error) {
          if (error instanceof OpenAiEnableError) {
            notify(t(error.i18nKey), false);
          } else {
            notify(error instanceof Error ? error.message : t("prov.saveFailed"), false);
          }
          return;
        } finally {
          if (aliveRef.current) setBusy(current => current === "openai" ? null : current);
        }
      }
      setCodexLoginOpen(true);
      return;
    }
    if (isForwardProvider(provider)) {
      setCodexLoginOpen(true);
      return;
    }
    // API-key rows have no OAuth login path (catalog hides the button).
    if (config.providers[provider]?.authMode === "oauth" || oauthProviders.includes(provider)) {
      requestLoginOAuth(provider, addAccount);
    }
  };

  const onAccountManage = (provider: string) => {
    revealProviderAccounts(provider);
  };

  return (
    <>
      <div className="page-head">
        <h2>{t("nav.providers")}</h2>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}><IconPlus />{t("prov.add")}</button>
        </div>
      </div>
      {status && (
        <ToastNotice tone={statusTone} onDismiss={clearStatus} dismissLabel={t("common.close")}>{status}</ToastNotice>
      )}
      <ProviderWorkspaceShell
        onRemoveProvider={removeProvider}
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
        quotaRefreshEpoch={quotaRefresh.epoch}
        quotaForceRefresh={quotaRefresh.force}
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
            hasLiveModels={data.hasLiveModels}
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
            accountsFocusToken={accountsFocus.token}
            accountsFocusProvider={accountsFocus.provider}
            switchingAccountId={switchingAccount?.provider === item.name ? switchingAccount.accountId : null}
            busyProvider={busy}
            loginHint={loginInfo}
            authHandlers={{
              onLogin: requestLoginOAuth,
              onCancelLogin: cancelLoginOAuth,
              onLogout: logoutOAuth,
              onReauth: (provider, accountId) => requestLoginOAuth(provider, true, accountId),
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
            onSetDefault={name => { void setDefaultProvider(name); }}
            onUpdateProvider={updateProvider}
            codexController={codexPool}
          />
          );
        }}
      />
      <ProvidersPageModals
        apiBase={apiBase}
        config={config}
        adding={adding}
        addIntent={addIntent}
        busy={busy}
        addModalAccountRows={addModalAccountRows}
        accountLoginStatus={accountLoginStatus}
        accountLoginHint={loginInfo}
        removeConfirmName={removeConfirmName}
        removeDefaultProvider={removeConfirmName === config.defaultProvider
          ? Object.entries(config.providers).find(([name, provider]) => name !== removeConfirmName && provider.disabled !== true)?.[0] ?? null
          : null}
        codexLoginOpen={codexLoginOpen}
        jsonLeaveOpen={jsonLeaveOpen}
        jsonSaving={jsonSaving}
        oauthTosPending={oauthTosPending}
        onCloseAdd={() => {
          if (busy) void cancelLoginOAuth(busy);
          setAdding(false);
          setAddIntent(null);
        }}
        onAdded={(name) => {
          setAdding(false);
          setAddIntent(null);
          notify(t("prov.added", { name, cmd: "ocx sync" }), true);
          fetchConfig();
          fetchOauth();
          fetchProviderQuotas(true);
          bumpModelsRefresh();
        }}
        onAccountLogin={onAccountLogin}
        onAccountCancelLogin={(provider) => { void cancelLoginOAuth(provider); }}
        onAccountLogout={(provider) => { void logoutOAuth(provider); }}
        onAccountManage={onAccountManage}
        onOpenAdd={fetchOauth}
        onCloseCodexLogin={() => setCodexLoginOpen(false)}
        onCodexAdded={(completion) => {
          setCodexLoginOpen(false);
          notifyCodexCompletion(completion);
          void fetchConfig();
          void fetchOauth();
          void fetchProviderQuotas(true);
          bumpModelsRefresh();
        }}
        onCancelRemove={() => setRemoveConfirmName(null)}
        onConfirmRemove={() => { void confirmRemoveProvider(removeConfirmName); }}
        onCancelJsonLeave={() => { if (!jsonSaving) setJsonLeaveOpen(false); }}
        onDiscardJson={discardJsonEditor}
        onSaveJson={() => { void saveConfig(); }}
        onCancelOauthTos={() => setOauthTosPending(null)}
        onContinueOauthTos={() => {
          const pending = oauthTosPending;
          if (!pending) return;
          setOauthTosPending(null);
          void loginOAuth(pending.provider, pending.addAccount, pending.accountId);
        }}
      />
    </>
  );
}
