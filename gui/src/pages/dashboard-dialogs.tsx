import { IconAlert, IconRefresh, IconX } from "../icons";
import { EmptyState, Select } from "../ui";
import { GithubStarButton } from "../components/github-star-button";
import {
  updateReasonLabel,
  type UpdateChannel,
} from "./dashboard-shared";
import type { useDashboardData } from "./use-dashboard-data";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardDialogs(d: Dash) {
  const {
    t,
    updateOpen, closeUpdateDialog, updateDialogRef,
    updateChannel, changeUpdateChannel, updateLoading, updateError, updateCheck,
    fetchUpdateCheck, updateRestart, setUpdateRestart, runUpdate,
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
            {/*
              Mounted only while the dialog is open (the <dialog> itself is always in the
              tree and only toggles display), so the star poll runs only while the user is
              looking at the project's own screen.
            */}
            {updateOpen && <GithubStarButton apiBase={d.apiBase} />}
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
    </>
  );
}
