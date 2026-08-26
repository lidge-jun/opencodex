import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { IconPlus } from "../icons";
import { EmptyState, type NoticeTone } from "../ui";
import AddCodexAccountModal from "./AddCodexAccountModal";
import { useCodexAccountPool, type CodexAccountPoolController } from "../hooks/useCodexAccountPool";
import type { ReactNode } from "react";
import type { CodexAccountModeState } from "../codex-multi-state";
import CodexAutoSwitchSetting from "./CodexAutoSwitchSetting";
import CodexPoolStrategySetting from "./CodexPoolStrategySetting";
import CodexAuthAdvancedSettings from "./CodexAuthAdvancedSettings";
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
import { DEFAULT_ACCOUNT_POOL_STRATEGY } from "../account-pool-strategy";
import type { CodexAccountMutationCompletion } from "../codex-account-mutation";

// Single definition lives with the controller that owns this data (WP3).
export type { CodexAccountEntry } from "../hooks/useCodexAccountPool";

const DOCTOR_CMD = "ocx doctor";

/**
 * Global ChatGPT / Codex account pool (main + extras), extracted from the Codex
 * Auth page (WP060). `accountModeState` arrives as a prop (the parent owns the
 * /api/config fetch); `banner` is an optional slot rendered above the main card
 * (the Codex Auth page passes its mode banner); `embedded` (WP090) omits page
 * title chrome while retaining the shared account actions in the Providers workspace.
 */
