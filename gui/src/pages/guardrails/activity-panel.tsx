import { EmptyState, Notice, Select } from "../../ui";
import { useT } from "../../i18n/shared";
import { GUARDRAILS_DATA_TYPES, GUARDRAILS_DATA_TYPE_KEYS } from "./constants";
import type {
  GuardrailsActivity,
  GuardrailsActivityFilters,
  GuardrailsMode,
  GuardrailsResult,
  GuardrailsSurface,
} from "./types";

export function GuardrailsActivityPanel({
  activity,
  filters,
  refreshing,
  lastRefreshAt,
  onFiltersChange,
  onRefresh,
}: {
  activity: GuardrailsActivity;
  filters: GuardrailsActivityFilters;
  refreshing: boolean;
  lastRefreshAt: number | null;
  onFiltersChange: (filters: GuardrailsActivityFilters) => void;
  onRefresh: () => void;
}) {
  const t = useT();
  const resultOptions: Array<{ value: GuardrailsResult | ""; label: string }> = [
    { value: "", label: t("guardrails.allResults") },
    { value: "scanned", label: t("guardrails.result.scanned") },
    { value: "masked", label: t("guardrails.result.masked") },
    { value: "detected", label: t("guardrails.result.detected") },
    { value: "blocked", label: t("guardrails.result.blocked") },
    { value: "passthrough", label: t("guardrails.result.passthrough") },
    { value: "demask_warning", label: t("guardrails.result.demaskWarning") },
    { value: "tool_argument_restore_skipped", label: t("guardrails.result.toolSkipped") },
  ];
  const surfaceOptions: Array<{ value: GuardrailsSurface | ""; label: string }> = [
    { value: "", label: t("guardrails.allSurfaces") },
    { value: "responses", label: t("api.protocolResponses") },
    { value: "chat", label: t("api.protocolChatCompletions") },
    { value: "messages", label: t("api.protocolMessages") },
    { value: "compact", label: t("guardrails.surfaceCompact") },
  ];
  const events = activity.events;
  const updateFilter = <K extends keyof GuardrailsActivityFilters>(
    key: K,
    value: GuardrailsActivityFilters[K],
  ) => onFiltersChange({ ...filters, [key]: value });

  return (
    <div className="guardrails-panel-stack">
      <Notice tone="warn">{t("guardrails.activityPrivacy")}</Notice>
      <div className="guardrails-activity-toolbar">
        <Select
          value={filters.surface}
          label={t("guardrails.surface")}
          disabled={refreshing}
          onChange={value => updateFilter("surface", value as GuardrailsSurface | "")}
          options={surfaceOptions}
        />
        <Select
          value={filters.mode}
          label={t("guardrails.mode")}
          disabled={refreshing}
          onChange={value => updateFilter("mode", value as GuardrailsMode | "")}
          options={[
            { value: "", label: t("guardrails.allModes") },
            { value: "enforce", label: t("guardrails.modeEnforce") },
            { value: "detect", label: t("guardrails.modeDetect") },
          ]}
        />
        <Select
          value={filters.result}
          label={t("guardrails.result")}
          disabled={refreshing}
          onChange={value => updateFilter("result", value as GuardrailsResult | "")}
          options={resultOptions}
        />
        <Select
          value={String(filters.category)}
          label={t("guardrails.category")}
          disabled={refreshing}
          onChange={value => updateFilter(
            "category",
            value === "" ? "" : Number(value) as GuardrailsActivityFilters["category"],
          )}
          options={[
            { value: "", label: t("guardrails.allCategories") },
            ...GUARDRAILS_DATA_TYPES.map(value => ({
              value: String(value),
              label: t(GUARDRAILS_DATA_TYPE_KEYS[value]),
            })),
          ]}
        />
        <button type="button" className="btn btn-ghost" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? t("common.loading") : t("guardrails.refresh")}
        </button>
      </div>
      <section className="card guardrails-retention" aria-label={t("guardrails.activitySummary")}>
        <span>{t("guardrails.activityEvents", { count: activity.filteredSummary.eventCount })}</span>
        <span>{t("guardrails.activityFindings", { count: activity.filteredSummary.findingCount })}</span>
        <span>{t("guardrails.activityAverageLatency", {
          value: activity.filteredSummary.averageLatencyMs.toFixed(2),
        })}</span>
        <span>{t("guardrails.activityTopRule", {
          rule: activity.filteredSummary.topRules[0]?.id ?? "—",
        })}</span>
      </section>
      <section className="card guardrails-retention">
        <span>{t("guardrails.retentionEvents", { current: activity.retention.currentEvents, max: activity.retention.maxEvents })}</span>
        <span>{t("guardrails.retentionEvicted", { count: activity.retention.evictedEvents })}</span>
        <span>{t("guardrails.showingEvents", { shown: events.length, total: activity.totalMatching })}</span>
        <span>{t("guardrails.oldestEvent", {
          date: activity.retention.oldestAt === null ? "—" : new Date(activity.retention.oldestAt).toLocaleString(),
        })}</span>
        <span>{t("guardrails.lastRefresh", {
          date: lastRefreshAt === null ? "—" : new Date(lastRefreshAt).toLocaleString(),
        })}</span>
      </section>
      {events.length === 0
        ? <EmptyState title={t("guardrails.noActivity")}>{t("guardrails.noActivityHint")}</EmptyState>
        : (
          <>
            <p className="guardrails-table-scroll-hint">{t("guardrails.tableScrollHint")}</p>
            <div className="guardrails-wide-table" role="region" tabIndex={0} aria-label={t("guardrails.activityTitle")}>
              <table>
                <thead><tr>
                  <th>{t("guardrails.time")}</th>
                  <th>{t("guardrails.surface")}</th>
                  <th>{t("guardrails.result")}</th>
                  <th>{t("guardrails.count")}</th>
                  <th>{t("guardrails.rules")}</th>
                  <th>{t("guardrails.generation")}</th>
                  <th>{t("guardrails.latency")}</th>
                </tr></thead>
                <tbody>{events.map(event => (
                  <tr key={event.id}>
                    <td>{new Date(event.timestamp).toLocaleString()}</td>
                    <td>{surfaceOptions.find(option => option.value === event.surface)?.label ?? event.surface}</td>
                    <td>
                      <span className={`badge ${event.severity === "high" ? "badge-amber" : "badge-muted"}`}>
                        {resultOptions.find(option => option.value === event.result)?.label ?? event.result}
                      </span>
                    </td>
                    <td>{event.count}</td>
                    <td><code>{event.ruleIds.join(", ") || "—"}</code></td>
                    <td>{event.registryGeneration}</td>
                    <td>{event.latencyMs.toFixed(2)} ms</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}
    </div>
  );
}
