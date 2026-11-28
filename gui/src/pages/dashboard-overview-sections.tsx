import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconAlert, IconCheck, IconChevron, IconRefresh, IconX } from "../icons";
import { Trans } from "../i18n/provider";
import { Select } from "../ui";
import { formatNamespacedModelId } from "../provider-icons";
import { navigateHash } from "../hash-routing";
import {
  clampVisionReasoningToLadder,
  EFFORT_CAP_LEVELS,
  parsePositiveInteger,
  parseVisionTimeoutMs,
  requireJson,
  type SidecarPatch,
  shadowCallModelOptions,
  webSearchSidecarSelectionForModel,
  updateJobLabel,
  webSearchEnabledPatch,
  sidecarCodexWritePending,
  visionEnabledPatch,
  visionMaxDescriptionsPatch,
  visionReasoningLadder,
  visionReasoningOptionsFor,
  visionReasoningPatch,
  visionSidecarBackendForModel,
  visionTimeoutPatch,
  VISION_MAX_DESCRIPTIONS_DEFAULT,
  VISION_TIMEOUT_MS_DEFAULT,
} from "./dashboard-shared";
import { DashboardMultiAgentControl, DashboardMultiAgentHelp } from "./dashboard-overview-head";
import { VisionAdvancedPopover } from "./dashboard-vision-popover";
import { shadowBackgroundModelBadge } from "./shadow-call-source";
import { ShadowCallSourceToggles } from "./shadow-call-source-toggles";
import type { useDashboardData } from "./use-dashboard-data";
import { HelpButton, SettingsRow, SettingsSection } from "@/components/v2-proxy/settings-layout";

type Dash = ReturnType<typeof useDashboardData>;

/* Row control widths: one model column and one effort column, shared by every row. */
const MODEL_FIELD = "w-[15rem] max-w-full";
const EFFORT_FIELD = "w-[9.5rem] max-w-full";

/* ---- Subagents -------------------------------------------------------------------------------- */

export function DashboardSubagentSection({ d }: { d: Dash }) {
  const { t, maMode, maError } = d;
  return (
    <SettingsSection id="proxy-subagents" title={t("proxyV2.secSubagents")} lede={t("proxyV2.secSubagentsLede")}>
      <SettingsRow
        label={t("dash.multiAgent")}
        hint={t("proxyV2.maModeHint")}
        help={<DashboardMultiAgentHelp {...d} />}
        control={<DashboardMultiAgentControl maMode={maMode} maSupportsPlaintextV2={d.maSupportsPlaintextV2} maBusy={d.maBusy} switchMaMode={d.switchMaMode} />}
      >
        {maError && <div role="alert" className="text-[13px] break-words text-danger">{maError}</div>}
      </SettingsRow>
      <DashboardEffortCapRows apiBase={d.apiBase} d={d} />
      <DashboardInjectionPanel apiBase={d.apiBase} d={d} />
    </SettingsSection>
  );
}