export default function CodexAccountPool({ apiBase, accountModeState = null, banner = null, embedded = false, onActiveNeedsReauthChange, controller: injectedController, advancedExtras = null }: {
  apiBase: string;
  accountModeState?: CodexAccountModeState | null;
  banner?: ReactNode;
  embedded?: boolean;
  onActiveNeedsReauthChange?: (needs: boolean) => void;
  /** Whole boxes rendered inside Advanced settings. Never fold these internally. */
  advancedExtras?: ReactNode;
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
  const [poolStrategy, setPoolStrategy] = useState<
    typeof DEFAULT_ACCOUNT_POOL_STRATEGY | "round-robin" | "fill-first" | null
  >(null);
  const { beginServerRead, acceptServerRead, rejectServerRead, hydrateServerValue } = autoSwitch;
  // A hook cannot be called conditionally, so the fallback instance is always created
  // but stays inert (no load, no polling) whenever a shared controller was injected.
  const ownController = useCodexAccountPool(apiBase, !injectedController);
  const controller = injectedController ?? ownController;
  const { accounts, activeId, loadState, switchingId, pauseUpdatingId, priorityUpdatingId, pausingExhausted, activePinnedId, load } = controller;
  const [confirm, setConfirm] = useState<CodexAccountEntry | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [reauthId, setReauthId] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [actionFeedbackTone, setActionFeedbackTone] = useState<NoticeTone | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  // undefined until /api/settings answers: the switch must not render a guessed position and
  // then visibly correct itself a moment later.
  const [sparkVisible, setSparkVisible] = useState<boolean | undefined>(undefined);
  const [sparkBusy, setSparkBusy] = useState(false);
  const [resetPopup, setResetPopup] = useState<CodexAccountEntry | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [creditDetails, setCreditDetails] = useState<{ granted_at: string; expires_at: string }[] | null>(null);
  const [creditDetailsLoading, setCreditDetailsLoading] = useState(false);
  const doctorCopy = useCopyFeedback<string>();

  const showActionFeedback = useCallback((text: string, tone: NoticeTone = "ok") => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setActionFeedback(text);
    setActionFeedbackTone(tone);
    feedbackTimerRef.current = setTimeout(() => {
      setActionFeedback(null);
      setActionFeedbackTone(null);
      feedbackTimerRef.current = null;
    }, 5000);
  }, []);

  useEffect(() => () => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
  }, []);

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
  const activePoolNeedsReauth = !activePoolAccount?.paused && accountNeedsReauth(activePoolAccount);

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

  const handleAccountAdded = useCallback((completion: CodexAccountMutationCompletion) => {
    void controller.syncAfterAccountAdded();
    showActionFeedback(
      t(completion.catalogRefreshPending
        ? "codexAuth.catalogRefreshPending"
        : "codexAuth.accountAdded"),
      completion.catalogRefreshPending ? "warn" : "ok",
    );
    closeAddModal();
  }, [closeAddModal, controller, showActionFeedback, t]);

  const setActive = async (id: string | null) => {
    const result = await controller.switchAccount(id);
    if (!result.ok) {
      if (result.reason === "busy") return;
      showActionFeedback(t("codexAuth.switchFailed"), "err");
      return;
    }
    setConfirm(null);
    const selectedId = result.activeId;
    const label = selectedId && selectedId !== "__main__"
      ? accounts.find(account => account.id === selectedId)?.email ?? t("pws.accountOrdinal", { count: "1" })
      : t("codexAuth.mainAccount");
    showActionFeedback(accountModeState === "direct"
      ? t("codexAuth.poolPreparedToast", { email: label })
      : t("codexAuth.switched", { email: label }));
  };

  const editAlias = async (account: CodexAccountEntry) => {
    const entered = window.prompt(t("prov.aliasPrompt"), account.alias ?? "");
    if (entered === null) return;
    const result = await controller.saveAlias(account.id, entered);
    showActionFeedback(t(result.ok ? "prov.aliasSaved" : "prov.aliasSaveFailed"), result.ok ? "ok" : "err");
  };

  const togglePaused = async (account: CodexAccountEntry) => {
    const paused = !account.paused;
    const result = await controller.setAccountPaused(account.id, paused);
    if (!result.ok && result.reason === "busy") return;
    setConfirm(current => current?.id === account.id ? null : current);
    showActionFeedback(t(result.ok
      ? paused ? "codexAuth.pauseSucceeded" : "codexAuth.resumeSucceeded"
      : paused ? "codexAuth.pauseFailed" : "codexAuth.resumeFailed", {
      email: account.alias ?? account.email,
    }), result.ok ? "ok" : "err");
  };

  const changePriority = async (account: CodexAccountEntry, priority: number) => {
    // Same guard as the pool strategy control (CodexPoolStrategySetting.tsx), and here it is
    // load-bearing rather than just thrift: `Select` calls onChange for the clicked option
    // even when it was already selected, and commits the highlighted one on Tab-out. The
    // route releases the pin on every accepted write — deliberately, since an explicit write
    // is a newer statement of intent — so without this a mis-click would unpin the account
    // the operator chose and still report success. Suppressing the no-op belongs here, at
    // the widget, not at the route, where a same-value write really is a statement.
    if (priority === account.priority) return;
    const result = await controller.setAccountPriority(account.id, priority);
    if (!result.ok && result.reason === "busy") return;
    showActionFeedback(t(result.ok ? "accountPool.priorityUpdated" : "accountPool.priorityUpdateFailed", {
      email: account.alias ?? account.email,
    }), result.ok ? "ok" : "err");
  };

  const remove = async (id: string) => {
    const label = accounts.find(account => account.id === id)?.email ?? t("pws.accountOrdinal", { count: "1" });
    if (!window.confirm(t("codexAuth.removeConfirm", { id: label }))) return;
    const result = await controller.removeAccount(id);
    if (!result.ok) {
      showActionFeedback(t("codexAuth.removeFailed"), "err");
    } else if (result.catalogRefreshPending) {
      showActionFeedback(t("codexAuth.catalogRefreshPending"), "warn");
    }
  };

  const refreshQuotas = async () => {
    setRefreshingQuota(true);
    try {
      const ok = await load(true);
      showActionFeedback(t(ok ? "codexAuth.quotaRefreshed" : "codexAuth.quotaRefreshFailed"), ok ? "ok" : "err");
    } finally {
      setRefreshingQuota(false);
    }
  };

  useEffect(() => {
    // AbortController rather than a `cancelled` flag: the in-flight request is actually torn
    // down on unmount, and the state update lands in a .then() the linter can see is guarded.
    const abort = new AbortController();
    fetch(`${apiBase}/api/settings`, { signal: abort.signal })
      .then(response => (response.ok ? response.json() : null))
      .then((payload: { showCodexSparkQuota?: unknown } | null) => {
        if (abort.signal.aborted || typeof payload?.showCodexSparkQuota !== "boolean") return;
        setSparkVisible(payload.showCodexSparkQuota);
      })
      // A settings read failure leaves the switch unrendered rather than guessing a position.
      .catch(() => {});
    return () => { abort.abort(); };
  }, [apiBase]);

  const toggleSpark = async () => {
    if (sparkBusy || sparkVisible === undefined) return;
    const requested = !sparkVisible;
    setSparkBusy(true);
    // Optimistic, then reconciled against what the server confirms — the same shape the account
    // picker toggle uses, so a rejected write visibly snaps back instead of lying.
    setSparkVisible(requested);
    try {
      const response = await fetch(`${apiBase}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ showCodexSparkQuota: requested }),
      });
      if (!response.ok) throw new Error("save");
      const payload = await response.json() as { showCodexSparkQuota?: unknown };
      const confirmed = typeof payload.showCodexSparkQuota === "boolean" ? payload.showCodexSparkQuota : requested;
      setSparkVisible(confirmed);
      showActionFeedback(t(confirmed ? "codexAuth.sparkQuotaShown" : "codexAuth.sparkQuotaHidden"), "ok");
      await load(true);
    } catch {
      setSparkVisible(!requested);
      showActionFeedback(t("codexAuth.sparkQuotaFailed"), "err");
    } finally {
      setSparkBusy(false);
    }
  };


  const pauseExhausted = async () => {
    const result = await controller.pauseExhaustedAccounts();
    if (!result.ok && result.reason === "busy") return;
    showActionFeedback(result.ok
      ? result.pausedCount > 0
        ? t("codexAuth.pauseExhaustedSucceeded", { count: String(result.pausedCount) })
        : t("codexAuth.pauseExhaustedNone")
      : t("codexAuth.pauseExhaustedFailed"), result.ok ? "ok" : "err");
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
        showActionFeedback(result.toast, result.ok ? "ok" : "err");
      }
    } finally {
      setRedeeming(false);
    }
  };

  const main = accounts.find(a => a.isMain);
  const pool = accounts.filter(a => !a.isMain);
  const isMainActive = !main?.paused && (!activeId || activeId === "__main__");
  const switchActionLabel = t(accountModeState === "direct" ? "codexAuth.prepareForPool" : "codexAuth.setAsNext");
  const pauseBusy = pauseUpdatingId !== null || pausingExhausted;
  const autoSwitchThreshold = autoSwitch.threshold ?? 0;
  // The standalone Codex Auth page keeps the doctor-copy affordance; the embedded
  // Providers workspace account surface does not.
  const showDoctorCopy = !embedded;

  return (
    <div>
      <CodexAccountPoolPageHead
        t={t}
        embedded={embedded}
        refreshingQuota={refreshingQuota}
        actionFeedback={actionFeedback}
        actionFeedbackTone={actionFeedbackTone}
        pausingExhausted={pausingExhausted}
        pauseBusy={pauseBusy}
        onRefresh={() => { void refreshQuotas(); }}
        onPauseExhausted={() => { void pauseExhausted(); }}
        sparkVisible={sparkVisible}
        sparkBusy={sparkBusy}
        onToggleSpark={() => { void toggleSpark(); }}
      />

      {banner}

      {/* Skeleton must sit where main/pool cards will be — never above the account-mode
          banner, or the strip collapses on ready and shoves the whole page up (CLS). */}
      <CodexAccountPoolLoadStates
        t={t}
        loadState={loadState}
        accountsCount={accounts.length}
        onRetry={() => { void load(); }}
      />

      {!(loadState === "loading" && accounts.length === 0) && (
        <>
          <CodexAccountPoolMainCard
            t={t}
            main={main}
            isMainActive={isMainActive}
            accountModeState={accountModeState}
            threshold={autoSwitchThreshold}
            switchActionLabel={switchActionLabel}
            onSwitch={setConfirm}
            onTogglePause={togglePaused}
            pauseUpdatingId={pauseUpdatingId}
            pauseBusy={pauseBusy}
            onPriorityChange={(entry, priority) => { void changePriority(entry, priority); }}
            priorityUpdatingId={priorityUpdatingId}
            switchingId={switchingId}
            pinnedId={activePinnedId}
            onOpenReset={openResetPopup}
            onCopyDoctor={showDoctorCopy ? copyDoctor : undefined}
            doctorCopyOutcomeFor={showDoctorCopy ? doctorCopy.outcomeFor : undefined}
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
            threshold={autoSwitchThreshold}
            onOpenReset={openResetPopup}
            onSwitch={setConfirm}
            onTogglePause={togglePaused}
            pauseUpdatingId={pauseUpdatingId}
            pauseBusy={pauseBusy}
            onPriorityChange={(entry, priority) => { void changePriority(entry, priority); }}
            priorityUpdatingId={priorityUpdatingId}
            switchingId={switchingId}
            pinnedId={activePinnedId}
            onReauth={openReauth}
            onEditAlias={editAlias}
            onRemove={remove}
            onCopyDoctor={showDoctorCopy ? copyDoctor : undefined}
            doctorCopyOutcomeFor={showDoctorCopy ? doctorCopy.outcomeFor : undefined}
          />
        </>
      )}

      <CodexPoolStrategySetting
        apiBase={apiBase}
        subscribeLoadObserver={controller.subscribeLoadObserver}
        readLastActive={controller.readLastActive}
        onStrategyResolved={setPoolStrategy}
      />

      <CodexAuthAdvancedSettings
        t={t}
        open={advancedOpen}
        onToggle={() => setAdvancedOpen(open => !open)}
      >
        {poolStrategy !== null && (
          <CodexAutoSwitchSetting
            threshold={autoSwitch.threshold}
            draft={autoSwitch.draft}
            strategy={poolStrategy}
            hydrated={autoSwitch.hydrated}
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
        )}
        {advancedExtras}
      </CodexAuthAdvancedSettings>

      {confirm && (
        <CodexAccountSwitchModal
          confirm={confirm}
          mainEmail={main?.email}
          accountModeState={accountModeState}
          switchingId={switchingId}
          orderBusy={priorityUpdatingId !== null}
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
