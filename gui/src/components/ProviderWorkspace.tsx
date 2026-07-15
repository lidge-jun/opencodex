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
  IconPlus,
  IconX,
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
} from "../icons";
import { Switch } from "../ui";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ProviderWorkspaceProps {
  /** Provider map as returned from the proxy config API. */
  providers: Record<string, WorkspaceProvider>;
  /** Base URL for API calls, e.g. http://localhost:11434 */
  apiBase: string;
  onAddProvider: () => void;
  onUseLegacyView: () => void;
  onEditConfig: () => void;
  onSetDisabled: (name: string, disabled: boolean) => void;
  onRemoveProvider: (name: string) => void;
  quotaReports?: Record<string, { updatedAt: number; source?: string; quota?: unknown }>;
  oauthStatus?: Record<string, { loggedIn: boolean; email?: string; error?: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Tab = "overview" | "models" | "auth" | "usage" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "models",   label: "Models" },
  { id: "auth",     label: "Auth" },
  { id: "usage",    label: "Usage & limits" },
  { id: "settings", label: "Settings" },
];

function statusDotCls(p: WorkspaceProvider): string {
  const s = binProviderStatus(p);
  if (s === "disabled") return "pwi-dot pwi-dot--inactive";
  if (s === "ready")    return "pwi-dot pwi-dot--active";
  return "pwi-dot pwi-dot--warning";
}

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