function DashboardEffortCapRows({ apiBase, d }: { apiBase: string; d: Dash }) {
  const {
    t, maMode, maModeResolved,
    effortCapHelpTriggerRef, effortCapHelpOpen, setEffortCapHelpOpen,
    effortCap, subagentEffortCap, effortCapSaving, setEffortCap, setSubagentEffortCap, setEffortCapSaving,
  } = d;

  if (!maModeResolved || maMode === "v1") return null;

  const options = [
    { value: "", label: t("dash.effortCapNone") },
    ...EFFORT_CAP_LEVELS.map(e => ({ value: e, label: e })),
  ];
  const save = async (patch: { effortCap: string | null } | { subagentEffortCap: string | null }) => {
    if (effortCapSaving) return;
    setEffortCapSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/effort-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await requireJson<{ ok: boolean; effortCap?: string | null; subagentEffortCap?: string | null }>(res);
      setEffortCap(data.effortCap ?? "");
      setSubagentEffortCap(data.subagentEffortCap ?? "");
    } catch { /* ignore */ }
    finally { setEffortCapSaving(false); }
  };

  return (
    <>
      <SettingsRow
        className="dash-effort-panel"
        label={t("dash.effortCapLabel")}
        hint={t("proxyV2.effortCapHint")}
        help={(
          <HelpButton
            buttonRef={effortCapHelpTriggerRef}
            label={t("dash.effortCapLabel")}
            expanded={effortCapHelpOpen}
            controls="effort-cap-help-dialog"
            popup="dialog"
            onClick={() => setEffortCapHelpOpen(open => !open)}
          />
        )}
        control={(
          <Select value={effortCap} options={options} fullWidth className={EFFORT_FIELD}
            onChange={v => { void save({ effortCap: v || null }); }}
            disabled={effortCapSaving} label={t("dash.effortCapLabel")} align="right" />
        )}
      />
      <SettingsRow
        label={t("dash.subagentEffortCapLabel")}
        hint={t("proxyV2.subagentEffortCapHint")}
        control={(
          <Select value={subagentEffortCap} options={options} fullWidth className={EFFORT_FIELD}
            onChange={v => { void save({ subagentEffortCap: v || null }); }}
            disabled={effortCapSaving} label={t("dash.subagentEffortCapLabel")} align="right" />
        )}
      />
    </>
  );
}

export function DashboardInjectionPanel({ d }: { apiBase: string; d: Dash }) {
  const {
    t, injectionModel, injectionEffort, injectionEfforts, injectionAvailable, injectionSaving,
    saveInjection,
  } = d;

  return (
    <SettingsRow
      className="dash-delegation-row"
      label={t("dash.injectionLabel")}
      hint={t("proxyV2.injectionHint")}
      control={(
        <>
          <Select
            value={injectionModel}
            options={[
              { value: "", label: t("dash.injectionNone") },
              ...injectionAvailable.map(m => ({ value: m.namespaced, label: formatNamespacedModelId(`${m.provider}/${m.model}`, t) })),
            ]}
            onChange={(v) => { void saveInjection({ model: v || null, effort: injectionEffort || null }); }}
            disabled={injectionSaving}
            label={t("dash.injectionLabel")}
            align="right"
            fullWidth
            className={MODEL_FIELD}
          />
          {injectionModel && injectionEfforts.length > 0 && (
            <Select
              value={injectionEffort}
              options={[
                { value: "", label: t("dash.injectionEffortNone") },
                ...injectionEfforts.map(e => ({ value: e, label: e })),
              ]}
              onChange={(v) => { void saveInjection({ model: injectionModel || null, effort: v || null }); }}
              disabled={injectionSaving}
              label={t("dash.injectionEffortLabel")}
              align="right"
              fullWidth
              className={EFFORT_FIELD}
            />
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigateHash("#subagents")}>
            {t("dash.injectionManage")}
          </button>
        </>
      )}
    />
  );
}

/* ---- Codex app ---------------------------------------------------------------------------------- */

export function DashboardCodexSection({ d }: { d: Dash }) {
  const { t, settings, settingsSaving, syncing, toggleCodexAutoStart, toggleCodexDesktopAuthless, toggleCodexClientCompaction } = d;
  const locked = !settings || settingsSaving || syncing;
  const catalogPending = settings?.catalogRefreshPending
    ? <p className="m-0 text-[13px] text-fg-muted" role="status">{t("codexAuth.catalogRefreshPending")}</p>
    : null;
  const remoteHistory = <p className="m-0 max-w-[68ch] text-[13px] leading-[19px] text-fg-muted">{t("dash.codexRemoteHistoryHint")}</p>;

  return (
    <SettingsSection id="proxy-codex" title={t("proxyV2.secCodex")} lede={t("proxyV2.secCodexLede")}>
      <SettingsRow
        label={t("dash.codexAutoStart")}
        hint={t("proxyV2.autoStartShort")}
        details={t("dash.codexAutoStartHint")}
        inline
        control={<CodexSwitch on={settings?.codexAutoStart ?? true} label={t("dash.codexAutoStart")} disabled={locked} onClick={toggleCodexAutoStart} />}
      />
      <SettingsRow
        label={t("dash.codexDesktopAuthless")}
        hint={t("proxyV2.authlessShort")}
        details={t("dash.codexDesktopAuthlessHint")}
        inline
        control={<CodexSwitch on={settings?.codexDesktopAuthless ?? false} label={t("dash.codexDesktopAuthless")} disabled={locked} onClick={toggleCodexDesktopAuthless} />}
      >
        {(settings?.codexDesktopAuthless || settings?.catalogRefreshPending) && (
          <div className="flex flex-col gap-1">
            {settings?.codexDesktopAuthless && remoteHistory}
            {catalogPending}
          </div>
        )}
      </SettingsRow>
      <SettingsRow
        label={t("dash.codexClientCompaction")}
        hint={t("proxyV2.clientCompactionShort")}
        details={t("dash.codexClientCompactionHint")}
        inline
        control={<CodexSwitch on={settings?.codexClientCompaction ?? false} label={t("dash.codexClientCompaction")} disabled={locked} onClick={toggleCodexClientCompaction} />}
      >
        {((!settings?.codexDesktopAuthless && settings?.codexClientCompaction) || settings?.catalogRefreshPending) && (
          <div className="flex flex-col gap-1">
            {!settings?.codexDesktopAuthless && settings?.codexClientCompaction && remoteHistory}
            {catalogPending}
          </div>
        )}
      </SettingsRow>
      <DashboardMaintenancePanel d={d} />
    </SettingsSection>
  );
}

function CodexSwitch({ on, label, disabled, onClick }: { on: boolean; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`switch ${on ? "on" : ""}`} onClick={onClick} disabled={disabled}
      aria-label={label} aria-pressed={on}>
      <span className="knob" />
    </button>
  );
}

