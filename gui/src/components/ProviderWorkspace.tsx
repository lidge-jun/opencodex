import { useState, useMemo, useEffect, useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  relativeTimeLabelsFromT,
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
import { formatProviderDisplayName, providerBrandColor, providerIconSrc } from "../provider-icons";
import {
  IconSearch,
  IconFilter,
  IconPlus,
  IconTrash,
  IconCheck,
  IconAlert,
  IconServer,
  IconBoxes,
  IconRefresh,
  IconInfo,
  IconChevron,
  IconExternal,
  IconActivity,
  IconLock,
  IconGlobe,
  IconKey,
  IconStar,
  IconBraces,
} from "../icons";
import { Switch } from "../ui";
import { useT, type TFn, type TKey } from "../i18n";
import QuotaBars, { maxQuotaUtilisation } from "./QuotaBars";
import type { AccountQuota } from "../codex-quota-utils";

const SETTINGS_ADAPTERS = ["openai-responses", "openai-chat", "anthropic", "google", "azure-openai", "cursor"] as const;

function useRelativeTimeLabels() {
  const t = useT();
  return useMemo(() => relativeTimeLabelsFromT(t), [t]);
}

function jsonErrorLocation(raw: string): { line: number } | null {
  try {
    JSON.parse(raw);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const match = /position\s+(\d+)/i.exec(message);
    if (match) {
      const pos = Number(match[1]);
      if (Number.isFinite(pos)) {
        const line = raw.slice(0, pos).split(/\r\n|\r|\n/).length;
        return { line };
      }
    }
    const lineMatch = /line\s+(\d+)/i.exec(message);
    if (lineMatch) return { line: Number(lineMatch[1]) };
    return { line: 1 };
  }
}

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
  /** Stop an in-progress OAuth browser wait. */
  onCancelLogin?: (provider: string) => void;
  onLogout: (provider: string) => void;
  onSwitchAccount: (provider: string, account: OAuthAccountRow) => void;
  onRemoveAccount: (provider: string, account: OAuthAccountRow) => void;
  onAddApiKey: (provider: string, key: string) => Promise<boolean>;
  onSwitchApiKey: (provider: string, entry: ApiKeyRow) => void;
  onRemoveApiKey: (provider: string, entry: ApiKeyRow) => void;
}

/** How the empty-state / rail “Add” entry should open the add-provider flow. */
export type AddProviderIntent = {
  /** Catalog tab: free, paid, or logins. */
  tier?: "free" | "paid" | "accounts";
  /** Jump straight to custom API-endpoint form. */
  custom?: boolean;
};

