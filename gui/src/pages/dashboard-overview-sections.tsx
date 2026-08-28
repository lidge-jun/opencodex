import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { IconAlert, IconCheck, IconChevron, IconInfo, IconRefresh, IconX } from "../icons";
import { Trans } from "../i18n/provider";
import type { TFn } from "../i18n/shared";
import { Select } from "../ui";
import { computeSelectMenuStyle } from "../select-position";
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
  visionEnabledPatch,
  visionMaxDescriptionsPatch,
  visionReasoningLadder,
  visionReasoningOptionsFor,
  visionReasoningPatch,
  visionSidecarBackendForModel,
  visionTimeoutPatch,
  VISION_MAX_DESCRIPTIONS_DEFAULT,
  VISION_TIMEOUT_MS_DEFAULT,
  VISION_TIMEOUT_MS_MAX,
  VISION_TIMEOUT_MS_MIN,
} from "./dashboard-shared";
import { shadowSourceModelBadge } from "./shadow-call-source";
import type { useDashboardData } from "./use-dashboard-data";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardEffortCapPanel({ apiBase, d }: { apiBase: string; d: Dash }) {
  const {
    t, maMode, maModeResolved,
    effortCapHelpTriggerRef, effortCapHelpOpen, setEffortCapHelpOpen,
    effortCap, subagentEffortCap, effortCapSaving, setEffortCap, setSubagentEffortCap, setEffortCapSaving,
  } = d;

  if (!maModeResolved || maMode === "v1") return null;

  return (
    <div className="panel">
      <div className="injection-head">
        <span className="injection-label" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {t("dash.effortCapLabel")}
          <button
            ref={effortCapHelpTriggerRef}
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ width: 22, height: 22, minWidth: 22, padding: 0, borderRadius: "var(--radius-pill)", color: "var(--muted)" }}
            onClick={() => setEffortCapHelpOpen(open => !open)}
            aria-label={t("dash.effortCapLabel")}
            aria-expanded={effortCapHelpOpen}
            aria-haspopup="dialog"
            aria-controls="effort-cap-help-dialog"
          >
            <IconInfo width={13} height={13} aria-hidden="true" />
          </button>
        </span>
        <Select
          value={effortCap}
          options={[
            { value: "", label: t("dash.effortCapNone") },
            ...EFFORT_CAP_LEVELS.map(e => ({ value: e, label: e })),
          ]}
          onChange={async (v) => {
            if (effortCapSaving) return;
            setEffortCapSaving(true);
            try {
              const res = await fetch(`${apiBase}/api/effort-caps`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ effortCap: v || null }),
              });
              const data = await requireJson<{ ok: boolean; effortCap?: string | null; subagentEffortCap?: string | null }>(res);
              setEffortCap(data.effortCap ?? "");
              setSubagentEffortCap(data.subagentEffortCap ?? "");
            } catch { /* ignore */ }
            finally { setEffortCapSaving(false); }
          }}
          disabled={effortCapSaving}
          label={t("dash.effortCapLabel")}
          align="right"
        />
        <Select
          value={subagentEffortCap}
          options={[
            { value: "", label: t("dash.effortCapNone") },
            ...EFFORT_CAP_LEVELS.map(e => ({ value: e, label: e })),
          ]}
          onChange={async (v) => {
            if (effortCapSaving) return;
            setEffortCapSaving(true);
            try {
              const res = await fetch(`${apiBase}/api/effort-caps`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ subagentEffortCap: v || null }),
              });
              const data = await requireJson<{ ok: boolean; effortCap?: string | null; subagentEffortCap?: string | null }>(res);
              setEffortCap(data.effortCap ?? "");
              setSubagentEffortCap(data.subagentEffortCap ?? "");
            } catch { /* ignore */ }
            finally { setEffortCapSaving(false); }
          }}
          disabled={effortCapSaving}
          label={t("dash.subagentEffortCapLabel")}
          align="right"
        />
      </div>
    </div>
  );
}