export function DashboardMaintenancePanel({ d }: { d: Dash }) {
  const {
    t, runSync, syncing, settingsSaving, updateTriggerRef, openUpdateDialog, updateLoading, updateOpen,
    syncResult, syncError, updateJob, reconnecting, clearSyncFeedback,
  } = d;
  const syncHoldsWarning = !!syncResult && (
    !!syncResult.warning
    || !!syncResult.nativeSubagentDefaultsWarning
    || !!syncResult.staleAppServerHint
  );
  const [syncToastDismissed, setSyncToastDismissed] = useState(false);
  const syncToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (syncToastTimerRef.current) {
      clearTimeout(syncToastTimerRef.current);
      syncToastTimerRef.current = null;
    }
    if ((syncResult || syncError) && !syncHoldsWarning) {
      const holdMs = syncError ? 8000 : 6000;
      syncToastTimerRef.current = setTimeout(() => {
        syncToastTimerRef.current = null;
        setSyncToastDismissed(true);
        clearSyncFeedback();
      }, holdMs);
    }
    return () => {
      if (syncToastTimerRef.current) clearTimeout(syncToastTimerRef.current);
    };
  }, [syncResult, syncError, syncHoldsWarning, clearSyncFeedback]);

  const handleRunSync = () => {
    setSyncToastDismissed(false);
    void runSync();
  };

  const dismissSyncToast = () => {
    setSyncToastDismissed(true);
    clearSyncFeedback();
  };

  return (
    <>
      <SettingsRow
        className="maintenance-panel dash-sync-summary"
        label={t("dash.syncModels")}
        hint={t("dash.syncModelsHint")}
        control={(
          <div className="maintenance-actions flex items-center gap-2">
            <button type="button" className="btn btn-sm" onClick={handleRunSync} disabled={syncing || settingsSaving}>
              <IconRefresh className={syncing ? "spin-icon" : undefined} /> {syncing ? t("dash.syncing") : t("dash.syncRun")}
            </button>
            <button
              ref={updateTriggerRef}
              type="button"
              className="maintenance-update-anchor"
              onClick={openUpdateDialog}
              disabled={updateLoading}
              aria-haspopup="dialog"
              aria-controls="dashboard-update-dialog"
              aria-expanded={updateOpen}
              aria-label={t("dash.checkUpdate")}
              tabIndex={-1}
            />
          </div>
        )}
      >
        {updateJob && (
          <div className={`notice ${updateJob.status === "failed" ? "notice-err" : "notice-ok"} dash-update-job`} role="status">
            {updateJob.status === "failed" ? <IconAlert /> : <IconRefresh />}
            <span>
              {updateJobLabel(updateJob.status, t)}
              {updateJob.latestVersion ? ` ${t("dash.updateVersionTransition", { currentVersion: updateJob.currentVersion, latestVersion: updateJob.latestVersion })}` : ""}
              {reconnecting ? ` ${t("dash.updateReconnecting")}` : ""}
              {updateJob.error ? ` ${updateJob.error}` : ""}
            </span>
          </div>
        )}
      </SettingsRow>
      {!syncToastDismissed && syncResult && (
        <div className={`action-toast notice ${syncHoldsWarning ? "notice-warn" : "notice-ok"}`} role="status" aria-live="polite">
          {syncHoldsWarning ? <IconAlert /> : <IconCheck />}
          <span>
            {t("dash.syncOk", { count: syncResult.added })}
            {syncResult.warning ? ` ${syncResult.warning}` : ""}
            {syncResult.nativeSubagentDefaultsWarning ? ` ${syncResult.nativeSubagentDefaultsWarning}` : ""}
            {syncResult.staleAppServerHint ? <>{" "}<Trans k="dash.syncStaleHint" cmd="ocx sync --restart-codex" /></> : null}
          </span>
          <button type="button" className="action-toast-dismiss" onClick={dismissSyncToast} aria-label={t("api.dismiss")}>
            <IconX width={13} height={13} aria-hidden="true" />
          </button>
        </div>
      )}
      {!syncToastDismissed && syncError && (
        <div className="action-toast notice notice-err" role="status" aria-live="polite">
          <IconAlert /><span>{t("dash.syncFailed", { error: syncError })}</span>
          <button type="button" className="action-toast-dismiss" onClick={dismissSyncToast} aria-label={t("api.dismiss")}>
            <IconX width={13} height={13} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}

/* ---- Helper models (sidecars) --------------------------------------------------------------------- */

export function DashboardSidecarPanels({ d }: { d: Dash }) {
  const {
    t,
    sidecar, sidecarSaving, sidecarModels, visionModels, models, saveSidecar,
    sidecarCodexApply,
    shadowCall, shadowCallSaving, shadowCallError, shadowCallHelpTriggerRef, shadowCallHelpOpen, setShadowCallHelpOpen, saveShadowCall,
  } = d;
  const shadowMemoryLabel = t("shadowCall.memoryLabel");
  const visionEnabled = sidecar?.vision?.enabled !== false;
  const visionModel = visionEnabled ? (sidecar?.vision?.model ?? "gpt-5.6-luna") : "";
  const visionBackend = sidecar?.vision.backend ?? visionModels.find(option => option.value === sidecar?.vision.model)?.backend;
  // Same derivation as Vision: a stored setting without a backend takes the picker option's backend.
  const webSearchBackend = sidecar?.webSearch.backend ?? sidecarModels.find(option => option.value === sidecar?.webSearch.model)?.backend;
  const webSearchEnabled = sidecar?.webSearch?.enabled !== false;
  // Same shape as the Vision card: Off is a row in the picker, and choosing a model is the way back.
  const webSearchModel = webSearchEnabled ? (sidecar?.webSearch?.model ?? "gpt-5.6-luna") : "";
  const persistedVisionReasoning = sidecar?.vision?.reasoning ?? "low";
  const visionLadder = visionReasoningLadder(models, visionModel);
  const visionReasoning = clampVisionReasoningToLadder(visionLadder, persistedVisionReasoning);
  const serverMaxDescriptions = String(sidecar?.vision?.maxDescriptionsPerTurn ?? VISION_MAX_DESCRIPTIONS_DEFAULT);
  const serverTimeoutMs = String(sidecar?.vision?.timeoutMs ?? VISION_TIMEOUT_MS_DEFAULT);
  const [maxDraft, setMaxDraft] = useState<string | null>(null);
  const [timeoutDraft, setTimeoutDraft] = useState<string | null>(null);
  const [maxInvalid, setMaxInvalid] = useState(false);
  const [timeoutInvalid, setTimeoutInvalid] = useState(false);
  const [visionAdvancedOpen, setVisionAdvancedOpen] = useState(false);
  const visionAdvancedTriggerRef = useRef<HTMLButtonElement>(null);
  const maxValue = maxDraft ?? serverMaxDescriptions;
  const timeoutValue = timeoutDraft ?? serverTimeoutMs;

  const commitMaxDescriptions = (raw = maxValue) => {
    const parsed = parsePositiveInteger(raw);
    if (parsed === undefined) {
      setMaxDraft(raw);
      setMaxInvalid(true);
      return;
    }
    setMaxInvalid(false);
    setMaxDraft(null);
    if (parsed === (sidecar?.vision?.maxDescriptionsPerTurn ?? VISION_MAX_DESCRIPTIONS_DEFAULT)) return;
    void saveSidecar(visionMaxDescriptionsPatch(parsed));
  };

  const commitTimeout = (raw = timeoutValue) => {
    const parsed = parseVisionTimeoutMs(raw);
    if (parsed === undefined) {
      setTimeoutDraft(raw);
      setTimeoutInvalid(true);
      return;
    }
    setTimeoutInvalid(false);
    setTimeoutDraft(null);
    if (parsed === (sidecar?.vision?.timeoutMs ?? VISION_TIMEOUT_MS_DEFAULT)) return;
    void saveSidecar(visionTimeoutPatch(parsed));
  };

  return (
    <SettingsSection id="proxy-sidecars" title={t("proxyV2.secSidecars")} lede={t("proxyV2.secSidecarsLede")}>
      {/* Both sidecar rows keep the delegation shell: copy left, a shared control band right
          (styles-dashboard-workspace.css pins the band so the two model pickers line up). */}
      <div className="pv2-row dash-delegation-summary dash-sidecar-row-card" aria-busy={!sidecar || undefined}>
        <div className="dash-sidecar-copy">
          <div className="pv2-row-label">{t("dash.webSearchSidecar")}</div>
          <div className="muted setting-hint">{t("dash.webSearchSidecarHint")}</div>
          {/* The switch is stored even when Codex's own key was not rewritten. Saying nothing
              here would read as "the native tool is off now", which is exactly the state the
              operator asked for and may not have. */}
          {sidecarCodexWritePending(sidecarCodexApply) && (
            <div className="notice-warn" role="status">
              <IconAlert />
              <span>{t("dash.webSearchCodexSync")}</span>
            </div>
          )}
        </div>
        <div className="dash-delegation-controls">
          <div className="dash-sidecar-select-row">
            <Select
              value={webSearchModel}
              options={[{ value: "", label: t("dash.webSearchOff") }, ...sidecarModels]}
              onChange={model => {
                if (model === "") {
                  void saveSidecar(webSearchEnabledPatch(false));
                  return;
                }
                const patch: SidecarPatch = { webSearch: webSearchSidecarSelectionForModel(models, sidecarModels, model) };
                // Choosing a model is the activation control: turning the sidecar back on from Off.
                if (!webSearchEnabled) patch.webSearch = { ...patch.webSearch, enabled: true };
                void saveSidecar(patch);
              }}
              disabled={!sidecar || sidecarSaving}
              label={t("dash.sidecarModel")}
              align="right"
            />
          </div>
          {sidecar && webSearchBackend === "anthropic" && (
            <div className="dash-sidecar-trailing-row">
              <Select value={sidecar.webSearch.anthropicInstance ?? ""} label={t("sidecar.pool")}
                options={[
                  { value: "", label: t("sidecar.poolCurrent") },
                  { value: "anthropic", label: t("sidecar.poolA") },
                  { value: "anthropic2", label: t("sidecar.poolB") },
                ]}
                disabled={sidecarSaving} align="right"
                onChange={value => { void saveSidecar({ webSearch: {
                  anthropicInstance: value === "anthropic" || value === "anthropic2" ? value : null,
                } }); }} />
              {sidecar.webSearch.anthropicPool?.mixed && <span className="muted setting-hint">{t("sidecar.poolMixed")}</span>}
            </div>
          )}
          <div className="dash-sidecar-trailing-row" title={t("dash.webSearchStreamHint")}>
            <span className="muted setting-hint dash-sidecar-toggle-label">{t("dash.webSearchStream")}</span>
            <button
              type="button"
              className={`switch ${sidecar?.webSearch?.streamRoutedModelOutput ? "on" : ""}`}
              onClick={() => {
                void saveSidecar({ webSearch: { streamRoutedModelOutput: !sidecar?.webSearch?.streamRoutedModelOutput } });
              }}
              disabled={!webSearchEnabled || !sidecar || sidecarSaving}
              aria-label={t("dash.webSearchStream")}
              aria-pressed={sidecar?.webSearch?.streamRoutedModelOutput === true}
            >
              <span className="knob" />
            </button>
          </div>
        </div>
      </div>

      <div className="pv2-row dash-delegation-summary dash-sidecar-row-card dash-vision-sidecar-card" aria-busy={!sidecar || undefined}>
        <div className="dash-sidecar-copy">
          <div className="pv2-row-label">{t("dash.visionSidecar")}</div>
          <div className="muted setting-hint">{t("dash.visionSidecarHint")}</div>
        </div>
        <div className="dash-delegation-controls">
          <div className="dash-sidecar-select-row">
            <Select
              value={visionModel}
              options={[{ value: "", label: t("dash.visionOff") }, ...visionModels]}
              onChange={model => {
                if (model === "") {
                  void saveSidecar(visionEnabledPatch(false));
                  return;
                }
                const ladder = visionReasoningLadder(models, model);
                const reasoning = clampVisionReasoningToLadder(ladder, visionReasoning);
                const patch: SidecarPatch = { vision: { model, backend: visionSidecarBackendForModel(models, visionModels, model), reasoning } };
                // Choosing a model is the activation control: turning Vision back on from Off.
                if (!visionEnabled) patch.vision = { ...patch.vision, enabled: true };
                void saveSidecar(patch);
              }}
              disabled={!sidecar || sidecarSaving}
              label={t("dash.sidecarModel")}
            />
            <Select
              value={visionReasoning}
              // Raw wire value (low…max), matching the delegation panel's bare `high`.
              options={visionReasoningOptionsFor(visionLadder, visionReasoning)
                .map(value => ({ value, label: value }))}
              onChange={reasoning => {
                void saveSidecar(visionReasoningPatch(reasoning as typeof visionReasoning));
              }}
              disabled={!visionEnabled || !sidecar || sidecarSaving}
              align="right"
              label={`${t("dash.visionSidecar")} — ${t("dash.injectionEffortLabel")}`}
            />
          </div>
          {sidecar && visionBackend === "anthropic" && (
            <div className="dash-sidecar-trailing-row">
              <Select value={sidecar.vision.anthropicInstance ?? ""} label={t("sidecar.pool")}
                options={[
                  { value: "", label: t("sidecar.poolCurrent") },
                  { value: "anthropic", label: t("sidecar.poolA") },
                  { value: "anthropic2", label: t("sidecar.poolB") },
                ]}
                disabled={sidecarSaving} align="right"
                onChange={value => { void saveSidecar({ vision: {
                  anthropicInstance: value === "anthropic" || value === "anthropic2" ? value : null,
                } }); }} />
              {sidecar.vision.anthropicPool?.mixed && <span className="muted setting-hint">{t("sidecar.poolMixed")}</span>}
            </div>
          )}
          <div className="dash-sidecar-trailing-row">
            <button
              type="button"
              ref={visionAdvancedTriggerRef}
              className="dash-vision-advanced-trigger"
              onClick={() => setVisionAdvancedOpen(open => !open)}
              disabled={!visionEnabled || !sidecar || sidecarSaving}
              aria-expanded={visionAdvancedOpen}
              aria-haspopup="dialog"
              aria-controls="dash-vision-advanced-popover"
            >
              <span>{t("dash.visionAdvanced")}</span>
              <IconChevron width={12} height={12} aria-hidden="true" style={{ transform: visionAdvancedOpen ? "rotate(90deg)" : "none", transition: "transform .12s" }} />
            </button>
          </div>
        </div>
        {createPortal(
          <VisionAdvancedPopover
            t={t}
            open={visionAdvancedOpen}
            triggerRef={visionAdvancedTriggerRef}
            onClose={() => setVisionAdvancedOpen(false)}
            maxValue={maxValue}
            maxInvalid={maxInvalid}
            timeoutValue={timeoutValue}
            timeoutInvalid={timeoutInvalid}
            disabled={!visionEnabled || !sidecar || sidecarSaving}
            setMaxDraft={setMaxDraft}
            setMaxInvalid={setMaxInvalid}
            setTimeoutDraft={setTimeoutDraft}
            setTimeoutInvalid={setTimeoutInvalid}
            commitMaxDescriptions={commitMaxDescriptions}
            commitTimeout={commitTimeout}
          />,
          document.body,
        )}
      </div>

      <SettingsRow
        className="dash-shadow-row"
        busy={!shadowCall}
        label={t("dash.shadowCallIntercept")}
        hint={t("proxyV2.shadowShort")}
        help={(
          <HelpButton
            buttonRef={shadowCallHelpTriggerRef}
            label={t("dash.shadowCallIntercept")}
            expanded={shadowCallHelpOpen}
            controls="shadow-call-help-dialog"
            popup="dialog"
            onClick={() => setShadowCallHelpOpen(open => !open)}
          />
        )}
        badge={<code className="dash-shadow-badge rounded-[6px] bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">{`⚠ ${shadowBackgroundModelBadge(shadowCall?.sourceModels, shadowMemoryLabel)}`}</code>}
        control={(
          <div className="flex items-center gap-2">
            <Select
              value={shadowCall?.model ?? ""}
              options={shadowCallModelOptions(models, shadowCall?.model, shadowCall?.sourceModels).map(option => option.value === "" ? option : { ...option, label: formatNamespacedModelId(option.value, t) })}
              onChange={v => { void saveShadowCall({ model: v }); }}
              disabled={!shadowCall || shadowCallSaving || !shadowCall?.enabled}
              label={t("dash.shadowCallModel")}
              align="right"
              fullWidth
              className={MODEL_FIELD}
            />
            <button
              type="button"
              className={`switch ${shadowCall?.enabled ? "on" : ""}`}
              onClick={() => saveShadowCall({ enabled: !shadowCall?.enabled })}
              disabled={!shadowCall || shadowCallSaving}
              aria-label={t("dash.shadowCallIntercept")}
              aria-pressed={shadowCall?.enabled ?? false}
            >
              <span className="knob" />
            </button>
          </div>
        )}
      >
        <ShadowCallSourceToggles
          className="dash-shadow-sources"
          options={shadowCall?.sourceModelOptions}
          sourceModels={shadowCall?.sourceModels}
          disabled={!shadowCall?.enabled}
          saving={shadowCallSaving}
          onChange={sourceModels => void saveShadowCall({ sourceModels })}
        />
        {shadowCallError && (
          <div className="notice notice-err" role="alert">
            <IconAlert /><span>{shadowCallError}</span>
          </div>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
