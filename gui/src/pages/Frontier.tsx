import { useEffect, useMemo, useState, type ReactNode } from "react";
import ReactECharts from "echarts-for-react";
import catalog from "../data/frontier-benchmarks.json";
import {
  buildFrontierChartOption,
  frontierChartHeight,
  frontierModelColorMap,
  readFrontierThemeColors,
  type FrontierChartKind,
} from "../frontier-echarts-theme";
import {
  boardGridColumns,
  boardMatchesDomain,
  filterBoardsByDomain,
  FRONTIER_DOMAIN_ORDER,
  type FrontierDomainFilter,
} from "../frontier-domains";
import {
  benchmarkHasCostParts,
  benchmarkHasMultiEffort,
  efficiencyRatio,
  priceBandFor,
  rowHasCostParts,
  selectBestEffortRows,
  type FrontierCatalog,
  type FrontierEffortView,
  type FrontierTag,
  type PriceBand,
} from "../frontier-types";
import { useI18n, useT, type TKey } from "../i18n";
import { EmptyState } from "../ui";

const data = catalog as FrontierCatalog;

const TAG_KEYS: Record<FrontierTag, TKey> = {
  workhorse: "frontier.tag.workhorse",
  planner: "frontier.tag.planner",
  frontier: "frontier.tag.frontier",
  "cheap-subagent": "frontier.tag.cheapSubagent",
  fast: "frontier.tag.fast",
};

const PRICE_KEYS: Record<PriceBand, TKey> = {
  lt3: "frontier.price.lt3",
  mid: "frontier.price.mid",
  gt8: "frontier.price.gt8",
};

const DOMAIN_KEYS: Record<FrontierDomainFilter, TKey> = {
  all: "frontier.domain.all",
  coding: "frontier.domain.coding",
  frontend: "frontier.domain.frontend",
  terminal: "frontier.domain.terminal",
  security: "frontier.domain.security",
  intelligence: "frontier.domain.intelligence",
};

const CHART_KINDS: { id: FrontierChartKind; tkey: TKey }[] = [
  { id: "scatter", tkey: "frontier.chart.scatter" },
  { id: "costStack", tkey: "frontier.chart.costStack" },
  { id: "score", tkey: "frontier.chart.score" },
  { id: "efficiency", tkey: "frontier.chart.efficiency" },
  { id: "reasoning", tkey: "frontier.chart.reasoning" },
];

const CHART_HINT_KEYS: Record<FrontierChartKind, TKey> = {
  scatter: "frontier.chartHint.scatter",
  costStack: "frontier.chartHint.costStack",
  score: "frontier.chartHint.score",
  efficiency: "frontier.chartHint.efficiency",
  reasoning: "frontier.chartHint.reasoning",
};

const EFFORT_VIEW_KEYS: Record<FrontierEffortView, TKey> = {
  best: "frontier.effortView.best",
  all: "frontier.effortView.all",
};

function toggleInSet(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function useThemeRevision(): number {
  const [rev, setRev] = useState(0);
  useEffect(() => {
    const root = document.documentElement;
    const bump = () => setRev(n => n + 1);
    const obs = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "data-theme") {
          bump();
          return;
        }
      }
    });
    obs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", bump);
    return () => {
      obs.disconnect();
      mq.removeEventListener("change", bump);
    };
  }, []);
  return rev;
}

