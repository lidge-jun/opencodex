import { IconAlert, IconRefresh, IconX } from "../icons";
import { EmptyState, Select } from "../ui";
import {
  updateReasonLabel,
  type UpdateChannel,
} from "./dashboard-shared";
import type { useDashboardData } from "./use-dashboard-data";
import { shadowSourceModelLabel } from "./shadow-call-source";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardDialogs(d: Dash) {
  const {
    t,
    updateOpen, closeUpdateDialog, updateDialogRef,
    updateChannel, changeUpdateChannel, updateLoading, updateError, updateCheck,
    fetchUpdateCheck, updateRestart, setUpdateRestart, runUpdate,
    maHelpOpen, setMaHelpOpen, maHelpDialogRef,
    effortCapHelpOpen, setEffortCapHelpOpen, effortCapHelpDialogRef,
    shadowCallHelpOpen, setShadowCallHelpOpen, shadowCallHelpDialogRef,
    shadowCall,
  } = d;

  return (
    <>
      <dialog
        ref={updateDialogRef}
        id="dashboard-update-dialog"
        className="modal-overlay"
        style={{ display: updateOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
        aria-labelledby="update-title"
        onCancel={event => { event.preventDefault(); closeUpdateDialog(); }}
      >
        <div className="modal-card">
          <div className="modal-head">
            <h3 id="update-title">{t("dash.updateTitle")}</h3>
            <button type="button" className="btn btn-ghost btn-icon" onClick={closeUpdateDialog} aria-label={t("common.cancel")}>
              <IconX />
            </button>
          </div>
          <div className="modal-desc">{t("dash.updateDesc")}</div>
          <div className="update-row">
            <label className="field-label" htmlFor="update-channel">{t("dash.updateChannel")}</label>
            <Select
              value={updateChannel}
              options={[{ value: "latest", label: "latest" }, { value: "preview", label: "preview" }]}
              onChange={v => changeUpdateChannel(v as UpdateChannel)}
              disabled={updateLoading}
              label={t("dash.updateChannel")}
              portal={false}
            />
          </div>
          {updateLoading && <EmptyState className="update-empty" icon={<span className="spin" />} title={t("dash.updateChecking")} />}
          {updateError && (
            <div className="notice notice-err" role="status"><IconAlert /><span>{updateError}</span></div>
          )}
          {updateCheck && !updateLoading && (
            <div className="update-box">
              <div className="spread">
                <div>
                  <div className="muted text-label">{t("dash.updateInstalled")}</div>
                  <div className="mono">{updateCheck.currentVersion}</div>
                </div>
                <div>
                  <div className="muted text-label">{t("dash.updateLatest")}</div>
                  <div className="mono">{updateCheck.latestVersion ?? "—"}</div>
                </div>
                <span className={`badge ${updateCheck.updateAvailable ? "badge-green" : "badge-muted"}`}>
                  {updateCheck.updateAvailable ? t("dash.updateAvailable") : t("dash.updateCurrent")}
                </span>
              </div>
              <div className="muted update-command">{t("dash.updateCommand")} <code className="chip">{updateCheck.command}</code></div>
              {updateCheck.reason === "source_checkout" && (
                <div className="notice-warn" role="status"><IconAlert /> {t("dash.updateSource")}</div>
              )}
              {updateCheck.reason === "latest_unavailable" && (
                <div className="notice-warn" role="status">
                  <IconAlert /> {t("dash.updateUnavailable")}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={updateLoading}
                    onClick={() => { void fetchUpdateCheck(updateChannel, true); }}
                    style={{ marginLeft: 12 }}
                  >
                    <IconRefresh /> {t("dash.updateRetry")}
                  </button>
                </div>
              )}
              {!updateCheck.canUpdate && updateCheck.reason !== "latest_unavailable" && updateCheck.reason !== "source_checkout" && (
                <div className="update-recheck">
                  <span className="muted update-recheck-reason">
                    {t("dash.updateCannotAuto", { reason: updateReasonLabel(updateCheck.reason, t) })}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={updateLoading}
                    onClick={() => { void fetchUpdateCheck(updateChannel, true); }}
                  >
                    <IconRefresh /> {updateLoading ? t("dash.updateChecking") : t("dash.updateRecheck")}
                  </button>
                </div>
              )}
              {updateCheck.canUpdate && (
                <div className="spread update-restart">
                  <div>
                    <div className="font-semibold">{t("dash.updateRestart")}</div>
                    <div className="muted text-label">{t("dash.updateRestartHint")}</div>
                  </div>
                  <button
                    type="button"
                    className={`switch ${updateRestart ? "on" : ""}`}
                    onClick={() => setUpdateRestart(v => !v)}
                    aria-label={t("dash.updateRestart")}
                    aria-pressed={updateRestart}
                  >
                    <span className="knob" />
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={closeUpdateDialog}>{t("common.cancel")}</button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={runUpdate}
              disabled={!updateCheck?.canUpdate || updateLoading}
            >
              {t("dash.runUpdate")}
            </button>
          </div>
        </div>
      </dialog>

      <dialog
        ref={maHelpDialogRef}
        id="multi-agent-help-dialog"
        className="modal-overlay"
        style={{ display: maHelpOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
        aria-labelledby="multi-agent-help-title"
        onCancel={event => { event.preventDefault(); setMaHelpOpen(false); }}
      >
        <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={() => setMaHelpOpen(false)} />
        <div className="modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <h3 id="multi-agent-help-title">{t("dash.multiAgent")}</h3>
            <button type="button" className="btn btn-ghost btn-icon" onClick={() => setMaHelpOpen(false)} aria-label={t("common.close")}><IconX /></button>
          </div>
          <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
            {t("models.v2Help")}
          </div>
          <div style={{ marginTop: 12 }}>
            <a className="text-control" href="https://opencodex.me/guides/sub-agent-surface/" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              {t("models.v2DocsLink")}
            </a>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={() => setMaHelpOpen(false)}>{t("common.ok")}</button>
          </div>
        </div>
      </dialog>

      <dialog
        ref={effortCapHelpDialogRef}
        id="effort-cap-help-dialog"
        className="modal-overlay"
        style={{ display: effortCapHelpOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
        aria-labelledby="effort-cap-help-title"
        onCancel={event => { event.preventDefault(); setEffortCapHelpOpen(false); }}
      >
        <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={() => setEffortCapHelpOpen(false)} />
        <div className="modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <h3 id="effort-cap-help-title">{t("dash.effortCapLabel")}</h3>
            <button type="button" className="btn btn-ghost btn-icon" onClick={() => setEffortCapHelpOpen(false)} aria-label={t("common.close")}><IconX /></button>
          </div>
          <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
            {t("dash.effortCapHelp")}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={() => setEffortCapHelpOpen(false)}>{t("common.ok")}</button>
          </div>
        </div>
      </dialog>

      <dialog
        ref={shadowCallHelpDialogRef}
        id="shadow-call-help-dialog"
        className="modal-overlay"
        style={{ display: shadowCallHelpOpen ? "flex" : "none", border: "none", margin: 0, maxWidth: "none", maxHeight: "none", width: "100%", height: "100%" }}
        aria-labelledby="shadow-call-help-title"
        onCancel={event => { event.preventDefault(); setShadowCallHelpOpen(false); }}
      >
        <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={() => setShadowCallHelpOpen(false)} />
        <div className="modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <h3 id="shadow-call-help-title">{t("dash.shadowCallIntercept")}</h3>
            <button type="button" className="btn btn-ghost btn-icon" onClick={() => setShadowCallHelpOpen(false)} aria-label={t("common.close")}><IconX /></button>
          </div>
          <div className="modal-desc leading-relaxed" style={{ whiteSpace: "pre-line" }}>
            {t("dash.shadowCallTooltip", { models: shadowSourceModelLabel(shadowCall?.sourceModels) })}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={() => setShadowCallHelpOpen(false)}>{t("common.ok")}</button>
          </div>
        </div>
      </dialog>
    </>
  );
}
