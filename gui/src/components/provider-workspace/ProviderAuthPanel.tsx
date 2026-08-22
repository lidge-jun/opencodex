/**
 * ProviderAuthPanel — OAuth accounts, API-key pool, and forward-auth
 * embedding for the workspace Settings tab (WP091). Consumes WP040+WP060
 * handlers via props-down; no internal auth machinery.
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { IconLock, IconTrash } from "../../icons";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { oauthAccountDisplayLabel, providerAuthSurface } from "../../provider-workspace/auth";
import { displayAccountId } from "../../lib/privacy";
import {
  formatOAuthHealthLabel,
  formatOAuthHealthSummary,
  oauthHealthBadgeClass,
  oauthHealthIsCooldown,
  oauthHealthShowsReauth,
} from "../../oauth-health-display";
import CodexAccountPool from "../CodexAccountPool";
import AnthropicAccountPoolSettings from "./AnthropicAccountPoolSettings";
import { LoginUrlBlock } from "../login-url-block";
import QuotaBars from "../QuotaBars";
import { useCopyFeedback } from "../use-copy-feedback";
import type { CodexAccountPoolController } from "../../hooks/useCodexAccountPool";
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

const QUOTA_ENRICH_RESERVE_MS = 4_000;
const COCKPIT_IMPORT_MAX_BYTES = 256 * 1024;
const EMPTY_OAUTH_ACCOUNTS: OAuthAccountRow[] = [];
const EMPTY_API_KEYS: ApiKeyRow[] = [];

function XaiResponsesOptInControl({
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
    const next = state !== true;
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
        <span className="pwi-auth-optin-label">{t("pws.xaiResponsesOptIn")}</span>
        <span className="pwi-auth-row-secondary">
          {t("pws.xaiResponsesOptInDesc")}
          {mixed && <span className="pwi-auth-optin-mixed"> {t("pws.xaiResponsesOptInMixed")}</span>}
        </span>
        {error && <span className="pwi-auth-optin-error" role="alert">{error}</span>}
      </div>
      <Switch
        on={state === true}
        mixed={mixed}
        onClick={() => { void toggle(); }}
        disabled={!onUpdateProvider || saving}
        label={t("pws.xaiResponsesOptIn")}
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
  const [reserveQuotaSlots, setReserveQuotaSlots] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const deviceCodeCopy = useCopyFeedback<string>();

  // Soft &quota=1 enrichment lands after the local account list. Reserve stacked
  // bar height briefly so bars don't shove rows when WHAM returns.
  //
  // Deliberately a timed state machine, not a derived value: the reservation must EXPIRE
  // after QUOTA_ENRICH_RESERVE_MS so a stalled enrichment cannot leave skeleton rows up
  // forever. A plain `accounts.some(...)` boolean would drop that bound, so the rule is
  // suppressed here rather than refactored away.
  useEffect(() => {
    if (accounts.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect, react/react-compiler
      setReserveQuotaSlots(false);
      return;
    }
    const needsFill = accounts.some(a => a.quota == null && !a.quotaUnavailable);
    if (!needsFill) {
      setReserveQuotaSlots(false);
      return;
    }
    setReserveQuotaSlots(true);
    const timer = window.setTimeout(() => setReserveQuotaSlots(false), QUOTA_ENRICH_RESERVE_MS);
    return () => window.clearTimeout(timer);
  }, [accounts]);

  const surface = providerAuthSurface({ ...item, hasApiKey: item.hasApiKey || keys.length > 0 });
  const isOauth = surface === "oauth-accounts";
  const isKeyAuth = surface === "api-keys";

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
  const deviceCode = hintForThis?.deviceCode ?? "";
  const deviceCodeOutcome = deviceCodeCopy.outcomeFor(deviceCode);
  const deviceCodeCopyLabel = deviceCodeOutcome === "copied"
    ? t("prov.codeCopied")
    : deviceCodeOutcome === "unavailable"
      ? t("prov.linkCopyUnavailable")
      : t("prov.copyCode");
  const loggedIn = accounts.length > 0 || oauth?.loggedIn === true;
  const activeReauthAccount = accounts.find(a => a.active && a.needsReauth);
  const activeNeedsReauth = Boolean(activeReauthAccount);

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
      <h3 className="pwi-section-title">{isOauth ? t("pws.availableAccounts") : t("pws.apiKeys")}</h3>
      <div className="pwi-auth-body">
        {item.name === "xai" && (
          <XaiResponsesOptInControl
            initialState={item.xaiResponsesOptInState ?? false}
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
            {busy && hintForThis && (
              <div className="pwi-auth-wait">
                <span className="pwi-spin-inline" aria-hidden="true" />
                <div className="pwi-auth-wait-copy">
                  <div className="pwi-auth-wait-title">{t("prov.waitingBrowser")}</div>
                  {hintForThis.deviceCode && (
                    <div className="pwi-device-code-wrap">
                      <span>{t("prov.deviceCode")}</span>
                      <code className="pwi-device-code">{hintForThis.deviceCode}</code>
                      <button type="button" className="btn btn-primary btn-sm"
                        onClick={() => deviceCodeCopy.copy(deviceCode, deviceCode)}>
                        <span aria-live="polite">{deviceCodeCopyLabel}</span>
                      </button>
                    </div>
                  )}
                  <LoginUrlBlock url={hintForThis.url ?? ""} />
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
              <ul className="pwi-auth-list">
                {accounts.map(account => {
                  const label = oauthAccountDisplayLabel(accounts, account, t);
                  const switching = switchingAccountId === account.id;
                  const healthStatus = account.health?.status;
                  const showReauth = Boolean(account.needsReauth) || oauthHealthShowsReauth(healthStatus);
                  const inCooldown = oauthHealthIsCooldown(healthStatus);
                  const maskedId = displayAccountId(account.id);
                  const healthLabel = formatOAuthHealthLabel(t, account.health);
                  const healthSummary = formatOAuthHealthSummary(t, item.name, account.id, account.health);
                  return (
                  <li key={account.id} className={`pwi-auth-acct${account.active ? " pwi-auth-acct--active" : ""}`}>
                    <div className={`pwi-auth-row${account.active ? " pwi-auth-row--active" : ""}`}>
                    <button type="button" className="pwi-auth-row-main"
                      onClick={() => { if (!account.active && !showReauth && !inCooldown && !switchingAccountId) void authHandlers.onSwitchAccount(item.name, account); }}
                      aria-current={account.active ? "true" : undefined}
                      aria-label={`${label}${account.active ? ` — ${t("pws.accountCurrent")}` : ""}`}
                      disabled={Boolean(showReauth || inCooldown || (switchingAccountId && !switching))}>
                      <span className={`pwi-auth-dot ${showReauth ? "pwi-auth-dot--warn" : account.active ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                      <span className="pwi-auth-row-copy">
                        <span className="pwi-auth-row-label">{label}</span>
                        <span className="pwi-auth-row-secondary">{[account.email, `${t("prov.accountId")}: ${maskedId}`].filter(Boolean).join(" · ")}</span>
                        {healthSummary && (
                          <span className="pwi-auth-row-secondary faint">{healthSummary}</span>
                        )}
                        {inCooldown && (
                          <span className="pwi-auth-row-secondary faint">{t("pws.healthCooldownHint")}</span>
                        )}
                      </span>
                      {healthLabel && (
                        <span className={oauthHealthBadgeClass(healthStatus)}>{healthLabel}</span>
                      )}
                      {showReauth && !healthLabel && <span className="badge badge-amber">{t("pws.reauth")}</span>}
                      {account.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                      {switching && <span className="badge badge-muted">{t("pws.accountSwitching")}</span>}
                    </button>
                    {showReauth && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy || Boolean(switchingAccountId)}
                        onClick={() => void authHandlers.onReauth(item.name, account.id)}
                      >
                        {t("pws.reauthenticate")}
                      </button>
                    )}
                    <button type="button" className="btn btn-ghost btn-sm"
                      onClick={() => void authHandlers.onEditAlias(item.name, "oauth", account.id, account.alias)}>
                      {t("prov.editAlias")}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm pwi-auth-row-remove"
                      aria-label={`${t("common.remove")} — ${label}`}
                      title={`${t("common.remove")} — ${label}`}
                      disabled={Boolean(switchingAccountId)}
                      onClick={() => void authHandlers.onRemoveAccount(item.name, account)}>
                      <IconTrash style={{ width: 13, height: 13 }} aria-hidden="true" />
                    </button>
                    </div>
                    {(account.quota != null || account.quotaUnavailable || (reserveQuotaSlots && account.quota == null)) && (
                      <div className="pwi-auth-acct-quota">
                        {account.quotaUnavailable ? (
                          <p className="muted pwi-auth-acct-quota-stale">{t("pws.accountQuotaUnavailable")}</p>
                        ) : (
                          <QuotaBars
                            quota={account.quota ?? null}
                            plan={null}
                            threshold={80}
                            t={t}
                            layout="stacked"
                            pending={account.quota == null}
                          />
                        )}
                      </div>
                    )}
                  </li>
                  );
                })}
              </ul>
            )}
            {accountLoadState === "ready" && loggedIn && accounts.length === 0 && (
              <div className="pwi-auth-state pwi-auth-state--empty">{t("pws.noAccounts")}</div>
            )}
            {loggedIn && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }}
                onClick={() => void authHandlers.onLogin(item.name, true)} disabled={busy || Boolean(switchingAccountId)}>
                {t("pws.addAccount")}
              </button>
            )}
          </>
        )}

        {isKeyAuth && (
          <>
            {keys.length > 0 && (
              <ul className="pwi-auth-list">
                {keys.map(entry => (
                  <li key={entry.id} className={`pwi-auth-row${entry.active ? " pwi-auth-row--active" : ""}`}>
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
