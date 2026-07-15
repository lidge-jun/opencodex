import { useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from "react";
import {
  type WorkspaceProvider,
  type WorkspaceItem,
  type WorkspaceSections,
  buildProviderWorkspace,
  binProviderStatus,
  buildAttentionItems,
  countAvailableModels,
  buildMostUsedProviders,
  formatRelativeTime,
  formatRequestCount,
  formatTokenCount,
  isFreeProvider,
  sortWorkspaceItems,
  type ProviderSortMode,
  type AttentionItem,
  type ProviderModelCounts,
  type ProviderAvailableModels,
  type ProviderSelectedModels,
  type ProviderUsageTotals,
  parseAvailableModels,
  parseSelectedModels,
} from "../provider-workspace-data";
import { providerIconSrc } from "../provider-icons";
import {
  IconSearch,
  IconFilter,
  IconPlus,
  IconPower,
  IconTrash,
  IconCheck,
  IconAlert,
  IconServer,
  IconBoxes,
  IconRefresh,
  IconKey,
  IconInfo,
  IconChevron,
  IconExternal,
  IconActivity,
  IconLock,
} from "../icons";
import { Switch } from "../ui";
import { useT, type TFn, type TKey } from "../i18n";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type OAuthAccountRow = {
  id: string;
  email?: string;
  active: boolean;
  needsReauth?: boolean;
};

export type ApiKeyRow = {
  id: string;
  label?: string;
  masked: string;
  active: boolean;
};

export type LoginHint = {
  provider: string;
  url?: string;
  instructions?: string;
};

export interface ProviderAuthHandlers {
  onLogin: (provider: string, addAccount?: boolean) => void;
  onLogout: (provider: string) => void;
  onSwitchAccount: (provider: string, account: OAuthAccountRow) => void;
  onRemoveAccount: (provider: string, account: OAuthAccountRow) => void;
  onAddApiKey: (provider: string, key: string) => Promise<boolean>;
  onSwitchApiKey: (provider: string, entry: ApiKeyRow) => void;
  onRemoveApiKey: (provider: string, entry: ApiKeyRow) => void;
}

export interface ProviderWorkspaceProps {
  /** Provider map as returned from the proxy config API. */
  providers: Record<string, WorkspaceProvider>;
  /** Base URL for API calls, e.g. http://localhost:11434 */
  apiBase: string;
  /** Name of the default routing provider (shows a Default label in the rail). */
  defaultProvider?: string;
  onAddProvider: () => void;
  onUseLegacyView: () => void;
  /** Open raw config JSON editor (workspace modal — do not leave workspace). */
  onEditConfig: () => void;
  onSetDisabled: (name: string, disabled: boolean) => void;
  onRemoveProvider: (name: string) => void;
  /** Partial update of a provider (settings form). */
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
  quotaReports?: Record<string, { updatedAt: number; source?: string; quota?: unknown }>;
  oauthStatus?: Record<string, { loggedIn: boolean; email?: string; error?: string }>;
  /** OAuth multi-account sets keyed by provider name. */
  accountSets?: Record<string, { activeAccountId: string | null; accounts: OAuthAccountRow[] }>;
  /** API-key pools keyed by provider name. */
  keyPools?: Record<string, ApiKeyRow[]>;
  /** Provider currently running an OAuth browser flow. */
  busyProvider?: string | null;
  /** Live login hint (URL / instructions) for the busy OAuth provider. */
  loginHint?: LoginHint | null;
  authHandlers?: ProviderAuthHandlers;
}

export type ProviderUpdatePatch = {
  adapter?: string;
  baseUrl?: string;
  defaultModel?: string;
  apiKey?: string;
  authMode?: string;
  note?: string;
  disabled?: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Tab = "overview" | "models" | "usage" | "settings";

const TAB_DEFS: { id: Tab; labelKey: TKey }[] = [
  { id: "overview", labelKey: "pws.tab.overview" },
  { id: "models",   labelKey: "pws.tab.models" },
  { id: "usage",    labelKey: "pws.tab.usage" },
  { id: "settings", labelKey: "pws.tab.settings" },
];

const SORT_DEFS: { id: ProviderSortMode; labelKey: TKey }[] = [
  { id: "az", labelKey: "pws.sort.az" },
  { id: "za", labelKey: "pws.sort.za" },
  { id: "free-paid", labelKey: "pws.sort.freePaid" },
  { id: "paid-free", labelKey: "pws.sort.paidFree" },
];

function statusLabel(p: WorkspaceProvider, t: TFn): string {
  const s = binProviderStatus(p);
  if (s === "disabled") return t("prov.disabledBadge");
  if (s === "ready")    return t("pws.status.ready");
  return t("pws.status.needsSetup");
}

function authModeLabel(item: WorkspaceItem, t: TFn): string {
  switch (item.authMode) {
    case "oauth":   return t("modal.badge.oauth");
    case "forward": return t("pws.auth.passthrough");
    case "local":   return t("modal.badge.local");
    case "key":     return t("modal.badge.apiKey");
    default:        return item.authMode ?? (item.keyOptional ? t("pws.auth.noKey") : t("modal.badge.apiKey"));
  }
}

// ---------------------------------------------------------------------------
// Provider icon
// ---------------------------------------------------------------------------

function ProviderIcon({ name, adapter, baseUrl, cls }: {
  name: string;
  adapter?: string;
  baseUrl?: string;
  cls: string;
}) {
  const src = providerIconSrc(name, { adapter, baseUrl });
  return (
    <span className={cls}>
      {src
        ? <img src={src} alt="" aria-hidden="true" />
        : <IconServer aria-hidden="true" />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Rail row
// ---------------------------------------------------------------------------

function railStatusCls(item: WorkspaceItem): string {
  const s = binProviderStatus(item);
  if (s === "disabled") return "providers-workspace-rail-status providers-workspace-rail-status--inactive";
  if (s === "ready") return "providers-workspace-rail-status providers-workspace-rail-status--active";
  return "providers-workspace-rail-status providers-workspace-rail-status--warning";
}

function isLocalProvider(item: WorkspaceProvider): boolean {
  if (item.authMode === "local") return true;
  try {
    const host = new URL(item.baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function RailRow({ item, selected, modelCount, isDefault, onClick }: {
  item: WorkspaceItem;
  selected: boolean;
  modelCount?: number;
  isDefault?: boolean;
  onClick: () => void;
}) {
  const t = useT();
  const free = isFreeProvider(item);
  const local = isLocalProvider(item);
  const status = statusLabel(item, t);
  const suffix = `${isDefault ? t("pws.rail.suffixDefault") : ""}${local ? t("pws.rail.suffixLocal") : free ? t("pws.rail.suffixFree") : ""}`;
  return (
    <button
      type="button"
      className={`providers-workspace-rail-row${selected ? " providers-workspace-rail-row--selected" : ""}`}
      onClick={onClick}
      role="option"
      aria-selected={selected}
      aria-label={t("pws.rail.selectAria", { name: item.name, status, suffix })}
    >
      <ProviderIcon
        name={item.name}
        adapter={item.adapter}
        baseUrl={item.baseUrl}
        cls="providers-workspace-rail-icon"
      />
      <span className="providers-workspace-rail-name">{item.name}</span>
      {isDefault && (
        <span className="pwi-rail-meta pwi-rail-meta--default" title={t("pws.defaultTitle")}>{t("prov.defaultBadge")}</span>
      )}
      {/* Only label exceptions (Local / Free). Paid is the unmarked default. */}
      {local ? (
        <span className="pwi-rail-meta" title={t("pws.localTitle")}>{t("modal.badge.local")}</span>
      ) : free ? (
        <span className="pwi-rail-meta pwi-rail-meta--free" title={t("pws.freeTitle")}>{t("modal.badge.free")}</span>
      ) : null}
      <span className={railStatusCls(item)} aria-hidden="true" title={status} />
      {modelCount !== undefined && modelCount > 0 && (
        <span className="providers-workspace-rail-model-count">{t("pws.modelCount", { count: modelCount })}</span>
      )}
      <IconChevron className="providers-workspace-rail-chevron" aria-hidden="true" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Connection card
// ---------------------------------------------------------------------------

function ConnectionCard({ item, onEdit, lastCheckedAt }: {
  item: WorkspaceItem;
  onEdit: () => void;
  lastCheckedAt?: number;
}) {
  const t = useT();
  const baseUrl = item.baseUrl?.trim() ? item.baseUrl : "—";
  const status = binProviderStatus(item);
  // Match design mock: connection cell uses "Connected" while the list uses Ready/Needs setup.
  const statusText = status === "ready"
    ? t("pws.status.connected")
    : status === "needs-setup"
      ? t("pws.status.needsSetup")
      : t("prov.disabledBadge");
  const configurationText = status === "ready"
    ? t("pws.ops.ok")
    : status === "needs-setup" ? t("pws.ops.creds") : t("pws.ops.disabled");
  const statusCls = status === "ready"
    ? "pwi-connection-status pwi-connection-status--ok"
    : "pwi-connection-status pwi-connection-status--warn";
  return (
    <div className="providers-workspace-section">
      <div className="providers-workspace-section-head">
        <span className="providers-workspace-section-title">{t("pws.connection")}</span>
      </div>
      <div className="providers-workspace-section-body">
        <div className="pwi-connection-grid">
          <div className="pwi-connection-cell">
            <span className="pwi-cell-label">{t("dash.status")}</span>
            <span className={statusCls}>{statusText}</span>
          </div>
          <div className="pwi-connection-cell">
            <span className="pwi-cell-label">{t("modal.baseUrl")}</span>
            <code className="pwi-cell-value-mono">{baseUrl}</code>
          </div>
          <div className="pwi-connection-cell">
            <span className="pwi-cell-label">{t("pws.cell.lastChecked")}</span>
            <span className="pwi-cell-value">{formatRelativeTime(lastCheckedAt)}</span>
          </div>
          <div className="pwi-connection-cell">
            <span className="pwi-cell-label">{t("pws.cell.auth")}</span>
            <span className="pwi-cell-value">{authModeLabel(item, t)}</span>
          </div>
          <div className="pwi-connection-cell">
            <span className="pwi-cell-label">{t("pws.cell.defaultModel")}</span>
            <span className="pwi-cell-value">
              {item.defaultModel
                ? <>{item.defaultModel}{" "}<span className="badge badge-muted">{t("prov.defaultBadge")}</span></>
                : <span className="muted">&mdash;</span>}
            </span>
          </div>
        </div>
        <div className={`pwi-connection-operational${status === "ready" ? "" : " pwi-connection-operational--warn"}`}>
          {status === "ready"
            ? <IconCheck style={{ width: 13, height: 13 }} aria-hidden="true" />
            : <IconAlert style={{ width: 13, height: 13 }} aria-hidden="true" />}
          {configurationText}
        </div>
        <div className="pwi-connection-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit} aria-label={t("pws.editAria", { name: item.name })}>
            <IconInfo style={{ width: 13, height: 13 }} aria-hidden="true" />
            {t("pws.editSettings")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick actions (selected provider overview)
// ---------------------------------------------------------------------------

function QuickActionsCard({ onSelectTab }: { onSelectTab: (tab: Tab) => void }) {
  const t = useT();
  return (
    <div className="providers-workspace-section">
      <div className="providers-workspace-section-head">
        <span className="providers-workspace-section-title">{t("pws.quickActions")}</span>
      </div>
      <div className="providers-workspace-section-body">
        <div className="pwi-qa-grid pwi-qa-grid--2">
          <a className="pwi-qa-tile" href="#models" onClick={() => onSelectTab("models")} aria-label={t("pws.qa.manageModels")}>
            <IconServer style={{ width: 18, height: 18 }} aria-hidden="true" />
            <span className="pwi-qa-label">{t("pws.qa.manageModels")}</span>
            <span className="pwi-qa-desc">{t("pws.qa.manageModelsDesc")}</span>
          </a>
          <a className="pwi-qa-tile" href="#usage" onClick={() => onSelectTab("usage")} aria-label={t("pws.qa.viewUsage")}>
            <IconActivity style={{ width: 18, height: 18 }} aria-hidden="true" />
            <span className="pwi-qa-label">{t("pws.qa.viewUsage")}</span>
            <span className="pwi-qa-desc">{t("pws.qa.viewUsageDesc")}</span>
          </a>
          <button type="button" className="pwi-qa-tile" onClick={() => onSelectTab("settings")} aria-label={t("pws.qa.apiSettings")}>
            <IconKey style={{ width: 18, height: 18 }} aria-hidden="true" />
            <span className="pwi-qa-label">{t("pws.qa.apiSettings")}</span>
            <span className="pwi-qa-desc">{t("pws.qa.apiSettingsDesc")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats sidebar
// ---------------------------------------------------------------------------

function StatsSidebar({ item, usageTotals, quotaReport, onViewUsage }: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: { updatedAt: number; source?: string };
  onViewUsage: () => void;
}) {
  const t = useT();
  const requests = usageTotals?.requests;
  const tokens = usageTotals?.totalTokens;
  return (
    <div className="pwi-stats-column">
      <aside className="pwi-stats-sidebar" aria-label={t("pws.statsAria")}>
        <div className="pwi-stats-head">{t("pws.statsTitle")}</div>
        <div className="pwi-stats-row-label">{t("pws.stats.requestsDay")}</div>
        <div className="pwi-stats-value">&mdash;</div>
        <div className="pwi-stats-unavailable muted">{t("pws.stats.dailyUnavailable")}</div>
        <div className="pwi-stats-divider" />
        <div className="pwi-stats-line">
          <span className="pwi-stats-line-label">{t("pws.stats.totalRequests")}</span>
          <span className="pwi-stats-line-value">{formatRequestCount(requests)}</span>
        </div>
        <div className="pwi-stats-line">
          <span className="pwi-stats-line-label">{t("dash.tokens30d")}</span>
          <span className="pwi-stats-line-value">{formatTokenCount(tokens)}</span>
        </div>
        {quotaReport && (
          <div className="pwi-stats-line">
            <span className="pwi-stats-line-label">{t("pws.stats.quotaUpdated")}</span>
            <span className="pwi-stats-line-value" title={quotaReport.source ? t("pws.stats.source", { source: quotaReport.source }) : undefined}>
              {formatRelativeTime(quotaReport.updatedAt)}
            </span>
          </div>
        )}
        <a href="#usage" className="pwi-stats-usage-link btn btn-ghost btn-sm" onClick={onViewUsage} aria-label={t("pws.stats.viewDetailed")}>
          <IconActivity style={{ width: 12, height: 12 }} aria-hidden="true" />
          {t("pws.stats.viewDetailed")}
          <IconChevron style={{ width: 11, height: 11 }} aria-hidden="true" />
        </a>
      </aside>
      <section className="pwi-stats-notes" aria-label={t("pws.notesAria")}>
        <div className="pwi-stats-notes-head">{t("pws.notes")}</div>
        {item.note ? (
          <div className="pwi-stats-notes-body">{item.note}</div>
        ) : (
          <div className="pwi-stats-notes-placeholder muted">{t("pws.notesPlaceholder")}</div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab panels
// ---------------------------------------------------------------------------

function TabOverview({
  item, usageTotals, quotaReport, onSelectTab, lastCheckedAt,
  oauth, accounts, keys, busy, loginHint, authHandlers,
}: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: { updatedAt: number; source?: string };
  onSelectTab: (tab: Tab) => void;
  lastCheckedAt?: number;
  oauth?: { loggedIn: boolean; email?: string; error?: string };
  accounts?: OAuthAccountRow[];
  keys?: ApiKeyRow[];
  busy?: boolean;
  loginHint?: LoginHint | null;
  authHandlers?: ProviderAuthHandlers;
}) {
  return (
    <div className="pwi-overview-tab">
      {/* Note is shown in the Notes card only — avoid duplicating above Connection. */}
      <div className="pwi-overview-layout">
        <div className="pwi-overview-main">
          <ConnectionCard item={item} onEdit={() => onSelectTab("settings")} lastCheckedAt={lastCheckedAt ?? quotaReport?.updatedAt} />
          <AuthAccountsCard
            item={item}
            oauth={oauth}
            accounts={accounts}
            keys={keys}
            busy={busy}
            loginHint={loginHint}
            authHandlers={authHandlers}
          />
          <QuickActionsCard onSelectTab={onSelectTab} />
        </div>
        <StatsSidebar item={item} usageTotals={usageTotals} quotaReport={quotaReport} onViewUsage={() => onSelectTab("usage")} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accounts / API keys (login-logout + multi-key) — new workspace style
// ---------------------------------------------------------------------------

function AuthAccountsCard({
  item, oauth, accounts = [], keys = [], busy = false, loginHint, authHandlers,
}: {
  item: WorkspaceItem;
  oauth?: { loggedIn: boolean; email?: string; error?: string };
  accounts?: OAuthAccountRow[];
  keys?: ApiKeyRow[];
  busy?: boolean;
  loginHint?: LoginHint | null;
  authHandlers?: ProviderAuthHandlers;
}) {
  const t = useT();
  const [addingKey, setAddingKey] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);

  const mode = (item.authMode ?? "").toLowerCase();
  const isOauth = mode === "oauth";
  const isForward = mode === "forward";
  const isLocal = mode === "local" || isLocalProvider(item);
  // Key-auth: explicit key mode, or unspecified mode that is not oauth/forward/local.
  const isKeyAuth = mode === "key" || (!isOauth && !isForward && !isLocal) || item.hasApiKey === true;

  // Always show when handlers exist: oauth login, key pool, or at least a configured key/local note.
  if (!authHandlers) return null;
  if (isForward) return null; // ChatGPT passthrough — no multi-key / multi-account here
  if (!isOauth && !isKeyAuth && !isLocal) return null;

  const hintForThis = loginHint?.provider === item.name ? loginHint : null;

  const submitKey = async () => {
    const key = newKey.trim();
    if (!key) return;
    setKeyBusy(true);
    const ok = await authHandlers.onAddApiKey(item.name, key);
    setKeyBusy(false);
    if (ok) {
      setNewKey("");
      setAddingKey(false);
    }
  };

  return (
    <div className="providers-workspace-section">
      <div className="providers-workspace-section-head">
        <span className="providers-workspace-section-title">
          {isOauth ? t("prov.accountLogin") : t("pws.apiKeys")}
        </span>
      </div>
      <div className="providers-workspace-section-body pwi-auth-body">
        {isOauth && (
          <>
            <div className="pwi-auth-status-row">
              <span className={`pwi-auth-dot ${oauth?.loggedIn ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
              <span className="pwi-auth-status-text">
                {oauth?.loggedIn
                  ? (oauth.email ? oauth.email : t("pws.loggedInTitle"))
                  : (oauth?.error || t("pws.notLoggedInTitle"))}
              </span>
              <span className="pwi-auth-actions">
                {oauth?.loggedIn ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => authHandlers.onLogout(item.name)}>
                    {t("prov.logout")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => authHandlers.onLogin(item.name, false)}
                    disabled={busy}
                  >
                    {busy
                      ? <><span className="pwi-spin-inline" aria-hidden="true" /> {t("prov.waitingBrowser")}</>
                      : <><IconLock style={{ width: 13, height: 13 }} aria-hidden="true" /> {t("prov.login")}</>}
                  </button>
                )}
              </span>
            </div>

            {busy && hintForThis && (hintForThis.url || hintForThis.instructions) && (
              <div className="pwi-auth-wait">
                <span className="pwi-spin-inline pwi-spin-inline--lg" aria-hidden="true" />
                <div className="pwi-auth-wait-copy">
                  <div className="pwi-auth-wait-title">{t("prov.waitingBrowser")}</div>
                  {hintForThis.instructions && (
                    <p className="pwi-auth-wait-hint muted">{hintForThis.instructions}</p>
                  )}
                  {hintForThis.url && (
                    <a
                      href={hintForThis.url}
                      target="_blank"
                      rel="noreferrer"
                      className="pwi-auth-open-link"
                    >
                      <IconExternal style={{ width: 13, height: 13 }} aria-hidden="true" />
                      {t("prov.didntOpen")}
                    </a>
                  )}
                </div>
              </div>
            )}

            {accounts.length > 0 && (
              <div className="pwi-auth-list" role="list">
                {accounts.map(account => (
                  <div
                    key={account.id}
                    className={`pwi-auth-row${account.active ? " pwi-auth-row--active" : ""}`}
                    role="listitem"
                  >
                    <button
                      type="button"
                      className="pwi-auth-row-main"
                      onClick={() => authHandlers.onSwitchAccount(item.name, account)}
                      disabled={account.active}
                      title={account.active ? t("pws.activeAccount") : t("pws.switchAccount")}
                    >
                      <span className={`pwi-auth-dot ${account.needsReauth ? "pwi-auth-dot--warn" : account.active ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                      <span className="pwi-auth-row-label">{account.email ?? account.id}</span>
                      {account.needsReauth && <span className="badge badge-amber">{t("pws.reauth")}</span>}
                      {account.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm pwi-auth-row-remove"
                      onClick={() => authHandlers.onRemoveAccount(item.name, account)}
                      aria-label={t("pws.removeAccountAria", { id: account.email ?? account.id })}
                    >
                      <IconTrash style={{ width: 13, height: 13 }} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="pwi-auth-add"
                  onClick={() => authHandlers.onLogin(item.name, true)}
                  disabled={busy}
                >
                  {busy
                    ? <><span className="pwi-spin-inline" aria-hidden="true" /> {t("prov.waitingBrowser")}</>
                    : <><IconPlus style={{ width: 13, height: 13 }} aria-hidden="true" /> {t("prov.accountAdd")}</>}
                </button>
              </div>
            )}
          </>
        )}

        {(isKeyAuth || (!isOauth && item.hasApiKey)) && (
          <>
            <div className="pwi-auth-status-row">
              <span className={`pwi-auth-dot ${item.hasApiKey || keys.length > 0 ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
              <span className="pwi-auth-status-text">
                {item.hasApiKey || keys.length > 0
                  ? (keys.find(k => k.active)?.masked ?? t("prov.hasApiKey"))
                  : t("pws.noApiKey")}
              </span>
            </div>
            {keys.length > 0 && (
              <div className="pwi-auth-list" role="list">
                {keys.map(entry => (
                  <div
                    key={entry.id}
                    className={`pwi-auth-row${entry.active ? " pwi-auth-row--active" : ""}`}
                    role="listitem"
                  >
                    <button
                      type="button"
                      className="pwi-auth-row-main"
                      onClick={() => authHandlers.onSwitchApiKey(item.name, entry)}
                      disabled={entry.active}
                      title={entry.active ? t("pws.activeKey") : t("pws.switchKey")}
                    >
                      <span className={`pwi-auth-dot ${entry.active ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                      <span className="pwi-auth-row-label mono">
                        {entry.label ? `${entry.label} · ${entry.masked}` : entry.masked}
                      </span>
                      {entry.active && <span className="badge badge-primary">{t("prov.accountActive")}</span>}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm pwi-auth-row-remove"
                      onClick={() => authHandlers.onRemoveApiKey(item.name, entry)}
                      aria-label={t("prov.keyRemoveAria", { key: entry.label ?? entry.masked })}
                    >
                      <IconTrash style={{ width: 13, height: 13 }} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {addingKey ? (
              <div className="pwi-auth-keyform">
                <input
                  className="input mono"
                  type="password"
                  autoFocus
                  placeholder={t("modal.apiKeyPlaceholder")}
                  value={newKey}
                  onChange={e => setNewKey(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") void submitKey();
                    if (e.key === "Escape") { setAddingKey(false); setNewKey(""); }
                  }}
                />
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void submitKey()} disabled={!newKey.trim() || keyBusy}>
                  {keyBusy ? t("pws.saving") : t("common.save")}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAddingKey(false); setNewKey(""); }}>
                  {t("common.cancel")}
                </button>
              </div>
            ) : (
              <button type="button" className="pwi-auth-add" onClick={() => setAddingKey(true)}>
                <IconPlus style={{ width: 13, height: 13 }} aria-hidden="true" />
                {t("prov.keyAdd")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TabModels({
  item,
  modelCount,
  availableModels,
  selectedModels,
}: {
  item: WorkspaceItem;
  modelCount: number;
  availableModels: string[];
  selectedModels: string[];
}) {
  const t = useT();
  const selectedSet = new Set(selectedModels);
  const models = availableModels.length > 0
    ? availableModels
    : item.defaultModel
      ? [item.defaultModel]
      : [];

  return (
    <div className="providers-workspace-section">
      <div className="providers-workspace-section-head">
        <span className="providers-workspace-section-title">{t("pws.tab.models")}</span>
        {modelCount > 0 ? (
          <span className="providers-workspace-section-meta">{t("pws.modelsAvailable", { count: modelCount })}</span>
        ) : null}
      </div>
      <div className="providers-workspace-section-body">
        {models.length > 0 ? (
          <div className="providers-workspace-model-list">
            {models.map(modelId => {
              const isDefault = modelId === item.defaultModel;
              const isSelected = selectedSet.has(modelId);
              return (
                <div key={modelId} className="providers-workspace-model-row">
                  <span className="providers-workspace-model-id">{modelId}</span>
                  <span className="providers-workspace-model-meta">
                    {isDefault ? <span className="badge badge-muted">{t("prov.defaultBadge")}</span> : null}
                    {isSelected ? <span className="badge badge-green">{t("pws.selected")}</span> : null}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="providers-workspace-row">
            <span className="providers-workspace-row-label">
              {t("pws.noDefaultModel")}
              <span className="providers-workspace-row-label-desc">
                {t("pws.modelsResolvedRuntime")}
              </span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function TabUsage({ item, usageTotals, quotaReport }: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: { updatedAt: number; source?: string };
}) {
  const t = useT();
  const when = formatRelativeTime(quotaReport?.updatedAt);
  return (
    <div className="providers-workspace-section">
      <div className="providers-workspace-section-head">
        <span className="providers-workspace-section-title">{t("pws.tab.usage")}</span>
      </div>
      <div className="providers-workspace-section-body">
        <div className="providers-workspace-row">
          <span className="providers-workspace-row-label">
            {t("pws.usageTotals")}
            <span className="providers-workspace-row-label-desc">
              {usageTotals?.requests === undefined
                ? t("pws.noUsageFor", { name: item.name })
                : t("pws.usageSummary", {
                    requests: formatRequestCount(usageTotals.requests),
                    tokens: formatTokenCount(usageTotals.totalTokens),
                  })}
            </span>
          </span>
        </div>
        {quotaReport && (
          <div className="providers-workspace-row">
            <span className="providers-workspace-row-label">
              {t("pws.quotaContext")}
              <span className="providers-workspace-row-label-desc">
                {quotaReport.source
                  ? t("pws.quotaUpdatedFrom", { when, source: quotaReport.source })
                  : t("pws.quotaUpdated", { when })}
              </span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function TabSettings({
  item,
  oauth,
  onSetDisabled,
  onUpdateProvider,
}: {
  item: WorkspaceItem;
  oauth?: { loggedIn: boolean; email?: string; error?: string };
  onSetDisabled: (name: string, disabled: boolean) => void;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [adapter, setAdapter] = useState(item.adapter);
  const [baseUrl, setBaseUrl] = useState(item.baseUrl);
  const [defaultModel, setDefaultModel] = useState(item.defaultModel ?? "");
  const [authMode, setAuthMode] = useState(String(item.authMode ?? (item.keyOptional ? "local" : "key")));
  const [apiKey, setApiKey] = useState("");
  const [note, setNote] = useState(item.note ?? "");
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Reset the settings form when the selected provider (or its server fields) change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional form reset on provider switch
    setAdapter(item.adapter);
    setBaseUrl(item.baseUrl);
    setDefaultModel(item.defaultModel ?? "");
    setAuthMode(String(item.authMode ?? (item.keyOptional ? "local" : "key")));
    setApiKey("");
    setNote(item.note ?? "");
    setMsg(null);
  }, [item.name, item.adapter, item.baseUrl, item.defaultModel, item.authMode, item.keyOptional, item.note]);

  const save = async () => {
    if (!onUpdateProvider) {
      setMsg({ ok: false, text: t("pws.updatesUnavailable") });
      return;
    }
    if (!adapter.trim() || !baseUrl.trim()) {
      setMsg({ ok: false, text: t("pws.adapterBaseRequired") });
      return;
    }
    setSaving(true);
    setMsg(null);
    const patch: ProviderUpdatePatch = {
      adapter: adapter.trim(),
      baseUrl: baseUrl.trim(),
      defaultModel: defaultModel.trim(),
      authMode,
      note: note.trim(),
    };
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    const res = await onUpdateProvider(item.name, patch);
    setSaving(false);
    setMsg(res.ok
      ? { ok: true, text: t("pws.settingsSaved") }
      : { ok: false, text: res.error || t("prov.saveFailed") });
    if (res.ok) setApiKey("");
  };

  const hasKey = item.hasApiKey === true;

  return (
    <>
      <div className="providers-workspace-section">
        <div className="providers-workspace-section-head">
          <span className="providers-workspace-section-title">{t("pws.connectionSettings")}</span>
        </div>
        <div className="providers-workspace-section-body pwi-settings-form">
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">{t("modal.providerName")}</span>
            <input className="input" value={item.name} disabled title={t("pws.renameUnsupported")} />
            <span className="pwi-settings-hint muted">{t("pws.immutableId")}</span>
          </label>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">{t("modal.adapter")}</span>
            <input className="input" value={adapter} onChange={e => setAdapter(e.target.value)} placeholder="openai-chat" />
          </label>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">{t("modal.baseUrl")}</span>
            <input className="input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={t("modal.baseUrlPlaceholder")} />
          </label>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">{t("pws.cell.defaultModel")}</span>
            <input className="input" value={defaultModel} onChange={e => setDefaultModel(e.target.value)} placeholder={t("pws.optionalPlaceholder")} />
          </label>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">{t("pws.note")}</span>
            <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={t("pws.notePlaceholder")} />
          </label>
        </div>
      </div>

      <div className="providers-workspace-section">
        <div className="providers-workspace-section-head">
          <span className="providers-workspace-section-title">{t("pws.cell.auth")}</span>
        </div>
        <div className="providers-workspace-section-body pwi-settings-form">
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">{t("pws.authMode")}</span>
            <select className="input" value={authMode} onChange={e => setAuthMode(e.target.value)}>
              <option value="key">{t("modal.badge.apiKey")}</option>
              <option value="forward">{t("pws.authForward")}</option>
              <option value="oauth">{t("modal.badge.oauth")}</option>
              <option value="local">{t("modal.badge.local")}</option>
            </select>
            <span className="pwi-settings-hint muted">{t("pws.authCurrent", { mode: authModeLabel(item, t) })}</span>
          </label>
          {(authMode === "key" || (!authMode && !item.keyOptional)) && (
            <label className="pwi-settings-field">
              <span className="pwi-settings-label">{t("modal.apiKey")}</span>
              <input
                className="input"
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={hasKey ? t("pws.apiKeyKeepPlaceholder") : t("modal.apiKeyPlaceholder")}
                autoComplete="off"
              />
              <span className="pwi-settings-hint muted">
                {hasKey
                  ? <><span className="badge badge-green" style={{ marginRight: 6 }}>{t("pws.configured")}</span>{t("pws.keyReplaceHint")}</>
                  : <><span className="badge badge-amber" style={{ marginRight: 6 }}>{t("pws.missing")}</span>{t("pws.keyRequiredHint")}</>}
              </span>
            </label>
          )}
          {authMode === "oauth" && (
            <div className="providers-workspace-row">
              <span className="providers-workspace-row-label">
                {t("pws.signInStatus")}
                <span className="providers-workspace-row-label-desc">
                  {oauth?.error
                    ? oauth.error
                    : oauth?.loggedIn
                      ? (oauth.email ? t("pws.signedInAs", { email: oauth.email }) : t("pws.signedIn"))
                      : t("pws.notSignedInHint")}
                </span>
              </span>
              <span className="providers-workspace-row-value">{oauth?.loggedIn ? t("pws.status.ready") : t("pws.status.needsSetup")}</span>
            </div>
          )}
          {item.keyOptional && (
            <div className="providers-workspace-row">
              <span className="providers-workspace-row-label">
                {t("modal.freeTierTitle")}
                <span className="providers-workspace-row-label-desc">{t("pws.freeTierDesc")}</span>
              </span>
            </div>
          )}
          <div className="pwi-settings-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving || !onUpdateProvider}>
              {saving ? t("pws.saving") : t("pws.saveSettings")}
            </button>
            {msg && <span className={msg.ok ? "pwi-settings-msg pwi-settings-msg--ok" : "pwi-settings-msg pwi-settings-msg--err"}>{msg.text}</span>}
          </div>
        </div>
      </div>

      <div className="providers-workspace-section">
        <div className="providers-workspace-section-head">
          <span className="providers-workspace-section-title">{t("pws.providerState")}</span>
        </div>
        <div className="providers-workspace-section-body">
          <div className="providers-workspace-row">
            <span className="providers-workspace-row-label">
              {item.disabled ? t("pws.providerDisabledLabel") : t("pws.providerEnabledLabel")}
              <span className="providers-workspace-row-label-desc">{t("pws.disabledRoutingHint")}</span>
            </span>
            <span className="providers-workspace-row-controls">
              <button
                type="button"
                className={`btn ${item.disabled ? "btn-primary" : "btn-ghost"} btn-sm`}
                onClick={() => onSetDisabled(item.name, !item.disabled)}
                aria-label={item.disabled ? t("prov.enableAria", { name: item.name }) : t("prov.disableAria", { name: item.name })}
              >
                <IconPower style={{ width: 13, height: 13 }} aria-hidden="true" />
                {item.disabled ? t("prov.enable") : t("prov.disable")}
              </button>
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function DetailPanel({
  item, apiBase, defaultProvider, onSetDisabled, onRemoveProvider, onDeselect, onUpdateProvider,
  usageTotals, quotaReport, oauth, modelCount, availableModels, selectedModels,
  onTestDone, accounts, keys, busy, loginHint, authHandlers,
}: {
  item: WorkspaceItem;
  apiBase: string;
  defaultProvider?: string;
  onSetDisabled: (name: string, disabled: boolean) => void;
  onRemoveProvider: (name: string) => void;
  onDeselect: () => void;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: { updatedAt: number; source?: string };
  oauth?: { loggedIn: boolean; email?: string; error?: string };
  modelCount: number;
  availableModels: string[];
  selectedModels: string[];
  onTestDone?: () => void;
  accounts?: OAuthAccountRow[];
  keys?: ApiKeyRow[];
  busy?: boolean;
  loginHint?: LoginHint | null;
  authHandlers?: ProviderAuthHandlers;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("overview");
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | undefined>(quotaReport?.updatedAt);
  const isEnabled = !item.disabled;

  // Reset detail chrome when the selected provider changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional UI reset on provider switch
    setTab("overview");
    setTestMsg(null);
    setLastCheckedAt(quotaReport?.updatedAt);
  }, [item.name]); // eslint-disable-line react-hooks/exhaustive-deps -- reset UI when switching provider

  const testConnection = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await fetch(`${apiBase}/api/providers/test?name=${encodeURIComponent(item.name)}`, { method: "POST" });
      const data = await res.json().catch(() => ({})) as {
        ok?: boolean; latencyMs?: number; models?: number; message?: string; error?: string;
      };
      const ok = data.ok === true;
      const latency = typeof data.latencyMs === "number" ? ` · ${data.latencyMs}ms` : "";
      setTestMsg({
        ok,
        text: ok
          ? `${data.message ?? t("pws.status.connected")}${latency}`
          : `${data.error ?? t("pws.connectionFailed")}${latency}`,
      });
      if (ok) {
        setLastCheckedAt(Date.now());
        onTestDone?.();
      }
    } catch {
      setTestMsg({ ok: false, text: t("modal.networkError") });
    } finally {
      setTesting(false);
    }
  };

  const confirmRemove = () => {
    if (window.confirm(t("pws.removeConfirmUi", { name: item.name }))) {
      onRemoveProvider(item.name);
    }
  };

  const renderTabPanel = (): ReactNode => {
    switch (tab) {
      case "overview": return (
        <TabOverview
          item={item}
          usageTotals={usageTotals}
          quotaReport={quotaReport}
          onSelectTab={setTab}
          lastCheckedAt={lastCheckedAt}
          oauth={oauth}
          accounts={accounts}
          keys={keys}
          busy={busy}
          loginHint={loginHint}
          authHandlers={authHandlers}
        />
      );
      case "models": return (
        <TabModels
          item={item}
          modelCount={modelCount}
          availableModels={availableModels}
          selectedModels={selectedModels}
        />
      );
      case "usage": return <TabUsage item={item} usageTotals={usageTotals} quotaReport={quotaReport} />;
      case "settings": return (
        <TabSettings
          item={item}
          oauth={oauth}
          onSetDisabled={onSetDisabled}
          onUpdateProvider={onUpdateProvider}
        />
      );
      default: return null;
    }
  };

  return (
    <div className="providers-workspace-detail" role="region" aria-label={t("pws.detailAria", { name: item.name })}>
      <div className="providers-workspace-detail-head">
        <button
          type="button"
          className="btn btn-ghost btn-sm pwi-back-overview"
          onClick={onDeselect}
          aria-label={t("pws.backToAll")}
          title={t("pws.backToAll")}
        >
          <IconChevron style={{ width: 14, height: 14, transform: "rotate(180deg)" }} aria-hidden="true" />
          {t("pws.allProviders")}
        </button>
        <ProviderIcon
          name={item.name}
          adapter={item.adapter}
          baseUrl={item.baseUrl}
          cls="providers-workspace-detail-icon"
        />
        <div className="providers-workspace-detail-title-group">
          <div className="providers-workspace-detail-title-row">
            <div className="providers-workspace-detail-title">{item.name}</div>
            {defaultProvider === item.name && (
              <span className="pwi-rail-meta pwi-rail-meta--default" title={t("pws.defaultTitle")}>{t("prov.defaultBadge")}</span>
            )}
            {isLocalProvider(item) ? (
              <span className="pwi-rail-meta" title={t("pws.localTitle")}>{t("modal.badge.local")}</span>
            ) : isFreeProvider(item) ? (
              <span className="pwi-rail-meta pwi-rail-meta--free" title={t("pws.freeTitle")}>{t("modal.badge.free")}</span>
            ) : null}
          </div>
        </div>
        <div className="providers-workspace-detail-actions">
          <div className="pwi-test-cluster">
            <span
              className={`pwi-test-msg${testMsg ? (testMsg.ok ? " pwi-test-msg--ok" : " pwi-test-msg--err") : " pwi-test-msg--idle"}`}
              role="status"
              aria-live="polite"
            >
              {testing ? t("pws.checking") : (testMsg?.text ?? "")}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void testConnection()}
              disabled={testing || item.disabled}
              aria-label={t("pws.testConnection")}
              title={item.disabled ? t("pws.enableFirst") : t("pws.probeModels")}
            >
              <IconRefresh style={{ width: 13, height: 13 }} aria-hidden="true" className={testing ? "pwi-spin" : undefined} />
              {testing ? t("pws.testing") : t("pws.testConnection")}
            </button>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm pwi-remove-btn"
            onClick={confirmRemove}
            aria-label={t("pws.removeProviderAria", { name: item.name })}
            title={t("pws.removeProvider")}
          >
            <IconTrash style={{ width: 15, height: 15 }} aria-hidden="true" />
          </button>
          <div className="pwi-enabled-toggle">
            <span className="pwi-enabled-label">{t("pws.enabledLabel")}</span>
            <Switch
              on={isEnabled}
              onClick={() => onSetDisabled(item.name, isEnabled)}
              label={isEnabled ? t("prov.disableAria", { name: item.name }) : t("prov.enableAria", { name: item.name })}
            />
          </div>
        </div>
      </div>

      <div className="providers-workspace-tabs" role="tablist" aria-label={t("pws.tabsAria", { name: item.name })}>
        {TAB_DEFS.map(tabDef => (
          <button
            key={tabDef.id}
            type="button"
            role="tab"
            id={`provider-tab-${tabDef.id}`}
            aria-controls={tabDef.id}
            className={`providers-workspace-tab${tab === tabDef.id ? " providers-workspace-tab--active" : ""}`}
            onClick={() => setTab(tabDef.id)}
            aria-selected={tab === tabDef.id}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
      </div>

      <div
        className="providers-workspace-tab-content"
        role="tabpanel"
        id={tab}
        aria-labelledby={`provider-tab-${tab}`}
      >
        {renderTabPanel()}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({
  onAddProvider,
}: {
  onAddProvider: () => void;
}) {
  const t = useT();
  // One CTA: opens the add-provider catalog (Custom is a row inside that modal).
  return (
    <div className="providers-workspace-empty-root">
      <div className="pwi-empty-hero">
        <div className="pwi-empty-right-icon" aria-hidden="true">
          <IconBoxes style={{ width: 64, height: 64 }} />
        </div>
        <h2 className="pwi-empty-right-title">{t("pws.connectFirst")}</h2>
        <p className="pwi-empty-right-sub">
          {t("pws.connectFirstSub")}
        </p>
        <button type="button" className="btn btn-primary" onClick={onAddProvider} aria-label={t("pws.addAria")}>
          <IconPlus style={{ width: 14, height: 14 }} aria-hidden="true" />
          {t("pws.addProvider")}
        </button>
        <p className="pwi-empty-doc-link muted">
          {t("pws.notSure")}{" "}
          <a href="https://opencodex.dev/docs" target="_blank" rel="noreferrer" className="link-btn">
            {t("pws.viewDocs")}
          </a>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview panel
// ---------------------------------------------------------------------------

function OverviewPanel({
  sections, onSelect, onEditConfig, attentionItems, usageTotals
}: {
  sections: WorkspaceSections;
  onSelect: (name: string) => void;
  onEditConfig: () => void;
  attentionItems: AttentionItem[];
  usageTotals: Record<string, ProviderUsageTotals>;
}) {
  const t = useT();
  const providersByName = useMemo(
    () => new Map(
      [...sections.ready, ...sections.needsSetup, ...sections.disabled].map(item => [item.name, item]),
    ),
    [sections],
  );
  const mostUsed = useMemo(
    () => buildMostUsedProviders(usageTotals)
      .filter(entry => providersByName.has(entry.name))
      .slice(0, 4),
    [usageTotals, providersByName],
  );
  const codingStats = useMemo(() => {
    let requests = 0;
    let tokens = 0;
    let activeProviders = 0;
    for (const [name, row] of Object.entries(usageTotals)) {
      if (!providersByName.has(name)) continue;
      if (typeof row.requests === "number" && row.requests > 0) {
        requests += row.requests;
        activeProviders += 1;
      }
      if (typeof row.totalTokens === "number" && row.totalTokens > 0) {
        tokens += row.totalTokens;
      }
    }
    return { requests, tokens, activeProviders };
  }, [usageTotals, providersByName]);

  return (
    <div className="providers-workspace-overview">
      <div className="providers-workspace-overview-head">
        <h2 className="providers-workspace-overview-title">{t("pws.overviewTitle")}</h2>
        <p className="providers-workspace-overview-sub">{t("pws.overviewSub")}</p>
      </div>
      <div className="providers-workspace-summary-row">
        <div className="providers-workspace-summary-card pwi-summary-ready">
          <span className="providers-workspace-summary-value">{sections.ready.length}</span>
          <span className="providers-workspace-summary-label">{t("pws.status.ready")}</span>
        </div>
        <div className="providers-workspace-summary-card pwi-summary-setup">
          <span className="providers-workspace-summary-value">{sections.needsSetup.length}</span>
          <span className="providers-workspace-summary-label">{t("pws.needSetup")}</span>
        </div>
        <div className="providers-workspace-summary-card pwi-summary-disabled">
          <span className="providers-workspace-summary-value">{sections.disabled.length}</span>
          <span className="providers-workspace-summary-label">{t("prov.disabledBadge")}</span>
        </div>
      </div>

      {/* Coding volume last 30 days */}
      <div className="providers-workspace-summary-row pwi-coding-stats-row">
        <div className="providers-workspace-summary-card">
          <span className="providers-workspace-summary-value">
            {codingStats.requests > 0 ? formatRequestCount(codingStats.requests) : "\u2014"}
          </span>
          <span className="providers-workspace-summary-label">{t("pws.stats.totalRequests")}</span>
        </div>
        <div className="providers-workspace-summary-card">
          <span className="providers-workspace-summary-value">
            {codingStats.tokens > 0 ? formatTokenCount(codingStats.tokens) : "\u2014"}
          </span>
          <span className="providers-workspace-summary-label">{t("pws.stats.tokens30d")}</span>
        </div>
        <div className="providers-workspace-summary-card">
          <span className="providers-workspace-summary-value">
            {codingStats.activeProviders > 0 ? codingStats.activeProviders : "\u2014"}
          </span>
          <span className="providers-workspace-summary-label">{t("pws.stats.activeCoded")}</span>
        </div>
      </div>

      {/* Equal panels: compact Edit JSON card | Recently used */}
      <div className="pwi-overview-edit-recent">
        <button
          type="button"
          className="providers-workspace-summary-card pwi-edit-json-card"
          onClick={onEditConfig}
          aria-label={t("prov.editJson")}
        >
          <span className="pwi-edit-json-card-title">{t("prov.editJson")}</span>
          <span className="providers-workspace-summary-label">{t("pws.editJsonDesc")}</span>
        </button>
        <div className="pwi-overview-section pwi-overview-recent">
          <div className="pwi-overview-section-head">{t("pws.recentlyUsed")}</div>
          <div className="pwi-overview-recent-body">
            {mostUsed.length === 0 ? (
              <div className="pwi-recent-empty muted">{t("pws.noUsageRecorded")}</div>
            ) : mostUsed.map(entry => {
              const item = providersByName.get(entry.name)!;
              return (
              <button key={entry.name} type="button" className="pwi-recent-row"
                onClick={() => onSelect(entry.name)} aria-label={t("pws.openProvider", { name: entry.name })}>
                <ProviderIcon name={entry.name} adapter={item.adapter} baseUrl={item.baseUrl}
                  cls="providers-workspace-rail-icon" />
                <span className="pwi-recent-name">{entry.name}</span>
                <span className="muted">{t("pws.requestsCount", { count: formatRequestCount(entry.requests) })}</span>
                <IconChevron style={{ width: 13, height: 13, color: "var(--muted)" }} aria-hidden="true" />
              </button>
            );})}
          </div>
        </div>
      </div>

      {attentionItems.length > 0 && (
        <div className="pwi-overview-section pwi-overview-attention">
          <div className="pwi-overview-section-head">{t("pws.attentionRequired")}</div>
          {attentionItems.map(ai => (
            <button key={ai.name} type="button" className="pwi-attention-row"
              onClick={() => onSelect(ai.name)}
              aria-label={t("pws.attentionAria", { name: ai.name, reason: ai.reason })}>
              <span className="pwi-dot pwi-dot--warning" aria-hidden="true" />
              <span className="pwi-attention-name">{ai.name}</span>
              <span className="pwi-attention-reason muted">{ai.reason}</span>
              <IconChevron style={{ width: 13, height: 13, color: "var(--muted)" }} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export default function ProviderWorkspace({
  providers, apiBase, defaultProvider, onAddProvider,
  onUseLegacyView: _onUseLegacyView, onEditConfig,
  onSetDisabled, onRemoveProvider, onUpdateProvider, quotaReports = {}, oauthStatus = {},
  accountSets = {}, keyPools = {}, busyProvider = null, loginHint = null, authHandlers,
}: ProviderWorkspaceProps) {
  void _onUseLegacyView;
  const t = useT();
  const [search, setSearch] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [modelCounts, setModelCounts] = useState<ProviderModelCounts>({});
  const [availableModels, setAvailableModels] = useState<ProviderAvailableModels>({});
  const [selectedModels, setSelectedModels] = useState<ProviderSelectedModels>({});
  const [usageTotals, setUsageTotals] = useState<Record<string, ProviderUsageTotals>>({});
  /** Status + pricing facets shown in the rail (all on by default). */
  const [statusFilter, setStatusFilter] = useState({ ready: true, needsSetup: true, disabled: true });
  const [pricingFilter, setPricingFilter] = useState({ free: true, paid: true });
  const [sortMode, setSortMode] = useState<ProviderSortMode>("az");
  const [filterOpen, setFilterOpen] = useState(false);
  const filterWrapRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => buildProviderWorkspace(providers), [providers]);

  const allItems = useMemo(
    () => [...sections.ready, ...sections.needsSetup, ...sections.disabled],
    [sections],
  );
  const freeCount = useMemo(() => allItems.filter(isFreeProvider).length, [allItems]);
  const paidCount = allItems.length - freeCount;

  const filteredSections = useMemo((): WorkspaceSections => {
    const q = search.trim().toLowerCase();
    const byQueryAndPricing = (items: WorkspaceItem[]) => {
      const filtered = items.filter(p => {
        if (q && !p.name.toLowerCase().includes(q) && !p.adapter.toLowerCase().includes(q)) return false;
        const free = isFreeProvider(p);
        if (free && !pricingFilter.free) return false;
        if (!free && !pricingFilter.paid) return false;
        return true;
      });
      return sortWorkspaceItems(filtered, sortMode);
    };
    return {
      ready: statusFilter.ready ? byQueryAndPricing(sections.ready) : [],
      needsSetup: statusFilter.needsSetup ? byQueryAndPricing(sections.needsSetup) : [],
      disabled: statusFilter.disabled ? byQueryAndPricing(sections.disabled) : [],
    };
  }, [sections, search, statusFilter, pricingFilter, sortMode]);

  const filterActive =
    !statusFilter.ready || !statusFilter.needsSetup || !statusFilter.disabled
    || !pricingFilter.free || !pricingFilter.paid
    || sortMode !== "az";

  const resetFilters = () => {
    setStatusFilter({ ready: true, needsSetup: true, disabled: true });
    setPricingFilter({ free: true, paid: true });
    setSortMode("az");
  };

  useEffect(() => {
    if (!filterOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (filterWrapRef.current && !filterWrapRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  const selectedItem = useMemo(
    () => selectedName
      ? [...sections.ready, ...sections.needsSetup, ...sections.disabled].find(p => p.name === selectedName) ?? null
      : null,
    [selectedName, sections],
  );

  const attentionItems = useMemo(() => buildAttentionItems(sections, {}), [sections]);

  const fetchModelCounts = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/selected-models`);
      if (!res.ok) return;
      const data = await res.json();
      setModelCounts(countAvailableModels(data));
      setAvailableModels(parseAvailableModels(data));
      setSelectedModels(parseSelectedModels(data));
    } catch { /* network unavailable */ }
  }, [apiBase]);

  const fetchUsageTotals = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/usage?range=30d`);
      if (!res.ok) return;
      const data = await res.json() as {
        providers?: Array<{ provider: string; requests: number; totalTokens?: number }>;
      };
      const byProvider: Record<string, ProviderUsageTotals> = {};
      for (const p of data.providers ?? []) {
        byProvider[p.provider] = { requests: p.requests, totalTokens: p.totalTokens };
      }
      setUsageTotals(byProvider);
    } catch { /* leave empty */ }
  }, [apiBase]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchModelCounts();
      void fetchUsageTotals();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchModelCounts, fetchUsageTotals]);

  const handleRemoveProvider = (name: string) => {
    onRemoveProvider(name);
    if (selectedName === name) setSelectedName(null);
  };

  const total = Object.keys(providers).length;

  if (total === 0) {
    return <EmptyState onAddProvider={onAddProvider} />;
  }

  const statusFilterOptions = [
    { key: "ready" as const, label: t("pws.status.ready"), dotCls: "pwi-dot--active", count: sections.ready.length },
    { key: "needsSetup" as const, label: t("pws.status.needsSetup"), dotCls: "pwi-dot--warning", count: sections.needsSetup.length },
    { key: "disabled" as const, label: t("prov.disabledBadge"), dotCls: "pwi-dot--inactive", count: sections.disabled.length },
  ];
  const railGroups = [
    { id: "ready", title: t("pws.groupReady", { count: filteredSections.ready.length }), items: filteredSections.ready, dotCls: "pwi-dot--active" },
    { id: "needs-setup", title: t("pws.groupNeedsSetup", { count: filteredSections.needsSetup.length }), items: filteredSections.needsSetup, dotCls: "pwi-dot--warning" },
    { id: "disabled", title: t("pws.groupDisabled", { count: filteredSections.disabled.length }), items: filteredSections.disabled, dotCls: "pwi-dot--inactive" },
  ];

  return (
    <div className="providers-workspace-root">
      <aside className="providers-workspace-rail" aria-label={t("pws.providerList")}>
        <div className="providers-workspace-rail-header">
          <span className="providers-workspace-rail-title">{t("nav.providers")}</span>
          <div className="pwi-rail-header-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm pwi-rail-add-btn"
              onClick={onAddProvider}
              aria-label={t("modal.add")}
              title={t("modal.add")}
            >
              <IconPlus style={{ width: 13, height: 13 }} aria-hidden="true" />
              {t("modal.add")}
            </button>
          </div>
        </div>
        <div className="pwi-rail-search-row">
          <div className="pwi-rail-search-wrap">
            <IconSearch className="pwi-rail-search-icon" width={14} height={14} aria-hidden="true" />
            <input
              type="search"
              className="input pwi-rail-search-input"
              placeholder={t("pws.searchPlaceholder")}
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label={t("pws.searchPlaceholder")}
            />
          </div>
          <div className="pwi-rail-filter-wrap" ref={filterWrapRef}>
            <button
              type="button"
              className={`btn btn-ghost btn-sm pwi-rail-filter-btn${filterActive || filterOpen ? " pwi-rail-filter-btn--active" : ""}`}
              onClick={() => setFilterOpen(o => !o)}
              aria-label={t("pws.filterAria")}
              aria-haspopup="menu"
              aria-expanded={filterOpen}
              title={t("pws.filterAria")}
            >
              <IconFilter width={29} height={29} aria-hidden="true" />
              {filterActive && <span className="pwi-rail-filter-dot" aria-hidden="true" />}
            </button>
            {filterOpen && (
              <div className="pwi-rail-filter-menu" role="menu" aria-label={t("pws.providerFiltersAria")}>
                <div className="pwi-rail-filter-menu-title">{t("pws.filters")}</div>

                <div className="pwi-rail-filter-section">
                  <div className="pwi-rail-filter-menu-head">{t("pws.filterStatus")}</div>
                  {statusFilterOptions.map(({ key, label, dotCls, count }) => (
                    <label key={key} className={`pwi-rail-filter-option${statusFilter[key] ? " pwi-rail-filter-option--on" : ""}`} role="menuitemcheckbox" aria-checked={statusFilter[key]}>
                      <span className={`pwi-rail-filter-check${statusFilter[key] ? " pwi-rail-filter-check--on" : ""}`} aria-hidden="true">
                        {statusFilter[key] ? <IconCheck width={11} height={11} /> : null}
                      </span>
                      <input
                        type="checkbox"
                        className="pwi-rail-filter-native"
                        checked={statusFilter[key]}
                        onChange={() => setStatusFilter(prev => ({ ...prev, [key]: !prev[key] }))}
                      />
                      <span className={`pwi-dot ${dotCls}`} aria-hidden="true" />
                      <span className="pwi-rail-filter-option-label">{label}</span>
                      <span className="pwi-rail-filter-option-count">{count}</span>
                    </label>
                  ))}
                </div>

                <div className="pwi-rail-filter-section">
                  <div className="pwi-rail-filter-menu-head">{t("pws.pricing")}</div>
                  <label className={`pwi-rail-filter-option${pricingFilter.free ? " pwi-rail-filter-option--on" : ""}`} role="menuitemcheckbox" aria-checked={pricingFilter.free}>
                    <span className={`pwi-rail-filter-check${pricingFilter.free ? " pwi-rail-filter-check--on" : ""}`} aria-hidden="true">
                      {pricingFilter.free ? <IconCheck width={11} height={11} /> : null}
                    </span>
                    <input
                      type="checkbox"
                      className="pwi-rail-filter-native"
                      checked={pricingFilter.free}
                      onChange={() => setPricingFilter(prev => ({ ...prev, free: !prev.free }))}
                    />
                    <span className="pwi-rail-filter-option-label">{t("modal.badge.free")}</span>
                    <span className="pwi-rail-filter-option-count">{freeCount}</span>
                  </label>
                  <label className={`pwi-rail-filter-option${pricingFilter.paid ? " pwi-rail-filter-option--on" : ""}`} role="menuitemcheckbox" aria-checked={pricingFilter.paid}>
                    <span className={`pwi-rail-filter-check${pricingFilter.paid ? " pwi-rail-filter-check--on" : ""}`} aria-hidden="true">
                      {pricingFilter.paid ? <IconCheck width={11} height={11} /> : null}
                    </span>
                    <input
                      type="checkbox"
                      className="pwi-rail-filter-native"
                      checked={pricingFilter.paid}
                      onChange={() => setPricingFilter(prev => ({ ...prev, paid: !prev.paid }))}
                    />
                    <span className="pwi-rail-filter-option-label">{t("pws.paid")}</span>
                    <span className="pwi-rail-filter-option-count">{paidCount}</span>
                  </label>
                </div>

                <div className="pwi-rail-filter-section">
                  <div className="pwi-rail-filter-menu-head">{t("pws.sort")}</div>
                  <div className="pwi-rail-sort-grid" role="group" aria-label={t("pws.sortProvidersAria")}>
                    {SORT_DEFS.map(opt => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`pwi-rail-sort-btn${sortMode === opt.id ? " pwi-rail-sort-btn--active" : ""}`}
                        onClick={() => setSortMode(opt.id)}
                        aria-pressed={sortMode === opt.id}
                      >
                        {t(opt.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pwi-rail-filter-footer">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm pwi-rail-filter-reset"
                    onClick={resetFilters}
                    disabled={!filterActive}
                  >
                    {t("pws.resetAll")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="providers-workspace-rail-list" role="listbox" aria-label={t("pws.providersAria")}>
          {Object.values(filteredSections).every(items => items.length === 0) && (
            <span className="muted" style={{ fontSize: 12, padding: "8px 4px" }}>
              {search
                ? t("pws.noResults", { search })
                : filterActive
                  ? t("pws.noMatchFilters")
                  : t("pws.noProvidersConfigured")}
            </span>
          )}
          {railGroups.map(({ id, title, items, dotCls }) => {
            if (items.length === 0) return null;
            return (
              <div key={id} className="providers-workspace-rail-group" role="group" aria-labelledby={`provider-group-${id}`}>
                <div id={`provider-group-${id}`} className="providers-workspace-rail-group-head pwi-group-head">
                  <span className={`pwi-dot ${dotCls}`} aria-hidden="true" />
                  <span>{title}</span>
                </div>
                {items.map(item => (
                  <RailRow key={item.name} item={item}
                    selected={selectedName === item.name}
                    modelCount={modelCounts[item.name]}
                    isDefault={defaultProvider === item.name}
                    onClick={() => setSelectedName(item.name)} />
                ))}
              </div>
            );
          })}
        </div>
      </aside>
      <main className="providers-workspace-main" aria-label={t("pws.workspaceMainAria")}>
        {selectedItem ? (
          <DetailPanel
            item={selectedItem}
            apiBase={apiBase}
            defaultProvider={defaultProvider}
            onSetDisabled={onSetDisabled}
            onRemoveProvider={handleRemoveProvider}
            onDeselect={() => setSelectedName(null)}
            onUpdateProvider={onUpdateProvider}
            usageTotals={usageTotals[selectedItem.name]}
            quotaReport={quotaReports[selectedItem.name]}
            oauth={oauthStatus[selectedItem.name]}
            modelCount={modelCounts[selectedItem.name] ?? 0}
            availableModels={availableModels[selectedItem.name] ?? []}
            selectedModels={selectedModels[selectedItem.name] ?? []}
            onTestDone={() => { void fetchModelCounts(); }}
            accounts={accountSets[selectedItem.name]?.accounts}
            keys={keyPools[selectedItem.name]}
            busy={busyProvider === selectedItem.name}
            loginHint={loginHint}
            authHandlers={authHandlers}
          />
        ) : (
          <OverviewPanel
            sections={sections}
            onSelect={setSelectedName}
            onEditConfig={onEditConfig}
            attentionItems={attentionItems}
            usageTotals={usageTotals}
          />
        )}
      </main>
    </div>
  );
}
