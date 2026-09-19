/**
 * ProviderAuthPanel — OAuth accounts, API-key pool, and forward-auth
 * embedding for the workspace Settings tab (WP091). Consumes WP040+WP060
 * handlers via props-down; no internal auth machinery.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { IconLock, IconRefresh, IconTrash } from "../../icons";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { oauthAccountDisplayLabel, providerAuthSurface } from "../../provider-workspace/auth";
import { oauthHealthShowsReauth } from "../../oauth-health-display";
import CodexAccountPool from "../CodexAccountPool";
import AnthropicAccountPoolSettings from "./AnthropicAccountPoolSettings";
import { LoginHint as LoginHintView } from "../login-url-block";
import { OpenBrowserPrefToggle } from "../open-browser-pref-toggle";
import ProviderAccountQuota from "./ProviderAccountQuota";
import ProviderAccountsToolbar from "./ProviderAccountsToolbar";
import ProviderAccountCard from "./ProviderAccountCard";
import {
  analyzeAccountQuota,
  filterAccounts,
  sortAccounts,
  type AccountFilterKey,
  type AccountSortKey,
  type AccountDisplayKey,
  type AccountViewModeKey,
} from "./account-quota-analysis";
import { getPoolSettings, putPoolSettings } from "../../pool-settings";
import { normalizeAccountPoolStrategy, type AccountPoolStrategy } from "../../account-pool-strategy";
import { DEFAULT_ACCOUNT_POOL_STRATEGY } from "../../account-pool-strategy";
import { RemoveAccountConfirmDialog } from "./ProviderDialogs";
import { GrokResetCouponModal } from "./GrokResetCoupons";
import type { CodexAccountPoolController } from "../../hooks/useCodexAccountPool";
import { useGrokResetCoupons } from "../../hooks/useGrokResetCoupons";
import { Switch } from "../../ui";
import type {
  AccountLoadState,
  OAuthAccountRow,
  ApiKeyRow,
  LoginHint,
  ProviderAuthHandlers,
  ProviderUpdatePatch,
  ProviderUpdateResult,
} from "./types";

const COCKPIT_IMPORT_MAX_BYTES = 256 * 1024;
const EMPTY_OAUTH_ACCOUNTS: OAuthAccountRow[] = [];
const EMPTY_API_KEYS: ApiKeyRow[] = [];

/**
 * One predicate for "this row cannot spend a coupon right now". The read set and
 * the badge must agree: a row fetched here and hidden there is a billing RPC
 * spent on a 401.
 */
function accountShowsReauth(account: OAuthAccountRow): boolean {
  return Boolean(account.needsReauth) || oauthHealthShowsReauth(account.health?.status);
}