export function DashboardInjectionPanel({ d }: { apiBase: string; d: Dash }) {
  const {
    t, injectionModel, injectionEffort, injectionEfforts, injectionAvailable, injectionSaving,
    saveInjection,
  } = d;

  return (
    <div className="panel dash-delegation-summary">
      <div className="font-semibold">{t("dash.injectionLabel")}</div>
      <div className="dash-delegation-controls">
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
          />
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigateHash("#subagents")}>
          {t("dash.injectionManage")}
        </button>
      </div>
    </div>
  );
}

export function DashboardMaintenancePanel({ d }: { d: Dash }) {
  const {
    t, runSync, syncing, updateTriggerRef, openUpdateDialog, updateLoading, updateOpen,
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
      <div className="panel maintenance-panel">
        <div className="dash-sync-summary">
          <div className="dash-sync-copy">
            <div className="font-semibold">{t("dash.syncModels")}</div>
            <div className="muted text-control dash-sync-hint">{t("dash.syncModelsHint")}</div>
          </div>
          <div className="maintenance-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleRunSync} disabled={syncing}>
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
        </div>
        {updateJob && (
          <div className={`notice ${updateJob.status === "failed" ? "notice-err" : "notice-ok"} maintenance-notice`} role="status">
            {updateJob.status === "failed" ? <IconAlert /> : <IconRefresh />}
            <span>
              {updateJobLabel(updateJob.status, t)}
              {updateJob.latestVersion ? ` ${t("dash.updateVersionTransition", { currentVersion: updateJob.currentVersion, latestVersion: updateJob.latestVersion })}` : ""}
              {reconnecting ? ` ${t("dash.updateReconnecting")}` : ""}
              {updateJob.error ? ` ${updateJob.error}` : ""}
            </span>
          </div>
        )}
      </div>
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

function VisionAdvancedPopover({ t, open, triggerRef, onClose, maxValue, maxInvalid, timeoutValue, timeoutInvalid, disabled, setMaxDraft, setMaxInvalid, setTimeoutDraft, setTimeoutInvalid, commitMaxDescriptions, commitTimeout }: {
  t: TFn;
  open: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  maxValue: string;
  maxInvalid: boolean;
  timeoutValue: string;
  timeoutInvalid: boolean;
  disabled: boolean;
  setMaxDraft: (v: string | null) => void;
  setMaxInvalid: (v: boolean) => void;
  setTimeoutDraft: (v: string | null) => void;
  setTimeoutInvalid: (v: boolean) => void;
  commitMaxDescriptions: (raw?: string) => void;
  commitTimeout: (raw?: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>();

  const reposition = useCallback(() => {
    if (!triggerRef.current) return;

    setStyle(computeSelectMenuStyle(
      triggerRef.current.getBoundingClientRect(),
      {
        align: "right",
        placement: "below",
        menuHeight: panelRef.current?.offsetHeight ?? 180,
      },
    ));
  }, [triggerRef]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onViewportChange = () => reposition();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open, reposition, maxInvalid, timeoutInvalid]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;

      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement && panelRef.current?.contains(activeElement)) {
        activeElement.blur();
      }

      onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, onClose, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, triggerRef]);
  useEffect(() => {
    if (!open) return;
    firstInputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div ref={panelRef} id="dash-vision-advanced-popover" className="dash-vision-advanced-popover" role="dialog" aria-modal="false"
      aria-label={t("dash.visionAdvancedPopover") as string}
      style={{ ...style, zIndex: 60 }}>
      <div className="dash-vision-advanced-popover-title">{t("dash.visionAdvancedPopover")}</div>
      <label className="dash-vision-number">
        <span className="muted setting-hint" id="dash-vision-max-label">{t("dash.visionMaxDescriptions")}</span>
        <span className="codex-auto-switch-input-wrap">
          <input
            ref={firstInputRef}
            className="input mono codex-auto-switch-input"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={maxValue}
            disabled={disabled}
            aria-invalid={maxInvalid || undefined}
            aria-label={t("dash.visionMaxDescriptions")}
            aria-describedby={maxInvalid ? "dash-vision-max-error dash-vision-max-label" : "dash-vision-max-label"}
            onChange={event => {
              setMaxInvalid(false);
              setMaxDraft(event.target.value);
            }}
            onBlur={event => commitMaxDescriptions(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || disabled) return;
              if (event.key === "Enter") {
                event.preventDefault();
                commitMaxDescriptions(event.currentTarget.value);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setMaxDraft(null);
                setMaxInvalid(false);
              }
            }}
          />
        </span>
        {maxInvalid && (
          <span id="dash-vision-max-error" className="muted setting-hint" role="alert">
            {t("dash.visionMaxDescriptionsInvalid")}
          </span>
        )}
      </label>
      <label className="dash-vision-number">
        <span className="muted setting-hint" id="dash-vision-timeout-label">{t("dash.visionTimeout")}</span>
        <span className="codex-auto-switch-input-wrap">
          <input
            className="input mono codex-auto-switch-input"
            type="number"
            min={VISION_TIMEOUT_MS_MIN}
            max={VISION_TIMEOUT_MS_MAX}
            step={1000}
            inputMode="numeric"
            value={timeoutValue}
            disabled={disabled}
            aria-invalid={timeoutInvalid || undefined}
            aria-label={t("dash.visionTimeout")}
            aria-describedby={timeoutInvalid ? "dash-vision-timeout-error dash-vision-timeout-label" : "dash-vision-timeout-label"}
            onChange={event => {
              setTimeoutInvalid(false);
              setTimeoutDraft(event.target.value);
            }}
            onBlur={event => commitTimeout(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || disabled) return;
              if (event.key === "Enter") {
                event.preventDefault();
                commitTimeout(event.currentTarget.value);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setTimeoutDraft(null);
                setTimeoutInvalid(false);
              }
            }}
          />
          <span className="codex-auto-switch-unit" aria-hidden="true">ms</span>
        </span>
        {timeoutInvalid && (
          <span id="dash-vision-timeout-error" className="muted setting-hint" role="alert">
            {t("dash.visionTimeoutInvalid", { min: VISION_TIMEOUT_MS_MIN, max: VISION_TIMEOUT_MS_MAX })}
          </span>
        )}
      </label>
    </div>
  );
}

