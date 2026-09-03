import { IconAlert } from "../icons";
import { Trans } from "../i18n/provider";
import { EmptyState } from "../ui";
import { DashboardDialogs } from "./dashboard-dialogs";
import { DashboardOverviewSection } from "./dashboard-overview-section";
import { useDashboardData } from "./use-dashboard-data";

/**
 * The dashboard is one surface: health, the reboot-protection bar, model sync, the sidecar
 * disclosure and memory pressure. It used to carry two more tabs — read-only copies of the
 * Providers and Models pages with no way to act on them — and the settings that have a home
 * elsewhere (subagent mode, delegation model, shadow-call intercept, Codex autostart). Each
 * of those was a second editor for one server value, which is a state-divergence bug
 * waiting to be filed. The old `#dashboard/providers` and `#dashboard/models` bookmarks
 * redirect to the real pages (app-routing.ts).
 */
export default function Dashboard({ apiBase }: { apiBase: string }) {
  const d = useDashboardData(apiBase);
  const { t, error } = d;

  if (error) {
    return (
      <EmptyState style={{ marginTop: 40 }} icon={<IconAlert />}
        title={<span style={{ color: "var(--red)" }}>{t("dash.cannotConnect")}</span>}>
        <Trans k="dash.runStart" cmd="ocx start" />
      </EmptyState>
    );
  }

  return (
    <div className="dashboard-workspace-shell">
      <div className="page-head">
        <h2>{t("nav.dashboard")}</h2>
      </div>
      <section className="dashboard-workspace-main" id="dashboard-panel-overview">
        <DashboardOverviewSection {...d} />
      </section>
      <DashboardDialogs {...d} />
    </div>
  );
}
