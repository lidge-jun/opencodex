/**
 * ProviderDetails — the detail header + tab shell (WP090+091). Owns tab state
 * and composes the Overview/Models/Usage/Settings panels.
 */
import { useCallback, useMemo, useState } from "react";
import { useT } from "../../i18n";
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
import ProviderSettings from "./ProviderSettings";
import type { ProviderQuotaReportView } from "../../provider-workspace/report";
import type { AccountLoadState, ProviderUsageTotals, OAuthAccountRow, ApiKeyRow, LoginHint, ProviderAuthHandlers, ProviderUpdatePatch } from "./types";

type Tab = "overview" | "models" | "usage" | "accounts" | "settings";

export default function ProviderDetails({
  item,
  usageTotals,
  quotaReport,
  availableModels,
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
  switchingAccountId,
  keys,
  busyProvider,
  loginHint,
  authHandlers,
  onCodexActiveNeedsReauthChange,
  onUpdateProvider,
  isDefault,
  onRemoveProvider,
  onSetDisabled,
}: {
  item: WorkspaceItem;
  usageTotals?: ProviderUsageTotals;
  quotaReport?: ProviderQuotaReportView;
  availableModels: string[];
  selectedModels: string[];
  modelsLoading?: boolean;
  modelsLoadFailed?: boolean;
  onRetryModels?: () => void;
  oauthEmail?: string;
  onDeselect: () => void;
  apiBase: string;
  oauth?: { loggedIn: boolean; email?: string; error?: string };
  accounts?: OAuthAccountRow[];
  accountLoadState?: AccountLoadState;
  switchingAccountId?: string | null;
  keys?: ApiKeyRow[];
  busyProvider?: string | null;
  loginHint?: LoginHint | null;
  authHandlers?: ProviderAuthHandlers;
  onCodexActiveNeedsReauthChange?: (needs: boolean) => void;
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>;
  isDefault?: boolean;
  onRemoveProvider?: (name: string) => void;
  onSetDisabled?: (name: string, disabled: boolean) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("overview");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const isDisabled = item.disabled === true;
  const free = useMemo(() => isFreeProvider(item), [item]);
  const local = useMemo(() => isLocalProvider(item), [item]);
  const authSurface = useMemo(() => providerAuthSurface(item), [item]);
  const tabs = useMemo<{ id: Tab; label: string }[]>(() => [
    { id: "overview", label: t("pws.tab.overview") },
    { id: "models", label: t("pws.tab.models") },
    { id: "usage", label: t("pws.tab.usage") },
    ...(authSurface ? [{ id: "accounts" as const, label: authSurface === "api-keys" ? t("pws.apiKeys") : t("pws.tab.accounts") }] : []),
    { id: "settings", label: t("pws.tab.settings") },
  ], [authSurface, t]);

  const switchTab = useCallback((next: Tab) => {
    if (settingsDirty && tab === "settings" && next !== "settings") {
      if (!window.confirm(t("pws.unsavedLeaveBody"))) return;
    }
    setTab(next);
  }, [tab, settingsDirty, t]);

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
        <button type="button" className="pws-detail-back-link" onClick={onDeselect}>
          <IconChevron className="pws-detail-back-chevron" aria-hidden="true" />
          {t("pws.allProviders")}
        </button>
      </div>
      <div className="pws-detail-head-main">
        <ProviderIcon name={item.name} adapter={item.adapter} baseUrl={item.baseUrl} cls="pws-detail-icon" />
        <div className="pws-detail-title-wrap">
          <h2 className="pws-detail-title">
            {formatProviderDisplayName(item.name)}
            {local && <span className="pwi-rail-badge pwi-rail-badge--local">{t("modal.badge.local")}</span>}
            {!local && free && <span className="pwi-rail-badge pwi-rail-badge--free">{t("modal.badge.free")}</span>}
          </h2>
        </div>
        <div className="pws-detail-actions">
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
            usageTotals={usageTotals}
            quotaReport={quotaReport}
            oauthEmail={oauthEmail}
            onEditSettings={() => switchTab("settings")}
            onViewUsage={() => switchTab("usage")}
            onUpdateProvider={onUpdateProvider}
            reauthBusy={busyProvider === item.name}
            onCancelLogin={authHandlers?.onCancelLogin ? () => void authHandlers.onCancelLogin?.(item.name) : undefined}
            onReauthenticate={
              item.activeNeedsReauth
                ? () => {
                    if (item.authMode === "oauth") {
                      void authHandlers?.onReauth(item.name);
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
            item={item}
            availableModels={availableModels}
            selectedModels={selectedModels}
            modelsLoading={modelsLoading}
            modelsLoadFailed={modelsLoadFailed}
            onRetryModels={onRetryModels}
          />
        )}
        {tab === "usage" && (
          <ProviderUsage item={item} usageTotals={usageTotals} quotaReport={quotaReport} />
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
            onCodexActiveNeedsReauthChange={onCodexActiveNeedsReauthChange}
          />
        )}
        {tab === "settings" && (
          <ProviderSettings
            item={item}
            availableModels={availableModels}
            onUpdateProvider={onUpdateProvider}
            onDirtyChange={setSettingsDirty}
          />
        )}
      </div>
    </div>
  );
}
