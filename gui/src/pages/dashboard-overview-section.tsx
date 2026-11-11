import { DashboardOverviewHead } from "./dashboard-overview-head";
import { DashboardOverviewPanels } from "./dashboard-overview-panels";
import { PROXY_SECTION_IDS } from "./dashboard-section-ids";
import type { useDashboardData } from "./use-dashboard-data";
import { SectionIndex } from "@/components/v2-proxy/section-index";

type Dash = ReturnType<typeof useDashboardData>;

/*
 * Proxy details overview: the state strip, then the expert settings as titled sections with a
 * sticky index beside them (a scrolling strip above them on narrow screens).
 */
export function DashboardOverviewSection({ readOnly = false, ...d }: Dash & { readOnly?: boolean }) {
  const items = PROXY_SECTION_IDS.map(([id, key]) => ({ id, label: d.t(key) }));
  return (
    <div className="dash-overview-stack">
      <DashboardOverviewHead {...d} />
      <div className="pv2-overview-grid grid min-w-0 gap-5 lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
        <SectionIndex items={items} label={d.t("proxyV2.indexLabel")}
          className="lg:sticky lg:top-4 lg:self-start" />
        <div className="flex min-w-0 flex-col gap-5">
          <DashboardOverviewPanels {...d} readOnly={readOnly} />
        </div>
      </div>
    </div>
  );
}
