import { useState, useMemo, useEffect, useCallback, useRef } from "react";
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
  IconGlobe,
  IconInfo,
  IconList,
  IconChevron,
  IconExternal,
  IconActivity,
  IconLock,
} from "../icons";
import { Switch } from "../ui";

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
  /** Open the add-provider flow focused on a custom endpoint (not a catalog preset). */
  onAddCustomProvider?: () => void;
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

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "models",   label: "Models" },
  { id: "usage",    label: "Usage & limits" },
  { id: "settings", label: "Settings" },
];

const SORT_OPTIONS: { id: ProviderSortMode; label: string }[] = [
  { id: "az", label: "A → Z" },
  { id: "za", label: "Z → A" },
  { id: "free-paid", label: "Free → Paid" },
  { id: "paid-free", label: "Paid → Free" },
];

function statusLabel(p: WorkspaceProvider): string {
  const s = binProviderStatus(p);
  if (s === "disabled") return "Disabled";
  if (s === "ready")    return "Ready";
  return "Needs setup";
}

function authModeLabel(item: WorkspaceItem): string {
  switch (item.authMode) {
    case "oauth":   return "OAuth";
    case "forward": return "Passthrough";
    case "local":   return "Local";
    case "key":     return "API key";
    default:        return item.authMode ?? (item.keyOptional ? "No key needed" : "API key");
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
  const free = isFreeProvider(item);
  const local = isLocalProvider(item);
  return (
    <button
      type="button"
      className={`providers-workspace-rail-row${selected ? " providers-workspace-rail-row--selected" : ""}`}
      onClick={onClick}
      role="option"
      aria-selected={selected}
      aria-label={`Select provider ${item.name}, ${statusLabel(item)}${isDefault ? ", default" : ""}${local ? ", local" : free ? ", free" : ""}`}
    >
      <ProviderIcon
        name={item.name}
        adapter={item.adapter}
        baseUrl={item.baseUrl}
        cls="providers-workspace-rail-icon"
      />
      <span className="providers-workspace-rail-name">{item.name}</span>
      {isDefault && (
        <span className="pwi-rail-meta pwi-rail-meta--default" title="Default routing provider">Default</span>
      )}
      {/* Only label exceptions (Local / Free). Paid is the unmarked default. */}
      {local ? (
        <span className="pwi-rail-meta" title="Local runtime">Local</span>
      ) : free ? (
        <span className="pwi-rail-meta pwi-rail-meta--free" title="No API key required">Free</span>
      ) : null}
      <span className={railStatusCls(item)} aria-hidden="true" title={statusLabel(item)} />
      {modelCount !== undefined && modelCount > 0 && (
        <span className="providers-workspace-rail-model-count">{modelCount} models</span>
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
  const baseUrl = item.baseUrl?.trim() ? item.baseUrl : "—";
  const status = binProviderStatus(item);
  // Match design mock: connection cell uses "Connected" while the list uses Ready/Needs setup.
  const statusText = status === "ready" ? "Connected" : status === "needs-setup" ? "Needs setup" : "Disabled";
  const configurationText = status === "ready"
    ? "All systems operational"
    : status === "needs-setup" ? "Credentials required" : "Provider disabled";
  const statusCls = status === "ready"
    ? "pwi-connection-status pwi-connection-status--ok"
    : "pwi-connection-status pwi-connection-status--warn";
  return (
    <div className="providers-workspace-section">
      <div className="providers-workspace-section-head">
        <span className="providers-workspace-section-title">Connection</span>
      </div>
      <div className="providers-workspace-section-body">
        <div className="pwi-connection-grid">
          <div className="pwi-connection-cell">
            <span className="pwi-cell-label">Status</span>
            <span className={statusCls}>{statusText}</span>
          </div>
          <div className="pwi-connection-cell">
            <span className="pwi-cell-label">Base URL</span>
            <code className="pwi-cell-value-mono">{baseUrl}</code>
          </div>
          <div className="pwi-connection-cell">
            <span className="pwi-cell-label">Last checked</span>
            <span className="pwi-cell-value">{formatRelativeTime(lastCheckedAt)}</span>
          </div>
          <div className="pwi-connection-cell">
            <span className="pwi-cell-label">Authentication</span>
            <span className="pwi-cell-value">{authModeLabel(item)}</span>
          </div>
          <div className="pwi-connection-cell">
            <span className="pwi-cell-label">Default model</span>
            <span className="pwi-cell-value">
              {item.defaultModel
                ? <>{item.defaultModel}{" "}<span className="badge badge-muted">Default</span></>
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
          <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit} aria-label={`Edit ${item.name}`}>
            <IconInfo style={{ width: 13, height: 13 }} aria-hidden="true" />
            Edit settings
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
  return (
    <div className="providers-workspace-section">
      <div className="providers-workspace-section-head">
        <span className="providers-workspace-section-title">Quick actions</span>
      </div>
      <div className="providers-workspace-section-body">
        <div className="pwi-qa-grid pwi-qa-grid--2">
          <a className="pwi-qa-tile" href="#models" onClick={() => onSelectTab("models")} aria-label="Manage models">
            <IconServer style={{ width: 18, height: 18 }} aria-hidden="true" />
            <span className="pwi-qa-label">Manage models</span>
            <span className="pwi-qa-desc">View and configure available models</span>
          </a>
          <a className="pwi-qa-tile" href="#usage" onClick={() => onSelectTab("usage")} aria-label="View usage">
            <IconActivity style={{ width: 18, height: 18 }} aria-hidden="true" />
            <span className="pwi-qa-label">View usage</span>
            <span className="pwi-qa-desc">Check your usage and limits</span>
          </a>
          <button type="button" className="pwi-qa-tile" onClick={() => onSelectTab("settings")} aria-label="API settings">
            <IconKey style={{ width: 18, height: 18 }} aria-hidden="true" />
            <span className="pwi-qa-label">API settings</span>
            <span className="pwi-qa-desc">Configure advanced API settings</span>
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
  const requests = usageTotals?.requests;
  const tokens = usageTotals?.totalTokens;
  return (
    <div className="pwi-stats-column">
      <aside className="pwi-stats-sidebar" aria-label="Provider stats">
        <div className="pwi-stats-head">Provider stats</div>
        <div className="pwi-stats-row-label">Requests / day</div>
        <div className="pwi-stats-value">&mdash;</div>
        <div className="pwi-stats-unavailable muted">Daily breakdown unavailable</div>
        <div className="pwi-stats-divider" />
        <div className="pwi-stats-line">
          <span className="pwi-stats-line-label">Total requests (30d)</span>
          <span className="pwi-stats-line-value">{formatRequestCount(requests)}</span>
        </div>
        <div className="pwi-stats-line">
          <span className="pwi-stats-line-label">Tokens (30d)</span>
          <span className="pwi-stats-line-value">{formatTokenCount(tokens)}</span>
        </div>
        {quotaReport && (
          <div className="pwi-stats-line">
            <span className="pwi-stats-line-label">Quota updated</span>
            <span className="pwi-stats-line-value" title={quotaReport.source ? `Source: ${quotaReport.source}` : undefined}>
              {formatRelativeTime(quotaReport.updatedAt)}
            </span>
          </div>
        )}
        <a href="#usage" className="pwi-stats-usage-link btn btn-ghost btn-sm" onClick={onViewUsage} aria-label="View detailed usage">
          <IconActivity style={{ width: 12, height: 12 }} aria-hidden="true" />
          View detailed usage
          <IconChevron style={{ width: 11, height: 11 }} aria-hidden="true" />
        </a>
      </aside>
      <section className="pwi-stats-notes" aria-label="Provider notes">
        <div className="pwi-stats-notes-head">Notes</div>
        {item.note ? (
          <div className="pwi-stats-notes-body">{item.note}</div>
        ) : (
          <div className="pwi-stats-notes-placeholder muted">Add a note about this provider&hellip;</div>
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
          {isOauth ? "Account login" : "API keys"}
        </span>
      </div>
      <div className="providers-workspace-section-body pwi-auth-body">
        {isOauth && (
          <>
            <div className="pwi-auth-status-row">
              <span className={`pwi-auth-dot ${oauth?.loggedIn ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
              <span className="pwi-auth-status-text">
                {oauth?.loggedIn
                  ? (oauth.email ? oauth.email : "Logged in")
                  : (oauth?.error || "Not logged in")}
              </span>
              <span className="pwi-auth-actions">
                {oauth?.loggedIn ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => authHandlers.onLogout(item.name)}>
                    Logout
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => authHandlers.onLogin(item.name, false)}
                    disabled={busy}
                  >
                    {busy
                      ? <><span className="pwi-spin-inline" aria-hidden="true" /> Waiting for browser…</>
                      : <><IconLock style={{ width: 13, height: 13 }} aria-hidden="true" /> Login</>}
                  </button>
                )}
              </span>
            </div>

            {busy && hintForThis && (hintForThis.url || hintForThis.instructions) && (
              <div className="pwi-auth-wait">
                <span className="pwi-spin-inline pwi-spin-inline--lg" aria-hidden="true" />
                <div className="pwi-auth-wait-copy">
                  <div className="pwi-auth-wait-title">Waiting for browser…</div>
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
                      Didn&apos;t open? Click here
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
                      title={account.active ? "Active account" : "Switch to this account"}
                    >
                      <span className={`pwi-auth-dot ${account.needsReauth ? "pwi-auth-dot--warn" : account.active ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                      <span className="pwi-auth-row-label">{account.email ?? account.id}</span>
                      {account.needsReauth && <span className="badge badge-amber">Re-auth</span>}
                      {account.active && <span className="badge badge-primary">Active</span>}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm pwi-auth-row-remove"
                      onClick={() => authHandlers.onRemoveAccount(item.name, account)}
                      aria-label={`Remove account ${account.email ?? account.id}`}
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
                    ? <><span className="pwi-spin-inline" aria-hidden="true" /> Waiting for browser…</>
                    : <><IconPlus style={{ width: 13, height: 13 }} aria-hidden="true" /> Add account</>}
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
                  ? (keys.find(k => k.active)?.masked ?? "API key configured")
                  : "No API key configured"}
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
                      title={entry.active ? "Active key" : "Switch to this key"}
                    >
                      <span className={`pwi-auth-dot ${entry.active ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                      <span className="pwi-auth-row-label mono">
                        {entry.label ? `${entry.label} · ${entry.masked}` : entry.masked}
                      </span>
                      {entry.active && <span className="badge badge-primary">Active</span>}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm pwi-auth-row-remove"
                      onClick={() => authHandlers.onRemoveApiKey(item.name, entry)}
                      aria-label={`Remove key ${entry.label ?? entry.masked}`}
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
                  placeholder="sk-… or $ENV_VAR"
                  value={newKey}
                  onChange={e => setNewKey(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") void submitKey();
                    if (e.key === "Escape") { setAddingKey(false); setNewKey(""); }
                  }}
                />
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void submitKey()} disabled={!newKey.trim() || keyBusy}>
                  {keyBusy ? "Saving…" : "Save"}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAddingKey(false); setNewKey(""); }}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="pwi-auth-add" onClick={() => setAddingKey(true)}>
                <IconPlus style={{ width: 13, height: 13 }} aria-hidden="true" />
                Add API key
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
  const selectedSet = new Set(selectedModels);
  const models = availableModels.length > 0
    ? availableModels
    : item.defaultModel
      ? [item.defaultModel]
      : [];

  return (
    <div className="providers-workspace-section">
      <div className="providers-workspace-section-head">
        <span className="providers-workspace-section-title">Models</span>
        {modelCount > 0 ? (
          <span className="providers-workspace-section-meta">{modelCount} available</span>
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
                    {isDefault ? <span className="badge badge-muted">Default</span> : null}
                    {isSelected ? <span className="badge badge-green">Selected</span> : null}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="providers-workspace-row">
            <span className="providers-workspace-row-label">
              No default model configured.
              <span className="providers-workspace-row-label-desc">
                Models are resolved at runtime from this provider&apos;s endpoint.
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
  return (
    <div className="providers-workspace-section">
      <div className="providers-workspace-section-head">
        <span className="providers-workspace-section-title">Usage &amp; limits</span>
      </div>
      <div className="providers-workspace-section-body">
        <div className="providers-workspace-row">
          <span className="providers-workspace-row-label">
            Usage totals (30d)
            <span className="providers-workspace-row-label-desc">
              {usageTotals?.requests === undefined
                ? `No usage recorded for ${item.name}.`
                : `${formatRequestCount(usageTotals.requests)} requests and ${formatTokenCount(usageTotals.totalTokens)} tokens.`}
            </span>
          </span>
        </div>
        {quotaReport && (
          <div className="providers-workspace-row">
            <span className="providers-workspace-row-label">
              Quota context
              <span className="providers-workspace-row-label-desc">
                Updated {formatRelativeTime(quotaReport.updatedAt)}{quotaReport.source ? ` from ${quotaReport.source}` : ""}.
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
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
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
      setMsg({ ok: false, text: "Updates are not available." });
      return;
    }
    if (!adapter.trim() || !baseUrl.trim()) {
      setMsg({ ok: false, text: "Adapter and Base URL are required." });
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
      ? { ok: true, text: "Settings saved." }
      : { ok: false, text: res.error || "Save failed." });
    if (res.ok) setApiKey("");
  };

  const hasKey = item.hasApiKey === true;

  return (
    <>
      <div className="providers-workspace-section">
        <div className="providers-workspace-section-head">
          <span className="providers-workspace-section-title">Connection settings</span>
        </div>
        <div className="providers-workspace-section-body pwi-settings-form">
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">Provider name</span>
            <input className="input" value={item.name} disabled title="Rename is not supported yet — remove and re-add to change the id." />
            <span className="pwi-settings-hint muted">Immutable id used in routing and config keys.</span>
          </label>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">Adapter</span>
            <input className="input" value={adapter} onChange={e => setAdapter(e.target.value)} placeholder="openai-chat" />
          </label>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">Base URL</span>
            <input className="input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://…" />
          </label>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">Default model</span>
            <input className="input" value={defaultModel} onChange={e => setDefaultModel(e.target.value)} placeholder="optional" />
          </label>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">Note</span>
            <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Optional note" />
          </label>
        </div>
      </div>

      <div className="providers-workspace-section">
        <div className="providers-workspace-section-head">
          <span className="providers-workspace-section-title">Authentication</span>
        </div>
        <div className="providers-workspace-section-body pwi-settings-form">
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">Auth mode</span>
            <select className="input" value={authMode} onChange={e => setAuthMode(e.target.value)}>
              <option value="key">API key</option>
              <option value="forward">Forward (Codex login)</option>
              <option value="oauth">OAuth</option>
              <option value="local">Local</option>
            </select>
            <span className="pwi-settings-hint muted">Current: {authModeLabel(item)}</span>
          </label>
          {(authMode === "key" || (!authMode && !item.keyOptional)) && (
            <label className="pwi-settings-field">
              <span className="pwi-settings-label">API key</span>
              <input
                className="input"
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={hasKey ? "••••••••  (leave blank to keep)" : "sk-… or $ENV_VAR"}
                autoComplete="off"
              />
              <span className="pwi-settings-hint muted">
                {hasKey
                  ? <><span className="badge badge-green" style={{ marginRight: 6 }}>Configured</span>Enter a new value only to replace it.</>
                  : <><span className="badge badge-amber" style={{ marginRight: 6 }}>Missing</span>Required for key-auth providers.</>}
              </span>
            </label>
          )}
          {authMode === "oauth" && (
            <div className="providers-workspace-row">
              <span className="providers-workspace-row-label">
                Sign-in status
                <span className="providers-workspace-row-label-desc">
                  {oauth?.error
                    ? oauth.error
                    : oauth?.loggedIn
                      ? `Signed in${oauth.email ? ` as ${oauth.email}` : ""}.`
                      : "Not signed in — use the classic Providers view or CLI login."}
                </span>
              </span>
              <span className="providers-workspace-row-value">{oauth?.loggedIn ? "Ready" : "Needs setup"}</span>
            </div>
          )}
          {item.keyOptional && (
            <div className="providers-workspace-row">
              <span className="providers-workspace-row-label">
                Free tier
                <span className="providers-workspace-row-label-desc">This provider does not require an API key.</span>
              </span>
            </div>
          )}
          <div className="pwi-settings-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving || !onUpdateProvider}>
              {saving ? "Saving…" : "Save settings"}
            </button>
            {msg && <span className={msg.ok ? "pwi-settings-msg pwi-settings-msg--ok" : "pwi-settings-msg pwi-settings-msg--err"}>{msg.text}</span>}
          </div>
        </div>
      </div>

      <div className="providers-workspace-section">
        <div className="providers-workspace-section-head">
          <span className="providers-workspace-section-title">Provider state</span>
        </div>
        <div className="providers-workspace-section-body">
          <div className="providers-workspace-row">
            <span className="providers-workspace-row-label">
              {item.disabled ? "Provider disabled" : "Provider enabled"}
              <span className="providers-workspace-row-label-desc">Disabled providers are excluded from model routing.</span>
            </span>
            <span className="providers-workspace-row-controls">
              <button
                type="button"
                className={`btn ${item.disabled ? "btn-primary" : "btn-ghost"} btn-sm`}
                onClick={() => onSetDisabled(item.name, !item.disabled)}
                aria-label={item.disabled ? `Enable ${item.name}` : `Disable ${item.name}`}
              >
                <IconPower style={{ width: 13, height: 13 }} aria-hidden="true" />
                {item.disabled ? "Enable" : "Disable"}
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
  const [tab, setTab] = useState<Tab>("overview");
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | undefined>(quotaReport?.updatedAt);
  const isEnabled = !item.disabled;

  useEffect(() => {
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
          ? `${data.message ?? "Connected"}${latency}`
          : `${data.error ?? "Connection failed"}${latency}`,
      });
      if (ok) {
        setLastCheckedAt(Date.now());
        onTestDone?.();
      }
    } catch {
      setTestMsg({ ok: false, text: "Network error — is the proxy running?" });
    } finally {
      setTesting(false);
    }
  };

  const confirmRemove = () => {
    if (window.confirm(`Remove provider "${item.name}"? This cannot be undone from the UI.`)) {
      onRemoveProvider(item.name);
    }
  };

  const renderTabPanel = (): React.ReactNode => {
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
    <div className="providers-workspace-detail" role="region" aria-label={`${item.name} provider details`}>
      <div className="providers-workspace-detail-head">
        <button
          type="button"
          className="btn btn-ghost btn-sm pwi-back-overview"
          onClick={onDeselect}
          aria-label="Back to all providers"
          title="Back to all providers"
        >
          <IconChevron style={{ width: 14, height: 14, transform: "rotate(180deg)" }} aria-hidden="true" />
          All providers
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
              <span className="pwi-rail-meta pwi-rail-meta--default" title="Default routing provider">Default</span>
            )}
            {isLocalProvider(item) ? (
              <span className="pwi-rail-meta" title="Local runtime">Local</span>
            ) : isFreeProvider(item) ? (
              <span className="pwi-rail-meta pwi-rail-meta--free" title="No API key required">Free</span>
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
              {testing ? "Checking…" : (testMsg?.text ?? "")}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void testConnection()}
              disabled={testing || item.disabled}
              aria-label="Test connection"
              title={item.disabled ? "Enable the provider first" : "Probe models for this provider"}
            >
              <IconRefresh style={{ width: 13, height: 13 }} aria-hidden="true" className={testing ? "pwi-spin" : undefined} />
              {testing ? "Testing…" : "Test connection"}
            </button>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm pwi-remove-btn"
            onClick={confirmRemove}
            aria-label={`Remove provider ${item.name}`}
            title="Remove provider"
          >
            <IconTrash style={{ width: 15, height: 15 }} aria-hidden="true" />
          </button>
          <div className="pwi-enabled-toggle">
            <span className="pwi-enabled-label">Enabled</span>
            <Switch
              on={isEnabled}
              onClick={() => onSetDisabled(item.name, isEnabled)}
              label={isEnabled ? `Disable ${item.name}` : `Enable ${item.name}`}
            />
          </div>
        </div>
      </div>

      <div className="providers-workspace-tabs" role="tablist" aria-label={`${item.name} tabs`}>
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`provider-tab-${t.id}`}
            aria-controls={t.id}
            className={`providers-workspace-tab${tab === t.id ? " providers-workspace-tab--active" : ""}`}
            onClick={() => setTab(t.id)}
            aria-selected={tab === t.id}
          >
            {t.label}
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
  onAddCustomProvider,
}: {
  onAddProvider: () => void;
  onAddCustomProvider?: () => void;
}) {
  return (
    <div className="providers-workspace-empty-root">
      <div className="pwi-empty-left">
        <div className="pwi-empty-card">
          <span className="pwi-empty-card-icon" aria-hidden="true">
            <IconPlus style={{ width: 24, height: 24 }} />
          </span>
          <p className="pwi-empty-card-title">No providers yet</p>
          <p className="pwi-empty-card-sub">Get started by connecting your first provider.</p>
          <div className="pwi-empty-card-actions">
            <button type="button" className="btn btn-primary" onClick={onAddProvider} aria-label="Add a provider">
              Add provider
            </button>
            {onAddCustomProvider && (
              <button type="button" className="btn btn-ghost" onClick={onAddCustomProvider} aria-label="Add custom provider">
                Custom provider
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="pwi-empty-right">
        <div className="pwi-empty-right-icon" aria-hidden="true">
          <IconBoxes style={{ width: 64, height: 64 }} />
        </div>
        <h2 className="pwi-empty-right-title">Connect your first provider</h2>
        <p className="pwi-empty-right-sub">
          Pick a catalog provider or wire any OpenAI-compatible endpoint.
        </p>
        <div className="pwi-empty-tiles">
          <button type="button" className="pwi-empty-tile" onClick={onAddProvider} aria-label="Browse providers">
            <IconGlobe style={{ width: 20, height: 20 }} aria-hidden="true" />
            <span className="pwi-empty-tile-label">Browse providers</span>
            <span className="pwi-empty-tile-desc">Connect to popular cloud providers</span>
          </button>
          <button
            type="button"
            className="pwi-empty-tile"
            onClick={onAddCustomProvider ?? onAddProvider}
            aria-label="Add custom provider"
          >
            <IconExternal style={{ width: 20, height: 20 }} aria-hidden="true" />
            <span className="pwi-empty-tile-label">Custom provider</span>
            <span className="pwi-empty-tile-desc">Any OpenAI-compatible base URL + key</span>
          </button>
        </div>
        <p className="pwi-empty-doc-link muted">
          Not sure where to start?{" "}
          <a href="https://opencodex.dev/docs" target="_blank" rel="noreferrer" className="link-btn">
            View documentation
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
  sections, onSelect, onAddProvider, onAddCustomProvider, onEditConfig, attentionItems, usageTotals
}: {
  sections: WorkspaceSections;
  onSelect: (name: string) => void;
  onAddProvider: () => void;
  onAddCustomProvider?: () => void;
  onEditConfig: () => void;
  attentionItems: AttentionItem[];
  usageTotals: Record<string, ProviderUsageTotals>;
}) {
  const providersByName = new Map(
    [...sections.ready, ...sections.needsSetup, ...sections.disabled].map(item => [item.name, item]),
  );
  const mostUsed = buildMostUsedProviders(usageTotals)
    .filter(entry => providersByName.has(entry.name))
    .slice(0, 3);
  return (
    <div className="providers-workspace-overview">
      <div className="providers-workspace-overview-head">
        <h2 className="providers-workspace-overview-title">Providers overview</h2>
        <p className="providers-workspace-overview-sub">Manage all your model providers in one place.</p>
      </div>
      <div className="providers-workspace-summary-row">
        <div className="providers-workspace-summary-card pwi-summary-ready">
          <span className="providers-workspace-summary-value">{sections.ready.length}</span>
          <span className="providers-workspace-summary-label">Ready</span>
        </div>
        <div className="providers-workspace-summary-card pwi-summary-setup">
          <span className="providers-workspace-summary-value">{sections.needsSetup.length}</span>
          <span className="providers-workspace-summary-label">Need setup</span>
        </div>
        <div className="providers-workspace-summary-card pwi-summary-disabled">
          <span className="providers-workspace-summary-value">{sections.disabled.length}</span>
          <span className="providers-workspace-summary-label">Disabled</span>
        </div>
      </div>
      <div className="pwi-overview-section pwi-overview-quick-actions">
        <div className="pwi-overview-section-head">Quick actions</div>
        <div className="pwi-oa-grid">
          <button type="button" className="pwi-oa-tile" onClick={onAddProvider} aria-label="Add provider">
            <IconPlus style={{ width: 18, height: 18 }} aria-hidden="true" />
            <span className="pwi-oa-label">Add provider</span>
            <span className="pwi-oa-desc">Browse catalog providers</span>
          </button>
          <button
            type="button"
            className="pwi-oa-tile"
            onClick={onAddCustomProvider ?? onAddProvider}
            aria-label="Add custom provider"
          >
            <IconExternal style={{ width: 18, height: 18 }} aria-hidden="true" />
            <span className="pwi-oa-label">Custom provider</span>
            <span className="pwi-oa-desc">Any OpenAI-compatible endpoint</span>
          </button>
          <button type="button" className="pwi-oa-tile" onClick={onEditConfig} aria-label="Edit JSON config">
            <IconList style={{ width: 18, height: 18 }} aria-hidden="true" />
            <span className="pwi-oa-label">Edit JSON</span>
            <span className="pwi-oa-desc">Edit the raw proxy config as JSON</span>
          </button>
        </div>
      </div>
      <div className="pwi-overview-two-col">
        {attentionItems.length > 0 && (
          <div className="pwi-overview-section pwi-overview-attention">
            <div className="pwi-overview-section-head">Attention required</div>
            {attentionItems.map(ai => (
              <button key={ai.name} type="button" className="pwi-attention-row"
                onClick={() => onSelect(ai.name)}
                aria-label={`${ai.name}: ${ai.reason}`}>
                <span className="pwi-dot pwi-dot--warning" aria-hidden="true" />
                <span className="pwi-attention-name">{ai.name}</span>
                <span className="pwi-attention-reason muted">{ai.reason}</span>
                <IconChevron style={{ width: 13, height: 13, color: "var(--muted)" }} aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        <div className="pwi-overview-section pwi-overview-recent">
          <div className="pwi-overview-section-head">Recently used</div>
          {mostUsed.length === 0 ? (
            <div className="pwi-recent-empty muted">No usage recorded.</div>
          ) : mostUsed.map(entry => {
            const item = providersByName.get(entry.name)!;
            return (
            <button key={entry.name} type="button" className="pwi-recent-row"
              onClick={() => onSelect(entry.name)} aria-label={`Open ${entry.name}`}>
              <ProviderIcon name={entry.name} adapter={item.adapter} baseUrl={item.baseUrl}
                cls="providers-workspace-rail-icon" />
              <span className="pwi-recent-name">{entry.name}</span>
              <span className="muted">{formatRequestCount(entry.requests)} requests</span>
              <IconChevron style={{ width: 13, height: 13, color: "var(--muted)" }} aria-hidden="true" />
            </button>
          );})}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export default function ProviderWorkspace({
  providers, apiBase, defaultProvider, onAddProvider, onAddCustomProvider,
  onUseLegacyView: _onUseLegacyView, onEditConfig,
  onSetDisabled, onRemoveProvider, onUpdateProvider, quotaReports = {}, oauthStatus = {},
  accountSets = {}, keyPools = {}, busyProvider = null, loginHint = null, authHandlers,
}: ProviderWorkspaceProps) {
  void _onUseLegacyView;
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
    const t = window.setTimeout(() => {
      void fetchModelCounts();
      void fetchUsageTotals();
    }, 0);
    return () => window.clearTimeout(t);
  }, [fetchModelCounts, fetchUsageTotals]);

  const handleRemoveProvider = (name: string) => {
    onRemoveProvider(name);
    if (selectedName === name) setSelectedName(null);
  };

  const total = Object.keys(providers).length;

  if (total === 0) {
    return <EmptyState onAddProvider={onAddProvider} onAddCustomProvider={onAddCustomProvider} />;
  }

  return (
    <div className="providers-workspace-root">
      <aside className="providers-workspace-rail" aria-label="Provider list">
        <div className="providers-workspace-rail-header">
          <span className="providers-workspace-rail-title">Providers</span>
          <div className="pwi-rail-header-actions">
            <button type="button" className="btn btn-ghost btn-sm pwi-rail-add-btn"
              onClick={onAddProvider} aria-label="Add a provider">
              <IconPlus style={{ width: 13, height: 13 }} aria-hidden="true" />
              Add
            </button>
            {onAddCustomProvider && (
              <button type="button" className="btn btn-ghost btn-sm pwi-rail-add-btn"
                onClick={onAddCustomProvider} aria-label="Add custom provider" title="Custom provider">
                Custom
              </button>
            )}
          </div>
        </div>
        <div className="pwi-rail-search-row">
          <div className="pwi-rail-search-wrap">
            <IconSearch className="pwi-rail-search-icon" width={14} height={14} aria-hidden="true" />
            <input
              type="search"
              className="input pwi-rail-search-input"
              placeholder="Search providers"
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Search providers"
            />
          </div>
          <div className="pwi-rail-filter-wrap" ref={filterWrapRef}>
            <button
              type="button"
              className={`btn btn-ghost btn-sm pwi-rail-filter-btn${filterActive || filterOpen ? " pwi-rail-filter-btn--active" : ""}`}
              onClick={() => setFilterOpen(o => !o)}
              aria-label="Filter providers"
              aria-haspopup="menu"
              aria-expanded={filterOpen}
              title="Filter providers"
            >
              <IconFilter width={29} height={29} aria-hidden="true" />
              {filterActive && <span className="pwi-rail-filter-dot" aria-hidden="true" />}
            </button>
            {filterOpen && (
              <div className="pwi-rail-filter-menu" role="menu" aria-label="Provider filters">
                <div className="pwi-rail-filter-menu-title">Filters</div>

                <div className="pwi-rail-filter-section">
                  <div className="pwi-rail-filter-menu-head">Status</div>
                  {([
                    ["ready", "Ready", "pwi-dot--active", sections.ready.length] as const,
                    ["needsSetup", "Needs setup", "pwi-dot--warning", sections.needsSetup.length] as const,
                    ["disabled", "Disabled", "pwi-dot--inactive", sections.disabled.length] as const,
                  ]).map(([key, label, dotCls, count]) => (
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
                  <div className="pwi-rail-filter-menu-head">Pricing</div>
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
                    <span className="pwi-rail-filter-option-label">Free</span>
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
                    <span className="pwi-rail-filter-option-label">Paid</span>
                    <span className="pwi-rail-filter-option-count">{paidCount}</span>
                  </label>
                </div>

                <div className="pwi-rail-filter-section">
                  <div className="pwi-rail-filter-menu-head">Sort</div>
                  <div className="pwi-rail-sort-grid" role="group" aria-label="Sort providers">
                    {SORT_OPTIONS.map(opt => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`pwi-rail-sort-btn${sortMode === opt.id ? " pwi-rail-sort-btn--active" : ""}`}
                        onClick={() => setSortMode(opt.id)}
                        aria-pressed={sortMode === opt.id}
                      >
                        {opt.label}
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
                    Reset all
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="providers-workspace-rail-list" role="listbox" aria-label="Providers">
          {Object.values(filteredSections).every(items => items.length === 0) && (
            <span className="muted" style={{ fontSize: 12, padding: "8px 4px" }}>
              {search
                ? `No results for \u201c${search}\u201d`
                : filterActive
                  ? "No providers match the current filters."
                  : "No providers configured."}
            </span>
          )}
          {([
            ["Ready", filteredSections.ready, "pwi-dot--active"] as const,
            ["Needs setup", filteredSections.needsSetup, "pwi-dot--warning"] as const,
            ["Disabled", filteredSections.disabled, "pwi-dot--inactive"] as const,
          ]).map(([title, items, dotCls]) => {
            if (items.length === 0) return null;
            return (
              <div key={title} className="providers-workspace-rail-group" role="group" aria-labelledby={`provider-group-${title.toLowerCase().replace(" ", "-")}`}>
                <div id={`provider-group-${title.toLowerCase().replace(" ", "-")}`} className="providers-workspace-rail-group-head pwi-group-head">
                  <span className={`pwi-dot ${dotCls}`} aria-hidden="true" />
                  <span>{title} ({items.length})</span>
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
      <main className="providers-workspace-main" aria-label="Provider workspace">
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
            onAddProvider={onAddProvider}
            onAddCustomProvider={onAddCustomProvider}
            onEditConfig={onEditConfig}
            attentionItems={attentionItems}
            usageTotals={usageTotals}
          />
        )}
      </main>
    </div>
  );
}
