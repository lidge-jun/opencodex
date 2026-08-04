import { type ReactNode } from "react";
import { IconAlert } from "../icons";
import { Trans } from "../i18n/provider";
import { navigateHash } from "../hash-routing";
import { EmptyState } from "../ui";
import { DashboardDialogs } from "./dashboard-dialogs";
import { DashboardModelsSection } from "./dashboard-models-section";
import { DashboardOverviewSection } from "./dashboard-overview-section";
import { DashboardProvidersSection } from "./dashboard-providers-section";
import {
  dashboardHashForSection,
  type DashboardSection,
} from "./dashboard-shared";
import { useDashboardData } from "./use-dashboard-data";

function selectDashboardTab(next: DashboardSection) {
  // Deliberate navigation: push a history entry so Back/Forward restore the tab.
  navigateHash(dashboardHashForSection(next));
}

export default function Dashboard({ apiBase }: { apiBase: string }) {
  const d = useDashboardData(apiBase);
  const {
    t, error, selectedSection,
    providers, models, modelsLoading, modelQuery, setModelQuery,
    filteredGroups, expandedProviders, setExpandedProviders,
  } = d;

  if (error) {
    return (
      <EmptyState style={{ marginTop: 40 }} icon={<IconAlert />}
        title={<span style={{ color: "var(--red)" }}>{t("dash.cannotConnect")}</span>}>
        <Trans k="dash.runStart" cmd="ocx start" />
      </EmptyState>
    );
  }

  const overviewSection = <DashboardOverviewSection {...d} />;
  const providersSection = <DashboardProvidersSection t={t} providers={providers} />;
  const modelsSection = (
    <DashboardModelsSection
      t={t}
      models={models}
      modelsLoading={modelsLoading}
      modelQuery={modelQuery}
      setModelQuery={setModelQuery}
      filteredGroups={filteredGroups}
      expandedProviders={expandedProviders}
      setExpandedProviders={setExpandedProviders}
    />
  );
  const updateDialog = <DashboardDialogs {...d} />;

  const sections: { id: DashboardSection; label: string; body: ReactNode }[] = [
    { id: "overview", label: t("dash.workspace.overview"), body: overviewSection },
    { id: "providers", label: t("dash.activeProviders"), body: providersSection },
    { id: "models", label: t("dash.availableModels"), body: modelsSection },
  ];
  const selected = sections.find(s => s.id === selectedSection) ?? sections[0];
  const selectTab = selectDashboardTab;
  const onTabKeyDown = (e: React.KeyboardEvent) => {
    const index = sections.findIndex(s => s.id === selectedSection);
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % sections.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + sections.length) % sections.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = sections.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = sections[next]!;
    selectTab(target.id);
    document.getElementById(`dashboard-tab-${target.id}`)?.focus();
  };

  return (
    <div className="dashboard-workspace-shell">
      <div className="page-head">
        <h2>{t("nav.dashboard")}</h2>
      </div>
      <p className="page-sub">{t("dash.subtitle")}</p>
      <div className="page-tabs" role="tablist" aria-label={t("dash.workspace.sections")}>
        {sections.map(s => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`dashboard-tab-${s.id}`}
            aria-selected={selectedSection === s.id}
            aria-controls={`dashboard-panel-${s.id}`}
            tabIndex={selectedSection === s.id ? 0 : -1}
            className={`page-tab${selectedSection === s.id ? " page-tab--active" : ""}`}
            onClick={() => selectTab(s.id)}
            onKeyDown={onTabKeyDown}
          >
            {s.label}
          </button>
        ))}
      </div>
      <section
        className="dashboard-workspace-main"
        role="tabpanel"
        id={`dashboard-panel-${selected.id}`}
        aria-labelledby={`dashboard-tab-${selected.id}`}
        tabIndex={0}
      >
        {selected.body}
      </section>
      {updateDialog}
    </div>
  );
}