export interface ProviderWorkspaceProps {
  /** Provider map as returned from the proxy config API. */
  providers: Record<string, WorkspaceProvider>;
  /** Base URL for API calls, e.g. http://localhost:11434 */
  apiBase: string;
  /** Name of the default routing provider (shows a Default label in the rail). */
  defaultProvider?: string;
  onAddProvider: (intent?: AddProviderIntent) => void;
  /** Open raw config JSON editor in the workspace main pane (not a modal). */
  onEditConfig: () => void;
  /** In-pane JSON editor state (fills the providers overview / main panel). */
  jsonEditor?: {
    open: boolean;
    draft: string;
    /** True when draft differs from the snapshot taken when the editor opened. */
    isDirty: boolean;
    onDraftChange: (value: string) => void;
    /** Persist draft; resolve true only on successful save. */
    onSave: () => Promise<boolean>;
    /** Close without saving (discard). Parent should reset draft to baseline. */
    onClose: () => void;
    /** Reset draft to the open-time baseline without closing the editor. */
    onRestore?: () => void;
  };
  onSetDisabled: (name: string, disabled: boolean) => void;
  onRemoveProvider: (name: string) => void;
  /** Partial update of a provider (settings form). */
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
  quotaReports?: Record<string, ProviderQuotaReportView>;
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

/** Per-provider quota report from `/api/provider-quotas` (workspace-friendly shape). */
export type ProviderQuotaReportView = {
  updatedAt: number;
  source?: string;
  quota?: AccountQuota | unknown;
  label?: string;
};

/** Pull a displayable AccountQuota from a provider-quotas report payload. */
function accountQuotaFromReport(report?: ProviderQuotaReportView): AccountQuota | null {
  if (!report?.quota || typeof report.quota !== "object" || Array.isArray(report.quota)) return null;
  const q = report.quota as Partial<AccountQuota>;
  const hasWindow =
    typeof q.fiveHourPercent === "number"
    || typeof q.weeklyPercent === "number"
    || typeof q.monthlyPercent === "number"
    || (Array.isArray(q.customWindows) && q.customWindows.length > 0);
  if (!hasWindow) return null;
  return {
    ...q,
    updatedAt: typeof q.updatedAt === "number" ? q.updatedAt : report.updatedAt,
  } as AccountQuota;
}

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
  const brand = providerBrandColor(name);
  return (
    <span className={cls} style={brand ? { color: brand } : undefined}>
      {src && brand ? (
        <span
          className="provider-icon-mask"
          style={{
            backgroundColor: brand,
            WebkitMaskImage: `url(${src})`,
            maskImage: `url(${src})`,
          }}
          aria-hidden="true"
        />
      ) : src ? (
        <img src={src} alt="" aria-hidden="true" />
      ) : (
        <IconServer aria-hidden="true" />
      )}
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

type ProviderKind = "cloud" | "local" | "selfHosted" | "account";

const SELF_HOSTED_HINTS = ["ollama", "vllm", "lm-studio", "lmstudio", "litellm", "localai"];

function providerKind(item: WorkspaceProvider & { name?: string }): ProviderKind {
  const mode = (item.authMode ?? "").toLowerCase();
  if (mode === "oauth" || mode === "forward") return "account";
  if (isLocalProvider(item)) return "local";
  const haystack = `${item.name ?? ""} ${item.adapter} ${item.baseUrl}`.toLowerCase();
  if (SELF_HOSTED_HINTS.some(h => haystack.includes(h))) return "selfHosted";
  return "cloud";
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
  const displayName = formatProviderDisplayName(item.name);
  const suffix = `${isDefault ? t("pws.rail.suffixDefault") : ""}${local ? t("pws.rail.suffixLocal") : free ? t("pws.rail.suffixFree") : ""}`;
  return (
    <button
      type="button"
      className={`providers-workspace-rail-row${selected ? " providers-workspace-rail-row--selected" : ""}`}
      onClick={onClick}
      role="option"
      aria-selected={selected}
      aria-label={t("pws.rail.selectAria", { name: displayName, status, suffix })}
    >
      <ProviderIcon
        name={item.name}
        adapter={item.adapter}
        baseUrl={item.baseUrl}
        cls="providers-workspace-rail-icon"
      />
      <span className="providers-workspace-rail-name" title={displayName}>{displayName}</span>
      <span className="providers-workspace-rail-badges">
        {/* Only label exceptions (Local / Free). Paid is the unmarked default.
            Default star sits next to the status dot (see trail cluster) so the
            model-count column does not wedge space between star and green. */}
        {local ? (
          <span className="pwi-rail-badge pwi-rail-badge--local" title={t("pws.localTitle")}>{t("modal.badge.local")}</span>
        ) : free ? (
          <span className="pwi-rail-badge pwi-rail-badge--free" title={t("pws.freeTitle")}>{t("modal.badge.free")}</span>
        ) : null}
      </span>
      {/* Model text left of status so an empty count doesn't leave the dot floating mid-row. */}
      <span className="providers-workspace-rail-model-count">
        {modelCount !== undefined && modelCount > 0 ? t("pws.modelCount", { count: modelCount }) : ""}
      </span>
      <span className="providers-workspace-rail-trail">
        {isDefault && (
          <span
            className="pwi-default-star"
            title={t("prov.defaultBadge")}
            aria-label={t("prov.defaultBadge")}
          >
            <IconStar width={17} height={17} aria-hidden="true" />
          </span>
        )}
        <span className={railStatusCls(item)} aria-hidden="true" title={status} />
      </span>
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
  const timeLabels = useRelativeTimeLabels();
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
    <section className="pwi-section" aria-label={t("pws.connection")}>
      <h3 className="pwi-section-title">{t("pws.connection")}</h3>
      <dl className="pwi-kv">
        <div className="pwi-kv-row">
          <dt>{t("dash.status")}</dt>
          <dd className={statusCls}>{statusText}</dd>
        </div>
        <div className="pwi-kv-row">
          <dt>{t("modal.baseUrl")}</dt>
          <dd><code className="pwi-cell-value-mono">{baseUrl}</code></dd>
        </div>
        <div className="pwi-kv-row">
          <dt>{t("pws.cell.lastChecked")}</dt>
          <dd>{formatRelativeTime(lastCheckedAt, timeLabels)}</dd>
        </div>
        <div className="pwi-kv-row">
          <dt>{t("pws.cell.auth")}</dt>
          <dd>{authModeLabel(item, t)}</dd>
        </div>
        <div className="pwi-kv-row">
          <dt>{t("pws.cell.defaultModel")}</dt>
          <dd>
            {item.defaultModel
              ? <>{item.defaultModel}{" "}<span className="pwi-model-flag">{t("prov.defaultBadge")}</span></>
              : <span className="muted">&mdash;</span>}
          </dd>
        </div>
      </dl>
      <div className={`pwi-section-meta-row${status === "ready" ? "" : " pwi-section-meta-row--warn"}`}>
        <span className="pwi-connection-ops" role="status">
          {status === "ready"
            ? <IconCheck style={{ width: 13, height: 13 }} aria-hidden="true" />
            : <IconAlert style={{ width: 13, height: 13 }} aria-hidden="true" />}
          {configurationText}
        </span>
        <button type="button" className="btn btn-ghost btn-sm pwi-chrome-btn" onClick={onEdit} aria-label={t("pws.editAria", { name: item.name })}>
          <IconInfo style={{ width: 13, height: 13 }} aria-hidden="true" />
          {t("pws.editSettings")}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Stats sidebar
// ---------------------------------------------------------------------------

function StatsSidebar({ item, usageTotals, quotaReport, onViewUsage }: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  onViewUsage: () => void;
}) {
  const t = useT();
  const timeLabels = useRelativeTimeLabels();
  const requests = usageTotals?.requests;
  const tokens = usageTotals?.totalTokens;
  const hasRequests = typeof requests === "number";
  const hasTokens = typeof tokens === "number";
  const hasQuota = !!quotaReport;
  return (
    <aside className="pwi-section pwi-section--side" aria-label={t("pws.statsAria")}>
      <h3 className="pwi-section-title">{t("pws.statsTitle")}</h3>
      <dl className="pwi-kv pwi-kv--stack">
        {hasRequests && (
          <div className="pwi-kv-row">
            <dt>{t("pws.stats.totalRequests")}</dt>
            <dd className="pwi-kv-mono">{formatRequestCount(requests)}</dd>
          </div>
        )}
        {hasTokens && (
          <div className="pwi-kv-row">
            <dt>{t("dash.tokens30d")}</dt>
            <dd className="pwi-kv-mono">{formatTokenCount(tokens)}</dd>
          </div>
        )}
        {hasQuota && (
          <div className="pwi-kv-row">
            <dt>{t("pws.stats.quotaUpdated")}</dt>
            <dd className="pwi-kv-mono" title={quotaReport.source ? t("pws.stats.source", { source: quotaReport.source }) : undefined}>
              {formatRelativeTime(quotaReport.updatedAt, timeLabels)}
            </dd>
          </div>
        )}
      </dl>
      {!hasRequests && !hasTokens && (
        <p className="pwi-stats-unavailable muted">{t("pws.stats.dailyUnavailable")}</p>
      )}
      <button type="button" className="pwi-stats-usage-link btn btn-ghost btn-sm pwi-chrome-btn" onClick={onViewUsage} aria-label={t("pws.stats.viewDetailed")}>
        <IconActivity style={{ width: 12, height: 12 }} aria-hidden="true" />
        {t("pws.stats.viewDetailed")}
        <IconChevron style={{ width: 11, height: 11 }} aria-hidden="true" />
      </button>
      <div className="pwi-notes-block" aria-label={t("pws.notesAria")}>
        <h4 className="pwi-section-title pwi-section-title--sub">{t("pws.notes")}</h4>
        {item.note ? (
          <p className="pwi-stats-notes-body">{item.note}</p>
        ) : (
          <p className="pwi-stats-notes-placeholder muted">{t("pws.notesPlaceholder")}</p>
        )}
      </div>
    </aside>
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
  quotaReport?: ProviderQuotaReportView;
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
    <section className="pwi-section pwi-auth-section" aria-label={isOauth ? t("prov.accountLogin") : t("pws.apiKeys")}>
      <h3 className="pwi-section-title">
        {isOauth ? t("prov.accountLogin") : t("pws.apiKeys")}
      </h3>
      <div className="pwi-auth-body">
        {isOauth && (
          <>
            <div className="pwi-auth-subsection">
              <div className="pwi-auth-status-row">
                <span className={`pwi-auth-dot ${oauth?.loggedIn ? "pwi-auth-dot--ok" : "pwi-auth-dot--off"}`} aria-hidden="true" />
                <span className="pwi-auth-status-text">
                  {oauth?.loggedIn
                    ? (oauth.email ? oauth.email : t("pws.loggedInTitle"))
                    : (oauth?.error || t("pws.notLoggedInTitle"))}
                </span>
                <span className="pwi-auth-actions">
                  {oauth?.loggedIn ? (
                    <button type="button" className="btn btn-ghost btn-sm pwi-chrome-btn" onClick={() => authHandlers.onLogout(item.name)}>
                      {t("prov.logout")}
                    </button>
                  ) : busy ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm pwi-chrome-btn"
                      onClick={() => authHandlers.onCancelLogin?.(item.name)}
                    >
                      {t("common.cancel")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm pwi-chrome-btn"
                      onClick={() => authHandlers.onLogin(item.name, false)}
                    >
                      <IconLock style={{ width: 13, height: 13 }} aria-hidden="true" /> {t("prov.login")}
                    </button>
                  )}
                </span>
              </div>
            </div>

            {busy && (
              <div className="pwi-auth-wait">
                <span className="pwi-spin-inline pwi-spin-inline--lg" aria-hidden="true" />
                <div className="pwi-auth-wait-copy">
                  <div className="pwi-auth-wait-title">{t("prov.waitingBrowser")}</div>
                  {hintForThis?.instructions && (
                    <p className="pwi-auth-wait-hint muted">{hintForThis.instructions}</p>
                  )}
                  {hintForThis?.url && (
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
                  {authHandlers.onCancelLogin && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ marginTop: 6, alignSelf: "flex-start" }}
                      onClick={() => authHandlers.onCancelLogin?.(item.name)}
                    >
                      {t("common.cancel")}
                    </button>
                  )}
                </div>
              </div>
            )}

            {(() => {
              const currentEmail = (oauth?.email ?? "").trim().toLowerCase();
              const soleMatchesLogin = accounts.length === 1
                && !!currentEmail
                && (accounts[0]?.email ?? "").trim().toLowerCase() === currentEmail;
              const listAccounts = soleMatchesLogin ? [] : accounts;
              return (
                <div className="pwi-auth-subsection">
                  <h4 className="pwi-section-title pwi-section-title--sub">{t("pws.availableAccounts")}</h4>
                  {listAccounts.length > 0 && (
                    <div className="pwi-auth-list" role="list">
                      {listAccounts.map(account => (
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
                    </div>
                  )}
                  <button
                    type="button"
                    className="pwi-auth-add"
                    onClick={() => busy
                      ? authHandlers.onCancelLogin?.(item.name)
                      : authHandlers.onLogin(item.name, true)}
                  >
                    {busy
                      ? t("common.cancel")
                      : <><IconPlus style={{ width: 13, height: 13 }} aria-hidden="true" /> {t("prov.accountAdd")}</>}
                  </button>
                </div>
              );
            })()}
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
    </section>
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
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selectedModels), [selectedModels]);
  const models = useMemo(() => {
    const base = availableModels.length > 0
      ? availableModels
      : item.defaultModel
        ? [item.defaultModel]
        : [];
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(id => id.toLowerCase().includes(q));
  }, [availableModels, item.defaultModel, query]);

  const virtualize = models.length > 40;
  const virtualizer = useVirtualizer({
    count: virtualize ? models.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => 36,
    overscan: 12,
  });

  const copyModelId = async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      setCopiedId(modelId);
      window.setTimeout(() => setCopiedId(prev => (prev === modelId ? null : prev)), 1200);
    } catch {
      /* ignore clipboard failures */
    }
  };

  const renderRow = (modelId: string, style?: CSSProperties) => {
    const isDefault = modelId === item.defaultModel;
    const isSelected = selectedSet.has(modelId);
    return (
      <div key={modelId} className="providers-workspace-model-row" style={style}>
        <span className="providers-workspace-model-id" title={modelId}>{modelId}</span>
        <span className="providers-workspace-model-meta">
          {isDefault ? <span className="pwi-model-flag">{t("prov.defaultBadge")}</span> : null}
          {isSelected ? <span className="pwi-model-flag pwi-model-flag--selected">{t("pws.selected")}</span> : null}
          <button
            type="button"
            className="btn btn-ghost btn-sm pwi-chrome-btn"
            onClick={() => { void copyModelId(modelId); }}
            aria-label={t("pws.copyModelId")}
            title={t("pws.copyModelId")}
          >
            {copiedId === modelId ? t("pws.modelCopied") : t("pws.copyModelId")}
          </button>
        </span>
      </div>
    );
  };

  return (
    <div className="providers-workspace-section">
      <div className="providers-workspace-section-head providers-workspace-section-head--sticky">
        <span className="providers-workspace-section-title">{t("pws.tab.models")}</span>
        {modelCount > 0 ? (
          <span className="providers-workspace-section-meta">{t("pws.modelsAvailable", { count: modelCount })}</span>
        ) : null}
      </div>
      <div className="providers-workspace-section-body">
        {availableModels.length > 0 || item.defaultModel ? (
          <>
            <div className="pwi-models-toolbar">
              <label className="pwi-models-search">
                <IconSearch style={{ width: 14, height: 14 }} aria-hidden="true" />
                <input
                  className="input"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder={t("pws.searchModels")}
                  aria-label={t("pws.searchModels")}
                />
              </label>
            </div>
            {models.length === 0 ? (
              <div className="providers-workspace-row">
                <span className="providers-workspace-row-label muted">{t("pws.noModelsMatch")}</span>
              </div>
            ) : virtualize ? (
              <div className="providers-workspace-model-list providers-workspace-model-list--virtual" ref={listRef}>
                <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
                  {virtualizer.getVirtualItems().map(vItem => {
                    const modelId = models[vItem.index]!;
                    return renderRow(modelId, {
                      position: "absolute",
                      top: vItem.start,
                      left: 0,
                      width: "100%",
                    });
                  })}
                </div>
              </div>
            ) : (
              <div className="providers-workspace-model-list">
                {models.map(modelId => renderRow(modelId))}
              </div>
            )}
          </>
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
  quotaReport?: ProviderQuotaReportView;
}) {
  const t = useT();
  const timeLabels = useRelativeTimeLabels();
  const when = formatRelativeTime(quotaReport?.updatedAt, timeLabels);
  const hasUsage = usageTotals?.requests !== undefined;
  const quota = accountQuotaFromReport(quotaReport);
  const hasQuotaMeta = !!quotaReport;
  return (
    <div className="providers-workspace-section">
      <div className="providers-workspace-section-head">
        <span className="providers-workspace-section-title">{t("pws.tab.usage")}</span>
      </div>
      <div className="providers-workspace-section-body">
        <div className="pwi-usage-block">
          <h4 className="pwi-section-title pwi-section-title--sub">{t("pws.usageLast30d")}</h4>
          {hasUsage ? (
            <div className="pwi-usage-metrics" role="group" aria-label={t("pws.usageLast30d")}>
              <div className="pwi-usage-metric">
                <span className="pwi-usage-metric-value">{formatRequestCount(usageTotals.requests)}</span>
                <span className="pwi-usage-metric-label muted">{t("pws.metricRequests")}</span>
              </div>
              <div className="pwi-usage-metric">
                <span className="pwi-usage-metric-value">{formatTokenCount(usageTotals.totalTokens)}</span>
                <span className="pwi-usage-metric-label muted">{t("pws.metricTokens")}</span>
              </div>
            </div>
          ) : (
            <p className="muted pwi-usage-empty">{t("pws.usageUnavailable")}</p>
          )}
        </div>
        <div className="pwi-usage-block">
          <h4 className="pwi-section-title pwi-section-title--sub">{t("pws.rateLimits")}</h4>
          {quota ? (
            <>
              <QuotaBars
                quota={quota}
                plan={null}
                threshold={80}
                t={t}
                layout="stacked"
                className="pwi-usage-quota-bars"
              />
              {hasQuotaMeta && (
                <dl className="pwi-kv" style={{ marginTop: 12 }}>
                  {quotaReport.source?.trim() ? (
                    <div className="pwi-kv-row">
                      <dt>{t("pws.quotaSource")}</dt>
                      <dd className="pwi-kv-mono">{quotaReport.source.trim()}</dd>
                    </div>
                  ) : null}
                  <div className="pwi-kv-row">
                    <dt>{t("pws.lastUpdated")}</dt>
                    <dd>{when}</dd>
                  </div>
                </dl>
              )}
            </>
          ) : (
            <p className="muted pwi-usage-empty">{t("pws.noRateLimits")}</p>
          )}
          {!hasUsage && !hasQuotaMeta && (
            <p className="muted" style={{ marginTop: 8 }}>{t("pws.noUsageFor", { name: formatProviderDisplayName(item.name) })}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function TabSettings({
  item,
  oauth,
  availableModels,
  onSetDisabled,
  onUpdateProvider,
  onDirtyChange,
}: {
  item: WorkspaceItem;
  oauth?: { loggedIn: boolean; email?: string; error?: string };
  availableModels: string[];
  onSetDisabled: (name: string, disabled: boolean) => void;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const initialAuthMode = String(item.authMode ?? (item.keyOptional ? "local" : "key"));
  const [adapter, setAdapter] = useState(item.adapter);
  const [baseUrl, setBaseUrl] = useState(item.baseUrl);
  const [defaultModel, setDefaultModel] = useState(item.defaultModel ?? "");
  const [authMode, setAuthMode] = useState(initialAuthMode);
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

  const dirty = adapter.trim() !== item.adapter
    || baseUrl.trim() !== item.baseUrl
    || defaultModel.trim() !== (item.defaultModel ?? "")
    || authMode !== String(item.authMode ?? (item.keyOptional ? "local" : "key"))
    || note.trim() !== (item.note ?? "")
    || apiKey.trim() !== "";

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const modelOptions = useMemo(() => {
    const set = new Set(availableModels);
    if (defaultModel.trim()) set.add(defaultModel.trim());
    if (item.defaultModel) set.add(item.defaultModel);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [availableModels, defaultModel, item.defaultModel]);

  const adapterOptions = useMemo(() => {
    const list = [...SETTINGS_ADAPTERS] as string[];
    if (adapter && !list.includes(adapter)) list.unshift(adapter);
    return list;
  }, [adapter]);

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
          {dirty && <span className="providers-workspace-section-meta pwi-settings-dirty">{t("pws.settingsDirty")}</span>}
        </div>
        <div className="providers-workspace-section-body pwi-settings-form">
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">
              <IconLock style={{ width: 12, height: 12 }} aria-hidden="true" />
              {t("pws.providerId")}
            </span>
            <input className="input" value={item.name} readOnly disabled title={t("pws.renameUnsupported")} />
            <span className="pwi-settings-hint muted">{t("pws.immutableId")}</span>
          </label>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">{t("modal.adapter")}</span>
            <select className="input" value={adapter} onChange={e => setAdapter(e.target.value)}>
              {adapterOptions.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">{t("modal.baseUrl")}</span>
            <input className="input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={t("modal.baseUrlPlaceholder")} />
          </label>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">{t("pws.cell.defaultModel")}</span>
            {modelOptions.length > 0 ? (
              <input
                className="input"
                list={`pwi-models-${item.name}`}
                value={defaultModel}
                onChange={e => setDefaultModel(e.target.value)}
                placeholder={t("pws.optionalPlaceholder")}
              />
            ) : (
              <input className="input" value={defaultModel} onChange={e => setDefaultModel(e.target.value)} placeholder={t("pws.optionalPlaceholder")} />
            )}
            {modelOptions.length > 0 && (
              <datalist id={`pwi-models-${item.name}`}>
                {modelOptions.map(m => <option key={m} value={m} />)}
              </datalist>
            )}
          </label>
          <label className="pwi-settings-field">
            <span className="pwi-settings-label">{t("pws.note")}</span>
            <textarea
              className="input pwi-settings-textarea"
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={t("pws.notePlaceholder")}
              rows={3}
            />
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
            <button type="button" className="btn btn-primary btn-sm pwi-save-btn" onClick={() => void save()} disabled={saving || !onUpdateProvider || !dirty}>
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
              <Switch
                on={!item.disabled}
                onClick={() => onSetDisabled(item.name, !item.disabled)}
                label={item.disabled ? t("prov.enableAria", { name: item.name }) : t("prov.disableAria", { name: item.name })}
              />
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
  onTestDone, accounts, keys, busy, loginHint, authHandlers, onSettingsDirtyChange,
}: {
  item: WorkspaceItem;
  apiBase: string;
  defaultProvider?: string;
  onSetDisabled: (name: string, disabled: boolean) => void;
  onRemoveProvider: (name: string) => void;
  onDeselect: () => void;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
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
  onSettingsDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("overview");
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | undefined>(quotaReport?.updatedAt);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const isEnabled = !item.disabled;

  // Reset detail chrome when the selected provider changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional UI reset on provider switch
    setTab("overview");
    setTestMsg(null);
    setLastCheckedAt(quotaReport?.updatedAt);
    setSettingsDirty(false);
    setRemoveOpen(false);
  }, [item.name]); // eslint-disable-line react-hooks/exhaustive-deps -- reset UI when switching provider

  useEffect(() => {
    onSettingsDirtyChange?.(settingsDirty);
    return () => onSettingsDirtyChange?.(false);
  }, [settingsDirty, onSettingsDirtyChange]);

  const requestTab = (next: Tab) => {
    if (tab === "settings" && next !== "settings" && settingsDirty) {
      if (!window.confirm(t("pws.settingsUnsavedLeave"))) return;
    }
    setTab(next);
  };

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
    setRemoveOpen(true);
  };

  const renderTabPanel = (): ReactNode => {
    switch (tab) {
      case "overview": return (
        <TabOverview
          item={item}
          usageTotals={usageTotals}
          quotaReport={quotaReport}
          onSelectTab={requestTab}
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
          availableModels={availableModels}
          onSetDisabled={onSetDisabled}
          onUpdateProvider={onUpdateProvider}
          onDirtyChange={setSettingsDirty}
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
          className="btn btn-ghost btn-sm pwi-back-overview pwi-chrome-btn"
          onClick={() => {
            if (tab === "settings" && settingsDirty && !window.confirm(t("pws.settingsUnsavedLeave"))) return;
            onDeselect();
          }}
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
            <div className="providers-workspace-detail-title">{formatProviderDisplayName(item.name)}</div>
            {defaultProvider === item.name && (
              <span
                className="pwi-default-star"
                title={t("prov.defaultBadge")}
                aria-label={t("prov.defaultBadge")}
              >
                <IconStar width={18} height={18} aria-hidden="true" />
              </span>
            )}
            {isLocalProvider(item) ? (
              <span className="pwi-rail-badge pwi-rail-badge--local" title={t("pws.localTitle")}>{t("modal.badge.local")}</span>
            ) : isFreeProvider(item) ? (
              <span className="pwi-rail-badge pwi-rail-badge--free" title={t("pws.freeTitle")}>{t("modal.badge.free")}</span>
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
              className="btn btn-ghost btn-sm pwi-chrome-btn"
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
            onClick={() => requestTab(tabDef.id)}
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
      {removeOpen && (
        <RemoveProviderDialog
          name={item.name}
          onCancel={() => setRemoveOpen(false)}
          onConfirm={() => {
            setRemoveOpen(false);
            onRemoveProvider(item.name);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({
  onAddProvider,
}: {
  onAddProvider: (intent?: AddProviderIntent) => void;
}) {
  const t = useT();
  return (
    <div className="providers-workspace-empty-root">
      <div className="pwi-empty-hero">
        <div className="pwi-empty-right-icon" aria-hidden="true">
          <IconBoxes style={{ width: 64, height: 64 }} />
        </div>
        <h2 className="pwi-empty-right-title">{t("pws.connectFirst")}</h2>
        <div className="pwi-empty-tiles pwi-empty-tiles--3">
          <button
            type="button"
            className="pwi-empty-tile"
            onClick={() => onAddProvider({ tier: "free" })}
          >
            <span className="pwi-empty-tile-icon" aria-hidden="true"><IconGlobe width={18} height={18} /></span>
            <span className="pwi-empty-tile-label">{t("pws.empty.browseFree")}</span>
            <span className="pwi-empty-tile-desc">{t("pws.empty.browseFreeDesc")}</span>
          </button>
          <button
            type="button"
            className="pwi-empty-tile"
            onClick={() => onAddProvider({ tier: "accounts" })}
          >
            <span className="pwi-empty-tile-icon" aria-hidden="true"><IconLock width={18} height={18} /></span>
            <span className="pwi-empty-tile-label">{t("pws.empty.connectAccount")}</span>
            <span className="pwi-empty-tile-desc">{t("pws.empty.connectAccountDesc")}</span>
          </button>
          <button
            type="button"
            className="pwi-empty-tile"
            onClick={() => onAddProvider({ custom: true })}
          >
            <span className="pwi-empty-tile-icon" aria-hidden="true"><IconKey width={18} height={18} /></span>
            <span className="pwi-empty-tile-label">{t("pws.empty.addEndpoint")}</span>
            <span className="pwi-empty-tile-desc">{t("pws.empty.addEndpointDesc")}</span>
          </button>
        </div>
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
// JSON editor — fills the main/overview pane (not a modal)
// ---------------------------------------------------------------------------

function JsonEditorPanel({
  draft, isDirty, onDraftChange, onSave, onRequestClose, onRestore, saving,
}: {
  draft: string;
  isDirty: boolean;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  /** Back / Cancel — parent decides dirty prompt. */
  onRequestClose: () => void;
  onRestore: () => void;
  saving?: boolean;
}) {
  const t = useT();
  const [parseError, setParseError] = useState<string | null>(null);
  const lineCount = Math.max(1, draft.split(/\r\n|\r|\n/).length);

  const formatJson = () => {
    try {
      onDraftChange(JSON.stringify(JSON.parse(draft), null, 2));
      setParseError(null);
    } catch {
      const loc = jsonErrorLocation(draft);
      setParseError(t("pws.jsonInvalid", {
        where: loc ? t("pws.jsonInvalidAt", { line: loc.line }) : "",
      }));
    }
  };

  const saveWithValidation = () => {
    const loc = jsonErrorLocation(draft);
    if (loc) {
      setParseError(t("pws.jsonInvalid", {
        where: t("pws.jsonInvalidAt", { line: loc.line }),
      }));
      return;
    }
    setParseError(null);
    onSave();
  };

  return (
    <div className="pwi-json-panel" role="region" aria-label={t("prov.editJson")}>
      <div className="pwi-json-panel-toolbar">
        <button
          type="button"
          className="btn btn-ghost btn-sm pwi-back-overview pwi-chrome-btn"
          onClick={onRequestClose}
          aria-label={t("pws.backToAll")}
          title={t("pws.backToAll")}
          disabled={saving}
        >
          <IconChevron style={{ width: 14, height: 14, transform: "rotate(180deg)" }} aria-hidden="true" />
          {t("pws.allProviders")}
        </button>
        <span className="pwi-json-panel-title">{t("pws.jsonLiveConfig")}</span>
        <div className="pwi-json-panel-actions">
          {isDirty && (
            <span className="pwi-json-dirty-badge muted" title={t("pws.jsonUnsavedDesc")}>
              {t("pws.jsonUnsavedBadge")}
            </span>
          )}
          <button type="button" className="btn btn-ghost pwi-chrome-btn" onClick={formatJson} disabled={saving}>
            {t("pws.jsonFormat")}
          </button>
          <button type="button" className="btn btn-ghost pwi-chrome-btn" onClick={onRestore} disabled={saving || !isDirty}>
            {t("pws.jsonRestore")}
          </button>
          <button type="button" className="btn btn-ghost pwi-chrome-btn" onClick={onRequestClose} disabled={saving}>
            {t("pws.jsonDiscard")}
          </button>
          <button type="button" className="btn btn-primary pwi-save-btn" onClick={saveWithValidation} disabled={saving || !isDirty}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
      <p className="pwi-json-panel-desc muted">{t("pws.jsonEditorDesc")}</p>
      {parseError && (
        <div className="pwi-json-error" role="alert">{parseError}</div>
      )}
      <div className="pwi-json-editor">
        <pre className="pwi-json-gutter" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
        </pre>
        <textarea
          className="input mono pwi-json-textarea"
          value={draft}
          onChange={e => {
            onDraftChange(e.target.value);
            if (parseError) setParseError(null);
          }}
          spellCheck={false}
          aria-label={t("prov.editJson")}
          disabled={saving}
        />
      </div>
    </div>
  );
}

/** Unsaved JSON leave prompt: Save / Discard / Keep editing. */
function JsonUnsavedDialog({
  busy, onSave, onDiscard, onCancel,
}: {
  busy?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pwi-json-unsaved-title"
      onClick={onCancel}
    >
      <div className="modal-card pwi-json-unsaved-card" onClick={e => e.stopPropagation()}>
        <h3 id="pwi-json-unsaved-title" className="pwi-json-unsaved-title">{t("pws.jsonUnsavedTitle")}</h3>
        <p className="muted pwi-json-unsaved-desc">{t("pws.jsonUnsavedDesc")}</p>
        <div className="pwi-json-unsaved-actions">
          <button type="button" className="btn btn-ghost pwi-chrome-btn" onClick={onCancel} disabled={busy}>
            {t("pws.jsonKeepEditing")}
          </button>
          <button type="button" className="btn btn-ghost pwi-chrome-btn pwi-json-discard-btn" onClick={onDiscard} disabled={busy}>
            {t("pws.jsonDiscard")}
          </button>
          <button type="button" className="btn btn-primary pwi-save-btn" onClick={onSave} disabled={busy}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** In-app remove confirmation (never use window.confirm for this). */
function RemoveProviderDialog({
  name, onCancel, onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const display = formatProviderDisplayName(name);
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pwi-remove-confirm-title"
      onClick={onCancel}
    >
      <div className="modal-card pwi-remove-confirm-card" onClick={e => e.stopPropagation()}>
        <h3 id="pwi-remove-confirm-title" className="pwi-remove-confirm-title">
          {t("pws.removeConfirmTitle", { name: display })}
        </h3>
        <p className="muted pwi-remove-confirm-desc">{t("pws.removeConfirmDesc")}</p>
        <div className="pwi-remove-confirm-actions">
          <button type="button" className="btn btn-ghost pwi-chrome-btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn pwi-remove-confirm-danger" onClick={onConfirm}>
            {t("common.remove")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview panel
// ---------------------------------------------------------------------------

function OverviewPanel({
  sections, onSelect, onEditConfig, attentionItems, usageTotals, quotaReports = {},
}: {
  sections: WorkspaceSections;
  onSelect: (name: string) => void;
  onEditConfig: () => void;
  attentionItems: AttentionItem[];
  usageTotals: Record<string, ProviderUsageTotals>;
  quotaReports?: Record<string, ProviderQuotaReportView>;
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
  const timeLabels = useRelativeTimeLabels();
  /** Providers that currently report 5h / week / month windows — sorted by urgency. */
  const quotaRows = useMemo(() => {
    const rows: {
      name: string;
      item: WorkspaceItem | null;
      quota: AccountQuota;
      report: ProviderQuotaReportView;
      urgency: number;
    }[] = [];
    for (const [name, report] of Object.entries(quotaReports)) {
      const item = providersByName.get(name) ?? null;
      if (item?.disabled) continue;
      const quota = accountQuotaFromReport(report);
      if (!quota) continue;
      rows.push({ name, item, quota, report, urgency: maxQuotaUtilisation(quota) });
    }
    rows.sort((a, b) =>
      b.urgency - a.urgency
      || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    return rows;
  }, [quotaReports, providersByName]);

  return (
    <div className="providers-workspace-overview">
      <header className="providers-workspace-overview-head">
        <div className="providers-workspace-overview-title-row">
          <h2 className="providers-workspace-overview-title">{t("pws.overviewTitle")}</h2>
          <button
            type="button"
            className="btn btn-ghost pwi-edit-json-btn pwi-chrome-btn"
            onClick={onEditConfig}
            aria-label={t("prov.editJson")}
            title={t("pws.editJsonDesc")}
          >
            <IconBraces width={18} height={18} aria-hidden="true" />
            {t("prov.editJson")}
          </button>
        </div>
        <p className="providers-workspace-overview-sub">{t("pws.overviewSub")}</p>
      </header>

      <section className="pwi-section pwi-overview-counts" aria-label={t("pws.overviewTitle")}>
        <div className="pwi-overview-count-strip" role="list">
          <div className="pwi-overview-count" role="listitem">
            <span className="providers-workspace-summary-value pwi-summary-ready">{sections.ready.length}</span>
            <span className="providers-workspace-summary-label">{t("pws.status.ready")}</span>
          </div>
          <div className="pwi-overview-count" role="listitem">
            <span className="providers-workspace-summary-value pwi-summary-setup">{sections.needsSetup.length}</span>
            <span className="providers-workspace-summary-label">{t("pws.needSetup")}</span>
          </div>
          <div className="pwi-overview-count" role="listitem">
            <span className="providers-workspace-summary-value pwi-summary-disabled">{sections.disabled.length}</span>
            <span className="providers-workspace-summary-label">{t("prov.disabledBadge")}</span>
          </div>
        </div>
      </section>

      <section className="pwi-section pwi-overview-quotas" aria-label={t("pws.rateLimits")}>
        <h3 className="pwi-section-title">{t("pws.rateLimits")}</h3>
        {quotaRows.length === 0 ? (
          <div className="pwi-overview-quota-empty muted">{t("pws.noRateLimits")}</div>
        ) : (
          <div className="pwi-overview-quota-list">
            {quotaRows.map(({ name, item, quota, report }) => {
              const label = report.label?.trim()
                || (item ? formatProviderDisplayName(item.name) : formatProviderDisplayName(name));
              return (
                <div key={name} className="pwi-overview-quota-card">
                  <button
                    type="button"
                    className="pwi-overview-quota-head"
                    onClick={() => onSelect(name)}
                    aria-label={t("pws.openProvider", { name: label })}
                  >
                    <ProviderIcon
                      name={name}
                      adapter={item?.adapter ?? "openai-chat"}
                      baseUrl={item?.baseUrl ?? ""}
                      cls="providers-workspace-rail-icon"
                    />
                    <span className="pwi-overview-quota-name">{label}</span>
                    <span
                      className="pwi-overview-quota-meta muted"
                      title={report.source || undefined}
                    >
                      {t("pws.quotaUpdated", { when: formatRelativeTime(report.updatedAt, timeLabels) })}
                    </span>
                    <IconChevron style={{ width: 13, height: 13, color: "var(--muted)" }} aria-hidden="true" />
                  </button>
                  <QuotaBars
                    quota={quota}
                    threshold={80}
                    t={t}
                    layout="stacked"
                    className="pwi-overview-quota-bars"
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="pwi-section pwi-overview-recent" aria-label={t("pws.recentlyUsed")}>
        <h3 className="pwi-section-title">{t("pws.recentlyUsed")}</h3>
        <div className="pwi-overview-recent-body">
          {mostUsed.length === 0 ? (
            <div className="pwi-recent-empty muted">{t("pws.noUsageRecorded")}</div>
          ) : mostUsed.map(entry => {
            const item = providersByName.get(entry.name)!;
            const label = formatProviderDisplayName(entry.name);
            return (
              <button
                key={entry.name}
                type="button"
                className="pwi-recent-row"
                onClick={() => onSelect(entry.name)}
                aria-label={t("pws.openProvider", { name: label })}
              >
                <ProviderIcon
                  name={entry.name}
                  adapter={item.adapter}
                  baseUrl={item.baseUrl}
                  cls="providers-workspace-rail-icon"
                />
                <span className="pwi-recent-name">{label}</span>
                <span className="muted">{t("pws.requestsCount", { count: formatRequestCount(entry.requests) })}</span>
                <IconChevron style={{ width: 13, height: 13, color: "var(--muted)" }} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </section>

      {attentionItems.length > 0 && (
        <section className="pwi-section pwi-overview-attention" aria-label={t("pws.attentionRequired")}>
          <h3 className="pwi-section-title">{t("pws.attentionRequired")}</h3>
          <div className="pwi-overview-attention-body">
            {attentionItems.map(ai => (
              <button
                key={ai.name}
                type="button"
                className="pwi-attention-row"
                onClick={() => onSelect(ai.name)}
                aria-label={t("pws.attentionAria", { name: ai.name, reason: ai.reason })}
              >
                <span className="pwi-dot pwi-dot--warning" aria-hidden="true" />
                <span className="pwi-attention-name">{formatProviderDisplayName(ai.name)}</span>
                <span className="pwi-attention-reason muted">{ai.reason}</span>
                <IconChevron style={{ width: 13, height: 13, color: "var(--muted)" }} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export default function ProviderWorkspace({
  providers, apiBase, defaultProvider, onAddProvider,
  onEditConfig, jsonEditor,
  onSetDisabled, onRemoveProvider, onUpdateProvider, quotaReports: quotaReportsProp = {}, oauthStatus = {},
  accountSets = {}, keyPools = {}, busyProvider = null, loginHint = null, authHandlers,
}: ProviderWorkspaceProps) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [modelCounts, setModelCounts] = useState<ProviderModelCounts>({});
  const [availableModels, setAvailableModels] = useState<ProviderAvailableModels>({});
  const [selectedModels, setSelectedModels] = useState<ProviderSelectedModels>({});
  const [usageTotals, setUsageTotals] = useState<Record<string, ProviderUsageTotals>>({});
  /** Local quota fetch so overview does not depend solely on parent timing/HMR. */
  const [quotaReportsLocal, setQuotaReportsLocal] = useState<Record<string, ProviderQuotaReportView>>({});
  /** Status + pricing facets shown in the rail (all on by default). */
  const [statusFilter, setStatusFilter] = useState({ ready: true, needsSetup: true, disabled: true });
  const [pricingFilter, setPricingFilter] = useState({ free: true, paid: true });
  const [typeFilter, setTypeFilter] = useState({ cloud: true, local: true, selfHosted: true, account: true });
  const [sortMode, setSortMode] = useState<ProviderSortMode>("az");
  const [filterOpen, setFilterOpen] = useState(false);
  const filterWrapRef = useRef<HTMLDivElement>(null);
  /** When leaving JSON editor with dirty draft: prompt then run this intent. */
  const [jsonLeaveIntent, setJsonLeaveIntent] = useState<null | { kind: "close" } | { kind: "provider"; name: string }>(null);
  const [jsonSaving, setJsonSaving] = useState(false);
  /** Local dirty latch — set on first textarea edit so prompts work even if parent baseline races. */
  const [jsonLocalDirty, setJsonLocalDirty] = useState(false);
  const [detailSettingsDirty, setDetailSettingsDirty] = useState(false);
  const jsonOpenPrev = useRef(false);

  const sections = useMemo(() => buildProviderWorkspace(providers), [providers]);

  const jsonOpen = !!jsonEditor?.open;
  const jsonDirty = jsonOpen && (!!jsonEditor?.isDirty || jsonLocalDirty);

  // Reset local dirty when the editor opens; keep it latched after the first edit.
  useEffect(() => {
    if (jsonOpen && !jsonOpenPrev.current) {
      setJsonLocalDirty(false);
    }
    if (!jsonOpen) {
      setJsonLocalDirty(false);
      setJsonLeaveIntent(null);
    }
    jsonOpenPrev.current = jsonOpen;
  }, [jsonOpen]);

  const onJsonDraftChange = useCallback((value: string) => {
    setJsonLocalDirty(true);
    jsonEditor?.onDraftChange(value);
  }, [jsonEditor]);

  /** Select a provider, closing the JSON editor first (with dirty prompt if needed). */
  const selectProvider = useCallback((name: string) => {
    if (jsonOpen) {
      if (jsonDirty) {
        setJsonLeaveIntent({ kind: "provider", name });
        return;
      }
      jsonEditor?.onClose();
      setSelectedName(name);
      return;
    }
    if (detailSettingsDirty && !window.confirm(t("pws.settingsUnsavedLeave"))) return;
    setSelectedName(name);
  }, [jsonOpen, jsonDirty, jsonEditor, detailSettingsDirty, t]);

  /** Back / Cancel from JSON editor. */
  const requestCloseJson = useCallback(() => {
    if (!jsonEditor?.open) return;
    if (jsonDirty) {
      setJsonLeaveIntent({ kind: "close" });
      return;
    }
    jsonEditor.onClose();
  }, [jsonEditor, jsonDirty]);

  const finishJsonLeave = useCallback((intent: typeof jsonLeaveIntent) => {
    setJsonLeaveIntent(null);
    jsonEditor?.onClose();
    if (intent?.kind === "provider") setSelectedName(intent.name);
    else setSelectedName(null);
  }, [jsonEditor]);

  const confirmJsonSaveAndLeave = useCallback(async () => {
    if (!jsonEditor) return;
    setJsonSaving(true);
    try {
      const ok = await jsonEditor.onSave();
      if (!ok) return; // stay on editor; leave dialog stays so user can discard/cancel
      const intent = jsonLeaveIntent;
      setJsonLeaveIntent(null);
      // Parent closes editor on success; still ensure selection.
      if (intent?.kind === "provider") setSelectedName(intent.name);
      else setSelectedName(null);
    } finally {
      setJsonSaving(false);
    }
  }, [jsonEditor, jsonLeaveIntent]);

  const confirmJsonDiscardAndLeave = useCallback(() => {
    finishJsonLeave(jsonLeaveIntent);
  }, [finishJsonLeave, jsonLeaveIntent]);

  // Prefer parent reports when present; otherwise (or in addition) use a direct workspace fetch.
  const quotaReports = useMemo(() => {
    const merged: Record<string, ProviderQuotaReportView> = { ...quotaReportsLocal };
    for (const [name, report] of Object.entries(quotaReportsProp)) {
      merged[name] = report;
    }
    return merged;
  }, [quotaReportsLocal, quotaReportsProp]);

  useEffect(() => {
    let cancelled = false;
    const load = async (refresh: boolean) => {
      try {
        const res = await fetch(`${apiBase}/api/provider-quotas${refresh ? "?refresh=1" : ""}`);
        if (!res.ok) return;
        const data = await res.json() as {
          reports?: Array<{
            provider: string;
            label?: string;
            source?: string;
            updatedAt?: number;
            quota?: unknown;
          }>;
        };
        if (cancelled) return;
        const next: Record<string, ProviderQuotaReportView> = {};
        for (const report of data.reports ?? []) {
          if (!report?.provider) continue;
          next[report.provider] = {
            label: report.label,
            source: report.source,
            updatedAt: typeof report.updatedAt === "number" ? report.updatedAt : Date.now(),
            quota: report.quota,
          };
        }
        setQuotaReportsLocal(next);
      } catch {
        /* parent prop may still supply data */
      }
    };
    void load(true);
    // Second pass after a beat in case the first oauth/WHAM probe was still warming up.
    const timer = window.setTimeout(() => { void load(true); }, 1800);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [apiBase]);

  const allItems = useMemo(
    () => [...sections.ready, ...sections.needsSetup, ...sections.disabled],
    [sections],
  );
  const freeCount = useMemo(() => allItems.filter(isFreeProvider).length, [allItems]);
  const paidCount = allItems.length - freeCount;
  const typeCounts = useMemo(() => {
    const counts = { cloud: 0, local: 0, selfHosted: 0, account: 0 };
    for (const item of allItems) counts[providerKind(item)] += 1;
    return counts;
  }, [allItems]);

  const filteredSections = useMemo((): WorkspaceSections => {
    const q = search.trim().toLowerCase();
    const byQueryAndFacets = (items: WorkspaceItem[]) => {
      const filtered = items.filter(p => {
        if (q && !p.name.toLowerCase().includes(q) && !p.adapter.toLowerCase().includes(q)) return false;
        const free = isFreeProvider(p);
        if (free && !pricingFilter.free) return false;
        if (!free && !pricingFilter.paid) return false;
        const kind = providerKind(p);
        if (!typeFilter[kind]) return false;
        return true;
      });
      return sortWorkspaceItems(filtered, sortMode);
    };
    return {
      ready: statusFilter.ready ? byQueryAndFacets(sections.ready) : [],
      needsSetup: statusFilter.needsSetup ? byQueryAndFacets(sections.needsSetup) : [],
      disabled: statusFilter.disabled ? byQueryAndFacets(sections.disabled) : [],
    };
  }, [sections, search, statusFilter, pricingFilter, typeFilter, sortMode]);

  const filterActive =
    !statusFilter.ready || !statusFilter.needsSetup || !statusFilter.disabled
    || !pricingFilter.free || !pricingFilter.paid
    || !typeFilter.cloud || !typeFilter.local || !typeFilter.selfHosted || !typeFilter.account
    || sortMode !== "az";

  const resetFilters = () => {
    setStatusFilter({ ready: true, needsSetup: true, disabled: true });
    setPricingFilter({ free: true, paid: true });
    setTypeFilter({ cloud: true, local: true, selfHosted: true, account: true });
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
              className="btn btn-ghost btn-sm pwi-rail-add-btn pwi-chrome-btn"
              onClick={() => onAddProvider()}
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
              className={`pwi-rail-filter-btn${filterActive || filterOpen ? " pwi-rail-filter-btn--active" : ""}`}
              onClick={() => setFilterOpen(o => !o)}
              aria-label={t("pws.filterAria")}
              aria-haspopup="menu"
              aria-expanded={filterOpen}
              title={t("pws.filterAria")}
            >
              <IconFilter width={20} height={20} aria-hidden="true" />
              {filterActive && <span className="pwi-rail-filter-dot" aria-hidden="true" />}
            </button>
            {filterOpen && (
              <div className="pwi-rail-filter-menu" role="menu" aria-label={t("pws.providerFiltersAria")}>
                <div className="pwi-rail-filter-menu-title">{t("pws.filters")}</div>

                <div className="pwi-rail-filter-section">
                  <div className="pwi-rail-filter-menu-head">{t("pws.filterStatus")}</div>
                  <div className="pwi-rail-filter-list">
                    {statusFilterOptions.map(({ key, label, dotCls, count }) => (
                      <label key={key} className={`pwi-rail-filter-option${statusFilter[key] ? " pwi-rail-filter-option--on" : ""}`} role="menuitemcheckbox" aria-checked={statusFilter[key]}>
                        <input
                          type="checkbox"
                          className="pwi-rail-filter-native"
                          checked={statusFilter[key]}
                          onChange={() => setStatusFilter(prev => ({ ...prev, [key]: !prev[key] }))}
                        />
                        <span className="pwi-rail-filter-toggle" aria-hidden="true" />
                        <span className={`pwi-dot ${dotCls}`} aria-hidden="true" />
                        <span className="pwi-rail-filter-option-label">{label}</span>
                        <span className="pwi-rail-filter-option-count">{count}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="pwi-rail-filter-section">
                  <div className="pwi-rail-filter-menu-head">{t("pws.pricing")}</div>
                  <div className="pwi-rail-filter-list">
                    <label className={`pwi-rail-filter-option${pricingFilter.free ? " pwi-rail-filter-option--on" : ""}`} role="menuitemcheckbox" aria-checked={pricingFilter.free}>
                      <input
                        type="checkbox"
                        className="pwi-rail-filter-native"
                        checked={pricingFilter.free}
                        onChange={() => setPricingFilter(prev => ({ ...prev, free: !prev.free }))}
                      />
                      <span className="pwi-rail-filter-toggle" aria-hidden="true" />
                      <span className="pwi-rail-filter-option-label">{t("modal.badge.free")}</span>
                      <span className="pwi-rail-filter-option-count">{freeCount}</span>
                    </label>
                    <label className={`pwi-rail-filter-option${pricingFilter.paid ? " pwi-rail-filter-option--on" : ""}`} role="menuitemcheckbox" aria-checked={pricingFilter.paid}>
                      <input
                        type="checkbox"
                        className="pwi-rail-filter-native"
                        checked={pricingFilter.paid}
                        onChange={() => setPricingFilter(prev => ({ ...prev, paid: !prev.paid }))}
                      />
                      <span className="pwi-rail-filter-toggle" aria-hidden="true" />
                      <span className="pwi-rail-filter-option-label">{t("pws.paid")}</span>
                      <span className="pwi-rail-filter-option-count">{paidCount}</span>
                    </label>
                  </div>
                </div>

                <div className="pwi-rail-filter-section">
                  <div className="pwi-rail-filter-menu-head">{t("pws.filterType")}</div>
                  <div className="pwi-rail-filter-list">
                    {([
                      { key: "cloud" as const, label: t("pws.type.cloud"), count: typeCounts.cloud },
                      { key: "local" as const, label: t("pws.type.local"), count: typeCounts.local },
                      { key: "selfHosted" as const, label: t("pws.type.selfHosted"), count: typeCounts.selfHosted },
                      { key: "account" as const, label: t("pws.type.account"), count: typeCounts.account },
                    ]).map(({ key, label, count }) => (
                      <label key={key} className={`pwi-rail-filter-option${typeFilter[key] ? " pwi-rail-filter-option--on" : ""}`} role="menuitemcheckbox" aria-checked={typeFilter[key]}>
                        <input
                          type="checkbox"
                          className="pwi-rail-filter-native"
                          checked={typeFilter[key]}
                          onChange={() => setTypeFilter(prev => ({ ...prev, [key]: !prev[key] }))}
                        />
                        <span className="pwi-rail-filter-toggle" aria-hidden="true" />
                        <span className="pwi-rail-filter-option-label">{label}</span>
                        <span className="pwi-rail-filter-option-count">{count}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="pwi-rail-filter-section pwi-rail-filter-section--sort">
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
                    className="pwi-rail-filter-reset"
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
                    selected={!jsonOpen && selectedName === item.name}
                    modelCount={modelCounts[item.name]}
                    isDefault={defaultProvider === item.name}
                    onClick={() => selectProvider(item.name)} />
                ))}
              </div>
            );
          })}
        </div>
      </aside>
      {jsonLeaveIntent && (
        <JsonUnsavedDialog
          busy={jsonSaving}
          onSave={() => { void confirmJsonSaveAndLeave(); }}
          onDiscard={confirmJsonDiscardAndLeave}
          onCancel={() => setJsonLeaveIntent(null)}
        />
      )}
      <main className="providers-workspace-main" aria-label={t("pws.workspaceMainAria")}>
        {jsonEditor?.open ? (
          <JsonEditorPanel
            draft={jsonEditor.draft}
            isDirty={jsonDirty}
            onDraftChange={onJsonDraftChange}
            onSave={() => { void (async () => {
              setJsonSaving(true);
              try {
                const ok = await jsonEditor.onSave();
                if (ok) setJsonLocalDirty(false);
              } finally {
                setJsonSaving(false);
              }
            })(); }}
            onRequestClose={requestCloseJson}
            onRestore={() => {
              jsonEditor.onRestore?.();
              setJsonLocalDirty(false);
            }}
            saving={jsonSaving}
          />
        ) : selectedItem ? (
          <DetailPanel
            item={selectedItem}
            apiBase={apiBase}
            defaultProvider={defaultProvider}
            onSetDisabled={onSetDisabled}
            onRemoveProvider={handleRemoveProvider}
            onDeselect={() => setSelectedName(null)}
            onUpdateProvider={onUpdateProvider}
            onSettingsDirtyChange={setDetailSettingsDirty}
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
            onEditConfig={() => {
              setSelectedName(null);
              onEditConfig();
            }}
            attentionItems={attentionItems}
            usageTotals={usageTotals}
            quotaReports={quotaReports}
          />
        )}
      </main>
    </div>
  );
}
