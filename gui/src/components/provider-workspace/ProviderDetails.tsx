/**
 * ProviderDetails — the detail header + tab shell (WP090+091). Owns tab state
 * and composes the Overview/Models/Usage/Settings panels.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import type { WorkspaceItem } from "../../provider-workspace/catalog";
import { formatProviderDisplayName } from "../../provider-icons";
import { isFreeProvider } from "../../provider-workspace/catalog";
import { isLocalProvider } from "../../provider-workspace/kind";
import { providerAuthSurface } from "../../provider-workspace/auth";
import { ProviderIcon } from "./ProviderRail";
import { Switch } from "../../ui";
import { IconChevron, IconTrash } from "../../icons";
import ProviderOverview from "./ProviderOverview";
import ProviderModels from "./ProviderModels";
import ProviderUsage from "./ProviderUsage";
import ProviderAuthPanel from "./ProviderAuthPanel";
import type { CodexAccountPoolController } from "../../hooks/useCodexAccountPool";
import ProviderSettings from "./ProviderSettings";
import { UnsavedLeaveDialog } from "./ProviderDialogs";
import type { ProviderQuotaReportView } from "../../provider-workspace/report";
import type { AccountLoadState, ProviderModelUsageRow, ProviderUsageTotals, OAuthAccountRow, ApiKeyRow, LoginHint, ProviderAuthHandlers, ProviderUpdatePatch, ProviderUpdateResult } from "./types";

type Tab = "overview" | "models" | "usage" | "accounts" | "settings";

export default function ProviderDetails({
  item,
  usageTotals,
  modelUsage,
  quotaReport,
  availableModels,
  hasLiveModels,
  selectedModels,
  modelsLoading,
  modelsLoadFailed,
  onRetryModels,
  oauthEmail,
  onDeselect,
  apiBase,
  oauth,
  accounts,
  accountLoadState,
  accountsFocusToken = 0,
  accountsFocusProvider = null,
  switchingAccountId,
  keys,
  busyProvider,
  loginHint,
  authHandlers,
  onCodexActiveNeedsReauthChange,
  codexController,
  onUpdateProvider,
  isDefault,
  onRemoveProvider,
  onSetDisabled,
  onSetDefault,
}: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  modelUsage?: ProviderModelUsageRow[];
  quotaReport?: ProviderQuotaReportView;
  availableModels: string[];
  /** Server-reported live-catalog provenance; see filterModels(). */
  hasLiveModels: boolean;
  selectedModels: string[];
  modelsLoading?: boolean;
  modelsLoadFailed?: boolean;
  onRetryModels?: () => void;
  oauthEmail?: string;
  onDeselect: () => void;
  apiBase: string;
  oauth?: { loggedIn: boolean; email?: string; error?: string; needsReauth?: boolean };
  accounts?: OAuthAccountRow[];
  accountLoadState?: AccountLoadState;
  /** When this token increases for accountsFocusProvider, switch to the Accounts tab. */
  accountsFocusToken?: number;
  /** Provider that owns the current accountsFocusToken; other providers ignore it. */
  accountsFocusProvider?: string | null;
  switchingAccountId?: string | null;
  keys?: ApiKeyRow[];
  busyProvider?: string | null;
  loginHint?: LoginHint | null;
  authHandlers?: ProviderAuthHandlers;
  onCodexActiveNeedsReauthChange?: (needs: boolean) => void;
  /** Shared Codex account state owned by Providers (WP3). */
  codexController?: CodexAccountPoolController;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<ProviderUpdateResult>;
  isDefault?: boolean;
  onRemoveProvider?: (name: string) => void;
  onSetDisabled?: (name: string, disabled: boolean) => void;
  onSetDefault?: (name: string) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("overview");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<Tab | "deselect" | null>(null);
  const [leaveSaving, setLeaveSaving] = useState(false);
  const settingsSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  // Seed 0 so a mount-time token from revealProviderAccounts stays pending until
  // authSurface exists; seeding with the prop would treat it as already seen.
  const [seenAccountsFocusToken, setSeenAccountsFocusToken] = useState(0);
  const registerSettingsSave = useCallback((save: (() => Promise<boolean>) | null) => {
    settingsSaveRef.current = save;
  }, []);
  const isDisabled = item.disabled === true;
  const free = useMemo(() => isFreeProvider(item), [item]);
  const local = useMemo(() => isLocalProvider(item), [item]);
  const authSurface = useMemo(() => providerAuthSurface(item), [item]);
  // Global counter from Providers — only honor it for the reveal target.
  const scopedAccountsFocusToken = accountsFocusProvider === item.name ? accountsFocusToken : 0;
  const connectionIdentity = JSON.stringify([
    codexController?.activeId ?? "",
    accounts?.find(account => account.active)?.id ?? "",
    keys?.find(entry => entry.active)?.id ?? "",
    oauth?.loggedIn === undefined ? "" : String(oauth.loggedIn),
    oauth?.needsReauth === undefined ? "" : String(oauth.needsReauth),
    oauthEmail ?? "",
  ]);
  const tabs = useMemo<{ id: Tab; label: string }[]>(() => [
    { id: "overview", label: t("pws.tab.overview") },
    { id: "models", label: t("pws.tab.models") },
    { id: "usage", label: t("pws.tab.usage") },
    ...(authSurface ? [{ id: "accounts" as const, label: authSurface === "api-keys" ? t("pws.apiKeys") : t("pws.tab.accounts") }] : []),
    { id: "settings", label: t("pws.tab.settings") },
  ], [authSurface, t]);

  const switchTab = useCallback((next: Tab) => {
    if (settingsDirty && tab === "settings" && next !== "settings") {
      setPendingLeave(next);
      return;
    }
    setTab(next);
  }, [tab, settingsDirty]);

  // Adjust related state when accountsFocusToken changes during render (not in an
  // effect) so the Accounts tab is selected without a one-frame stale paint.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  // Hold a non-zero token until authSurface exists so mount-time focus from
  // revealProviderAccounts is not marked seen before Accounts can open.
  if (scopedAccountsFocusToken !== seenAccountsFocusToken && !(scopedAccountsFocusToken && !authSurface)) {
    setSeenAccountsFocusToken(scopedAccountsFocusToken);
    if (scopedAccountsFocusToken && authSurface) {
      if (settingsDirty && tab === "settings") {
        setPendingLeave("accounts");
      } else {
        setTab("accounts");
      }
    }
  }

  const requestDeselect = useCallback(() => {
    if (settingsDirty && tab === "settings") {
      setPendingLeave("deselect");
      return;
    }
    onDeselect();
  }, [settingsDirty, tab, onDeselect]);

  const onTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    switchTab(tabs[next]!.id);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]
      ?.focus();
  }, [switchTab, tabs]);

  const activeTabId = `pws-tab-${tab}`;
  const activePanelId = `pws-panel-${tab}`;

  return (
    <div className="pws-detail">
      <div className="pws-detail-head">
        <button type="button" className="pws-detail-back-link" onClick={requestDeselect}>
          <IconChevron className="pws-detail-back-chevron" aria-hidden="true" />
          {t("pws.allProviders")}
        </button>
      </div>
      <div className="pws-detail-head-main">
        <ProviderIcon name={item.name} adapter={item.adapter} baseUrl={item.baseUrl} cls="pws-detail-icon" />
        <div className="pws-detail-title-wrap">
          <h2 className="pws-detail-title">
            {formatProviderDisplayName(item.name, t)}
            {local && <span className="pwi-rail-badge pwi-rail-badge--local">{t("modal.badge.local")}</span>}
            {!local && free && <span className="pwi-rail-badge pwi-rail-badge--free">{t("modal.badge.free")}</span>}
          </h2>
        </div>
        <div className="pws-detail-actions">
          {!isDefault && !isDisabled && onSetDefault && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onSetDefault(item.name)}>
              {t("prov.setDefault")}
            </button>
          )}
          {onRemoveProvider && (
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon-only"
              onClick={() => onRemoveProvider(item.name)}
              aria-label={t("pws.removeConfirmTitle")}
              title={t("pws.removeConfirmTitle")}
            >
              <IconTrash style={{ width: 15, height: 15 }} aria-hidden="true" />
            </button>
          )}
          {onSetDisabled && (
            <div className="pws-detail-toggle">
              <span className="pws-detail-toggle-label">{t("pws.enabledLabel")}</span>
              <Switch
                on={!isDisabled}
                onClick={() => onSetDisabled(item.name, !isDisabled)}
                disabled={isDefault}
                label={t("pws.enabledLabel")}
              />
            </div>
          )}
        </div>
      </div>
      <div className="pws-detail-tabs" role="tablist">
        {tabs.map((candidate, index) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            id={`pws-tab-${candidate.id}`}
            aria-controls={`pws-panel-${candidate.id}`}
            aria-selected={tab === candidate.id}
            tabIndex={tab === candidate.id ? 0 : -1}
            className={`pws-detail-tab${tab === candidate.id ? " pws-detail-tab--active" : ""}`}
            onClick={() => switchTab(candidate.id)}
            onKeyDown={event => onTabKeyDown(event, index)}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div
        className="pws-detail-panel"
        role="tabpanel"
        id={activePanelId}
        aria-labelledby={activeTabId}
        tabIndex={0}
      >
        {tab === "overview" && (
          <ProviderOverview
            item={item}
            apiBase={apiBase}
            connectionIdentity={connectionIdentity}
            usageTotals={usageTotals}
            quotaReport={quotaReport}
            oauthEmail={oauthEmail}
            oauth={oauth}
            onEditSettings={() => switchTab("settings")}
            onViewUsage={() => switchTab("usage")}
            onUpdateProvider={onUpdateProvider}
            reauthBusy={busyProvider === item.name}
            onCancelLogin={authHandlers?.onCancelLogin ? () => void authHandlers.onCancelLogin?.(item.name) : undefined}
            onReauthenticate={
              item.activeNeedsReauth
                ? () => {
                    if (item.authMode === "oauth") {
                      const rows = accounts ?? [];
                      const active = rows.find(a => a.active && a.needsReauth)
                        ?? rows.find(a => a.needsReauth);
                      void authHandlers?.onReauth(item.name, active?.id);
                      return;
                    }
                    // Codex / forward: Accounts tab owns the pool reauth CTA.
                    switchTab("accounts");
                  }
                : undefined
            }
          />
        )}
        {tab === "models" && (
          <ProviderModels
            key={item.name}
            item={item}
            apiBase={apiBase}
            availableModels={availableModels}
            hasLiveModels={hasLiveModels}
            selectedModels={selectedModels}
            modelsLoading={modelsLoading}
            modelsLoadFailed={modelsLoadFailed}
            needsReauth={
              (accounts ?? []).some(account => account.active && account.needsReauth)
              || oauth?.needsReauth === true
            }
            onRetryModels={onRetryModels}
            onOpenAccounts={authSurface ? () => switchTab("accounts") : undefined}
          />
        )}
        {tab === "usage" && (
          <ProviderUsage item={item} usageTotals={usageTotals} quotaReport={quotaReport} modelUsage={modelUsage} />
        )}
        {tab === "accounts" && (
          <ProviderAuthPanel
            item={item}
            apiBase={apiBase}
            oauth={oauth}
            accounts={accounts}
            keys={keys}
            accountLoadState={accountLoadState}
            switchingAccountId={switchingAccountId}
            busy={busyProvider === item.name}
            loginHint={loginHint}
            authHandlers={authHandlers}
            onUpdateProvider={onUpdateProvider}
            onCodexActiveNeedsReauthChange={onCodexActiveNeedsReauthChange}
            codexController={codexController}
          />
        )}
        {tab === "settings" && (
          <ProviderSettings
            key={item.name}
            item={item}
            apiBase={apiBase}
            availableModels={availableModels}
            onUpdateProvider={onUpdateProvider}
            onDirtyChange={setSettingsDirty}
            onRegisterSave={registerSettingsSave}
          />
        )}
      </div>
      {pendingLeave && (
        <UnsavedLeaveDialog
          saving={leaveSaving}
          onCancel={() => { if (!leaveSaving) setPendingLeave(null); }}
          onDiscard={() => {
            if (leaveSaving) return;
            const next = pendingLeave;
            setPendingLeave(null);
            setSettingsDirty(false);
            if (next === "deselect") onDeselect();
            else setTab(next);
          }}
          onSave={() => {
            void (async () => {
              if (leaveSaving) return;
              setLeaveSaving(true);
              try {
                const ok = await settingsSaveRef.current?.() ?? false;
                if (!ok) return;
                const next = pendingLeave;
                setPendingLeave(null);
                setSettingsDirty(false);
                if (next === "deselect") onDeselect();
                else if (next) setTab(next);
              } finally {
                setLeaveSaving(false);
              }
            })();
          }}
        />
      )}
    </div>
  );
}
