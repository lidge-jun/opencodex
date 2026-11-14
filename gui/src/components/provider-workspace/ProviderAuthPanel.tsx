import { anthropicSubscriptionLabel } from "../../../../src/providers/anthropic-subscription";
import { anthropicInstanceRowShapeMatches, isAnthropicInstanceId } from "../../../../src/providers/anthropic-instance-id";
/**
 * ProviderAuthPanel — OAuth accounts, API-key pool, and forward-auth
 * embedding for the workspace Settings tab (WP091). Consumes WP040+WP060
 * handlers via props-down; no internal auth machinery.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useT, useI18n } from "../../i18n/shared";
import { formatAccountPauseTooltip } from "../../account-pause-display";
import { IconLock, IconRefresh, IconTrash } from "../../icons";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { oauthAccountDisplayLabel, providerAuthSurface } from "../../provider-workspace/auth";
import { displayAccountId } from "../../lib/privacy";
import AccountAutoSwitchControl from "../AccountAutoSwitchControl";
import {
  formatOAuthHealthSummary,
  oauthHealthIsCooldown,
  oauthHealthShowsReauth,
} from "../../oauth-health-display";
import CodexAccountPool from "../CodexAccountPool";
import AnthropicAccountPoolSettings from "./AnthropicAccountPoolSettings";
import { LoginHint as LoginHintView } from "../login-url-block";
import { OpenBrowserPrefToggle } from "../open-browser-pref-toggle";
import ProviderAccountQuota from "./ProviderAccountQuota";
import { AccountProbeButton, AccountProbeResultLine } from "./AccountProbe";
import { ACCOUNT_PROBE_PROVIDERS, useAccountProbe } from "../../hooks/useAccountProbe";
import { AccountQuotaTable } from "./AccountQuotaTable";
import { accountQuotaFromReport } from "../../provider-workspace/report";
import { uncoveredWindows } from "../../provider-workspace/account-quota-table";
import { GrokCouponBadge, GrokResetCouponModal } from "./GrokResetCoupons";
import { AnthropicGrantBadge, AnthropicResetGrantModal } from "./AnthropicResetGrants";
import type { CodexAccountPoolController } from "../../hooks/useCodexAccountPool";
import { useGrokResetCoupons } from "../../hooks/useGrokResetCoupons";
import { useAnthropicResetGrants } from "../../hooks/useAnthropicResetGrants";
import { Switch } from "../../ui";
import { kiroSkipReasonKey } from "../../kiro-device-login-helpers";
import { isApiTargetCaptureCurrent, targetFetch, type ApiTargetCapture } from "../../api";
import { useRenderTargetCapture } from "../../use-render-target-capture";
import KiroDeviceLoginDialog from "../KiroDeviceLoginDialog";
import type {
  AccountLoadState,
  OAuthAccountRow,
  ApiKeyRow,
  LoginHint,
  ProviderAuthHandlers,
  ProviderUpdateCallback,
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
  onUpdateProvider?: ProviderUpdateCallback;
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
  item, apiBase, targetKey, oauth, accounts = EMPTY_OAUTH_ACCOUNTS, keys = EMPTY_API_KEYS, accountLoadState = "ready",
  switchingAccountId = null, pausingAccountId = null, busy = false, loginHint, loginCapture, authHandlers, onCodexActiveNeedsReauthChange,
  codexController, onUpdateProvider,
}: {
  item: WorkspaceItem;
  apiBase: string;
  /** Logical dashboard target; the panel's rows and actions belong to it. */
  targetKey?: string;
  oauth?: { loggedIn: boolean; email?: string; error?: string };
  accounts?: OAuthAccountRow[];
  keys?: ApiKeyRow[];
  accountLoadState?: AccountLoadState;
  switchingAccountId?: string | null;
  pausingAccountId?: string | null;
  busy?: boolean;
  loginHint?: LoginHint | null;
  loginCapture?: ApiTargetCapture;
  authHandlers?: ProviderAuthHandlers;
  onCodexActiveNeedsReauthChange?: (needs: boolean) => void;
  onUpdateProvider?: ProviderUpdateCallback;
  /** Shared Codex account state owned by Providers (WP3). */
  codexController?: CodexAccountPoolController;
}) {
  const t = useT();
  // The panel's render owns the target for its own import action.
  const renderCapture = useRenderTargetCapture(apiBase, targetKey);
  const { locale } = useI18n();
  const [addingKey, setAddingKey] = useState(false);
  const [kiroChooser, setKiroChooser] = useState<{ addAccount: boolean } | null>(null);
  const kiroLoginTriggerRef = useRef<HTMLButtonElement>(null);
  const kiroAddTriggerRef = useRef<HTMLButtonElement>(null);
  const openLogin = (addAccount: boolean) => {
    if (item.name === "kiro") setKiroChooser({ addAccount });
    else void authHandlers?.onLogin(item.name, addAccount);
  };
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
  // Claude usage resets ride a separate usage read, like the Grok coupons above.
  const isAnthropicPool = isAnthropicInstanceId(item.name) && anthropicInstanceRowShapeMatches(item.name, item);
  const claudeGrantsEnabled = isOauth && isAnthropicPool && accounts.length > 0;
  const claudeAccountIds = useMemo(
    () => (claudeGrantsEnabled ? accounts.filter(account => !accountShowsReauth(account)).map(account => account.id) : []),
    [claudeGrantsEnabled, accounts],
  );
  const claudeGrants = useAnthropicResetGrants({ apiBase, provider: isAnthropicInstanceId(item.name) ? item.name : "anthropic", accountIds: claudeAccountIds, enabled: claudeGrantsEnabled });
  // The open reset dialog belongs to the pool it was opened in. Switching server or pool
  // hides it during render rather than resetting it from an effect.
  const grantScope = `${apiBase}\0${item.name}`;
  const [grantSelection, setGrantSelection] = useState<{ scope: string; account: OAuthAccountRow } | null>(null);
  const grantAccount = grantSelection?.scope === grantScope ? grantSelection.account : null;
  const setGrantAccount = (account: OAuthAccountRow | null) => {
    setGrantSelection(account ? { scope: grantScope, account } : null);
  };
  // Read-only per-account probe (stored token, no refresh); only providers the server implements.
  const accountProbe = useAccountProbe(apiBase, item.name);
  const probeEnabled = isOauth && ACCOUNT_PROBE_PROVIDERS.has(item.name) && accounts.length > 0;
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
          {codexController && codexController.accounts.length > 1 && (
            <AccountQuotaTable
              strategy={(codexController.readLastActive() as { accountPoolStrategy?: string } | undefined)?.accountPoolStrategy}
              accounts={codexController.accounts.map(account => ({
                id: account.id, label: account.alias ?? (account.email || t("codexAuth.mainAccount")), plan: account.plan ?? null,
                active: account.id === codexController.activeId, paused: account.paused, needsReauth: account.needsReauth, health: account.health,
                quota: account.quota && {
                  ...account.quota,
                  fiveHourPercent: account.quota.fiveHourPercent ?? account.quota.shortPercent,
                  fiveHourResetAt: account.quota.fiveHourResetAt ?? account.quota.shortResetAt,
                },
              }))}
            />
          )}
          <CodexAccountPool
            apiBase={apiBase}
            targetKey={targetKey}
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
    if (!loginCapture) {
      setManualCodeOk(false);
      setManualCodeMsg(t("prov.targetChanged"));
      return;
    }
    setManualCodeBusy(true);
    setManualCodeMsg("");
    try {
      const res = await targetFetch(loginCapture, `${apiBase}/api/oauth/login/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: item.name, input }),
      });
      if (!isApiTargetCaptureCurrent(loginCapture)) {
        setManualCodeOk(false);
        setManualCodeMsg(t("prov.targetChanged"));
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setManualCodeOk(false);
        setManualCodeMsg(data.error === "target_changed"
          ? t("prov.targetChanged")
          : t("prov.pasteFail", { error: data.error || res.statusText }));
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
  const loggedIn = (accountLoadState === "ready" && accounts.length > 0) || oauth?.loggedIn === true;
  const canLogout = loggedIn || (accountLoadState === "error" && oauth?.loggedIn !== false);
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
    const capture = renderCapture;
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
      const response = await targetFetch(capture, `${apiBase}/api/oauth/accounts/import`, {
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
        {((((isOauth && loggedIn) || isKeyAuth) && canRefreshQuota) || probeEnabled) && (
          <div className="pwi-auth-head-actions">
            {((isOauth && loggedIn) || isKeyAuth) && canRefreshQuota && <>
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
            </>}
            {probeEnabled && (
              <button type="button" className="btn btn-ghost btn-sm" title={t("acctProbe.hint")}
                aria-busy={accountProbe.allPending} disabled={accountProbe.allPending}
                onClick={() => { void accountProbe.probeAll(accounts.map(account => account.id)); }}>
                {accountProbe.allPending ? t("acctProbe.testing") : t("acctProbe.testAll")}
              </button>
            )}
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
            {isAnthropicPool && (
              <AnthropicAccountPoolSettings
                key={`${apiBase}:${item.name}`}
                apiBase={apiBase}
                targetKey={targetKey}
                provider={isAnthropicInstanceId(item.name) ? item.name : "anthropic"}
                accountCount={accounts.length}
                onThresholdChange={threshold => { void authHandlers?.onAccountPoolThreshold?.(item.name, threshold); }}
              />
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
                  ? t("pws.loggedInTitle")
                  : (oauth?.error || (oauth?.loggedIn === false ? t("pws.notLoggedInTitle") : t("startup.unverified")))}
              </span>
              <span className="pwi-auth-actions">
                {activeReauthAccount && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void authHandlers.onReauth(item.name, activeReauthAccount.id)}>
                    {t("pws.reauthenticate")}
                  </button>
                )}
                {canLogout ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void authHandlers.onLogout(item.name)}>{t("prov.logout")}</button>
                ) : (
                  <button ref={item.name === "kiro" ? kiroLoginTriggerRef : undefined} type="button" className="btn btn-primary btn-sm" disabled={busy || (item.name === "kiro" && Boolean(kiroChooser))} onClick={() => openLogin(false)}>
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
                      browserLaunch: hintForThis.browserLaunch,
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
            {authHandlers.pendingAffinityResets?.[item.name] && (
              <div className="pwi-auth-state pwi-auth-state--error" role="alert">
                <span>{t("prov.affinityResetPending")}</span>
                {authHandlers.onRetryAffinityReset && <button type="button" className="btn btn-ghost btn-sm"
                  disabled={Boolean(switchingAccountId || pausingAccountId)}
                  onClick={() => void authHandlers.onRetryAffinityReset?.(item.name)}>{t("common.retry")}</button>}
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
            {accounts.length > 0 && (() => {
              const byId = new Map(accounts.map(account => [account.id, account]));
              const controlsLocked = Boolean(switchingAccountId) || Boolean(pausingAccountId);
              return (
              <AccountQuotaTable
                accounts={accounts.map(account => {
                  const probe = accountProbe.entries[account.id];
                  return {
                    id: account.id, label: oauthAccountDisplayLabel(accounts, account, t), plan: account.plan,
                    planLabel: isAnthropicPool ? anthropicSubscriptionLabel(account.plan) : undefined,
                    active: account.active, paused: account.paused === true, needsReauth: accountShowsReauth(account),
                    health: account.health, quota: accountQuotaFromReport({ quota: account.quota }), quotaUnavailable: account.quotaUnavailable,
                    ...(probe && "result" in probe ? { probe: { status: probe.result.status, latencyMs: probe.result.latencyMs } } : {}),
                  };
                })}
                renderAccount={row => {
                  const account = byId.get(row.account.id)!;
                  const showReauth = accountShowsReauth(account);
                  const inCooldown = oauthHealthIsCooldown(account.health?.status);
                  const kiroReason = kiroSkipReasonKey(account, item.name);
                  return (
                    <button type="button" className="aqt-account-main"
                      onClick={() => { if (!account.active && !account.paused && !showReauth && !inCooldown && !controlsLocked) void authHandlers.onSwitchAccount(item.name, account); }}
                      aria-current={account.active ? "true" : undefined}
                      aria-label={`${row.account.label}${row.plan ? ` — ${row.plan}` : ""}${account.active ? ` — ${t("pws.accountCurrent")}` : ""}`}
                      title={account.paused && account.pauseDetails ? formatAccountPauseTooltip(t, locale, account.pauseDetails) : undefined}
                      disabled={Boolean(account.paused || showReauth || inCooldown || controlsLocked)}>
                      <span className={`pwi-auth-dot ${showReauth ? "pwi-auth-dot--warn" : account.active && !account.paused ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                      <span className="aqt-account-copy">
                        <span className="aqt-account-label">{row.account.label}</span>
                        {!isAnthropicPool && <span className="aqt-account-id faint">{displayAccountId(account.id)}</span>}
                      </span>
                      {account.active && !account.paused && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                      {kiroReason && <span className="badge badge-amber">{t(kiroReason)}</span>}
                      {switchingAccountId === account.id && <span className="badge badge-muted">{t("pws.accountSwitching")}</span>}
                    </button>
                  );
                }}
                renderActions={row => {
                  const account = byId.get(row.account.id)!;
                  const showReauth = accountShowsReauth(account);
                  return <>
                    {claudeGrantsEnabled && !showReauth && (
                      <AnthropicGrantBadge entry={claudeGrants.entries[account.id]} t={t} onClick={() => setGrantAccount(account)} />
                    )}
                    {grokCouponsEnabled && !showReauth && (
                      <GrokCouponBadge entry={grokCoupons.entries[account.id]} t={t} onClick={() => setCouponAccount(account)} />
                    )}
                    {showReauth && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy || controlsLocked}
                        onClick={() => void authHandlers.onReauth(item.name, account.id)}>
                        {t("pws.reauthenticate")}
                      </button>
                    )}
                    {typeof account.paused === "boolean" && authHandlers.onPauseAccount && (
                      <button type="button" className="btn btn-ghost btn-sm"
                        aria-label={`${t(account.paused ? "codexAuth.resume" : "codexAuth.pause")} — ${row.account.label}`}
                        aria-busy={pausingAccountId === account.id}
                        disabled={busy || controlsLocked}
                        onClick={() => void authHandlers.onPauseAccount(item.name, account, !account.paused)}>
                        {t(account.paused ? "codexAuth.resume" : "codexAuth.pause")}
                      </button>
                    )}
                    {probeEnabled && (
                      <AccountProbeButton controller={accountProbe} accountId={account.id} label={row.account.label}
                        disabled={accountProbe.allPending} />
                    )}
                    <button type="button" className="btn btn-ghost btn-sm"
                      aria-label={`${t("prov.editAlias")} — ${row.account.label}`}
                      onClick={() => void authHandlers.onEditAlias(item.name, "oauth", account.id, account.alias)}>
                      {t("prov.editAlias")}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm pwi-auth-row-remove"
                      aria-label={`${t("common.remove")} — ${row.account.label}`}
                      title={`${t("common.remove")} — ${row.account.label}`}
                      disabled={controlsLocked}
                      onClick={() => void authHandlers.onRemoveAccount(item.name, account)}>
                      <IconTrash style={{ width: 13, height: 13 }} aria-hidden="true" />
                    </button>
                  </>;
                }}
                renderDetails={row => {
                  const account = byId.get(row.account.id)!;
                  const healthSummary = isAnthropicPool ? null : formatOAuthHealthSummary(t, item.name, account.id, account.health);
                  const inCooldown = oauthHealthIsCooldown(account.health?.status);
                  const covered = Object.keys(row.cells).length > 0;
                  // Windows the pool columns already show are not repeated; anything else (per-model
                  // rows, monthly, credits) still renders here so the list drops no reading.
                  const rest = covered && row.account.quota ? accountQuotaFromReport({ quota: {
                    ...row.account.quota,
                    customWindows: uncoveredWindows(row.account.quota.customWindows),
                    ...(row.cells.subscription ? { fiveHourPercent: undefined, fiveHourResetAt: undefined, weeklyPercent: undefined, weeklyResetAt: undefined } : {}),
                  } }) : null;
                  const probeEntry = probeEnabled ? accountProbe.entries[account.id] : undefined;
                  const threshold = isAnthropicPool && account.autoSwitchThresholdOverride !== undefined
                    && account.autoSwitchThreshold !== undefined && authHandlers.onAccountThreshold;
                  const parts = [
                    healthSummary && <p key="health">{healthSummary}</p>,
                    inCooldown && <p key="cooldown">{t("pws.healthCooldownHint")}</p>,
                    account.paused && <p key="paused">{t("pws.accountPausedHint")}</p>,
                    probeEntry && <AccountProbeResultLine key="probe" entry={probeEntry} />,
                    threshold && (
                      <AccountAutoSwitchControl key="threshold"
                        accountLabel={row.account.label} inputId={`anthropic-threshold-${account.id}`}
                        globalThreshold={account.autoSwitchThreshold!} override={account.autoSwitchThresholdOverride!}
                        hintText={t("pws.anthropicAccountThresholdHint")}
                        disabled={busy || controlsLocked}
                        onChange={value => authHandlers.onAccountThreshold!(item.name, account, value)}
                      />
                    ),
                    !covered && (
                      <ProviderAccountQuota key="quota" quotaMode={account.quotaMode} quota={account.quota}
                        quotaUnavailable={account.quotaUnavailable} quotaPending={account.quotaPending} quotaFailure={account.quotaFailure}
                        quotaReadAt={account.quotaReadAt} />
                    ),
                    rest && <ProviderAccountQuota key="rest" quotaMode={account.quotaMode} quota={rest} />,
                  ].filter(Boolean);
                  return parts.length > 0 ? parts : null;
                }}
              />
              );
            })()}
            {couponAccount && (
              <GrokResetCouponModal
                accountId={couponAccount.id}
                accountLabel={oauthAccountDisplayLabel(accounts, couponAccount, t)}
                entry={grokCoupons.entries[couponAccount.id]}
                controller={grokCoupons}
                onClose={() => setCouponAccount(null)}
              />
            )}
            {grantAccount && (
              <AnthropicResetGrantModal
                key={`${apiBase}:${item.name}:${grantAccount.id}`}
                accountId={grantAccount.id}
                accountLabel={oauthAccountDisplayLabel(accounts, grantAccount, t)}
                entry={claudeGrants.entries[grantAccount.id]}
                controller={claudeGrants}
                onClose={() => setGrantAccount(null)}
              />
            )}
            {accountLoadState === "ready" && loggedIn && accounts.length === 0 && (
              <div className="pwi-auth-state pwi-auth-state--empty">{t("pws.noAccounts")}</div>
            )}
            {loggedIn && (
              <div className="pwi-auth-actions">
                <button ref={item.name === "kiro" ? kiroAddTriggerRef : undefined} type="button" className="btn btn-ghost btn-sm"
                  onClick={() => openLogin(true)} disabled={busy || Boolean(switchingAccountId) || (item.name === "kiro" && Boolean(kiroChooser))}>
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
        {item.name === "kiro" && kiroChooser && (
          <KiroDeviceLoginDialog apiBase={apiBase} targetKey={targetKey} triggerRef={kiroChooser.addAccount ? kiroAddTriggerRef : kiroLoginTriggerRef}
            addAccount={kiroChooser.addAccount} busy={busy} onClose={() => setKiroChooser(null)}
            onCli={addAccount => { void authHandlers.onLogin(item.name, addAccount); }}
            onSettled={authHandlers.onNativeLoginSettled} />
        )}

        {isKeyAuth && (
          <>
            {keys.length > 0 && (
              <ul className="pwi-auth-list">
                {keys.map(entry => {
                  const switching = switchingAccountId === entry.id;
                  const pausing = pausingAccountId === entry.id;
                  return (
                  <li key={entry.id} className={`pwi-auth-acct${entry.active && !entry.disabled ? " pwi-auth-acct--active" : ""}`}>
                    <div className={`pwi-auth-row${entry.active && !entry.disabled ? " pwi-auth-row--active" : ""}`}>
                    <button type="button" className="pwi-auth-row-main"
                      onClick={() => void authHandlers.onSwitchApiKey(item.name, entry)}
                      aria-current={entry.active && !entry.disabled ? "true" : undefined}
                      disabled={(entry.active && !entry.disabled) || busy || Boolean(switchingAccountId) || Boolean(pausingAccountId)} aria-label={entry.disabled ? `${t("pws.resumeAndActivateKey")} — ${entry.label ?? entry.masked}` : undefined}>
                      <span className={`pwi-auth-dot ${entry.active && !entry.disabled ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                      <span className="pwi-auth-row-copy">
                        <span className="pwi-auth-row-label">{entry.label ?? entry.masked}</span>
                        {entry.label && <code className="pwi-auth-row-secondary">{entry.masked} · {t("prov.accountId")}: {entry.id}</code>}
                        {entry.disabled && (
                          <span className="pwi-auth-row-secondary faint">{t("pws.accountPausedHint")}</span>
                        )}
                      </span>
                      {entry.disabled && <span className="badge badge-muted" title={entry.pauseDetails ? formatAccountPauseTooltip(t, locale, entry.pauseDetails) : undefined}>{t("codexAuth.paused")} · {t("codexAuth.resume")}</span>}
                      {entry.active && !entry.disabled && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                      {switching && <span className="badge badge-muted">{t("pws.accountSwitching")}</span>}
                    </button>
                    {authHandlers.onPauseApiKey && (
                      <button type="button" className="btn btn-ghost btn-sm"
                        aria-label={`${t(entry.disabled ? "codexAuth.resume" : "codexAuth.pause")} — ${entry.label ?? entry.masked}`}
                        title={entry.disabled ? t("pws.accountPausedHint") : undefined}
                        aria-busy={pausing}
                        disabled={busy || Boolean(switchingAccountId) || Boolean(pausingAccountId)}
                        onClick={() => void authHandlers.onPauseApiKey!(item.name, entry, !entry.disabled)}>
                        {t(entry.disabled ? "codexAuth.resume" : "codexAuth.pause")}
                      </button>
                    )}
                    <button type="button" className="btn btn-ghost btn-sm"
                      disabled={busy || Boolean(switchingAccountId) || Boolean(pausingAccountId)}
                      onClick={() => void authHandlers.onEditAlias(item.name, "api-key", entry.id, entry.label)}>
                      {t("prov.editAlias")}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm pwi-auth-row-remove"
                      aria-label={`${t("common.remove")} — ${entry.label ?? entry.masked}`}
                      disabled={busy || Boolean(switchingAccountId) || Boolean(pausingAccountId)}
                      title={`${t("common.remove")} — ${entry.label ?? entry.masked}`}
                      onClick={() => void authHandlers.onRemoveApiKey(item.name, entry)}>
                      <IconTrash style={{ width: 13, height: 13 }} aria-hidden="true" />
                    </button>
                    </div>
                    <div className="pwi-auth-acct-quota">
                      <ProviderAccountQuota quotaMode={entry.quotaMode} quota={entry.quota}
                        quotaUnavailable={entry.quotaUnavailable} quotaPending={entry.quotaPending} quotaFailure={entry.quotaFailure}
                        quotaReadAt={entry.quotaReadAt} />
                    </div>
                  </li>
                );})}
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