function XaiChatOptInControl({
  initialState,
  onUpdateProvider,
}: {
  initialState: NonNullable<WorkspaceItem["xaiResponsesOptInState"]>;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<ProviderUpdateResult>;
}) {
  const t = useT();
  const [state, setState] = useState(initialState);
  const [seenInitialState, setSeenInitialState] = useState(initialState);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (initialState !== seenInitialState) {
    setSeenInitialState(initialState);
    setState(initialState);
  }
  const mixed = state === "mixed";

  const toggle = async () => {
    if (!onUpdateProvider || saving) return;
    const next = state === false;
    setSaving(true);
    setError("");
    try {
      const result = await onUpdateProvider("xai", { xaiResponsesOptIn: next });
      if (!result.ok) {
        setError(result.error ?? t("prov.updateFail"));
        return;
      }
      setState(result.xaiResponsesOptInState ?? next);
    } catch {
      setError(t("prov.networkError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pwi-auth-optin-row">
      <div className="pwi-auth-optin-copy">
        <span className="pwi-auth-optin-label">{t("pws.xaiChatOptIn")}</span>
        <span className="pwi-auth-row-secondary">
          {t("pws.xaiChatOptInDesc")}
          {mixed && <span className="pwi-auth-optin-mixed"> {t("pws.xaiChatOptInMixed")}</span>}
        </span>
        {error && <span className="pwi-auth-optin-error" role="alert">{error}</span>}
      </div>
      <Switch
        on={state === false}
        mixed={mixed}
        onClick={() => { void toggle(); }}
        disabled={!onUpdateProvider || saving}
        label={t("pws.xaiChatOptIn")}
      />
    </div>
  );
}

type CockpitImportResult = {
  importedCount: number;
  updatedCount: number;
  failedCount: number;
  unsupportedCount: number;
};

const COCKPIT_RESULT_KEYS = new Set([
  "totalCount", "importedCount", "updatedCount", "failedCount", "unsupportedCount", "results",
]);
const COCKPIT_RESULT_STATUSES = new Set(["imported", "updated", "failed", "unsupported"]);
const COCKPIT_STATUS_CODES: Record<string, ReadonlySet<string>> = {
  imported: new Set(["imported"]),
  updated: new Set(["updated"]),
  failed: new Set([
    "invalid_record",
    "credential_rejected",
    "identity_mismatch",
    "missing_project",
    "persist_failed",
  ]),
  unsupported: new Set(["unsupported_provider", "unsupported_format"]),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeCockpitImportResult(value: unknown): CockpitImportResult | null {
  if (!isPlainObject(value) || Object.keys(value).some(key => !COCKPIT_RESULT_KEYS.has(key))) return null;
  const { totalCount, importedCount, updatedCount, failedCount, unsupportedCount, results } = value;
  if (
    !isSafeCount(totalCount)
    || !isSafeCount(importedCount)
    || !isSafeCount(updatedCount)
    || !isSafeCount(failedCount)
    || !isSafeCount(unsupportedCount)
    || !Array.isArray(results)
    || results.length !== totalCount
    || importedCount + updatedCount + failedCount + unsupportedCount !== totalCount
  ) return null;

  const observed = { imported: 0, updated: 0, failed: 0, unsupported: 0 };
  for (const [index, result] of results.entries()) {
    if (!isPlainObject(result) || Object.keys(result).some(key => !["index", "status", "code"].includes(key))) return null;
    const status = String(result.status);
    const code = String(result.code);
    if (result.index !== index || !COCKPIT_RESULT_STATUSES.has(status)) return null;
    const allowedCodes = COCKPIT_STATUS_CODES[status];
    if (!allowedCodes?.has(code)) return null;
    observed[status as keyof typeof observed] += 1;
  }
  if (
    observed.imported !== importedCount
    || observed.updated !== updatedCount
    || observed.failed !== failedCount
    || observed.unsupported !== unsupportedCount
  ) return null;
  return { importedCount, updatedCount, failedCount, unsupportedCount };
}

export default function ProviderAuthPanel({
  item, apiBase, oauth, accounts = EMPTY_OAUTH_ACCOUNTS, keys = EMPTY_API_KEYS, accountLoadState = "ready",
  switchingAccountId = null, busy = false, loginHint, authHandlers, onCodexActiveNeedsReauthChange,
  codexController, onUpdateProvider,
}: {
  item: WorkspaceItem;
  apiBase: string;
  oauth?: { loggedIn: boolean; email?: string; error?: string };
  accounts?: OAuthAccountRow[];
  keys?: ApiKeyRow[];
  accountLoadState?: AccountLoadState;
  switchingAccountId?: string | null;
  busy?: boolean;
  loginHint?: LoginHint | null;
  authHandlers?: ProviderAuthHandlers;
  onCodexActiveNeedsReauthChange?: (needs: boolean) => void;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<ProviderUpdateResult>;
  /** Shared Codex account state owned by Providers (WP3). */
  codexController?: CodexAccountPoolController;
}) {
  const t = useT();
  const [addingKey, setAddingKey] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importStatus, setImportStatus] = useState<"idle" | "invalid" | "failed" | "complete">("idle");
  const [importResult, setImportResult] = useState<CockpitImportResult | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const [manualCode, setManualCode] = useState("");
  const [manualCodeBusy, setManualCodeBusy] = useState(false);
  const [manualCodeMsg, setManualCodeMsg] = useState("");
  const [manualCodeOk, setManualCodeOk] = useState(true);
  const connectionIdentity = JSON.stringify([apiBase, item.name, accounts.find(account => account.active)?.id, keys.find(key => key.active)?.id]);
  const [quotaRefreshState, setQuotaRefreshState] = useState<{
    identity: string; refreshing: boolean; result: { ok: boolean; text: string } | null;
  }>({ identity: connectionIdentity, refreshing: false, result: null });
  const refreshingQuota = quotaRefreshState.identity === connectionIdentity && quotaRefreshState.refreshing;
  const quotaRefreshResult = quotaRefreshState.identity === connectionIdentity ? quotaRefreshState.result : null;
  const quotaRefreshGeneration = useRef(0);
  useEffect(() => {
    quotaRefreshGeneration.current += 1;
    return () => { quotaRefreshGeneration.current += 1; };
  }, [connectionIdentity]);

  const onRefreshQuota = authHandlers?.onRefreshQuota;
  const surface = providerAuthSurface({ ...item, hasApiKey: item.hasApiKey || keys.length > 0 });
  const isOauth = surface === "oauth-accounts";
  const isKeyAuth = surface === "api-keys";
  // Grok reset coupons live behind a billing RPC rather than the quota payload,
  // so the xAI rows read them once per roster instead of riding the quota probe.
  // The gate names the OAuth surface here rather than relying on the roster
  // loader three files away to leave `accounts` empty for key-auth xAI.
  const grokCouponsEnabled = isOauth && item.name === "xai" && accounts.length > 0;
  const grokAccountIds = useMemo(
    () => (grokCouponsEnabled
      ? accounts.filter(account => !accountShowsReauth(account)).map(account => account.id)
      : []),
    [grokCouponsEnabled, accounts],
  );
  const grokCoupons = useGrokResetCoupons({ apiBase, accountIds: grokAccountIds, enabled: grokCouponsEnabled });
  const [couponAccount, setCouponAccount] = useState<OAuthAccountRow | null>(null);
  const [accountToRemove, setAccountToRemove] = useState<OAuthAccountRow | null>(null);
  const [removingAccount, setRemovingAccount] = useState(false);
  const [accountFilter, setAccountFilter] = useState<AccountFilterKey>(() => {
    try {
      const saved = localStorage.getItem("ocx_account_filter");
      const valid = ["with_limits", "with_limits_gemini", "with_limits_claude", "all", "gemini_exhausted", "claude_exhausted", "fully_exhausted"];
      if (saved && valid.includes(saved)) return saved as AccountFilterKey;
    } catch { /* localStorage unavailable */ }
    return "with_limits";
  });
  const [accountSort, setAccountSort] = useState<AccountSortKey>(() => {
    try {
      const saved = localStorage.getItem("ocx_account_sort");
      const valid = ["more_headroom", "less_headroom", "reset_5h_soonest", "reset_7d_soonest"];
      if (saved && valid.includes(saved)) return saved as AccountSortKey;
    } catch { /* localStorage unavailable */ }
    return "more_headroom";
  });
  const [accountTitleMode, setAccountTitleMode] = useState<AccountDisplayKey>(() => {
    try {
      const saved = localStorage.getItem("ocx_account_title_mode");
      const valid = ["login", "masked", "alias"];
      if (saved && valid.includes(saved)) return saved as AccountDisplayKey;
    } catch { /* localStorage unavailable */ }
    return "login";
  });
  const [accountViewMode, setAccountViewMode] = useState<AccountViewModeKey>(() => {
    try {
      const saved = localStorage.getItem("ocx_account_view_mode");
      const valid = ["cards", "compact"];
      if (saved && valid.includes(saved)) return saved as AccountViewModeKey;
    } catch { /* localStorage unavailable */ }
    return "cards";
  });
  const handleFilterChange = (next: AccountFilterKey) => {
    setAccountFilter(next);
    try { localStorage.setItem("ocx_account_filter", next); } catch { /* ignore */ }
  };
  const handleSortChange = (next: AccountSortKey) => {
    setAccountSort(next);
    try { localStorage.setItem("ocx_account_sort", next); } catch { /* ignore */ }
  };
  const handleTitleModeChange = (next: AccountDisplayKey) => {
    setAccountTitleMode(next);
    try { localStorage.setItem("ocx_account_title_mode", next); } catch { /* ignore */ }
  };
  const handleViewModeChange = (next: AccountViewModeKey) => {
    setAccountViewMode(next);
    try { localStorage.setItem("ocx_account_view_mode", next); } catch { /* ignore */ }
  };
  const [accountSearch, setAccountSearch] = useState("");
  const [refreshingAccountId, setRefreshingAccountId] = useState<string | null>(null);
  const [genericPool, setGenericPool] = useState<{ enabled: boolean; strategy: AccountPoolStrategy } | null>(null);
  useEffect(() => {
    // The panel is not remounted per provider: without this, a failed read (or an
    // empty roster) leaves the previous provider's strategy on screen, and the
    // toggle would persist it under the new provider.
    setGenericPool(null);
    if (!isOauth || item.name === "openai" || item.name === "anthropic") return;
    // Pool settings govern rotation between accounts; with an empty roster there
    // is nothing to rotate, so skip the settings fetch until accounts arrive.
    if (accounts.length === 0) return;
    let cancelled = false;
    void getPoolSettings(apiBase, item.name).then(res => {
      if (cancelled || !res) return;
      setGenericPool({
        enabled: res.enabled === true || res.enabledEffective === true,
        strategy: normalizeAccountPoolStrategy(res.strategy),
      });
    });
    return () => { cancelled = true; };
  }, [apiBase, isOauth, item.name, accounts.length]);
  const handleTogglePoolEnabled = useCallback(() => {
    if (!genericPool) return;
    const nextEnabled = !genericPool.enabled;
    setGenericPool(prev => prev ? { ...prev, enabled: nextEnabled } : null);
    void putPoolSettings(apiBase, item.name, {
      enabled: nextEnabled,
      strategy: genericPool.strategy,
    });
  }, [apiBase, genericPool, item.name]);
  const handleSelectPoolStrategy = useCallback((nextStrategy: AccountPoolStrategy) => {
    if (!genericPool) return;
    setGenericPool(prev => prev ? { ...prev, strategy: nextStrategy } : null);
    void putPoolSettings(apiBase, item.name, {
      enabled: genericPool.enabled,
      strategy: nextStrategy,
    });
  }, [apiBase, genericPool, item.name]);
  const showModelFamilies = item.name === "google-antigravity";
  useEffect(() => {
    if (showModelFamilies) return;
    if (
      accountFilter === "with_limits_gemini"
      || accountFilter === "with_limits_claude"
      || accountFilter === "gemini_exhausted"
      || accountFilter === "claude_exhausted"
    ) {
      handleFilterChange("with_limits");
    }
  }, [showModelFamilies, accountFilter]);
  const analyzedAccounts = useMemo(() => {
    return accounts.map(a => analyzeAccountQuota(a, item.name));
  }, [accounts, item.name]);
  const filteredAndSortedAccounts = useMemo(() => {
    const filtered = filterAccounts(analyzedAccounts, accountFilter, accountSearch);
    return sortAccounts(filtered, accountSort, accountFilter);
  }, [analyzedAccounts, accountFilter, accountSearch, accountSort]);
  const refreshQuota = async () => {
    if (!onRefreshQuota || refreshingQuota) return;
    const generation = ++quotaRefreshGeneration.current;
    // Cleared on click so a previous "refreshed" cannot sit under a later failure.
    setQuotaRefreshState({ identity: connectionIdentity, refreshing: true, result: null });
    try {
      const ok = await onRefreshQuota(item.name);
      if (quotaRefreshGeneration.current === generation) setQuotaRefreshState({ identity: connectionIdentity, refreshing: false,
        result: { ok, text: t(ok ? "pws.quotaCheckCompleted" : "codexAuth.quotaRefreshFailed") } });
    } catch {
      if (quotaRefreshGeneration.current === generation) setQuotaRefreshState({ identity: connectionIdentity, refreshing: false,
        result: { ok: false, text: t("codexAuth.quotaRefreshFailed") } });
    }
  };

  if (surface === "codex-accounts") {
    return (
      <section className="pwi-section pwi-auth-section" aria-label={t("pws.availableAccounts")}>
        <h3 className="pwi-section-title">{t("pws.availableAccounts")}</h3>
        <div className="pwi-auth-body">
          <CodexAccountPool
            apiBase={apiBase}
            embedded
            controller={codexController}
            onActiveNeedsReauthChange={onCodexActiveNeedsReauthChange}
          />
        </div>
      </section>
    );
  }

  if (!surface || !authHandlers) return null;

  const hintForThis = loginHint?.provider === item.name ? loginHint : null;
  // Paste fallback for when the browser cannot reach the loopback callback
  // (remote dashboard, SSH, blocked localhost). A rejected paste reports why and
  // leaves the flow running, so the user can correct it and try again.
  const submitManualCode = async () => {
    const input = manualCode.trim();
    if (!input || manualCodeBusy) return;
    setManualCodeBusy(true);
    setManualCodeMsg("");
    try {
      const res = await fetch(`${apiBase}/api/oauth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: item.name, input }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setManualCodeOk(false);
        setManualCodeMsg(t("prov.pasteFail", { error: data.error || res.statusText }));
        return;
      }
      setManualCode("");
      setManualCodeOk(true);
      setManualCodeMsg(t("prov.pasteOk"));
    } catch {
      setManualCodeOk(false);
      setManualCodeMsg(t("modal.networkError"));
    } finally {
      setManualCodeBusy(false);
    }
  };
  const loggedIn = accounts.length > 0 || oauth?.loggedIn === true;
  const activeReauthAccount = accounts.find(a => a.active && a.needsReauth);
  const activeNeedsReauth = Boolean(activeReauthAccount);
  const quotaRows = isOauth ? accounts : keys;
  const canRefreshQuota = Boolean(onRefreshQuota)
    && !(quotaRows.length > 0 && quotaRows.every(row => row.quotaMode === "unsupported"));

  const submitKey = async () => {
    const key = newKey.trim();
    if (!key) return;
    setKeyBusy(true);
    try {
      const ok = await authHandlers.onAddApiKey(item.name, key);
      if (ok) { setNewKey(""); setAddingKey(false); }
    } finally {
      setKeyBusy(false);
    }
  };

  const importCockpitFile = async (file: File | undefined) => {
    if (!file || importBusy) return;
    setImportBusy(true);
    setImportStatus("idle");
    setImportResult(null);
    try {
      if (!file.name.toLowerCase().endsWith(".json") || file.size > COCKPIT_IMPORT_MAX_BYTES) {
        setImportStatus("invalid");
        return;
      }
      let document: unknown;
      try {
        document = JSON.parse(await file.text()) as unknown;
      } catch {
        setImportStatus("invalid");
        return;
      }
      const response = await fetch(`${apiBase}/api/oauth/accounts/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-antigravity", format: "cockpit-tools", document }),
      });
      if (!response.ok) {
        setImportStatus("failed");
        return;
      }
      const result = safeCockpitImportResult(await response.json().catch(() => null));
      if (!result) {
        setImportStatus("failed");
        return;
      }
      setImportResult(result);
      setImportStatus("complete");
      // The validated import is complete independently of the best-effort list refresh.
      // The account-pool owner reports refresh failure through accountLoadState, which
      // remains visible beside this completed import result.
      try {
        await authHandlers.onRetryAccounts?.(item.name);
      } catch {
        /* Preserve the completed import state; accountLoadState owns refresh errors. */
      }
    } catch {
      setImportStatus("failed");
    } finally {
      if (importFileRef.current) importFileRef.current.value = "";
      setImportBusy(false);
    }
  };

  return (
    <section className="pwi-section pwi-auth-section" aria-label={isOauth ? t("pws.availableAccounts") : t("pws.apiKeys")}>
      {/*
        The refresh control is in the section HEAD, not only at the foot of the list.
        Every account renders a stack of 5-hour/weekly/Fable bars, so with two accounts
        the footer copy sits well below the fold: an operator looking straight at stale
        bars had to scroll past all of them to find the button that re-reads them. The
        header keeps it beside the numbers it refreshes; the footer copy stays where it
        is, next to "Add account", because that is the account-management cluster.
      */}
      <div className="pwi-auth-head">
        <h3 className="pwi-section-title">{isOauth ? t("pws.availableAccounts") : t("pws.apiKeys")}</h3>
        {((isOauth && loggedIn) || isKeyAuth) && canRefreshQuota && (
          <div className="pwi-auth-head-actions">
            {quotaRefreshResult && (
              <span role="status" className={quotaRefreshResult.ok ? "pws-status-ok" : "pws-status-warn"}>
                {quotaRefreshResult.text}
              </span>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={refreshingQuota || busy || Boolean(switchingAccountId)}
              onClick={() => { void refreshQuota(); }}
            >
              <IconRefresh width={14} height={14} aria-hidden="true" />
              {" "}
              {refreshingQuota ? t("codexAuth.refreshingQuota") : t("codexAuth.refreshQuota")}
            </button>
          </div>
        )}
      </div>
      <div className="pwi-auth-body">
        {item.name === "xai" && (
          <XaiChatOptInControl
            initialState={item.xaiResponsesOptInState ?? true}
            onUpdateProvider={onUpdateProvider}
          />
        )}
        {isOauth && (
          <>
            {item.name === "anthropic" && (
              <AnthropicAccountPoolSettings apiBase={apiBase} accountCount={accounts.length} />
            )}
            {item.name === "google-antigravity" && (
              <div className="pwi-auth-add-key">
                <div>
                  <div id="cockpit-import-description" className="pwi-auth-row-secondary">
                    {t("pws.cockpitImportDescription")}
                  </div>
                  <label className="sr-only" htmlFor="cockpit-import-file">{t("pws.cockpitImportFileLabel")}</label>
                  <input
                    ref={importFileRef}
                    id="cockpit-import-file"
                    type="file"
                    accept="application/json,.json"
                    className="sr-only"
                    aria-describedby="cockpit-import-description cockpit-import-status"
                    disabled={importBusy}
                    onChange={event => { void importCockpitFile(event.currentTarget.files?.[0]); }}
                  />
                </div>
                <button type="button" className="btn btn-ghost btn-sm" disabled={importBusy}
                  onClick={() => importFileRef.current?.click()}>
                  {importBusy ? t("pws.cockpitImporting") : t("pws.cockpitImportChooseFile")}
                </button>
                <div id="cockpit-import-status" role="status" aria-live="polite">
                  {importStatus === "invalid" && t("pws.cockpitImportInvalid")}
                  {importStatus === "failed" && t("pws.cockpitImportFailed")}
                  {importStatus === "complete" && importResult && t("pws.cockpitImportComplete", {
                    imported: importResult.importedCount,
                    updated: importResult.updatedCount,
                    failed: importResult.failedCount,
                    unsupported: importResult.unsupportedCount,
                  })}
                </div>
              </div>
            )}
            <div className="pwi-auth-status-row">
              <span className={`pwi-auth-dot ${activeNeedsReauth ? "pwi-auth-dot--warn" : loggedIn ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
              <span className="pwi-auth-status-text">
                {loggedIn
                  ? (accounts.length > 0 ? t("pws.loggedInTitle") : (oauth?.email ?? t("pws.loggedInTitle")))
                  : (oauth?.error || t("pws.notLoggedInTitle"))}
              </span>
              <span className="pwi-auth-actions">
                {activeReauthAccount && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void authHandlers.onReauth(item.name, activeReauthAccount.id)}>
                    {t("pws.reauthenticate")}
                  </button>
                )}
                {loggedIn ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void authHandlers.onLogout(item.name)}>{t("prov.logout")}</button>
                ) : (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void authHandlers.onLogin(item.name, false)}>
                    {busy ? <span className="pwi-spin-inline" aria-hidden="true" /> : <IconLock style={{ width: 13, height: 13 }} aria-hidden="true" />}
                    {busy ? t("prov.waitingBrowser") : t("prov.login")}
                  </button>
                )}
              </span>
            </div>
            {!busy && <OpenBrowserPrefToggle />}
            {busy && hintForThis && (
              <div className="pwi-auth-wait">
                <span className="pwi-spin-inline" aria-hidden="true" />
                <div className="pwi-auth-wait-copy">
                  <div className="pwi-auth-wait-title">{t("prov.waitingBrowser")}</div>
                  <LoginHintView
                    hint={{
                      url: hintForThis.url,
                      deviceCode: hintForThis.deviceCode,
                      instructions: hintForThis.instructions,
                    }}
                    paste={{
                      value: manualCode,
                      busy: manualCodeBusy,
                      message: manualCodeMsg,
                      ok: manualCodeOk,
                      onChange: setManualCode,
                      onSubmit: () => { void submitManualCode(); },
                    }}
                  />
                  {authHandlers.onCancelLogin && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void authHandlers.onCancelLogin?.(item.name)}>
                      {t("common.cancel")}
                    </button>
                  )}
                </div>
              </div>
            )}
            {accountLoadState === "loading" && accounts.length === 0 && (
              <div className="pwi-auth-state" role="status">
                <span className="pwi-spin-inline" aria-hidden="true" />
                {t("pws.accountsLoading")}
              </div>
            )}
            {accountLoadState === "error" && (
              <div className="pwi-auth-state pwi-auth-state--error" role="alert">
                <span>{t("pws.accountsLoadFailed")}</span>
                {authHandlers.onRetryAccounts && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void authHandlers.onRetryAccounts?.(item.name)}>
                    {t("pws.retryAccounts")}
                  </button>
                )}
              </div>
            )}
                        {accounts.length > 0 && (
              <>
                <ProviderAccountsToolbar
                  analyzedList={analyzedAccounts}
                  showModelFamilies={showModelFamilies}
                  filter={accountFilter}
                  onFilterChange={handleFilterChange}
                  sortKey={accountSort}
                  onSortChange={handleSortChange}
                  titleMode={accountTitleMode}
                  onTitleModeChange={handleTitleModeChange}
                  viewMode={accountViewMode}
                  onViewModeChange={handleViewModeChange}
                  searchQuery={accountSearch}
                  onSearchQueryChange={setAccountSearch}
                  refreshingAll={refreshingQuota}
                  onRefreshAll={canRefreshQuota ? () => { void refreshQuota(); } : undefined}
                  quotaRefreshResultText={quotaRefreshResult?.text}
                  quotaRefreshResultOk={quotaRefreshResult?.ok}
                  poolSupported={genericPool !== null}
                  poolEnabled={genericPool?.enabled ?? false}
                  onTogglePoolEnabled={handleTogglePoolEnabled}
                  poolStrategy={genericPool?.strategy ?? DEFAULT_ACCOUNT_POOL_STRATEGY}
                  onSelectPoolStrategy={handleSelectPoolStrategy}
                />
                {filteredAndSortedAccounts.length > 0 ? (
                  <div className={accountViewMode === "compact" ? "compact-dense-grid" : "pwi-accounts-grid-2col"}>
                    {filteredAndSortedAccounts.map(analyzed => (
                      <ProviderAccountCard
                        key={analyzed.account.id}
                        analyzed={analyzed}
                        viewMode={accountViewMode}
                        titleMode={accountTitleMode}
                        switching={switchingAccountId === analyzed.account.id}
                        disabled={busy || Boolean(switchingAccountId && switchingAccountId !== analyzed.account.id)}
                        refreshing={refreshingQuota && (refreshingAccountId === analyzed.account.id || !refreshingAccountId)}
                        onSwitch={acc => void authHandlers.onSwitchAccount(item.name, acc)}
                        onRefreshSingle={canRefreshQuota ? acc => {
                          setRefreshingAccountId(acc.id);
                          void refreshQuota().finally(() => setRefreshingAccountId(null));
                        } : undefined}
                        onEditAlias={acc => void authHandlers.onEditAlias(item.name, "oauth", acc.id, acc.alias)}
                        onRemove={acc => setAccountToRemove(acc)}
                        onReauth={acc => void authHandlers.onReauth(item.name, acc.id)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="pwi-auth-state pwi-auth-state--empty" style={{ justifyContent: "center", gap: 12 }}>
                    <span>{t("modal.noMatch")}</span>
                    {accountFilter !== "all" && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleFilterChange("all")}>
                        {t("pws.filterAllAccounts")}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            {accountToRemove && (
              <RemoveAccountConfirmDialog
                accountLabel={oauthAccountDisplayLabel(accounts, accountToRemove, t)}
                removing={removingAccount}
                onCancel={() => { if (!removingAccount) setAccountToRemove(null); }}
                onConfirm={async () => {
                  if (removingAccount || !accountToRemove) return;
                  setRemovingAccount(true);
                  try {
                    await authHandlers.onRemoveAccount(item.name, accountToRemove);
                    setAccountToRemove(null);
                  } finally {
                    setRemovingAccount(false);
                  }
                }}
              />
            )}
            {couponAccount && (
              <GrokResetCouponModal
                accountId={couponAccount.id}
                accountLabel={oauthAccountDisplayLabel(accounts, couponAccount, t)}
                entry={grokCoupons.entries[couponAccount.id]}
                controller={grokCoupons}
                onClose={() => setCouponAccount(null)}
              />
            )}
            {accountLoadState === "ready" && loggedIn && accounts.length === 0 && (
              <div className="pwi-auth-state pwi-auth-state--empty">{t("pws.noAccounts")}</div>
            )}
            {loggedIn && (
              <div className="pwi-auth-actions">
                <button type="button" className="btn btn-ghost btn-sm"
                  onClick={() => void authHandlers.onLogin(item.name, true)} disabled={busy || Boolean(switchingAccountId)}>
                  {t("pws.addAccount")}
                </button>
                {canRefreshQuota && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={refreshingQuota || busy || Boolean(switchingAccountId)}
                    onClick={() => { void refreshQuota(); }}
                  >
                    <IconRefresh width={14} height={14} aria-hidden="true" />
                    {" "}
                    {refreshingQuota ? t("codexAuth.refreshingQuota") : t("codexAuth.refreshQuota")}
                  </button>
                )}
                {/*
                  The result line lives in the section head only. Rendering it in both
                  places would announce one refresh twice to a screen reader, since both
                  spans carry role="status".
                */}
              </div>
            )}
          </>
        )}

        {isKeyAuth && (
          <>
            {keys.length > 0 && (
              <ul className="pwi-auth-list">
                {keys.map(entry => (
                  <li key={entry.id} className={`pwi-auth-acct${entry.active ? " pwi-auth-acct--active" : ""}`}>
                    <div className={`pwi-auth-row${entry.active ? " pwi-auth-row--active" : ""}`}>
                    <button type="button" className="pwi-auth-row-main"
                      onClick={() => void authHandlers.onSwitchApiKey(item.name, entry)}
                      disabled={entry.active}>
                      <span className={`pwi-auth-dot ${entry.active ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                      <span className="pwi-auth-row-copy">
                        <span className="pwi-auth-row-label">{entry.label ?? entry.masked}</span>
                        {entry.label && <code className="pwi-auth-row-secondary">{entry.masked} · {t("prov.accountId")}: {entry.id}</code>}
                      </span>
                      {entry.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm"
                      onClick={() => void authHandlers.onEditAlias(item.name, "api-key", entry.id, entry.label)}>
                      {t("prov.editAlias")}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm pwi-auth-row-remove"
                      aria-label={`${t("common.remove")} — ${entry.label ?? entry.masked}`}
                      title={`${t("common.remove")} — ${entry.label ?? entry.masked}`}
                      onClick={() => void authHandlers.onRemoveApiKey(item.name, entry)}>
                      <IconTrash style={{ width: 13, height: 13 }} aria-hidden="true" />
                    </button>
                    </div>
                    <div className="pwi-auth-acct-quota">
                      <ProviderAccountQuota quotaMode={entry.quotaMode} quota={entry.quota}
                        quotaUnavailable={entry.quotaUnavailable} quotaPending={entry.quotaPending} quotaFailure={entry.quotaFailure} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {addingKey ? (
              <div className="pwi-auth-add-key">
                <input className="input" type="password" value={newKey} onChange={e => setNewKey(e.target.value)}
                  placeholder={t("modal.apiKeyPlaceholder")} autoComplete="off" disabled={keyBusy} />
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void submitKey()} disabled={keyBusy || !newKey.trim()}>
                  {keyBusy ? t("pws.saving") : t("pws.addKey")}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAddingKey(false); setNewKey(""); }}>{t("common.cancel")}</button>
              </div>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }}
                onClick={() => setAddingKey(true)}>{t("pws.addKey")}</button>
            )}
          </>
        )}

      </div>
    </section>
  );
}
