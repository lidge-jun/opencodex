import CompactionRoutingPanel from "../components/CompactionRoutingPanel";
import MemoryObservabilityCard from "../components/MemoryObservabilityCard";
import type { useDashboardData } from "./use-dashboard-data";
import {
  DashboardEffortCapPanel,
  DashboardInjectionPanel,
  DashboardMaintenancePanel,
  DashboardSidecarPanels,
} from "./dashboard-overview-sections";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardOverviewPanels(props: Dash) {
  return (
    <>
      <DashboardEffortCapPanel apiBase={props.apiBase} d={props} />
      <div className="dash-overview-tools">
        <DashboardInjectionPanel apiBase={props.apiBase} d={props} />
        <DashboardMaintenancePanel d={props} />
      </div>
      <DashboardSidecarPanels d={props} />
      <CompactionRoutingPanel apiBase={props.apiBase} models={props.models} />
      <MemoryObservabilityCard apiBase={props.apiBase} />
    </>
  );
}
