import { useI18n } from "../i18n/shared";
import type { CodexRestartController } from "../use-codex-restart";
import type { AppServerStateOutcome } from "../codex-app-server-state";

/**
 * Shown only when the proxy says a running Codex app-server predates the current
 * catalog. `fresh`, `not_running`, `unknown`, and a failed reading all render
 * nothing: telling a user "we could not tell" on a page about models is noise, and
 * the sidebar control stays available regardless.
 *
 * The banner owns no transport, no pending state, and no refresh logic. The page
 * passes one controller whose `onSettled` already re-reads staleness, so this
 * button, the page-head button, and the sidebar button all clear the banner the
 * same way.
 */
export function CodexStaleBanner(props: {
  state: AppServerStateOutcome["state"];
  controller: CodexRestartController;
}) {
  const { t } = useI18n();
  if (props.state !== "stale") return null;
  return (
    <div className="codex-stale-banner" role="status">
      <span className="codex-stale-banner-text">{t("models.staleBanner")}</span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={props.controller.restarting}
        onClick={() => { void props.controller.restart(); }}
      >
        {props.controller.restarting ? t("dash.codexRestarting") : t("dash.codexRestart")}
      </button>
    </div>
  );
}

