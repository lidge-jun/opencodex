import { IconAlert, IconInfo, IconRefresh } from "../icons";
import { Trans } from "../i18n/provider";
import { Select } from "../ui";
import { navigateHash } from "../hash-routing";
import { EFFORT_CAP_LEVELS, requireJson, sidecarBackendForModel, updateJobLabel } from "./dashboard-shared";
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
        />
      </div>
    </div>
  );
}

/**
 * Delegation row: pick the model (and effort) inline, with a link to the rest.
 *
 * The two switches moved to the Subagents tab, which is where the roster they affect lives.
 * The model pick stays: it is the same shape as the sidecar rows below it (label left,
 * dropdown right), and it is the one delegation choice worth changing without leaving the
 * status page.
 */
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
            ...injectionAvailable.map(m => ({ value: m.namespaced, label: `${m.provider} / ${m.model}` })),
          ]}
          onChange={(v) => { void saveInjection({ model: v || null, effort: injectionEffort || null }); }}
          disabled={injectionSaving}
          label={t("dash.injectionLabel")}
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
          />
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => navigateHash("#subagents")}
        >
          {t("dash.injectionManage")}
        </button>
      </div>
    </div>
  );
}

export function DashboardMaintenancePanel({ d }: { d: Dash }) {
  const {
    t, runSync, syncing, updateTriggerRef, openUpdateDialog, updateLoading, updateOpen,
    syncResult, syncError, updateJob, reconnecting,
  } = d;

  return (
    <div className="panel maintenance-panel">
      <div className="spread maintenance-head">
        <div>
          <div className="font-semibold">{t("dash.syncModels")}</div>
          <div className="muted text-control" style={{ marginTop: 3 }}>{t("dash.syncModelsHint")}</div>
        </div>
        <div className="maintenance-actions">
          <button type="button" className="btn btn-ghost" onClick={runSync} disabled={syncing}>
            <IconRefresh /> {syncing ? t("dash.syncing") : t("dash.syncRun")}
          </button>
          {/*
            The update flow lives in the sidebar footer, which reports whether one is waiting
            and is reachable from every page. A second button here duplicated it without
            adding that signal. The trigger stays as a zero-size anchor so the deep link
            (`#dashboard/update`) still has something to open against and the dialog has a
            focus target to return to on close.
          */}
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
      {syncResult && (
        <div className={`notice ${syncResult.nativeSubagentDefaultsWarning ? "notice-warn" : "notice-ok"} maintenance-notice`} role="status">
          {syncResult.nativeSubagentDefaultsWarning ? <IconAlert /> : <IconRefresh />}
          <span>
            {t("dash.syncOk", { count: syncResult.added })}
            {syncResult.warning ? ` ${syncResult.warning}` : ""}
            {syncResult.nativeSubagentDefaultsWarning ? ` ${syncResult.nativeSubagentDefaultsWarning}` : ""}
            {syncResult.staleAppServerHint ? <>{" "}<Trans k="dash.syncStaleHint" cmd="ocx sync --restart-codex" /></> : null}
          </span>
        </div>
      )}
      {syncError && (
        <div className="notice notice-err maintenance-notice" role="status">
          <IconAlert /><span>{t("dash.syncFailed", { error: syncError })}</span>
        </div>
      )}
      {updateJob && (
        <div className={`notice ${updateJob.status === "failed" ? "notice-err" : "notice-ok"} maintenance-notice`} role="status">
          {updateJob.status === "failed" ? <IconAlert /> : <IconRefresh />}
          <span>
            {updateJobLabel(updateJob.status, t)}
            {updateJob.latestVersion ? ` ${updateJob.currentVersion} -> ${updateJob.latestVersion}.` : ""}
            {reconnecting ? ` ${t("dash.updateReconnecting")}` : ""}
            {updateJob.error ? ` ${updateJob.error}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

export function DashboardSidecarPanels({ d }: { d: Dash }) {
  const {
    t, settings, settingsSaving, toggleCodexAutoStart,
    sidecar, sidecarSaving, sidecarModels, models, saveSidecar,
    shadowCall, shadowCallSaving, shadowCallHelpTriggerRef, shadowCallHelpOpen, setShadowCallHelpOpen, saveShadowCall,
  } = d;

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
        <div className="panel dash-sidecar-card" aria-busy={!sidecar || undefined}>
          <div className="dash-sidecar-card__row">
            <div className="font-semibold">{t("dash.webSearchSidecar")}</div>
            <Select
              value={sidecar?.webSearch.model ?? "gpt-5.6-luna"}
              options={sidecarModels}
              onChange={model => { void saveSidecar({ webSearch: { model, backend: sidecarBackendForModel(models, model) } }); }}
              disabled={!sidecar || sidecarSaving}
              label={t("dash.sidecarModel")}
            />
          </div>
          <div className="muted setting-hint">{t("dash.webSearchSidecarHint")}</div>
        </div>

        <div className="panel dash-sidecar-card" aria-busy={!sidecar || undefined}>
          <div className="dash-sidecar-card__row">
            <div className="font-semibold">{t("dash.visionSidecar")}</div>
            <Select
              value={sidecar?.vision.model ?? "gpt-5.6-luna"}
              options={sidecarModels}
              onChange={model => { void saveSidecar({ vision: { model, backend: sidecarBackendForModel(models, model) } }); }}
              disabled={!sidecar || sidecarSaving}
              label={t("dash.sidecarModel")}
            />
          </div>
          <div className="muted setting-hint">{t("dash.visionSidecarHint")}</div>
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
              options={[{ value: "", label: "—" }, ...models.map(m => ({ value: m.id, label: `${m.provider}/${m.id}` }))]}
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
