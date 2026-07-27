import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ProviderWorkspaceShell, { type AddProviderIntent } from "../components/provider-workspace/ProviderWorkspaceShell";
import ProviderDetails from "../components/provider-workspace/ProviderDetails";
import type { WorkspaceProvider } from "../provider-workspace/catalog";
import { ensureOpenAiProvider, openAiAccountProviderState, OpenAiEnableError } from "../provider-payload";
import { oauthTosRisk } from "../oauth-tos-risk";
import { Notice } from "../ui";
import { IconPlus } from "../icons";
import { useT } from "../i18n/shared";
import { formatProviderDisplayName } from "../provider-icons";
import { useProviderAccountPools } from "../hooks/useProviderAccountPools";
import { useCodexAccountPool } from "../hooks/useCodexAccountPool";
import { useJsonConfigEditor } from "../hooks/useJsonConfigEditor";
import type { ProvidersConfig } from "./providers-shared";
import { useProvidersOAuth } from "./use-providers-oauth";
import { useProvidersCrud } from "./use-providers-crud";
import { useProvidersFetch } from "./use-providers-fetch";
import { ProvidersPageModals } from "./providers-page-modals";
import { buildAccountLoginStatus, buildAddModalAccountRows } from "./providers-page-utils";

export default function Providers({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [config, setConfig] = useState<ProvidersConfig | null>(null);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState("");
  const [statusOk, setStatusOk] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);
  const [oauthStatus, setOauthStatus] = useState<Record<string, import("./providers-shared").OAuthStatus>>({});
  // Value is unread: the workspace shell fetches its own quota view. The setter stays
  // because the refresh path still primes this cache for that shell.
  const [, setQuotaReports] = useState<Record<string, import("./providers-shared").ProviderQuotaReport>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loginInfo, setLoginInfo] = useState<{ provider: string; url?: string; instructions?: string; deviceCode?: string } | null>(null);
  const [workspaceSelected, setWorkspaceSelected] = useState<string | null>(null);
  const [addIntent, setAddIntent] = useState<AddProviderIntent | null>(null);
  const [removeConfirmName, setRemoveConfirmName] = useState<string | null>(null);
  /** ChatGPT/Codex login from Add Provider → Accounts (uses /api/codex-auth, not /api/oauth). */
  const [codexLoginOpen, setCodexLoginOpen] = useState(false);
  const [modelsRefreshToken, setModelsRefreshToken] = useState(0);
  const [oauthTosPending, setOauthTosPending] = useState<{ provider: string; addAccount: boolean } | null>(null);
  const aliveRef = useRef(true);
  const removeBusyRef = useRef(false);
  const oauthLoginGenerationRef = useRef<Map<string, number>>(new Map());

  const notify = useCallback((msg: string, ok: boolean = true) => {
    setStatus(msg);
    setStatusOk(ok);
  }, []);

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  // Providers hash sync is owned by App (passive replaceHash / deliberate navigateHash).

  const { fetchConfig, fetchOauth, fetchProviderQuotas } = useProvidersFetch({
    apiBase, t, setConfig, setOauthProviders, setOauthStatus, setQuotaReports, notify,
  });

  // WP3: one Codex account controller for the whole Providers page, shared by the
  // Overview tab and the Accounts tab so a mutation on either is instantly visible on
  // both. Mounting CodexAccountPool twice used to fork this state.
  const codexPool = useCodexAccountPool(apiBase);
  // Single source for Codex reauth health: the controller derives it from the same
  // accounts/active pair this page used to poll on its own 30s timer.
  const codexActiveNeedsReauth = codexPool.activeNeedsReauth;

  const pools = useProviderAccountPools({
    apiBase, t: t as unknown as Parameters<typeof useProviderAccountPools>[0]["t"],
    config, oauthStatus, aliveRef,
    notify,
    fetchConfig, fetchOauth, fetchProviderQuotas, codexActiveNeedsReauth,
  });
  const {
    accountSets, accountLoadStates, switchingAccount, keyPools, fetchAccountSets,
    switchAccount, switchApiKey, removeApiKey, addApiKeyValue, editCredentialAlias,
    removeAccount, activeAccountNeedsReauth,
  } = pools;
  const quotaRefreshKey = useMemo(
    () => Object.entries(accountSets)
      .map(([provider, set]) => `${provider}:${set.activeAccountId ?? ""}`)
      .sort()
      .join("|"),
    [accountSets],
  );
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
    const timeout = window.setTimeout(() => {
      void fetchConfig();
      void fetchOauth();
      void fetchProviderQuotas();
    }, 0);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [fetchConfig, fetchOauth, fetchProviderQuotas]);

  const bumpModelsRefresh = () => setModelsRefreshToken(n => n + 1);

  const { cancelLoginOAuth, loginOAuth, logoutOAuth } = useProvidersOAuth({
    apiBase, t, aliveRef, oauthLoginGenerationRef, accountSets,
    setBusy, setStatus, setLoginInfo, setOauthStatus, notify,
    fetchConfig, fetchOauth, fetchAccountSets, fetchProviderQuotas, bumpModelsRefresh,
  });

  const { removeProvider, confirmRemoveProvider, setProviderDisabled, updateProvider } = useProvidersCrud({
    apiBase, t, removeBusyRef, workspaceSelected, setWorkspaceSelected, setRemoveConfirmName,
    notify, fetchConfig, fetchOauth, fetchProviderQuotas,
  });

  const requestLoginOAuth = (provider: string, addAccount = false) => {
    if (busy === provider) return;
    if (oauthTosRisk(provider)) {
      setOauthTosPending({ provider, addAccount });
      return;
    }
    void loginOAuth(provider, addAccount);
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

  const addModalAccountRows = buildAddModalAccountRows(config, oauthProviders);
  const accountLoginStatus = buildAccountLoginStatus(config, oauthStatus);
  const isForwardProvider = (name: string) => config.providers[name]?.authMode === "forward";

  const onAccountLogin = async (provider: string) => {
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
      requestLoginOAuth(provider);
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>{t("nav.providers")}</h2>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}><IconPlus />{t("prov.add")}</button>
        </div>
      </div>
      {status && <Notice tone={statusOk ? "ok" : "err"}>{status}</Notice>}
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
        quotaRefreshKey={quotaRefreshKey}
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
        removeConfirmName={removeConfirmName}
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
        onOpenAdd={fetchOauth}
        onCloseCodexLogin={() => setCodexLoginOpen(false)}
        onCodexAdded={() => {
          setCodexLoginOpen(false);
          notify(t("prov.loginOk", { provider: formatProviderDisplayName("openai"), cmd: "ocx sync" }), true);
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
          void loginOAuth(pending.provider, pending.addAccount);
        }}
      />
    </>
  );
}
