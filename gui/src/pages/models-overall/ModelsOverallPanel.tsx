/**
 * The Models page "Overall" tab: every model from every provider in one searchable list, each
 * with an on/off switch.
 *
 * Laid out like the Subagents model picker (a Frame with a search box, a count and a scrolling
 * ruled list). It owns no data and no writes: Models.tsx hands it the catalog rows, the same
 * visibility answer the per-provider catalog shows, and the same ordered write queue, so the
 * two tabs can never disagree about a model and the catalog poll cannot repaint a row while its
 * write is in flight.
 *
 * Rows keep the catalog's order and do not move when switched, so a row never jumps out from
 * under the pointer; the On/Off filter is the explicit way to narrow by state.
 */
import { useMemo, useState } from "react";
import { IconSearch } from "../../icons";
import { useT } from "../../i18n/shared";
import { Notice } from "../../ui";
import { cn } from "@/lib/utils";
import { modelLabel } from "../../model-display";
import { providerDisplaySlug } from "../../provider-icons";
import { CountPill, Frame, FrameBody } from "../../components/v2-subagents/frame";
import { ProviderMark } from "../../components/v2-models/provider-mark";
import { DataSurfaceSkeleton } from "../../components/data-surface";
import { IntegrationRefreshWarning } from "../../components/integration-refresh-warning";
import { ModelVisibilitySwitch } from "../../model-visibility-switch";
import type { ClientCatalogRefreshFailure } from "../../model-visibility";
import type { ModelRow } from "../models-shared";

type StateFilter = "all" | "on" | "off";
const FILTERS: readonly StateFilter[] = ["all", "on", "off"];
const FILTER_LABEL = { all: "modelsOverall.filter.all", on: "modelsOverall.filter.on", off: "modelsOverall.filter.off" } as const;
/** Rows rendered before "Show more"; a 300-model router stays responsive. */
const OVERALL_PAGE = 200;

export function ModelsOverallPanel({ rows, isOn, switchDisabled, onToggle, failures, loading, error, onRetry }: {
  rows: readonly ModelRow[];
  isOn: (row: ModelRow) => boolean;
  switchDisabled: (row: ModelRow) => boolean;
  onToggle: (row: ModelRow, enable: boolean) => void;
  failures: readonly ClientCatalogRefreshFailure[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StateFilter>("all");
  const [limit, setLimit] = useState(OVERALL_PAGE);

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(row => [row.id, row.namespaced, row.provider, row.displayName ?? "", row.native ? modelLabel(row.id) : ""]
      .some(value => value.toLowerCase().includes(q)));
  }, [rows, query]);
  // State is read at render time, so a row switched under the On/Off filter leaves it at once.
  const shown = filter === "all" ? searched : searched.filter(row => isOn(row) === (filter === "on"));
  const onCount = rows.filter(isOn).length;

  if (loading) return <DataSurfaceSkeleton label={t("models.loading")} rows={5} />;
  if (error !== null) {
    return (
      <>
        <Notice tone="err">{error}</Notice>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>{t("common.retry")}</button>
      </>
    );
  }

  return (
    <div className="models-overall flex flex-col gap-4">
      <IntegrationRefreshWarning failures={failures} />
      <Frame
        title={t("modelsOverall.title")}
        meta={<CountPill>{t("models.active", { active: onCount, total: rows.length })}</CountPill>}
        actions={<>
          <div className="flex items-center gap-1" role="group" aria-label={t("modelsOverall.filterLabel")}>
            {FILTERS.map(candidate => (
              <button key={candidate} type="button" aria-pressed={filter === candidate}
                className={cn("btn btn-sm", filter === candidate ? "btn-primary" : "btn-ghost")}
                onClick={() => { setFilter(candidate); setLimit(OVERALL_PAGE); }}>
                {t(FILTER_LABEL[candidate])}
              </button>
            ))}
          </div>
          <label className="relative flex w-full items-center sm:w-72">
            <IconSearch className="pointer-events-none absolute left-2.5 size-4 text-fg-subtle" aria-hidden="true" />
            <input
              className="input w-full pl-8"
              type="search"
              value={query}
              onChange={event => { setQuery(event.target.value); setLimit(OVERALL_PAGE); }}
              placeholder={t("modelsOverall.search")}
              aria-label={t("modelsOverall.search")}
            />
          </label>
        </>}
      >
        <FrameBody as="ul" className="max-h-[min(40rem,70vh)] overflow-y-auto">
          {rows.length === 0 ? (
            <li className="px-4 py-6 text-center text-[13px] text-fg-muted">{t("modelsOverall.empty")}</li>
          ) : shown.length === 0 ? (
            <li className="px-4 py-6 text-center text-[13px] text-fg-muted" role="status">{t("modelsOverall.noMatch")}</li>
          ) : shown.slice(0, limit).map(row => {
            const on = isOn(row);
            const friendly = !row.native && row.displayName?.trim() && row.displayName.trim() !== row.namespaced ? row.displayName.trim() : null;
            return (
              <li key={row.namespaced + (row.native ? "\0native" : "")} className="flex min-h-11 min-w-0 items-center gap-3 py-1.5 pr-3 pl-3.5">
                <ProviderMark name={row.provider} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn("truncate font-mono text-[13px]", on ? "text-fg" : "text-fg-subtle line-through")}>
                    {row.native ? modelLabel(row.id) : row.namespaced}
                  </span>
                  {friendly && <span className="truncate text-[12px] text-fg-muted">{friendly}</span>}
                </span>
                <span className="shrink-0 text-[12px] text-fg-subtle max-sm:hidden">{providerDisplaySlug(row.provider)}</span>
                <ModelVisibilitySwitch row={row} on={on} disabled={switchDisabled(row)} onToggle={enable => onToggle(row, enable)} />
              </li>
            );
          })}
        </FrameBody>
        {shown.length > limit && (
          <div className="px-4 py-2.5">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLimit(value => value + OVERALL_PAGE)}>
              {t("models.showMore", { n: Math.min(OVERALL_PAGE, shown.length - limit) })}
            </button>
          </div>
        )}
      </Frame>
    </div>
  );
}