export function DashboardSidecarPanels({ d }: { d: Dash }) {
  const {
    t, settings, settingsSaving, toggleCodexAutoStart,
    sidecar, sidecarSaving, sidecarModels, visionModels, models, saveSidecar,
    shadowCall, shadowCallSaving, shadowCallHelpTriggerRef, shadowCallHelpOpen, setShadowCallHelpOpen, saveShadowCall,
  } = d;
  const visionEnabled = sidecar?.vision.enabled !== false;
  const visionModel = visionEnabled ? (sidecar?.vision.model ?? "gpt-5.4-mini") : "";
  const persistedVisionReasoning = sidecar?.vision.reasoning ?? "low";
  const visionLadder = visionReasoningLadder(models, visionModel);
  const visionReasoning = clampVisionReasoningToLadder(visionLadder, persistedVisionReasoning);
  const serverMaxDescriptions = String(sidecar?.vision.maxDescriptionsPerTurn ?? VISION_MAX_DESCRIPTIONS_DEFAULT);
  const serverTimeoutMs = String(sidecar?.vision.timeoutMs ?? VISION_TIMEOUT_MS_DEFAULT);
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
    if (parsed === (sidecar?.vision.maxDescriptionsPerTurn ?? VISION_MAX_DESCRIPTIONS_DEFAULT)) return;
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
    if (parsed === (sidecar?.vision.timeoutMs ?? VISION_TIMEOUT_MS_DEFAULT)) return;
    void saveSidecar(visionTimeoutPatch(parsed));
  };

  return (
    <>
      <div className="panel">
        <div className="spread">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="font-semibold">{t("dash.codexAutoStart")}</div>
            <div className="muted setting-hint">{t("dash.codexAutoStartHint")}</div>
          </div>
          <button
            type="button"
            className={`switch ${settings?.codexAutoStart ?? true ? "on" : ""}`}
            onClick={toggleCodexAutoStart}
            disabled={!settings || settingsSaving}
            aria-label={t("dash.codexAutoStart")}
            aria-pressed={settings?.codexAutoStart ?? true}
          >
            <span className="knob" />
          </button>
        </div>
      </div>

      <div className="dash-sidecar-grid">
        {/* Both sidecar cards wear the DashboardInjectionPanel shell: the PANEL is
            the flex row, copy left, controls right. */}
        <div className="panel dash-delegation-summary dash-sidecar-row-card" aria-busy={!sidecar || undefined}>
          <div className="dash-sidecar-copy">
            <div className="font-semibold">{t("dash.webSearchSidecar")}</div>
            <div className="muted setting-hint">{t("dash.webSearchSidecarHint")}</div>
          </div>
          <div className="dash-delegation-controls">
            <Select
              value={sidecar?.webSearch.model ?? "gpt-5.6-luna"}
              options={sidecarModels}
              onChange={model => {
                void saveSidecar({ webSearch: webSearchSidecarSelectionForModel(models, sidecarModels, model) });
              }}
              disabled={!sidecar || sidecarSaving}
              label={t("dash.sidecarModel")}
              align="right"
            />
            <div style={{ display: "flex", alignItems: "center", gap: 8 }} title={t("dash.webSearchStreamHint")}>
              <span className="muted setting-hint">{t("dash.webSearchStream")}</span>
              <button
                type="button"
                className={`switch ${sidecar?.webSearch.streamRoutedModelOutput ? "on" : ""}`}
                onClick={() => {
                  void saveSidecar({ webSearch: { streamRoutedModelOutput: !sidecar?.webSearch.streamRoutedModelOutput } });
                }}
                disabled={!sidecar || sidecarSaving}
                aria-label={t("dash.webSearchStream")}
                aria-pressed={sidecar?.webSearch.streamRoutedModelOutput === true}
              >
                <span className="knob" />
              </button>
            </div>
          </div>
        </div>

        <div className="panel dash-delegation-summary dash-sidecar-row-card dash-vision-sidecar-card" aria-busy={!sidecar || undefined}>
          <div className="dash-sidecar-copy">
            <div className="font-semibold">{t("dash.visionSidecar")}</div>
            <div className="muted setting-hint">{t("dash.visionSidecarHint")}</div>
          </div>
          <div className="dash-delegation-controls">
            <div className="dash-vision-select-row">
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
            <div className="dash-vision-advanced-row">
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
        </div>

      <div className="panel" aria-busy={!shadowCall || undefined}>
        <div className="spread" style={{ alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="font-semibold">{t("dash.shadowCallIntercept")}</span>
            <button
              ref={shadowCallHelpTriggerRef}
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ width: 22, height: 22, minWidth: 22, padding: 0, borderRadius: "var(--radius-pill)", color: "var(--muted)" }}
              onClick={() => setShadowCallHelpOpen(open => !open)}
              aria-label={t("dash.shadowCallIntercept")}
              aria-expanded={shadowCallHelpOpen}
              aria-haspopup="dialog"
              aria-controls="shadow-call-help-dialog"
            >
              <IconInfo width={13} height={13} aria-hidden="true" />
            </button>
            <code className="muted text-caption">{`⚠ ${shadowSourceModelBadge(shadowCall?.sourceModels)}`}</code>
          </div>
          <div className="setting-controls" style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
            <Select
              value={shadowCall?.model ?? ""}
              options={shadowCallModelOptions(models, shadowCall?.model, shadowCall?.sourceModels).map(option => option.value === "" ? option : { ...option, label: formatNamespacedModelId(option.value, t) })}
              onChange={v => { void saveShadowCall({ model: v }); }}
              disabled={!shadowCall || shadowCallSaving || !shadowCall?.enabled}
              label={t("dash.shadowCallModel")}
              align="right"
            />
          </div>
        </div>
      </div>
    </>
  );
}
