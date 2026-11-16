import type * as Echarts from "echarts";

type EchartsModule = typeof import("echarts");
let echartsLoad: Promise<EchartsModule> | null = null;
// Loaded on first chart render: keeps ECharts out of the initial page script and lets
// helpers in this module be imported where the docs-site dependencies are not installed.
function loadEcharts(): Promise<EchartsModule> {
  return (echartsLoad ??= import("echarts"));
}
import type { TelemetryDashboardCopy } from "../../data/telemetry-dashboard-i18n";
import {
  DEFAULT_STATS_REQUEST_TIMEOUT_MS,
  buildChannelRows,
  buildDailyChartAccessibleTable,
  buildDailyProviderChart,
  buildHeatmapCalendar,
  buildKpiStrip,
  buildModelShareRows,
  buildPlatformRows,
  buildProviderShareRows,
  buildReliabilitySummary,
  buildStatsUrl,
  buildTokenMix,
  buildVersionRows,
  classifyStatsResponse,
  createEmptyStatsSnapshot,
  createStatsRequestSequencer,
  fetchGithubReleasesPages,
  fetchJsonWithTimeout,
  formatCompactNumber,
  formatExactNumber,
  formatGeneratedTimestamp,
  formatHeatmapCellAriaLabel,
  navigateHeatmapDate,
  parseDownloadsPayload,
  parseStatsRangeParam,
  type DailyChartMetric,
  type HeatmapCell,
  type HeatmapNavigationKey,
  type TelemetryStatsRange,
  type TelemetryStatsV1,
} from "./index";

