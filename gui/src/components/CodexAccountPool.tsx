import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n/shared";
import { IconPlus } from "../icons";
import { Notice, EmptyState } from "../ui";
import AddCodexAccountModal from "./AddCodexAccountModal";
import { useCodexAccountPool, type CodexAccountPoolController } from "../hooks/useCodexAccountPool";
import type { ReactNode } from "react";
import type { CodexAccountModeState } from "../codex-multi-state";
import CodexAutoSwitchSetting from "./CodexAutoSwitchSetting";
import CodexPoolStrategySetting from "./CodexPoolStrategySetting";
import { useCodexAutoSwitch } from "../hooks/useCodexAutoSwitch";
import { readJsonIfOk } from "../fetch-json";
import { CodexAccountPoolCards, CodexAccountPoolReauthBanner } from "./codex-account-pool-cards";
import { CodexAccountSwitchModal } from "./codex-account-switch-modal";
import { CodexAccountResetModal } from "./codex-account-reset-modal";
import { CodexAccountPoolLoadStates, CodexAccountPoolMainCard, CodexAccountPoolPageHead } from "./codex-account-pool-main-card";
import { redeemResetCredit } from "./codex-account-pool-handlers";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import { accountNeedsReauth } from "../oauth-health-display";
import { useCopyFeedback } from "./use-copy-feedback";

// Single definition lives with the controller that owns this data (WP3).
export type { CodexAccountEntry } from "../hooks/useCodexAccountPool";

const DOCTOR_CMD = "ocx doctor";

/**
 * Global ChatGPT / Codex account pool (main + extras), extracted from the Codex
 * Auth page (WP060). `accountModeState` arrives as a prop (the parent owns the
 * /api/config fetch); `banner` is an optional slot rendered above the main card
 * (the Codex Auth page passes its mode banner); `embedded` (WP090) omits page
 * chrome — currently a no-op stub reserved for the Providers workspace.
 */
