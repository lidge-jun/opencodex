import { useCallback, useState } from "react";
import { useDataSurface } from "../data-surface";
import { formatTokens } from "../format-tokens";
import { useI18n } from "../i18n/shared";
import { formatProviderDisplayName } from "../provider-icons";
import type { UsageReadMetadata } from "../usage-summary-resource";
import { Notice } from "../ui";
import { DataSurfaceSkeleton } from "./data-surface";
import { UsageIncompleteNotice } from "./usage-incomplete-notice";

type JevStatsRange = "7d" | "30d" | "all";

interface JevStatsResponse extends UsageReadMetadata {
  range: JevStatsRange;
  comboId: string | null;
  generatedAt: number;
  summary: {
    decisions: number;
    appliedDecisions: number;
    failOpenDecisions: number;
    successfulRequests: number;
    requestsWithModelFallback: number;
    modelAttempts: number;
    measuredModelAttempts: number;
    modelInputTokens: number;
    modelOutputTokens: number;
    modelReasoningTokens: number;
    modelCacheReadTokens: number;
    modelCacheWriteTokens: number;
    modelTotalTokens: number;
    decisionUsageReported: number;
    decisionInputTokens: number;
    decisionOutputTokens: number;
    decisionTotalTokens: number;
    averageLatencyMs: number | null;
    averageConfidence: number | null;
    averageChosenProbability: number | null;
  };
  gates: Array<{ gate: string; decisions: number }>;
  models: Array<{
    provider: string;
    model: string;
    overflow: boolean;
    picks: number;
    appliedPicks: number;
    failOpenPicks: number;
    attempts: number;
    measuredAttempts: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    efforts: Array<{ effort: string | null; picks: number }>;
  }>;
  historyTruncated: boolean;
  entriesTruncated: boolean;
  error?: string;
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function formatLatency(value: number | null, locale: string): string {
  if (value === null) return "—";
  const seconds = value >= 1_000;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: seconds ? "second" : "millisecond",
    unitDisplay: "short",
    maximumFractionDigits: seconds && value < 10_000 ? 1 : 0,
  }).format(seconds ? value / 1_000 : value);
}