export function mountTelemetryDashboard(
  root: HTMLElement | null = document.querySelector<HTMLElement>("[data-telemetry-dashboard]"),
): void {
  if (!root) return;

  const locale = root.dataset.locale ?? "en";
  const statsEndpoint =
    root.dataset.statsEndpoint ?? "https://telemetry.opencodex.me/v1/stats";
  const copy = JSON.parse(root.dataset.copy ?? "{}") as TelemetryDashboardCopy;

  let activeRange: TelemetryStatsRange = parseStatsRangeParam(
    new URLSearchParams(window.location.search).get("range") ??
      root.dataset.defaultRange,
  );
  let activeChartMetric: DailyChartMetric = "tokens";
  let latestStats: TelemetryStatsV1 | null = null;
  let chartInstance: Echarts.ECharts | null = null;
  let currentHeatmapCells: HeatmapCell[] = [];
  let focusedHeatmapDate: string | null = null;
  const statsSequencer = createStatsRequestSequencer(DEFAULT_STATS_REQUEST_TIMEOUT_MS);

  const setDashboardState = (
    state: "loading" | "ready" | "empty" | "error",
    detail?: string,
  ) => {
    root.dataset.dashboardState = state;
    for (const panel of root.querySelectorAll<HTMLElement>("[data-state-panel]")) {
      panel.hidden = panel.dataset.statePanel !== state;
    }
    if (state === "error" && detail) {
      const errBody = root.querySelector<HTMLElement>("[data-error-body]");
      if (errBody) {
        errBody.textContent = `${copy.stateErrorBody} (${detail})`;
      }
    }
  };

  const syncRangePills = () => {
    for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-range-pill]")) {
      const isCurrent = btn.dataset.rangePill === activeRange;
      btn.setAttribute("aria-pressed", isCurrent ? "true" : "false");
    }
  };

  const syncChartMetricPills = () => {
    for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-chart-metric]")) {
      const isCurrent = btn.dataset.chartMetric === activeChartMetric;
      btn.setAttribute("aria-pressed", isCurrent ? "true" : "false");
    }
  };

  const renderDailyChart = () => {
    const chartEl = root.querySelector<HTMLElement>("[data-daily-chart]");
    if (!chartEl) return;
    const textColor = getComputedStyle(document.body).color;
    const borderColor =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--sl-color-gray-5")
        .trim() || "rgba(128,128,128,0.25)";

    const model = buildDailyProviderChart(
      latestStats?.dailyByProvider,
      latestStats?.daily,
      activeChartMetric,
    );
    const metricLabel =
      activeChartMetric === "requests" ? copy.metricRequests : copy.metricTokens;
    chartEl.setAttribute(
      "aria-label",
      `${copy.dailyChartTitle} (${metricLabel}): ${formatCompactNumber(model.total)}`,
    );

    const metricHeaderEl = root.querySelector<HTMLElement>(
      "[data-daily-chart-metric-col]",
    );
    if (metricHeaderEl) {
      metricHeaderEl.textContent = metricLabel;
    }
    const chartTbody = root.querySelector<HTMLTableSectionElement>(
      "[data-daily-chart-tbody]",
    );
    if (chartTbody) {
      const srRows = buildDailyChartAccessibleTable(model, locale);
      if (srRows.length === 0) {
        chartTbody.replaceChildren(makeEmptyRow(3, copy.noDataInTable));
      } else {
        chartTbody.replaceChildren(
          ...srRows.map((row) => {
            const tr = document.createElement("tr");
            const tdDay = document.createElement("td");
            tdDay.textContent = row.day;
            const tdProv = document.createElement("td");
            tdProv.textContent = row.providerKind;
            const tdVal = document.createElement("td");
            tdVal.textContent = `${row.valueExact} (${row.valueCompact})`;
            tr.append(tdDay, tdProv, tdVal);
            return tr;
          }),
        );
      }
    }

    const applyChart = (echarts: EchartsModule) => {
      if (!chartInstance) {
        chartInstance = echarts.init(chartEl);
      }
      chartInstance.setOption(
        {
          textStyle: { color: textColor },
          tooltip: {
            trigger: "axis",
            axisPointer: { type: "shadow" },
          },
          legend: {
            top: 0,
            textStyle: { color: textColor, fontSize: 11 },
          },
          grid: { left: 52, right: 16, top: 34, bottom: 28 },
          xAxis: {
            type: "category",
            data: model.days,
            axisLabel: { color: textColor, fontSize: 11 },
            axisLine: { lineStyle: { color: borderColor } },
          },
          yAxis: {
            type: "value",
            axisLabel: {
              color: textColor,
              fontSize: 11,
              formatter: (val: number) => formatCompactNumber(val),
            },
            splitLine: { lineStyle: { color: borderColor } },
          },
          series: model.series.map((s) => ({
            name: s.providerKind,
            type: "bar",
            stack: "daily",
            itemStyle: { color: s.color },
            emphasis: { focus: "series" },
            data: s.values,
          })),
        },
        { notMerge: true },
      );
    };
    void loadEcharts().then(applyChart).catch(() => {
      chartEl.dataset.chartUnavailable = "true";
    });
  };

  const renderHeatmap = (stats: TelemetryStatsV1 | null) => {
    const gridEl = root.querySelector<HTMLElement>("[data-heatmap-grid]");
    const monthsEl = root.querySelector<HTMLElement>("[data-heatmap-months]");
    const activeDaysEl = root.querySelector<HTMLElement>("[data-heatmap-active-days]");
    const peakEl = root.querySelector<HTMLElement>("[data-heatmap-peak]");
    const rangeLabelEl = root.querySelector<HTMLElement>("[data-heatmap-range-label]");
    const tooltipEl = root.querySelector<HTMLElement>("[data-heatmap-tooltip]");
    if (!gridEl || !monthsEl) return;

    const calendar = buildHeatmapCalendar(stats?.heatmap, locale);
    currentHeatmapCells = calendar.cells;

    if (activeDaysEl) {
      activeDaysEl.textContent = copy.heatmapActiveDays.replace(
        "{count}",
        formatExactNumber(calendar.activeDays, locale),
      );
    }
    if (peakEl) {
      if (calendar.peakDay) {
        peakEl.hidden = false;
        peakEl.textContent = copy.heatmapPeakDay
          .replace("{date}", calendar.peakDay.date)
          .replace("{count}", formatExactNumber(calendar.peakDay.activeInstalls, locale));
      } else {
        peakEl.hidden = true;
      }
    }
    if (rangeLabelEl && calendar.startDate && calendar.endDate) {
      rangeLabelEl.textContent = `${calendar.startDate} → ${calendar.endDate} (UTC)`;
    }

    if (calendar.weekCount === 0) {
      focusedHeatmapDate = null;
      if (peakEl) {
        peakEl.hidden = true;
        peakEl.textContent = "";
      }
      if (rangeLabelEl) {
        rangeLabelEl.textContent = "365d UTC";
      }
      gridEl.style.setProperty("--heatmap-weeks", "53");
      monthsEl.style.setProperty("--heatmap-weeks", "53");
      monthsEl.replaceChildren();
      const emptyButtons = Array.from({ length: 53 * 7 }, () => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "td-heatmap-cell";
        btn.dataset.grade = "0";
        btn.disabled = true;
        btn.tabIndex = -1;
        btn.setAttribute("aria-hidden", "true");
        return btn;
      });
      gridEl.replaceChildren(...emptyButtons);
      if (tooltipEl) {
        tooltipEl.dataset.active = "false";
        tooltipEl.setAttribute("aria-hidden", "true");
        tooltipEl.textContent = "\u00a0";
      }
      return;
    }

    const weeks = String(calendar.weekCount);
    gridEl.style.setProperty("--heatmap-weeks", weeks);
    monthsEl.style.setProperty("--heatmap-weeks", weeks);

    monthsEl.replaceChildren(
      ...calendar.monthMarkers.map((m) => {
        const span = document.createElement("span");
        span.style.gridColumnStart = String(m.weekIndex + 1);
        span.textContent = m.label;
        return span;
      }),
    );

    const selectableCells = calendar.cells.filter((c) => c.selectable);
    focusedHeatmapDate =
      selectableCells[selectableCells.length - 1]?.date ?? null;

    const showCellTooltip = (cell: HeatmapCell) => {
      if (!tooltipEl || !cell.selectable) return;
      tooltipEl.dataset.active = "true";
      tooltipEl.setAttribute("aria-hidden", "false");
      tooltipEl.textContent = `${cell.date} · ${formatExactNumber(cell.activeInstalls, locale)} ${copy.heatmapTooltipUnit}`;
    };

    const hideCellTooltip = () => {
      if (!tooltipEl) return;
      tooltipEl.dataset.active = "false";
      tooltipEl.setAttribute("aria-hidden", "true");
    };

    const buttons = calendar.cells.map((cell) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "td-heatmap-cell";
      btn.dataset.grade = String(cell.grade);
      if (cell.selectable) {
        btn.dataset.date = cell.date;
        btn.tabIndex = cell.date === focusedHeatmapDate ? 0 : -1;
        btn.setAttribute(
          "aria-label",
          formatHeatmapCellAriaLabel(cell, locale, copy.heatmapTooltipUnit),
        );
        btn.setAttribute("aria-describedby", "td-heatmap-tooltip");
        btn.addEventListener("mouseenter", () => showCellTooltip(cell));
        btn.addEventListener("mouseleave", hideCellTooltip);
        btn.addEventListener("focus", () => {
          focusedHeatmapDate = cell.date;
          showCellTooltip(cell);
        });
        btn.addEventListener("blur", hideCellTooltip);
        btn.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key === "Escape") {
            event.preventDefault();
            hideCellTooltip();
            return;
          }
          if (
            ![
              "ArrowUp",
              "ArrowDown",
              "ArrowLeft",
              "ArrowRight",
              "Home",
              "End",
            ].includes(event.key)
          ) {
            return;
          }
          event.preventDefault();
          const nextDate = navigateHeatmapDate(
            currentHeatmapCells,
            cell.date,
            event.key as HeatmapNavigationKey,
          );
          if (!nextDate) return;
          focusedHeatmapDate = nextDate;
          for (const b of gridEl.querySelectorAll<HTMLButtonElement>("button[data-date]")) {
            const isTarget = b.dataset.date === nextDate;
            b.tabIndex = isTarget ? 0 : -1;
            if (isTarget) b.focus();
          }
        });
      } else {
        btn.disabled = true;
        btn.tabIndex = -1;
        btn.setAttribute("aria-hidden", "true");
      }
      return btn;
    });

    gridEl.replaceChildren(...buttons);
  };

  const makeEmptyRow = (colSpan: number, message: string): HTMLTableRowElement => {
    const tr = document.createElement("tr");
    tr.className = "td-empty-row";
    const td = document.createElement("td");
    td.colSpan = colSpan;
    td.textContent = message;
    tr.appendChild(td);
    return tr;
  };

  const renderShareTable = (
    tbodyName: "providers" | "models",
    rows: ReturnType<typeof buildProviderShareRows>,
  ) => {
    const tbody = root.querySelector<HTMLTableSectionElement>(
      `[data-tbody="${tbodyName}"]`,
    );
    if (!tbody) return;
    if (rows.length === 0) {
      tbody.replaceChildren(makeEmptyRow(4, copy.noDataInTable));
      return;
    }
    tbody.replaceChildren(
      ...rows.map((row) => {
        const tr = document.createElement("tr");

        const tdName = document.createElement("td");
        const identity = document.createElement("span");
        identity.className = "td-row-identity";
        const dot = document.createElement("span");
        dot.className = "td-row-dot";
        dot.style.backgroundColor = row.color;
        dot.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.textContent = row.label;
        identity.append(dot, label);
        tdName.appendChild(identity);

        const tdReq = document.createElement("td");
        tdReq.className = "td-num";
        tdReq.title = row.requestsExact;
        tdReq.textContent = row.requestsCompact;

        const tdTok = document.createElement("td");
        tdTok.className = "td-num";
        tdTok.title = row.tokensExact;
        tdTok.textContent = row.tokensCompact;

        const tdShare = document.createElement("td");
        tdShare.className = "td-num";
        tdShare.textContent = row.tokenShareLabel;

        tr.append(tdName, tdReq, tdTok, tdShare);
        return tr;
      }),
    );
  };

  const renderInstallTable = (
    tbodyName: "versions" | "platforms" | "channels",
    rows: ReturnType<typeof buildVersionRows>,
    includeNewInstalls: boolean,
  ) => {
    const tbody = root.querySelector<HTMLTableSectionElement>(
      `[data-tbody="${tbodyName}"]`,
    );
    if (!tbody) return;
    const cols = includeNewInstalls ? 4 : 3;
    if (rows.length === 0) {
      tbody.replaceChildren(makeEmptyRow(cols, copy.noDataInTable));
      return;
    }
    tbody.replaceChildren(
      ...rows.map((row) => {
        const tr = document.createElement("tr");
        const tdLabel = document.createElement("td");
        tdLabel.className = "td-mono";
        tdLabel.textContent = row.label;

        const tdInstalls = document.createElement("td");
        tdInstalls.className = "td-num";
        tdInstalls.title = row.installsExact;
        tdInstalls.textContent = row.installsCompact;

        tr.append(tdLabel, tdInstalls);

        if (includeNewInstalls) {
          const tdNew = document.createElement("td");
          tdNew.className = "td-num";
          tdNew.title = row.newInstallsExact ?? "0";
          tdNew.textContent = row.newInstallsCompact ?? "0";
          tr.appendChild(tdNew);
        }

        const tdShare = document.createElement("td");
        tdShare.className = "td-num";
        tdShare.textContent = row.shareLabel;
        tr.appendChild(tdShare);
        return tr;
      }),
    );
  };

  const applyStatsSnapshot = (stats: TelemetryStatsV1) => {
    latestStats = stats;

    const updatedEl = root.querySelector<HTMLElement>("[data-updated-label]");
    const formattedTime = formatGeneratedTimestamp(stats.generatedAt, locale);
    if (updatedEl && formattedTime) {
      updatedEl.textContent = `${copy.updatedPrefix}: ${formattedTime}`;
    } else if (updatedEl) {
      updatedEl.textContent = `${copy.updatedPrefix}: ${copy.updatedPending}`;
    }

    for (const kpi of buildKpiStrip(stats, locale)) {
      const el = root.querySelector<HTMLElement>(`[data-kpi-value="${kpi.id}"]`);
      if (el) {
        el.textContent = kpi.compact;
        el.title = kpi.exactTitle;
      }
    }

    const tokenMix = buildTokenMix(stats.totals.tokens, locale);
    const totalMixEl = root.querySelector<HTMLElement>("[data-token-mix-total]");
    if (totalMixEl) {
      totalMixEl.textContent = tokenMix.totalCompact;
      totalMixEl.title = tokenMix.totalExactTitle;
    }
    for (const seg of tokenMix.segments) {
      const barSeg = root.querySelector<HTMLElement>(
        `[data-token-segment="${seg.id}"]`,
      );
      if (barSeg) {
        barSeg.style.flex = `${Math.max(seg.value, 0)} 1 0`;
        barSeg.style.minWidth = seg.value > 0 ? "3px" : "0";
        barSeg.title = `${seg.id}: ${seg.exactTitle} (${seg.percentLabel})`;
      }
      const valEl = root.querySelector<HTMLElement>(`[data-token-value="${seg.id}"]`);
      if (valEl) {
        valEl.textContent = seg.compact;
        valEl.title = seg.exactTitle;
      }
      const pctEl = root.querySelector<HTMLElement>(`[data-token-pct="${seg.id}"]`);
      if (pctEl) {
        pctEl.textContent = seg.percentLabel;
      }
    }

    renderHeatmap(stats);
    renderDailyChart();

    renderShareTable("providers", buildProviderShareRows(stats.providers, locale));
    renderShareTable("models", buildModelShareRows(stats.models, locale));

    renderInstallTable("versions", buildVersionRows(stats.versions, locale), true);
    renderInstallTable("platforms", buildPlatformRows(stats.platforms, locale), false);
    renderInstallTable("channels", buildChannelRows(stats.channels, locale), true);

    const reliability = buildReliabilitySummary(stats.outcomes, stats.errors, locale);
    const rateEl = root.querySelector<HTMLElement>("[data-completion-rate]");
    if (rateEl) {
      rateEl.textContent = reliability.completedRatioLabel;
    }
    for (const out of reliability.outcomes) {
      const segEl = root.querySelector<HTMLElement>(
        `[data-outcome-segment="${out.key}"]`,
      );
      if (segEl) {
        segEl.style.flex = `${Math.max(out.count, 0)} 1 0`;
        segEl.style.minWidth = out.count > 0 ? "3px" : "0";
        segEl.title = `${out.key}: ${out.exact} (${out.shareLabel})`;
      }
      const cntEl = root.querySelector<HTMLElement>(
        `[data-outcome-count="${out.key}"]`,
      );
      if (cntEl) {
        cntEl.textContent = out.compact;
        cntEl.title = out.exact;
      }
      const pctEl = root.querySelector<HTMLElement>(
        `[data-outcome-pct="${out.key}"]`,
      );
      if (pctEl) {
        pctEl.textContent = out.shareLabel;
      }
    }

    const errorsTbody = root.querySelector<HTMLTableSectionElement>(
      '[data-tbody="errors"]',
    );
    if (errorsTbody) {
      if (reliability.errors.length === 0) {
        errorsTbody.replaceChildren(makeEmptyRow(3, copy.noErrorsRecorded));
      } else {
        errorsTbody.replaceChildren(
          ...reliability.errors.map((err) => {
            const tr = document.createElement("tr");
            const tdCause = document.createElement("td");
            tdCause.className = "td-mono";
            tdCause.textContent = err.cause;

            const tdCount = document.createElement("td");
            tdCount.className = "td-num";
            tdCount.title = err.exact;
            tdCount.textContent = err.compact;

            const tdShare = document.createElement("td");
            tdShare.className = "td-num";
            tdShare.textContent = err.shareLabel;

            tr.append(tdCause, tdCount, tdShare);
            return tr;
          }),
        );
      }
    }
  };

  const loadTelemetryStats = async (range: TelemetryStatsRange) => {
    activeRange = range;
    syncRangePills();
    const ticket = statsSequencer.begin(range, DEFAULT_STATS_REQUEST_TIMEOUT_MS);
    setDashboardState("loading");
    try {
      const url = buildStatsUrl(range, statsEndpoint);
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: ticket.signal,
      });
      if (!ticket.isCurrent()) return;
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!ticket.isCurrent()) return;
      const classified = classifyStatsResponse({
        ok: response.ok,
        status: response.status,
        body,
      });
      if (classified.stats) {
        applyStatsSnapshot(classified.stats);
      } else {
        applyStatsSnapshot(createEmptyStatsSnapshot(range));
      }
      setDashboardState(classified.state, classified.detail);
    } catch (error) {
      if (!ticket.isCurrent()) return;
      const isAbort =
        error instanceof Error && error.name === "AbortError";
      const detailMessage =
        ticket.didTimeout() || isAbort
          ? "Request timed out"
          : error instanceof Error
            ? error.message
            : String(error);
      const classified = classifyStatsResponse({
        networkError: true,
        errorMessage: detailMessage,
      });
      applyStatsSnapshot(createEmptyStatsSnapshot(range));
      setDashboardState(classified.state, classified.detail);
    } finally {
      ticket.finish();
    }
  };

  const loadDownloads = async () => {
    const [npmWeekly, npmMonthly, npmYearly, githubReleases] = await Promise.all([
      fetchJsonWithTimeout(root.dataset.npmWeeklyUrl, DEFAULT_STATS_REQUEST_TIMEOUT_MS),
      fetchJsonWithTimeout(root.dataset.npmMonthlyUrl, DEFAULT_STATS_REQUEST_TIMEOUT_MS),
      fetchJsonWithTimeout(root.dataset.npmYearlyUrl, DEFAULT_STATS_REQUEST_TIMEOUT_MS),
      fetchGithubReleasesPages(root.dataset.githubReleasesUrl, DEFAULT_STATS_REQUEST_TIMEOUT_MS),
    ]);

    const dl = parseDownloadsPayload({
      npmWeekly,
      npmMonthly,
      npmYearly,
      githubReleases,
    });

    const setDlValue = (selector: string, value: number | null) => {
      const el = root.querySelector<HTMLElement>(selector);
      if (!el) return;
      if (value === null) {
        el.textContent = "—";
        el.title = copy.downloadsUnavailable;
      } else {
        el.textContent = formatCompactNumber(value);
        el.title = formatExactNumber(value, locale);
      }
    };

    setDlValue("[data-dl-npm-weekly]", dl.npmWeekly);
    setDlValue("[data-dl-npm-monthly]", dl.npmMonthly);
    setDlValue("[data-dl-npm-yearly]", dl.npmYearly);
    const ghTotalEl = root.querySelector<HTMLElement>("[data-dl-gh-total]");
    if (ghTotalEl) {
      if (dl.githubTotalDownloads === null) {
        ghTotalEl.textContent = "—";
        ghTotalEl.title = copy.downloadsUnavailable;
        delete ghTotalEl.dataset.partial;
      } else if (dl.githubDownloadsPartial) {
        const partialLabel = copy.downloadsPartial || "partial";
        ghTotalEl.textContent = `${formatCompactNumber(dl.githubTotalDownloads)} (${partialLabel})`;
        ghTotalEl.title = `${formatExactNumber(dl.githubTotalDownloads, locale)} (${partialLabel})`;
        ghTotalEl.dataset.partial = "true";
      } else {
        ghTotalEl.textContent = formatCompactNumber(dl.githubTotalDownloads);
        ghTotalEl.title = formatExactNumber(dl.githubTotalDownloads, locale);
        ghTotalEl.dataset.partial = "false";
      }
    }
    setDlValue("[data-dl-gh-latest]", dl.githubLatestDownloads);

    const latestTagEl = root.querySelector<HTMLElement>("[data-dl-gh-latest-tag]");
    if (latestTagEl && dl.githubLatestTag) {
      latestTagEl.textContent = `(${dl.githubLatestTag})`;
    }
  };

  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-range-pill]")) {
    btn.addEventListener("click", () => {
      const nextRange = parseStatsRangeParam(btn.dataset.rangePill);
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("range", nextRange);
      window.history.replaceState(null, "", nextUrl.toString());
      void loadTelemetryStats(nextRange);
    });
  }

  for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-chart-metric]")) {
    btn.addEventListener("click", () => {
      activeChartMetric =
        btn.dataset.chartMetric === "requests" ? "requests" : "tokens";
      syncChartMetricPills();
      renderDailyChart();
    });
  }

  const retryBtn = root.querySelector<HTMLButtonElement>("[data-retry-btn]");
  retryBtn?.addEventListener("click", () => {
    void loadTelemetryStats(activeRange);
  });

  window.addEventListener("resize", () => chartInstance?.resize());
  new MutationObserver(() => renderDailyChart()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  renderDailyChart();
  void loadTelemetryStats(activeRange);
  void loadDownloads();
}
