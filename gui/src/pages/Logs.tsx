import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n, LOCALES, type TFn } from "../i18n";
import { formatTokens } from "../format-tokens";
import { statusCodeInfo } from "../status-codes";
import { IconX } from "../icons";
import { modelLabel } from "../model-display";
import { EmptyState } from "../ui";

interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
}

type LogUsageStatus = "reported" | "unreported" | "unsupported" | "estimated";

interface LogEntry {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  surface?: "claude";
  requestedEffort?: string;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  responseServiceTier?: string;
  resolvedModel?: string;
  modelSupportsServiceTier?: boolean;
  status: number;
  durationMs: number;
  errorCode?: string;
  upstreamError?: string;
  usageStatus?: LogUsageStatus;
  usage?: UsageBreakdown;
  totalTokens?: number;
}

function tokensTitle(log: LogEntry, t: TFn): string | undefined {
  if (!log.usage) return undefined;
  const split = cacheSplit(log);
  const parts = [
    `${t("logs.tokens.input")}=${log.usage.inputTokens}`,
    `${t("logs.tokens.output")}=${log.usage.outputTokens}`,
  ];
  if (split.read !== undefined) parts.push(`${t("logs.tokens.cacheRead")}=${split.read}`);
  if (split.write !== undefined) parts.push(`${t("logs.tokens.cacheWrite")}=${split.write}`);
  if (typeof log.usage.reasoningOutputTokens === "number") parts.push(`${t("logs.tokens.reasoning")}=${log.usage.reasoningOutputTokens}`);
  if (log.usageStatus === "estimated") parts.push(t("logs.tokens.estimatedNote"));
  if (log.usageStatus === "estimated" && split.read === undefined && split.write === undefined) {
    parts.push(t("logs.tokens.noCacheNote"));
  }
  return parts.join(" \xC2\xB7 ");
}

function displayTokenTotal(log: LogEntry): number | undefined {
  if (!log.usage) return typeof log.totalTokens === "number" ? log.totalTokens : undefined;
  // inputTokens is inclusive of cache read/write (canonical convention, devlog 070);
  // never re-add cache detail. max() keeps legacy pre-070 rows honest.
  const baseTotal = log.usage.inputTokens + log.usage.outputTokens;
  const explicitTotal = log.usage.totalTokens ?? log.totalTokens;
  return typeof explicitTotal === "number" ? Math.max(explicitTotal, baseTotal) : baseTotal;
}

/** Cache read/write split; recovers reads from legacy rows that stored read+write combined. */
function cacheSplit(log: LogEntry): { read?: number; write?: number } {
  const u = log.usage;
  if (!u) return {};
  const write = typeof u.cacheCreationInputTokens === "number" ? u.cacheCreationInputTokens : undefined;
  const read = typeof u.cacheReadInputTokens === "number"
    ? u.cacheReadInputTokens
    : typeof u.cachedInputTokens === "number" && write !== undefined
      ? Math.max(0, u.cachedInputTokens - write)
      : u.cachedInputTokens;
  return { read, write };
}

function speedLabel(log: LogEntry): string | undefined {
  if (log.requestedSpeedLabel) return log.requestedSpeedLabel;
  if (log.modelSupportsServiceTier && log.configuredSpeedLabel) return log.configuredSpeedLabel;
  return undefined;
}

function modelTitle(log: LogEntry): string {
  const details = [
    `model=${log.model}`,
    log.resolvedModel ? `resolved=${log.resolvedModel}` : undefined,
    log.requestedServiceTier ? `requestedTier=${log.requestedServiceTier}` : undefined,
    log.configuredServiceTier ? `configuredTier=${log.configuredServiceTier}` : undefined,
    log.responseServiceTier ? `responseTier=${log.responseServiceTier}` : undefined,
    log.modelSupportsServiceTier !== undefined ? `supportsTier=${log.modelSupportsServiceTier}` : undefined,
  ].filter(Boolean);
  return details.join(" \xC2\xB7 ");
}