export default function Frontier() {
  const t = useT();
  const { locale } = useI18n();
  const themeRev = useThemeRevision();

  const benchmarks = data.benchmarks;
  const [domain, setDomain] = useState<FrontierDomainFilter>("all");
  const [benchmarkId, setBenchmarkId] = useState(benchmarks[0]?.id ?? "deepswe");
  const [chartKind, setChartKind] = useState<FrontierChartKind>("scatter");
  const [effortView, setEffortView] = useState<FrontierEffortView>("best");
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => new Set());
  const [hiddenEfforts, setHiddenEfforts] = useState<Set<string>>(() => new Set());
  const [priceBands, setPriceBands] = useState<Set<PriceBand>>(() => new Set(["lt3", "mid", "gt8"]));
  const [activeTags, setActiveTags] = useState<Set<FrontierTag>>(() => new Set());

  const resetFilters = () => {
    setHiddenModels(new Set());
    setHiddenEfforts(new Set());
    setPriceBands(new Set(["lt3", "mid", "gt8"]));
    setActiveTags(new Set());
  };

  const visibleBenchmarks = useMemo(
    () => filterBoardsByDomain(benchmarks, domain),
    [benchmarks, domain],
  );
  const active = visibleBenchmarks.find(b => b.id === benchmarkId)
    ?? benchmarks.find(b => b.id === benchmarkId)
    ?? visibleBenchmarks[0]
    ?? benchmarks[0];

  const costStackBoards = useMemo(
    () => visibleBenchmarks.filter(benchmarkHasCostParts),
    [visibleBenchmarks],
  );
  const multiEffortBoards = useMemo(
    () => visibleBenchmarks.filter(benchmarkHasMultiEffort),
    [visibleBenchmarks],
  );
  const costStackLocked = chartKind === "costStack";
  const reasoningLocked = chartKind === "reasoning";
  const showEffortView = active != null && benchmarkHasMultiEffort(active);

  const pickFallbackBoard = (candidates: typeof benchmarks) =>
    candidates.find(b => b.id === "frontiercode")
    ?? candidates.find(b => b.id === "aa-intelligence-index")
    ?? candidates.find(b => b.id === "cybench")
    ?? candidates[0];

  const selectDomain = (next: FrontierDomainFilter) => {
    setDomain(next);
    const inDomain = filterBoardsByDomain(benchmarks, next);
    let nextBoards = inDomain;
    if (costStackLocked) nextBoards = nextBoards.filter(benchmarkHasCostParts);
    if (reasoningLocked) nextBoards = nextBoards.filter(benchmarkHasMultiEffort);
    if (nextBoards.length === 0) {
      setChartKind("scatter");
      nextBoards = inDomain;
    }
    const keep = nextBoards.find(b => b.id === benchmarkId);
    if (keep) return;
    const fallback = pickFallbackBoard(nextBoards) ?? inDomain[0];
    if (!fallback) return;
    setBenchmarkId(fallback.id);
    resetFilters();
  };

  const allModels = useMemo(
    () => [...new Set((active?.rows ?? []).map(r => r.model))].toSorted((a, b) => a.localeCompare(b)),
    [active],
  );
  const allEfforts = useMemo(
    () => [...new Set((active?.rows ?? []).map(r => r.effort).filter((e): e is string => Boolean(e)))].toSorted(),
    [active],
  );
  const allTags = useMemo(() => {
    const tags = new Set<FrontierTag>();
    for (const row of active?.rows ?? []) for (const tag of row.tags) tags.add(tag);
    return [...tags].toSorted();
  }, [active]);

  const selectBenchmark = (id: string) => {
    const board = benchmarks.find(b => b.id === id);
    if (!board) return;
    if (!boardMatchesDomain(board, domain)) return;
    if (costStackLocked && !benchmarkHasCostParts(board)) return;
    if (reasoningLocked && !benchmarkHasMultiEffort(board)) return;
    setBenchmarkId(id);
    resetFilters();
  };

  const selectChartKind = (kind: FrontierChartKind) => {
    setChartKind(kind);
    if (kind === "costStack") {
      const currentOk = active != null && benchmarkHasCostParts(active);
      if (currentOk) return;
      const fallback = costStackBoards[0]
        ?? benchmarks.filter(benchmarkHasCostParts)[0];
      if (!fallback) return;
      if (fallback.id !== benchmarkId) {
        setBenchmarkId(fallback.id);
        resetFilters();
      }
      if (!boardMatchesDomain(fallback, domain)) setDomain("all");
      return;
    }
    if (kind === "reasoning") {
      const currentOk = active != null && benchmarkHasMultiEffort(active);
      if (currentOk) return;
      const fallback = multiEffortBoards.find(b => b.id === "frontiercode")
        ?? multiEffortBoards[0]
        ?? benchmarks.filter(benchmarkHasMultiEffort).find(b => b.id === "frontiercode")
        ?? benchmarks.filter(benchmarkHasMultiEffort)[0];
      if (!fallback) return;
      if (fallback.id !== benchmarkId) {
        setBenchmarkId(fallback.id);
        resetFilters();
      }
      if (!boardMatchesDomain(fallback, domain)) setDomain("all");
    }
  };

  const filtered = useMemo(() => {
    if (!active) return [];
    const base = active.rows.filter(row => {
      if (hiddenModels.has(row.model)) return false;
      if (row.effort && hiddenEfforts.has(row.effort)) return false;
      if (!priceBands.has(priceBandFor(row.avgCostUsd))) return false;
      if (activeTags.size > 0 && !row.tags.some(tag => activeTags.has(tag))) return false;
      return true;
    });
    if (showEffortView && effortView === "best") return selectBestEffortRows(base);
    return base;
  }, [active, hiddenModels, hiddenEfforts, priceBands, activeTags, showEffortView, effortView]);

  const ranked = useMemo(
    () => [...filtered].toSorted((a, b) => {
      const eff = efficiencyRatio(b.score, b.avgCostUsd) - efficiencyRatio(a.score, a.avgCostUsd);
      if (Math.abs(eff) > 1e-9) return eff;
      return b.score - a.score;
    }),
    [filtered],
  );

  const theme = useMemo(() => {
    void themeRev;
    return readFrontierThemeColors();
  }, [themeRev]);

  const modelColors = useMemo(() => frontierModelColorMap(allModels), [allModels]);

  const chartRows = useMemo(() => {
    if (chartKind === "costStack") return filtered.filter(rowHasCostParts);
    return filtered;
  }, [chartKind, filtered]);

  const option = useMemo(() => {
    if (!active) return {};
    return buildFrontierChartOption({
      kind: chartKind,
      rows: chartRows,
      xLabel: active.axes.xLabel,
      yLabel: active.axes.yLabel,
      yUnit: active.axes.yUnit,
      theme,
      locale,
      modelColors,
    });
  }, [active, chartRows, theme, locale, chartKind, modelColors]);

  const chartModelCount = useMemo(
    () => new Set(chartRows.map(r => r.model)).size,
    [chartRows],
  );
  const chartHeight = frontierChartHeight(chartKind, chartRows.length, chartModelCount);

  if (!active) {
    return <EmptyState title={t("frontier.empty")} />;
  }

  const yIsPercent = active.axes.yUnit === "%";

  return (
    <div className="frontier-page">
      <div className="page-head">
        <h2>{t("nav.frontier")}</h2>
        <span className="muted mono text-label">
          {t("frontier.updated", { date: active.updated })}
          {active.taskCount != null ? ` · ${t("frontier.tasks", { count: active.taskCount })}` : ""}
        </span>
      </div>
      <p className="page-sub">{t("frontier.subtitle")}</p>

      <div className="frontier-domains" role="tablist" aria-label={t("frontier.domainsAria")}>
        {FRONTIER_DOMAIN_ORDER.map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={domain === id}
            className={`frontier-domain-btn${domain === id ? " active" : ""}`}
            onClick={() => selectDomain(id)}
          >
            {t(DOMAIN_KEYS[id])}
          </button>
        ))}
      </div>
      <p className="frontier-domain-hint muted text-label">{t("frontier.domainHint")}</p>

      <div
        className="frontier-benchmarks"
        role="tablist"
        aria-label={t("frontier.benchmarksAria")}
        style={{ ["--frontier-board-cols" as string]: boardGridColumns(visibleBenchmarks.length) }}
      >
        {visibleBenchmarks.map(b => {
          const disabled =
            (costStackLocked && !benchmarkHasCostParts(b))
            || (reasoningLocked && !benchmarkHasMultiEffort(b));
          const disabledTitle = costStackLocked && !benchmarkHasCostParts(b)
            ? t("frontier.boardNoCostParts")
            : reasoningLocked && !benchmarkHasMultiEffort(b)
              ? t("frontier.boardNoMultiEffort")
              : undefined;
          return (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={b.id === benchmarkId}
              aria-disabled={disabled || undefined}
              disabled={disabled}
              title={disabledTitle}
              className={`frontier-board-btn${b.id === benchmarkId ? " active" : ""}${disabled ? " is-disabled" : ""}`}
              onClick={() => selectBenchmark(b.id)}
            >
              {b.title}
            </button>
          );
        })}
      </div>

      <p className="frontier-source muted text-control">{active.sourceNote}</p>

      <section className="panel frontier-chart-panel" aria-label={t("frontier.chartAria")}>
        <div className="frontier-chart-toolbar">
          <div className="frontier-chart-toolbar-row">
            <div className="usage-segmented" role="tablist" aria-label={t("frontier.chartKindsAria")}>
              {CHART_KINDS.map(({ id, tkey }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={chartKind === id}
                  className={`usage-segmented-btn${chartKind === id ? " active" : ""}`}
                  onClick={() => selectChartKind(id)}
                >
                  {t(tkey)}
                </button>
              ))}
            </div>
            <div
              className={`usage-segmented frontier-effort-view${showEffortView ? "" : " is-disabled"}`}
              role="tablist"
              aria-label={t("frontier.effortViewAria")}
              aria-disabled={!showEffortView || undefined}
              title={showEffortView ? undefined : t("frontier.effortViewDisabled")}
            >
              {(Object.keys(EFFORT_VIEW_KEYS) as FrontierEffortView[]).map(mode => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={effortView === mode}
                  disabled={!showEffortView}
                  className={`usage-segmented-btn${effortView === mode ? " active" : ""}`}
                  onClick={() => setEffortView(mode)}
                >
                  {t(EFFORT_VIEW_KEYS[mode])}
                </button>
              ))}
            </div>
          </div>
          <p className="frontier-chart-hint muted text-label">{t(CHART_HINT_KEYS[chartKind])}</p>
        </div>

        <div className="frontier-filters">
          {chartKind !== "reasoning" && (
            <FilterGroup label={t("frontier.filter.models")}>
              {allModels.map(model => {
                const on = !hiddenModels.has(model);
                return (
                  <button
                    key={model}
                    type="button"
                    className={`frontier-chip${on ? " active" : ""}`}
                    aria-pressed={on}
                    onClick={() => setHiddenModels(prev => toggleInSet(prev, model))}
                  >
                    {model}
                  </button>
                );
              })}
            </FilterGroup>
          )}

          {allEfforts.length > 0 && (
            <FilterGroup label={t("frontier.filter.effort")}>
              {allEfforts.map(effort => {
                const on = !hiddenEfforts.has(effort);
                return (
                  <button
                    key={effort}
                    type="button"
                    className={`frontier-chip${on ? " active" : ""}`}
                    aria-pressed={on}
                    onClick={() => setHiddenEfforts(prev => toggleInSet(prev, effort))}
                  >
                    {effort}
                  </button>
                );
              })}
            </FilterGroup>
          )}

          <FilterGroup label={t("frontier.filter.price")}>
            {(Object.keys(PRICE_KEYS) as PriceBand[]).map(band => {
              const on = priceBands.has(band);
              return (
                <button
                  key={band}
                  type="button"
                  className={`frontier-chip${on ? " active" : ""}`}
                  aria-pressed={on}
                  onClick={() => setPriceBands(prev => {
                    const next = toggleInSet(prev, band) as Set<PriceBand>;
                    return next.size === 0 ? new Set(prev) : next;
                  })}
                >
                  {t(PRICE_KEYS[band])}
                </button>
              );
            })}
          </FilterGroup>

          {allTags.length > 0 && (
            <FilterGroup label={t("frontier.filter.tags")}>
              {allTags.map(tag => {
                const on = activeTags.has(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    className={`frontier-chip${on ? " active" : ""}`}
                    aria-pressed={on}
                    onClick={() => setActiveTags(prev => toggleInSet(prev, tag) as Set<FrontierTag>)}
                  >
                    {t(TAG_KEYS[tag])}
                  </button>
                );
              })}
            </FilterGroup>
          )}
        </div>

        {filtered.length === 0 ? (
          <EmptyState title={t("frontier.noMatches")} />
        ) : chartKind === "costStack" && chartRows.length === 0 ? (
          <EmptyState title={t("frontier.noCostParts")} />
        ) : chartKind === "reasoning" && chartRows.length === 0 ? (
          <EmptyState title={t("frontier.noMultiEffort")} />
        ) : (
          <>
            <ReactECharts
              key={`${benchmarkId}-${chartKind}-${themeRev}`}
              option={option}
              style={{ height: chartHeight, width: "100%" }}
              opts={{ renderer: "canvas" }}
              notMerge
              lazyUpdate
            />
            {chartKind === "reasoning" && (
              <div className="frontier-model-legend" role="group" aria-label={t("frontier.filter.models")}>
                {allModels.map(model => {
                  const on = !hiddenModels.has(model);
                  return (
                    <button
                      key={model}
                      type="button"
                      className={`frontier-legend-chip${on ? " active" : ""}`}
                      aria-pressed={on}
                      onClick={() => setHiddenModels(prev => toggleInSet(prev, model))}
                    >
                      <span
                        className="frontier-legend-swatch"
                        style={{ background: modelColors[model] }}
                        aria-hidden
                      />
                      {model}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>

      <section className="panel frontier-table-panel" aria-label={t("frontier.tableAria")}>
        <div className="panel-head">
          <h3 className="panel-title">{t("frontier.ranking")}</h3>
          <span className="muted text-label">{t("frontier.rankingHint")}</span>
        </div>
        <div className="tbl-wrap usage-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("frontier.col.model")}</th>
                <th>{t("frontier.col.effort")}</th>
                <th>{active.axes.yLabel}</th>
                <th>{t("frontier.col.cost")}</th>
                <th>{t("frontier.col.efficiency")}</th>
                <th>{t("frontier.col.tags")}</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((row, i) => {
                const eff = efficiencyRatio(row.score, row.avgCostUsd);
                const best = i === 0;
                return (
                  <tr key={row.id} className={best ? "frontier-row-best" : undefined}>
                    <td>
                      <span className="frontier-model-cell">
                        <span
                          className="frontier-family-dot"
                          style={{ background: theme.families[row.family] }}
                          aria-hidden
                        />
                        {row.model}
                        {best && <span className="badge badge-green text-micro">{t("frontier.bestValue")}</span>}
                      </span>
                    </td>
                    <td className="muted">{row.effort ?? "—"}</td>
                    <td>
                      {yIsPercent ? `${row.score}%` : row.score}
                      {row.scoreCi != null ? <span className="muted"> ±{row.scoreCi}</span> : null}
                    </td>
                    <td>${row.avgCostUsd.toLocaleString(locale, { maximumFractionDigits: 2 })}</td>
                    <td className="mono">{eff.toFixed(1)}</td>
                    <td className="muted">{row.tags.map(tag => t(TAG_KEYS[tag])).join(", ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="frontier-filter-group">
      <div className="frontier-filter-label">{label}</div>
      <div className="frontier-chip-row">{children}</div>
    </div>
  );
}