export default function CodexAccountPool({ apiBase, accountModeState = null, banner = null, embedded = false, onActiveNeedsReauthChange, controller: injectedController }: {
  apiBase: string;
  accountModeState?: CodexAccountModeState | null;
  banner?: ReactNode;
  embedded?: boolean;
  onActiveNeedsReauthChange?: (needs: boolean) => void;
  /**
   * WP3: when Providers owns the controller, every surface shares one instance so a
   * mutation on Overview is immediately visible on the Accounts tab. The standalone
   * Codex Auth page passes nothing and gets its own.
   */
  controller?: CodexAccountPoolController;
}) {
  const t = useT();
  const autoSwitch = useCodexAutoSwitch(apiBase, {
    updated: t("codexAuth.autoSwitchUpdated"),
    updateFailed: t("codexAuth.autoSwitchUpdateFailed"),
    invalid: t("codexAuth.autoSwitchThresholdInvalid"),
  });
  const { beginServerRead, acceptServerRead, rejectServerRead, hydrateServerValue } = autoSwitch;
  // A hook cannot be called conditionally, so the fallback instance is always created
  // but stays inert (no load, no polling) whenever a shared controller was injected.
  const ownController = useCodexAccountPool(apiBase, !injectedController);
  const controller = injectedController ?? ownController;
  const { accounts, activeId, loadState, switchingId, load } = controller;
  const [confirm, setConfirm] = useState<CodexAccountEntry | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [reauthId, setReauthId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [toastError, setToastError] = useState(false);
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [resetPopup, setResetPopup] = useState<CodexAccountEntry | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [creditDetails, setCreditDetails] = useState<{ granted_at: string; expires_at: string }[] | null>(null);
  const [creditDetailsLoading, setCreditDetailsLoading] = useState(false);
  const doctorCopy = useCopyFeedback<string>();

  const copyDoctor = useCallback((accountId: string) => {
    doctorCopy.copy(DOCTOR_CMD, accountId);
  }, [doctorCopy]);

  // The controller owns loading and polling. This surface only feeds the auto-switch
  // threshold observer and leases a pause while an OAuth modal is open.
  // Depend on the stable subscribe callback, not the controller object: the hook
  // returns a fresh object every render, which would resubscribe on every render.
  const { subscribeLoadObserver, readLastThreshold } = controller;

  useEffect(() => subscribeLoadObserver({
    beginActiveRead: beginServerRead,
    acceptActiveRead: acceptServerRead,
    rejectActiveRead: rejectServerRead,
  }), [subscribeLoadObserver, beginServerRead, acceptServerRead, rejectServerRead]);

  // Seed from a value an earlier load already fetched. Tabs mount and unmount their
  // panels, so a panel appearing after that load would otherwise show "Loading" until
  // the next poll. Hydration applies only while uninitialized, so it cannot disturb a
  // draft or a pending save.
  useEffect(() => {
    const cached = readLastThreshold();
    if (cached !== undefined) hydrateServerValue(cached);
  }, [readLastThreshold, hydrateServerValue]);

  useEffect(() => {
    if (!showAdd) return;
    const token = controller.pauseRefresh();
    return () => controller.resumeRefresh(token);
  }, [controller, showAdd]);

  const activePoolAccount = activeId && activeId !== "__main__"
    ? accounts.find(a => a.id === activeId)
    : null;
  const activePoolNeedsReauth = accountNeedsReauth(activePoolAccount);

  useEffect(() => {
    onActiveNeedsReauthChange?.(activePoolNeedsReauth);
  }, [activePoolNeedsReauth, onActiveNeedsReauthChange]);

  const openReauth = useCallback((id: string) => {
    setReauthId(id);
    setShowAdd(true);
  }, []);

  const closeAddModal = useCallback(() => {
    setShowAdd(false);
    setReauthId(null);
  }, []);

  const handleAccountAdded = useCallback(() => {
    void controller.syncAfterAccountAdded();
    setToast(t("codexAuth.accountAdded"));
    setToastError(false);
    setTimeout(() => setToast(""), 5000);
    closeAddModal();
  }, [closeAddModal, controller, t]);

  const setActive = async (id: string | null) => {
    const result = await controller.switchAccount(id);
    if (!result.ok) {
      if (result.reason === "busy") return;
      setToast(t("codexAuth.switchFailed"));
      setToastError(true);
      setTimeout(() => setToast(""), 5000);
      return;
    }
    setConfirm(null);
    const selectedId = result.activeId;
    const label = selectedId && selectedId !== "__main__"
      ? accounts.find(account => account.id === selectedId)?.email ?? t("pws.accountOrdinal", { count: "1" })
      : t("codexAuth.mainAccount");
    setToast(accountModeState === "direct"
      ? t("codexAuth.poolPreparedToast", { email: label })
      : t("codexAuth.switched", { email: label }));
    setToastError(false);
    setTimeout(() => setToast(""), 5000);
  };

  const editAlias = async (account: CodexAccountEntry) => {
    const entered = window.prompt(t("prov.aliasPrompt"), account.alias ?? "");
    if (entered === null) return;
    const result = await controller.saveAlias(account.id, entered);
    setToastError(!result.ok);
    setToast(t(result.ok ? "prov.aliasSaved" : "prov.aliasSaveFailed"));
  };

  const remove = async (id: string) => {
    const label = accounts.find(account => account.id === id)?.email ?? t("pws.accountOrdinal", { count: "1" });
    if (!window.confirm(t("codexAuth.removeConfirm", { id: label }))) return;
    const result = await controller.removeAccount(id);
    if (!result.ok) {
      setToast(t("codexAuth.removeFailed"));
      setToastError(true);
      setTimeout(() => setToast(""), 5000);
    }
  };

  const refreshQuotas = async () => {
    setRefreshingQuota(true);
    try {
      const ok = await load(true);
      setToast(t(ok ? "codexAuth.quotaRefreshed" : "codexAuth.quotaRefreshFailed"));
      setTimeout(() => setToast(""), 5000);
    } finally {
      setRefreshingQuota(false);
    }
  };

  const openResetPopup = async (account: CodexAccountEntry) => {
    setResetPopup(account);
    setResetConfirm(false);
    setCreditDetails(null);
    setCreditDetailsLoading(true);
    try {
      const resp = await fetch(`${apiBase}/api/codex-auth/reset-credits?accountId=${encodeURIComponent(account.id)}`);
      const data = await readJsonIfOk<{ credits?: { granted_at: string; expires_at: string }[] }>(resp);
      if (data) {
        const sorted = (data.credits ?? []).sort((a, b) =>
          new Date(a.granted_at).getTime() - new Date(b.granted_at).getTime()
        );
        setCreditDetails(sorted);
      }
    } catch { /* detail fetch is non-blocking */ }
    finally { setCreditDetailsLoading(false); }
  };

  const handleRedeem = async (accountId: string) => {
    setRedeeming(true);
    try {
      const result = await redeemResetCredit(apiBase, accountId, t, load);
      if (result.close) {
        setResetPopup(null);
        setResetConfirm(false);
      }
      if (result.toast) {
        setToastError(!result.ok);
        setToast(result.toast);
        setTimeout(() => setToast(""), 5000);
      }
    } finally {
      setRedeeming(false);
    }
  };

  const main = accounts.find(a => a.isMain);
  const pool = accounts.filter(a => !a.isMain);
  const isMainActive = !activeId || activeId === "__main__";
  const switchActionLabel = t(accountModeState === "direct" ? "codexAuth.prepareForPool" : "codexAuth.setAsNext");

  return (
    <div>
      <CodexAccountPoolPageHead
        t={t}
        embedded={embedded}
        refreshingQuota={refreshingQuota}
        onRefresh={() => { void refreshQuotas(); }}
      />

      {toast && <Notice tone={toastError ? "err" : "ok"}>{toast}</Notice>}

      <CodexAccountPoolLoadStates
        t={t}
        loadState={loadState}
        accountsCount={accounts.length}
        onRetry={() => { void load(); }}
      />

      {banner}

      <CodexAccountPoolMainCard
        t={t}
        main={main}
        isMainActive={isMainActive}
        accountModeState={accountModeState}
        threshold={autoSwitch.threshold ?? 0}
        switchActionLabel={switchActionLabel}
        onSwitch={setConfirm}
        onOpenReset={openResetPopup}
        onCopyDoctor={copyDoctor}
        doctorCopyOutcomeFor={doctorCopy.outcomeFor}
      />

      <div className="section-sep">
        <span className="section-label">{t("codexAuth.accountPool")}</span>
        <div className="sep-line" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowAdd(true)}>
          <IconPlus width={14} /> {t("codexAuth.add")}
        </button>
      </div>

      {activePoolNeedsReauth && activePoolAccount && (
        <CodexAccountPoolReauthBanner onReauth={() => openReauth(activePoolAccount.id)} />
      )}

      {pool.length === 0 && <EmptyState title={t("codexAuth.noPool")} />}

      <CodexAccountPoolCards
        pool={pool}
        activeId={activeId}
        accountModeState={accountModeState}
        switchActionLabel={switchActionLabel}
        threshold={autoSwitch.threshold ?? 0}
        onOpenReset={openResetPopup}
        onSwitch={setConfirm}
        onReauth={openReauth}
        onEditAlias={editAlias}
        onRemove={remove}
        onCopyDoctor={copyDoctor}
        doctorCopyOutcomeFor={doctorCopy.outcomeFor}
      />

      <CodexAutoSwitchSetting
        threshold={autoSwitch.threshold}
        draft={autoSwitch.draft}
        saving={autoSwitch.saving}
        loadError={autoSwitch.loadError}
        feedback={autoSwitch.feedback}
        onDraftChange={autoSwitch.setDraft}
        onEditingChange={autoSwitch.setEditing}
        onCommit={autoSwitch.commit}
        onCancel={autoSwitch.cancel}
        onToggle={autoSwitch.toggle}
        onRetry={() => {
          autoSwitch.retry();
          void load();
        }}
      />

      <CodexPoolStrategySetting apiBase={apiBase} />

      {confirm && (
        <CodexAccountSwitchModal
          confirm={confirm}
          mainEmail={main?.email}
          accountModeState={accountModeState}
          switchingId={switchingId}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { void setActive(confirm.id === "__main__" ? "__main__" : confirm.id); }}
        />
      )}

      {resetPopup && (
        <CodexAccountResetModal
          resetPopup={resetPopup}
          resetConfirm={resetConfirm}
          creditDetails={creditDetails}
          creditDetailsLoading={creditDetailsLoading}
          redeeming={redeeming}
          onClose={() => { setResetPopup(null); setResetConfirm(false); setCreditDetails(null); }}
          onShowConfirm={() => setResetConfirm(true)}
          onCancelConfirm={() => setResetConfirm(false)}
          onRedeem={() => { void handleRedeem(resetPopup.id); }}
        />
      )}

      {showAdd && (
        <AddCodexAccountModal
          apiBase={apiBase}
          reauthAccountId={reauthId ?? undefined}
          onClose={closeAddModal}
          onAdded={handleAccountAdded}
        />
      )}
    </div>
  );
}