export default function Logs({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [detail, setDetail] = useState<LogEntry | null>(null);
  const [surfaceFilter, setSurfaceFilter] = useState<"all" | "claude" | "codex">("all");
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await fetch(`${apiBase}/api/logs`);
        setLogs(await res.json());
      } catch { /* ignore */ }
    };
    fetchLogs();
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [apiBase, autoRefresh]);

  const statusColor = (s: number) => s >= 200 && s < 300 ? "var(--green)" : s >= 400 ? "var(--red)" : "var(--amber)";

  const detailInfo = detail ? statusCodeInfo(detail.status, locale) : null;
  const filteredLogs = logs.filter(log => (
    surfaceFilter === "all"
    || (surfaceFilter === "claude" ? log.surface === "claude" : log.surface !== "claude")
  ));

  // TanStack Virtual returns unstable function identities; React Compiler skips this call.
  // eslint-disable-next-line react-hooks/incompatible-library -- known useVirtualizer limitation
  const rowVirtualizer = useVirtualizer({
    count: filteredLogs.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 44,
    overscan: 15,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length > 0
    ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;

  return (
    <>
      <div className="page-head">
        <h2>{t("logs.title")}</h2>
        <label className="muted text-control" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
          {t("logs.autoRefresh")}
        </label>
      </div>
      <p className="page-sub">{t("logs.subtitle")}</p>

      <div className="row" style={{ gap: 8, marginBottom: 12, alignItems: "center" }}>
        <span className="muted text-control">{t("logs.filter.surface.label")}</span>
        <div className="segmented" role="radiogroup" aria-label={t("logs.filter.surface.label")} style={{ display: "inline-flex", borderRadius: "var(--radius-pill)", background: "var(--surface-soft, var(--raised))", padding: 3, gap: 2 }}>
          {(["all", "claude", "codex"] as const).map(surface => (
            <button
              key={surface}
              type="button"
              role="radio"
              aria-checked={surfaceFilter === surface}
              className={`btn btn-sm${surfaceFilter === surface ? " btn-primary" : " btn-ghost"}`}
              style={{ borderRadius: "var(--radius-pill)", minWidth: 64, padding: "5px 12px", border: "none", background: surfaceFilter === surface ? undefined : "transparent", color: surfaceFilter === surface ? undefined : "var(--muted)" }}
              onClick={() => setSurfaceFilter(surface)}
            >
              {t(`logs.filter.surface.${surface}`)}
            </button>
          ))}
        </div>
      </div>

      {filteredLogs.length === 0 ? (
        <EmptyState title={t("logs.noRequests")} />
      ) : (
        <div ref={scrollContainerRef} className="tbl-wrap" style={{ overflowY: "auto", maxHeight: "calc(100vh - 260px)" }}>
          <table className="tbl">
            <thead style={{ position: "sticky", top: 0, zIndex: 1, background: "var(--surface)" }}>
             <tr>
               <th>{t("logs.col.time")}</th>
                <th className="num log-col-tokens">{t("logs.col.tokens")}</th>
               <th className="log-col-model">{t("logs.col.model")}</th>
               <th>{t("logs.col.effort")}</th>
               <th>{t("logs.col.provider")}</th>
               <th>{t("logs.col.status")}</th>
                <th>{t("logs.col.request")}</th>
               <th className="num">{t("logs.col.duration")}</th>
             </tr>
            </thead>
            <tbody>
              {paddingTop > 0 && (
                <tr>
                  <td colSpan={8} style={{ height: paddingTop, padding: 0, border: 0 }} />
                </tr>
              )}
              {virtualRows.map(virtualRow => {
                const log = filteredLogs[filteredLogs.length - 1 - virtualRow.index];
                return (
               <tr
                 key={log.requestId ?? `${log.timestamp}-${virtualRow.index}`}
                 data-index={virtualRow.index}
                 ref={rowVirtualizer.measureElement}
               >
                 <td className="muted mono">{new Date(log.timestamp).toLocaleTimeString(localeTag)}</td>
                  <td className="num mono log-col-tokens" title={tokensTitle(log, t)}>
                    {(() => {
                      const tokenTotal = displayTokenTotal(log);
                      const { read, write } = cacheSplit(log);
                      return tokenTotal !== undefined
                        ? (
                            <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                              <span>{log.usageStatus === "estimated" ? "~" : ""}{formatTokens(tokenTotal, locale)}</span>
                              {(read !== undefined && read > 0) && (
                                <span className="muted text-caption leading-tight">
                                  c {formatTokens(read, locale)}
                                </span>
                              )}
                              {(write !== undefined && write > 0) && (
                                <span className="muted text-caption leading-tight">
                                  w {formatTokens(write, locale)}
                                </span>
                              )}
                              {(log.usageStatus === "estimated" && read === undefined && write === undefined) && (
                                <span className="muted text-caption leading-tight">
                                  {t("logs.tokens.noCache")}
                                </span>
                              )}
                            </span>
                          )
                        : <span className="muted">{t(`logs.tokens.${log.usageStatus ?? "unreported"}`)}</span>;
                    })()}
                  </td>
                 <td className="mono log-col-model" title={modelTitle(log)}>
                   <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span>{modelLabel(log.resolvedModel ?? log.model)}</span>
                      {log.surface === "claude" && <span className="badge badge-accent">{t("logs.badge.claude")}</span>}
                      {speedLabel(log) && <span className="badge badge-amber">{speedLabel(log)}</span>}
                    </span>
                  </td>
                  <td className="mono">{log.requestedEffort ?? "-"}</td>
                  <td className="muted">{log.provider}</td>
                  <td>
                    <span className="log-status-cell">
                      <span className="mono font-semibold" style={{ color: statusColor(log.status) }}>{log.status}</span>
                      {log.status >= 400 && (
                        <button type="button" className="log-detail-btn" onClick={() => setDetail(log)}>
                          {t("logs.details")}
                        </button>
                      )}
                    </span>
                 </td>
                  <td className="muted mono"><span className="log-reqid" title={log.requestId}>{log.requestId ?? "-"}</span></td>
                 <td className="num">{log.durationMs}ms</td>
                </tr>
                );
              })}
              {paddingBottom > 0 && (
                <tr>
                  <td colSpan={8} style={{ height: paddingBottom, padding: 0, border: 0 }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div role="dialog" aria-modal="true" aria-label={t("logs.detailTitle")} className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <h3>
                <span className="mono" style={{ color: statusColor(detail.status) }}>{detail.status}</span>
                {detailInfo && <span style={{ marginLeft: 8 }}>{detailInfo.label}</span>}
              </h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setDetail(null)} aria-label={t("common.cancel")}><IconX /></button>
            </div>
            {detailInfo && <p className="modal-desc">{detailInfo.description}</p>}
            <div className="log-detail-grid">
              <span className="muted">{t("logs.col.time")}</span><span className="mono">{new Date(detail.timestamp).toLocaleString(localeTag)}</span>
              <span className="muted">{t("logs.col.request")}</span><span className="mono log-detail-break">{detail.requestId ?? "-"}</span>
              <span className="muted">{t("logs.col.model")}</span><span className="mono">{modelLabel(detail.resolvedModel ?? detail.model)}</span>
              <span className="muted">{t("logs.col.provider")}</span><span>{detail.provider}</span>
              {detail.errorCode && (<><span className="muted">{t("logs.col.error")}</span><span className="mono">{detail.errorCode}</span></>)}
              {detail.upstreamError && (<><span className="muted">{t("logs.col.upstreamReason")}</span><span className="mono log-detail-break">{detail.upstreamError}</span></>)}
              <span className="muted">{t("logs.col.duration")}</span><span className="mono">{detail.durationMs}ms</span>
            </div>
            <div className="muted text-label" style={{ margin: "12px 0 6px" }}>{t("logs.detailRaw")}</div>
            <pre className="log-detail-json">{JSON.stringify(detail, null, 2)}</pre>
          </div>
        </div>
      )}
    </>
  );
}