export function JevStatsPanel({
  apiBase,
  comboId,
  active,
}: {
  apiBase: string;
  comboId: string;
  active: boolean;
}) {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<JevStatsRange>("30d");
  const load = useCallback(async (signal: AbortSignal): Promise<JevStatsResponse> => {
    const query = new URLSearchParams({ jev: "1", comboId, range });
    const response = await fetch(`${apiBase}/api/usage?${query}`, { signal });
    if (!response.ok) throw new Error(String(response.status));
    return response.json() as Promise<JevStatsResponse>;
  }, [apiBase, comboId, range]);
  const resource = useDataSurface<JevStatsResponse>(
    `ocx.jev-stats.v1:${apiBase}:${comboId}:${range}`,
    [apiBase, comboId, range],
    load,
    {
      isEmpty: data => data.summary.decisions === 0,
      enabled: active,
      pollMs: 30_000,
      pauseWhenHidden: true,
      deadlineMs: 60_000,
    },
  );
  const { state } = resource;
  const data = state.data;

  if (!active) return null;

  return (
    <section className="jev-stats" aria-busy={state.refreshing}>
      <div className="jev-stats-toolbar">
        <div className="segmented jev-stats-ranges" role="group" aria-label={t("cws.jev.stats.range") }>
          {(["7d", "30d", "all"] as const).map(option => (
            <button
              key={option}
              type="button"
              className={`btn btn-sm ${range === option ? "btn-primary" : "btn-ghost"}`}
              aria-pressed={range === option}
              onClick={() => setRange(option)}
            >
              {option === "all" ? t("usage.range.available") : t(`usage.range.${option}`)}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh()}>
          {t("cws.jev.stats.refresh")}
        </button>
      </div>

      {state.showSkeleton && <DataSurfaceSkeleton label={t("cws.jev.stats.loading")} rows={4} />}
      {state.showError && <Notice tone="err">{t("cws.jev.stats.loadFailed")}</Notice>}
      {data && (
        <>
          <UsageIncompleteNotice data={data} />
          {(data.historyTruncated || data.entriesTruncated) && (
            <Notice tone="warn">{t("cws.jev.stats.historyIncomplete")}</Notice>
          )}
          {data.error && <Notice tone="err">{t("cws.jev.stats.loadFailed")}</Notice>}
          {data.summary.decisions === 0 ? (
            <div className="jev-stats-empty">
              <h3>{t("cws.jev.stats.emptyTitle")}</h3>
              <p className="muted">{t("cws.jev.stats.emptyBody")}</p>
            </div>
          ) : (
            <>
              <div className="jev-stats-cards">
                <div className="stat">
                  <div className="muted">{t("cws.jev.stats.decisions")}</div>
                  <div className="stat-value">{data.summary.decisions.toLocaleString(locale)}</div>
                  <div className="muted text-caption">
                    {t("cws.jev.stats.appliedAndFailOpen", {
                      applied: data.summary.appliedDecisions,
                      failOpen: data.summary.failOpenDecisions,
                    })}
                  </div>
                </div>
                <div className="stat">
                  <div className="muted">{t("cws.jev.stats.modelTokens")}</div>
                  <div className="stat-value">{formatTokens(data.summary.modelTotalTokens, locale)}</div>
                  <div className="muted text-caption">
                    {t("cws.jev.stats.measuredAttempts", {
                      measured: data.summary.measuredModelAttempts,
                      total: data.summary.modelAttempts,
                    })}
                  </div>
                </div>
                <div className="stat">
                  <div className="muted">{t("cws.jev.stats.decisionTokens")}</div>
                  <div className="stat-value">{formatTokens(data.summary.decisionTotalTokens, locale)}</div>
                  <div className="muted text-caption">
                    {t("cws.jev.stats.measuredDecisions", {
                      measured: data.summary.decisionUsageReported,
                      total: data.summary.decisions,
                    })}
                  </div>
                </div>
              </div>

              <div className="jev-stats-facts">
                <span>{t("cws.jev.stats.successful", { count: data.summary.successfulRequests })}</span>
                <span>{t(
                  data.summary.requestsWithModelFallback === 1
                    ? "cws.jev.stats.fallbackOne"
                    : "cws.jev.stats.fallbackMany",
                  { count: data.summary.requestsWithModelFallback },
                )}</span>
                <span>{t("cws.jev.stats.averageLatency", { value: formatLatency(data.summary.averageLatencyMs, locale) })}</span>
                <span>{t("cws.jev.stats.averageConfidence", { value: formatPercent(data.summary.averageConfidence) })}</span>
              </div>

              <div className="jev-stats-gates" aria-label={t("cws.jev.stats.gates") }>
                {data.gates.map(gate => (
                  <span className="chip" key={gate.gate}>{gate.gate}: {gate.decisions}</span>
                ))}
              </div>

              <div className="jev-stats-table-wrap">
                <table className="jev-stats-table">
                  <thead>
                    <tr>
                      <th>{t("cws.jev.stats.model")}</th>
                      <th className="num">{t("cws.jev.stats.picks")}</th>
                      <th>{t("cws.jev.stats.efforts")}</th>
                      <th className="num">{t("cws.jev.stats.attempts")}</th>
                      <th className="num">{t("cws.jev.stats.input")}</th>
                      <th className="num">{t("cws.jev.stats.output")}</th>
                      <th className="num">{t("cws.jev.stats.reasoning")}</th>
                      <th className="num">{t("cws.jev.stats.cacheReadWrite")}</th>
                      <th className="num">{t("cws.jev.stats.total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.models.map(model => (
                      <tr key={model.overflow ? "__jev_stats_overflow__" : `${model.provider}\0${model.model}`}>
                        <td>
                          {model.overflow ? (
                            <div>{t("cws.jev.stats.otherModels")}</div>
                          ) : (
                            <>
                              <div className="mono">{model.model}</div>
                              <div className="muted text-caption">{formatProviderDisplayName(model.provider, t)}</div>
                            </>
                          )}
                        </td>
                        <td className="num mono">
                          {model.picks}
                          <span className="jev-stats-cell-note">{t("cws.jev.stats.appliedAndFailOpen", {
                            applied: model.appliedPicks,
                            failOpen: model.failOpenPicks,
                          })}</span>
                        </td>
                        <td>{model.efforts.length > 0
                          ? model.efforts.map(effort => `${effort.effort ?? t("cws.jev.stats.noEffort")} × ${effort.picks}`).join(", ")
                          : "—"}</td>
                        <td className="num mono">
                          {model.attempts}
                          <span className="jev-stats-cell-note">{model.measuredAttempts} {t("cws.jev.stats.measuredShort")}</span>
                        </td>
                        <td className="num mono">{formatTokens(model.inputTokens, locale)}</td>
                        <td className="num mono">{formatTokens(model.outputTokens, locale)}</td>
                        <td className="num mono">{formatTokens(model.reasoningTokens, locale)}</td>
                        <td className="num mono">{formatTokens(model.cacheReadTokens, locale)} / {formatTokens(model.cacheWriteTokens, locale)}</td>
                        <td className="num mono">{formatTokens(model.totalTokens, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted text-caption jev-stats-footnote">{t("cws.jev.stats.tokenFootnote")}</p>
            </>
          )}
        </>
      )}
    </section>
  );
}
