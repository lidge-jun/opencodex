import MemoryObservabilityCard from "../components/MemoryObservabilityCard";
import { useT } from "../i18n/shared";
import type { useDashboardData } from "./use-dashboard-data";
import {
  DashboardMaintenancePanel,
  DashboardSidecarPanels,
} from "./dashboard-overview-sections";

type Dash = ReturnType<typeof useDashboardData>;

export function DashboardOverviewPanels(props: Dash) {
  const t = useT();
  return (
    <>
      <DashboardMaintenancePanel d={props} />
      {/*
        Web-search and vision sidecars are routing configuration, not health. They stay on
        the dashboard (there is no better home yet) but closed by default, so the first
        viewport is the state of the proxy rather than two model pickers.
      */}
      <details className="panel dash-sidecars">
        <summary className="font-semibold">{t("dash.sidecars")}</summary>
        <DashboardSidecarPanels d={props} />
      </details>
      <MemoryObservabilityCard apiBase={props.apiBase} />
    </>
  );
}
