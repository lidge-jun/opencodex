import { DashboardOverviewHead } from "./dashboard-overview-head";
import { DashboardOverviewPanels } from "./dashboard-overview-panels";
import type { useDashboardData } from "./use-dashboard-data";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardOverviewSection(d: Dash) {
  return (
    <div className="dash-overview-stack">
      <DashboardOverviewHead {...d} />
      <DashboardOverviewPanels {...d} />
    </div>
  );
}
