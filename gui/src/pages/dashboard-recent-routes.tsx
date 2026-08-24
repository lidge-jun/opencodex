import { useDataSurface } from "../data-surface";
import { navigateHash } from "../hash-routing";
import { useI18n } from "../i18n/shared";
import { EmptyState } from "../ui";

interface RecentRouteEntry {
  requestId?: string;
  timestamp: number;
  model: string;
  requestedModel?: string;
  resolvedModel?: string;
  provider: string;
  status: number;
  attempts?: Array<{ ordinal: number }>;
  routeDecision?: {
    routeKind?: string;
    profile?: { id?: string; revision?: string };
    selected?: { provider?: string; model?: string };
  };
}

interface RecentRoutePage {
  entries: RecentRouteEntry[];
}

export function DashboardRecentRoutes({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const resource = useDataSurface<RecentRoutePage>(
    `dashboard-recent-routes:${apiBase}`,
    [apiBase],
    async signal => {
      const response = await fetch(`${apiBase}/api/request-history?limit=5`, { signal });
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<RecentRoutePage>;
    },
    { isEmpty: page => page.entries.length === 0, pollMs: 10_000 },
  );

  return (
    <section className="panel dashboard-route-evidence" aria-labelledby="dashboard-recent-routes-title">
      <div className="panel-head">
        <div>
          <h3 id="dashboard-recent-routes-title" className="panel-title">{t("dash.routes.title")}</h3>
          <p className="muted text-label dashboard-route-evidence__hint">{t("dash.routes.hint")}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigateHash("logs")}>{t("dash.routes.viewAll")}</button>
      </div>
      {resource.state.showSkeleton ? (
        <div className="dashboard-route-evidence__skeleton" aria-label={t("common.loading")} />
      ) : resource.state.showError ? (
        <EmptyState title={t("dash.routes.unavailable")} />
      ) : resource.data?.entries.length ? (
        <div className="dashboard-route-evidence__list">
          {resource.data.entries.map(entry => {
            const route = entry.routeDecision;
            const selectedProvider = route?.selected?.provider ?? entry.provider;
            const selectedModel = route?.selected?.model ?? entry.resolvedModel ?? entry.model;
            return (
              <button
                type="button"
                className="list-row dashboard-route-evidence__row"
                key={entry.requestId ?? `${entry.timestamp}-${entry.provider}-${entry.model}`}
                onClick={() => navigateHash("logs")}
              >
                <span>
                  <span className="title mono">{entry.requestedModel ?? entry.model} → {selectedProvider}/{selectedModel}</span>
                  <span className="sub">
                    {route
                      ? `${route.routeKind ?? t("dash.routes.unknown")}${route.profile?.id ? ` · ${route.profile.id}` : ""}`
                      : t("dash.routes.unknown")}
                    {(entry.attempts?.length ?? 0) > 0 ? ` · ${t("dash.routes.attempts", { count: entry.attempts!.length })}` : ""}
                  </span>
                </span>
                <span className="dashboard-route-evidence__outcome">
                  <span className={`badge ${entry.status >= 200 && entry.status < 400 ? "badge-green" : "badge-amber"}`}>{entry.status}</span>
                  <span className="muted text-caption">{new Date(entry.timestamp).toLocaleTimeString(locale)}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyState title={t("dash.routes.empty")} />
      )}
    </section>
  );
}