function RailRow({ item, selected, modelCount, onClick }: {
  item: WorkspaceItem;
  selected: boolean;
  modelCount?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`providers-workspace-rail-row${selected ? " providers-workspace-rail-row--selected" : ""}`}
      onClick={onClick}
      role="option"
      aria-selected={selected}
      aria-label={`Select provider ${item.name}`}
    >
      <ProviderIcon
        name={item.name}
        adapter={item.adapter}
        baseUrl={item.baseUrl}
        cls="providers-workspace-rail-icon"
      />
      <span className="providers-workspace-rail-name">{item.name}</span>
      {modelCount !== undefined && (
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
  const statusText = status === "ready" ? "Ready" : status === "needs-setup" ? "Needs setup" : "Disabled";
  const configurationText = status === "ready"
    ? "Configuration is ready"
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
            Edit
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled title="No reconnect endpoint is available" aria-label={`Reconnect ${item.name}`}>
            <IconRefresh style={{ width: 13, height: 13 }} aria-hidden="true" />
            Reconnect
          </button>
          <button type="button" className="btn btn-danger btn-sm" disabled title="No disconnect endpoint is available" aria-label={`Disconnect ${item.name}`}>
            <IconX style={{ width: 13, height: 13 }} aria-hidden="true" />
            Disconnect
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
        <div className="pwi-qa-grid">
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

function TabOverview({ item, usageTotals, quotaReport, onSelectTab }: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: { updatedAt: number; source?: string };
  onSelectTab: (tab: Tab) => void;
}) {
  return (
    <div className="pwi-overview-tab">
      {item.note && <p className="pwi-provider-summary">{item.note}</p>}
      <div className="pwi-overview-layout">
        <div className="pwi-overview-main">
          <ConnectionCard item={item} onEdit={() => onSelectTab("settings")} lastCheckedAt={quotaReport?.updatedAt} />
          <QuickActionsCard onSelectTab={onSelectTab} />
        </div>
        <StatsSidebar item={item} usageTotals={usageTotals} quotaReport={quotaReport} onViewUsage={() => onSelectTab("usage")} />
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

function TabAuth({ item, oauth }: {
  item: WorkspaceItem;
  oauth?: { loggedIn: boolean; email?: string; error?: string };
}) {
  const hasKey = item.hasApiKey === true;
  return (
    <div className="providers-workspace-section">
      <div className="providers-workspace-section-head">
        <span className="providers-workspace-section-title">Authentication</span>
      </div>
      <div className="providers-workspace-section-body">
        <div className="providers-workspace-row">
          <span className="providers-workspace-row-label">
            Auth mode
            <span className="providers-workspace-row-label-desc">How credentials are supplied to this provider.</span>
          </span>
          <span className="providers-workspace-row-value">{authModeLabel(item)}</span>
        </div>
        {(item.authMode === "key" || (!item.authMode && !item.keyOptional)) && (
          <div className="providers-workspace-row">
            <span className="providers-workspace-row-label">
              API key
              <span className="providers-workspace-row-label-desc">
                {hasKey ? "A key is configured for this provider." : "No key configured. Add one via the classic view."}
              </span>
            </span>
            <span className="providers-workspace-row-controls">
              {hasKey
                ? <span className="badge badge-green"><IconCheck style={{ width: 11, height: 11 }} aria-hidden="true" />Configured</span>
                : <span className="badge badge-amber"><IconAlert style={{ width: 11, height: 11 }} aria-hidden="true" />Missing</span>}
            </span>
          </div>
        )}
        {item.authMode === "oauth" && (
          <div className="providers-workspace-row">
            <span className="providers-workspace-row-label">
              OAuth
              <span className="providers-workspace-row-label-desc">
                {oauth?.error
                  ? oauth.error
                  : oauth?.loggedIn ? `Signed in${oauth.email ? ` as ${oauth.email}` : ""}.` : "Not signed in."}
              </span>
            </span>
            <span className="providers-workspace-row-value">{oauth?.loggedIn ? "Ready" : "Needs setup"}</span>
          </div>
        )}
        {item.keyOptional && (
          <div className="providers-workspace-row">
            <span className="providers-workspace-row-label">
              Key optional
              <span className="providers-workspace-row-label-desc">This provider does not require an API key (free tier).</span>
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

function TabSettings({ item, onSetDisabled, onRemoveProvider }: {
  item: WorkspaceItem;
  onSetDisabled: (name: string, disabled: boolean) => void;
  onRemoveProvider: (name: string) => void;
}) {
  return (
    <>
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
      <div className="providers-workspace-section">
        <div className="providers-workspace-section-head">
          <span className="providers-workspace-section-title">Danger zone</span>
        </div>
        <div className="providers-workspace-section-body">
          <div className="providers-workspace-row">
            <span className="providers-workspace-row-label">
              Remove provider
              <span className="providers-workspace-row-label-desc">Permanently removes this provider from the proxy config.</span>
            </span>
            <span className="providers-workspace-row-controls">
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => onRemoveProvider(item.name)}
                aria-label={`Remove provider ${item.name}`}
              >
                <IconTrash style={{ width: 13, height: 13 }} aria-hidden="true" />
                Remove
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
  item, onSetDisabled, onRemoveProvider, onDeselect, onUseLegacyView, usageTotals,
  quotaReport, oauth, modelCount, availableModels, selectedModels,
}: {
  item: WorkspaceItem;
  onSetDisabled: (name: string, disabled: boolean) => void;
  onRemoveProvider: (name: string) => void;
  onDeselect: () => void;
  onUseLegacyView: () => void;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: { updatedAt: number; source?: string };
  oauth?: { loggedIn: boolean; email?: string; error?: string };
  modelCount: number;
  availableModels: string[];
  selectedModels: string[];
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isEnabled = !item.disabled;

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const renderTabPanel = (): React.ReactNode => {
    switch (tab) {
      case "overview": return <TabOverview item={item} usageTotals={usageTotals} quotaReport={quotaReport} onSelectTab={setTab} />;
      case "models":   return (
        <TabModels
          item={item}
          modelCount={modelCount}
          availableModels={availableModels}
          selectedModels={selectedModels}
        />
      );
      case "auth":     return <TabAuth item={item} oauth={oauth} />;
      case "usage":    return <TabUsage item={item} usageTotals={usageTotals} quotaReport={quotaReport} />;
      case "settings": return <TabSettings item={item} onSetDisabled={onSetDisabled} onRemoveProvider={onRemoveProvider} />;
      default:         return null;
    }
  };

  return (
    <div className="providers-workspace-detail" role="region" aria-label={`${item.name} provider details`}>
      <div className="providers-workspace-detail-head">
        <ProviderIcon
          name={item.name}
          adapter={item.adapter}
          baseUrl={item.baseUrl}
          cls="providers-workspace-detail-icon"
        />
        <div className="providers-workspace-detail-title-group">
          <div className="providers-workspace-detail-title">{item.name}</div>
          <div className="providers-workspace-detail-status-row">
            <span className={statusDotCls(item)} aria-hidden="true" />
            <span className="providers-workspace-detail-status-label">{statusLabel(item)}</span>
          </div>
        </div>
        <div className="providers-workspace-detail-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled
            title="No connection-test endpoint is available"
            aria-label="Test connection"
          >
            <IconRefresh style={{ width: 13, height: 13 }} aria-hidden="true" />
            Test connection
          </button>
          <div className="pwi-kebab-wrap" ref={menuRef}>
            <button
              type="button"
              className="btn btn-ghost btn-sm pwi-kebab-btn"
              onClick={() => setMenuOpen(o => !o)}
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              &bull;&bull;&bull;
            </button>
            {menuOpen && (
              <div className="pwi-kebab-menu" role="menu">
                <button type="button" role="menuitem" className="pwi-kebab-item"
                  onClick={() => { setMenuOpen(false); onUseLegacyView(); }}>
                  <IconList style={{ width: 13, height: 13 }} aria-hidden="true" />
                  Classic view
                </button>
                <button type="button" role="menuitem" className="pwi-kebab-item"
                  onClick={() => { setMenuOpen(false); onSetDisabled(item.name, !item.disabled); }}
                  aria-label={item.disabled ? `Enable ${item.name}` : `Disable ${item.name}`}>
                  <IconPower style={{ width: 13, height: 13 }} aria-hidden="true" />
                  {item.disabled ? "Enable" : "Disable"}
                </button>
                <button type="button" role="menuitem" className="pwi-kebab-item"
                  onClick={() => { setMenuOpen(false); onDeselect(); }}>
                  <IconX style={{ width: 13, height: 13 }} aria-hidden="true" />
                  Close
                </button>
                <div className="pwi-kebab-divider" role="separator" />
                <button type="button" role="menuitem" className="pwi-kebab-item pwi-kebab-item--danger"
                  onClick={() => { setMenuOpen(false); onRemoveProvider(item.name); }}
                  aria-label={`Remove provider ${item.name}`}>
                  <IconTrash style={{ width: 13, height: 13 }} aria-hidden="true" />
                  Remove provider
                </button>
              </div>
            )}
          </div>
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

function EmptyState({ onAddProvider }: { onAddProvider: () => void }) {
  return (
    <div className="providers-workspace-empty-root">
      <div className="pwi-empty-left">
        <div className="pwi-empty-card">
          <span className="pwi-empty-card-icon" aria-hidden="true">
            <IconPlus style={{ width: 24, height: 24 }} />
          </span>
          <p className="pwi-empty-card-title">No providers yet</p>
          <p className="pwi-empty-card-sub">Get started by connecting your first provider.</p>
          <button type="button" className="btn btn-primary" onClick={onAddProvider} aria-label="Add a provider">
            Add provider
          </button>
        </div>
      </div>
      <div className="pwi-empty-right">
        <div className="pwi-empty-right-icon" aria-hidden="true">
          <IconBoxes style={{ width: 64, height: 64 }} />
        </div>
        <h2 className="pwi-empty-right-title">Connect your first provider</h2>
        <p className="pwi-empty-right-sub">
          Use cloud APIs, local models, or a compatible custom endpoint to get started.
        </p>
        <div className="pwi-empty-tiles">
          <button type="button" className="pwi-empty-tile" onClick={onAddProvider} aria-label="Browse providers">
            <IconGlobe style={{ width: 20, height: 20 }} aria-hidden="true" />
            <span className="pwi-empty-tile-label">Browse providers</span>
            <span className="pwi-empty-tile-desc">Connect to popular cloud providers</span>
          </button>
          <button type="button" className="pwi-empty-tile" onClick={onAddProvider} aria-label="Connect local provider">
            <IconServer style={{ width: 20, height: 20 }} aria-hidden="true" />
            <span className="pwi-empty-tile-label">Connect local provider</span>
            <span className="pwi-empty-tile-desc">Set up Ollama, LM Studio or other local models</span>
          </button>
          <button type="button" className="pwi-empty-tile" onClick={onAddProvider} aria-label="Add custom endpoint">
            <IconExternal style={{ width: 20, height: 20 }} aria-hidden="true" />
            <span className="pwi-empty-tile-label">Add custom endpoint</span>
            <span className="pwi-empty-tile-desc">Connect any OpenAI compatible endpoint</span>
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
  sections, onSelect, onAddProvider, onEditConfig, attentionItems, usageTotals
}: {
  sections: WorkspaceSections;
  onSelect: (name: string) => void;
  onAddProvider: () => void;
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
          <span className="providers-workspace-summary-label">Ready</span>
          <span className="providers-workspace-summary-value">{sections.ready.length}</span>
        </div>
        <div className="providers-workspace-summary-card pwi-summary-setup">
          <span className="providers-workspace-summary-label">Need setup</span>
          <span className="providers-workspace-summary-value">{sections.needsSetup.length}</span>
        </div>
        <div className="providers-workspace-summary-card pwi-summary-disabled">
          <span className="providers-workspace-summary-label">Disabled</span>
          <span className="providers-workspace-summary-value">{sections.disabled.length}</span>
        </div>
      </div>
      <div className="pwi-overview-section pwi-overview-quick-actions">
        <div className="pwi-overview-section-head">Quick actions</div>
        <div className="pwi-oa-grid">
          <button type="button" className="pwi-oa-tile" onClick={onAddProvider} aria-label="Add provider">
            <IconPlus style={{ width: 18, height: 18 }} aria-hidden="true" />
            <span className="pwi-oa-label">Add provider</span>
            <span className="pwi-oa-desc">Connect a new provider</span>
          </button>
          <button type="button" className="pwi-oa-tile" onClick={onAddProvider} aria-label="Connect local provider">
            <IconServer style={{ width: 18, height: 18 }} aria-hidden="true" />
            <span className="pwi-oa-label">Connect local</span>
            <span className="pwi-oa-desc">Set up a local model provider</span>
          </button>
          <button type="button" className="pwi-oa-tile" onClick={onEditConfig} aria-label="Import config">
            <IconList style={{ width: 18, height: 18 }} aria-hidden="true" />
            <span className="pwi-oa-label">Import config</span>
            <span className="pwi-oa-desc">Import providers from a config file</span>
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
          <div className="pwi-overview-section-head">Most used (30d)</div>
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
  providers, apiBase, onAddProvider, onUseLegacyView, onEditConfig,
  onSetDisabled, onRemoveProvider, quotaReports = {}, oauthStatus = {},
}: ProviderWorkspaceProps) {
  const [search, setSearch] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [modelCounts, setModelCounts] = useState<ProviderModelCounts>({});
  const [availableModels, setAvailableModels] = useState<ProviderAvailableModels>({});
  const [selectedModels, setSelectedModels] = useState<ProviderSelectedModels>({});
  const [usageTotals, setUsageTotals] = useState<Record<string, ProviderUsageTotals>>({});

  const sections = useMemo(() => buildProviderWorkspace(providers), [providers]);

  const filteredSections = useMemo((): WorkspaceSections => {
    const q = search.trim().toLowerCase();
    if (!q) return sections;
    const filter = (items: WorkspaceItem[]) =>
      items.filter(p => p.name.toLowerCase().includes(q) || p.adapter.toLowerCase().includes(q));
    return { ready: filter(sections.ready), needsSetup: filter(sections.needsSetup), disabled: filter(sections.disabled) };
  }, [sections, search]);

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

  if (total === 0) return <EmptyState onAddProvider={onAddProvider} />;

  return (
    <div className="providers-workspace-root">
      <aside className="providers-workspace-rail" aria-label="Provider list">
        <div className="providers-workspace-rail-header">
          <span className="providers-workspace-rail-title">Providers</span>
          <button type="button" className="btn btn-ghost btn-sm pwi-rail-add-btn"
            onClick={onAddProvider} aria-label="Add a provider">
            <IconPlus style={{ width: 13, height: 13 }} aria-hidden="true" />
            Add provider
          </button>
        </div>
        <div className="pwi-rail-search-row">
          <div className="pwi-rail-search-wrap">
            <IconSearch className="pwi-rail-search-icon" aria-hidden="true" />
            <input type="search" className="input pwi-rail-search-input"
              placeholder="Search providers" value={search}
              onChange={e => setSearch(e.target.value)} aria-label="Search providers" />
          </div>
          <button type="button" className="btn btn-ghost btn-sm pwi-rail-filter-btn" aria-label="Filter providers">
            <IconList style={{ width: 13, height: 13 }} aria-hidden="true" />
          </button>
        </div>
        <div className="providers-workspace-rail-list" role="listbox" aria-label="Providers">
          {Object.values(filteredSections).every(items => items.length === 0) && (
            <span className="muted" style={{ fontSize: 12, padding: "8px 4px" }}>
              {search ? `No results for \u201c${search}\u201d` : "No providers configured."}
            </span>
          )}
          {([
            ["Ready", filteredSections.ready, "pwi-dot--active"],
            ["Needs setup", filteredSections.needsSetup, "pwi-dot--warning"],
            ["Disabled", filteredSections.disabled, "pwi-dot--inactive"],
          ] as const).map(([title, items, dotCls]) => {
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
            onSetDisabled={onSetDisabled}
            onRemoveProvider={handleRemoveProvider}
            onDeselect={() => setSelectedName(null)}
            onUseLegacyView={onUseLegacyView}
            usageTotals={usageTotals[selectedItem.name]}
            quotaReport={quotaReports[selectedItem.name]}
            oauth={oauthStatus[selectedItem.name]}
            modelCount={modelCounts[selectedItem.name] ?? 0}
            availableModels={availableModels[selectedItem.name] ?? []}
            selectedModels={selectedModels[selectedItem.name] ?? []}
          />
        ) : (
          <OverviewPanel
            sections={sections}
            onSelect={setSelectedName}
            onAddProvider={onAddProvider}
            onEditConfig={onEditConfig}
            attentionItems={attentionItems}
            usageTotals={usageTotals}
          />
        )}
      </main>
    </div>
  );
}
