import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n, LOCALES, type TFn } from "../i18n/shared";
import { formatTokens } from "../format-tokens";
import { hashLogConversationQuery, matchesLogConversationId } from "../log-conversation-id";
import { statusCodeInfo } from "../status-codes";
import { IconX } from "../icons";
import { modelLabel } from "../model-display";
import { EmptyState, Notice } from "../ui";
import Debug from "./Debug";

import type { LogsTab } from "./logs-tab-keydown";
import { logsTabKeyDown, readTabFromHash, selectLogsTab } from "./logs-tab-keydown";

interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  estimated?: boolean;
}

type LogUsageStatus = "reported" | "unreported" | "unsupported" | "estimated";

type MetricUnavailableReason =
  | "usage_missing" | "usage_unsupported" | "output_missing" | "invalid_duration"
  | "price_unmatched" | "invalid_cache_breakdown"
  | "invalid_usage" | "combo_attempt_unavailable";

type CostEstimateReason = "usage_estimated" | "cache_detail_missing" | "expected_price_overlay";

type TokPerSecondResult =
  | { kind: "value"; value: number; estimated: boolean }
  | { kind: "unavailable"; reason: MetricUnavailableReason };

interface MatchedPriceInfo {
  provider: string;
  modelId: string;
  jawcodeProvider?: string;
  source: "jawcode" | "expected";
  sourceRef?: string;
  verifiedAt?: string;
  status: "verified" | "verified-derived";
}

type CostResult =
  | {
    kind: "value";
    estimate: {
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
      estimated: boolean;
      price?: MatchedPriceInfo;
      attempts?: Array<{ ordinal: number; price: MatchedPriceInfo }>;
    };
    estimateReasons: CostEstimateReason[];
  }
  | { kind: "unavailable"; reason: MetricUnavailableReason };

interface LogDisplayMetrics {
  tokPerSecond: TokPerSecondResult;
  cost: CostResult;
}

type AttemptRecoveryKind =
  | "transient-5xx"
  | "connection-reset"
  | "oauth-401"
  | "key-429"
  | "image-413";

interface LogAttempt {
  ordinal: number;
  provider: string;
  model: string;
  adapter: string;
  status: number;
  durationMs: number;
  sendCount: number;
  recoveryKinds: AttemptRecoveryKind[];
  usageStatus: LogUsageStatus;
  inputTokenEstimate?: number;
  usage?: UsageBreakdown;
  totalTokens?: number;
  errorCode?: string;
  firstOutputMs?: number;
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number;
  displayMetrics?: LogDisplayMetrics;
}

interface LogEntry {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  surface?: "claude";
  conversationId?: string;
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number;
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
  firstOutputMs?: number;
  attempts?: LogAttempt[];
  displayMetrics?: LogDisplayMetrics;
}

function isCursorUsageProvider(provider: string): boolean {
  return provider === "cursor" || provider.startsWith("cursor-");
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
    parts.push(t(isCursorUsageProvider(log.provider) ? "logs.tokens.noCacheCursorNote" : "logs.tokens.noCacheNote"));
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

interface ReasoningLogFields {
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number;
}

function effortLabel(log: ReasoningLogFields): string {
  const requested = log.requestedEffort?.replace(/\s*->\s*/g, " → ");
  const effective = log.effectiveEffort;
  if (!requested) return effective ?? "-";
  // requestedEffort may already contain a cap/clamp chain (for example max->high).
  // Only append the adapter result when it differs from that chain's terminal value.
  if (!effective || requested === effective || requested.split(" → ").at(-1) === effective) return requested;
  return `${requested} → ${effective}`;
}

function reasoningWireLabel(log: ReasoningLogFields): string | undefined {
  if (!log.reasoningWireField || log.reasoningWireValue === undefined) return undefined;
  return `${log.reasoningWireField}=${log.reasoningWireValue}`;
}

function formatTokPerSecond(result: TokPerSecondResult | undefined, localeTag?: string): string {
  if (!result || result.kind === "unavailable" || !Number.isFinite(result.value) || result.value <= 0) return "\u2014";
  const digits = result.value >= 100 ? 0 : 1;
  const value = new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(result.value);
  return `${result.estimated ? "~" : ""}${value}`;
}

function formatEstimatedUsd(result: CostResult | undefined, localeTag?: string): string {
  if (!result || result.kind === "unavailable" || !Number.isFinite(result.estimate.cost.total) || result.estimate.cost.total < 0) return "\u2014";
  const totalUsd = result.estimate.cost.total;
  return `~$${new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(totalUsd)}`;
}

function formatEstimatedUsdValue(value: number, localeTag?: string): string {
  if (!Number.isFinite(value) || value < 0) return "\u2014";
  return `~$${new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value)}`;
}

const METRIC_REASON_KEYS = {
  usage_missing: "logs.detail.reason.usage_missing",
  usage_unsupported: "logs.detail.reason.usage_unsupported",
  output_missing: "logs.detail.reason.output_missing",
  invalid_duration: "logs.detail.reason.invalid_duration",
  price_unmatched: "logs.detail.reason.price_unmatched",
  invalid_cache_breakdown: "logs.detail.reason.invalid_cache_breakdown",
  invalid_usage: "logs.detail.reason.invalid_usage",
  combo_attempt_unavailable: "logs.detail.reason.combo_attempt_unavailable",
} as const satisfies Record<MetricUnavailableReason, string>;

const ESTIMATE_REASON_KEYS = {
  usage_estimated: "logs.detail.estimate.usage_estimated",
  cache_detail_missing: "logs.detail.estimate.cache_detail_missing",
  expected_price_overlay: "logs.detail.estimate.expected_price_overlay",
} as const satisfies Record<CostEstimateReason, string>;

function metricReasonKey(reason: MetricUnavailableReason) {
  return METRIC_REASON_KEYS[reason];
}

function estimateReasonKey(reason: CostEstimateReason) {
  return ESTIMATE_REASON_KEYS[reason];
}

function verificationKey(status: MatchedPriceInfo["status"]): "logs.detail.verification.verified" | "logs.detail.verification.derived" {
  return status === "verified" ? "logs.detail.verification.verified" : "logs.detail.verification.derived";
}

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return "var(--green)";
  if (status >= 400) return "var(--red)";
  return "var(--amber)";
}

function formatLogTimestamp(ts: number, localeTag?: string): string {
  return new Date(ts).toLocaleTimeString(localeTag);
}

function formatLogDateTime(ts: number, localeTag?: string): string {
  return new Date(ts).toLocaleString(localeTag);
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

function summarizeFilteredLogs(entries: LogEntry[]): {
  requests: number;
  totalTokens: number;
  estimatedCostUsd: number;
  unpricedRequests: number;
  unmeteredRequests: number;
} {
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let unpricedRequests = 0;
  let unmeteredRequests = 0;
  for (const entry of entries) {
    const tokens = displayTokenTotal(entry);
    if (tokens !== undefined) totalTokens += tokens;
    if (entry.usageStatus === "unsupported") {
      unmeteredRequests += 1;
      continue;
    }
    const cost = entry.displayMetrics?.cost;
    if (cost?.kind === "value" && Number.isFinite(cost.estimate.cost.total) && cost.estimate.cost.total >= 0) {
      estimatedCostUsd += cost.estimate.cost.total;
      continue;
    }
    unpricedRequests += 1;
  }
  return { requests: entries.length, totalTokens, estimatedCostUsd, unpricedRequests, unmeteredRequests };
}

export default function Logs({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [detail, setDetail] = useState<LogEntry | null>(null);
  const [surfaceFilter, setSurfaceFilter] = useState<"all" | "claude" | "codex">("all");
  const [conversationFilter, setConversationFilter] = useState("");
  const [conversationQueryHash, setConversationQueryHash] = useState<string | undefined>();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  // The hash is the source of truth for the active tab (#logs vs #logs/debug),
  // so refresh/bookmark/back-forward keep the tab choice.
  const [tab, setTab] = useState<LogsTab>(readTabFromHash);

  useEffect(() => {
    const onHash = () => setTab(readTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const selectTab = selectLogsTab;

  const fetchLogs = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    // Silent polls must not clear an existing error or toggle loading — otherwise
    // failures flicker between the error banner, empty state, and stale table.
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/logs`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      setLogs(await res.json());
      setError(null);
    } catch (cause) {
      if (silent) return;
      const detail = cause instanceof Error ? cause.message : "";
      setError(detail ? `${t("logs.loadError")} ${detail}` : t("logs.loadError"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    if (tab !== "logs") return;
    void fetchLogs();
    if (!autoRefresh) return;
    const interval = setInterval(() => void fetchLogs({ silent: true }), 2000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs, tab]);

  const detailInfo = detail ? statusCodeInfo(detail.status, locale) : null;
  const conversationQuery = conversationFilter.trim();

  useEffect(() => {
    let cancelled = false;
    if (!conversationQuery) {
      setConversationQueryHash(undefined);
      return;
    }
    void hashLogConversationQuery(conversationQuery).then(hash => {
      if (!cancelled) setConversationQueryHash(hash);
    });
    return () => { cancelled = true; };
  }, [conversationQuery]);

  const filteredLogs = logs.filter(log => (
    (surfaceFilter === "all"
      || (surfaceFilter === "claude" ? log.surface === "claude" : log.surface !== "claude"))
    && (!conversationQuery || matchesLogConversationId(log.conversationId, conversationQuery, conversationQueryHash))
  ));
  const conversationTotals = conversationQuery ? summarizeFilteredLogs(filteredLogs) : null;

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
        <h2>{t("nav.logs")}</h2>
        {tab === "logs" && (
          <label className="muted text-control" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            {t("logs.autoRefresh")}
          </label>
        )}
      </div>
      <div className="page-tabs" role="tablist" aria-label={t("nav.logs")}>
        <button
          type="button"
          role="tab"
          id="logs-tab-logs"
          aria-selected={tab === "logs"}
          aria-controls="logs-panel-logs"
          tabIndex={tab === "logs" ? 0 : -1}
          className={`page-tab${tab === "logs" ? " page-tab--active" : ""}`}
          onClick={() => selectTab("logs")}
          onKeyDown={logsTabKeyDown}
        >
          {t("logs.tabLogs")}
        </button>
        <button
          type="button"
          role="tab"
          id="logs-tab-debug"
          aria-selected={tab === "debug"}
          aria-controls="logs-panel-debug"
          tabIndex={tab === "debug" ? 0 : -1}
          className={`page-tab${tab === "debug" ? " page-tab--active" : ""}`}
          onClick={() => selectTab("debug")}
          onKeyDown={logsTabKeyDown}
        >
          {t("logs.tabDebug")}
        </button>
      </div>

      {tab === "debug" && (
        <div role="tabpanel" id="logs-panel-debug" aria-labelledby="logs-tab-debug">
          <Debug apiBase={apiBase} embedded />
        </div>
      )}

      {tab === "logs" && (
      <div role="tabpanel" id="logs-panel-logs" aria-labelledby="logs-tab-logs">
      <p className="page-sub">{t("logs.subtitle")}</p>

      <div className="row" style={{ gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
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
        <label className="muted text-control" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {t("logs.filter.conversation.label")}
          <input
            type="search"
            className="input mono"
            value={conversationFilter}
            onChange={e => setConversationFilter(e.target.value)}
            placeholder={t("logs.filter.conversation.placeholder")}
            aria-label={t("logs.filter.conversation.label")}
            style={{ minWidth: 220, maxWidth: 360 }}
          />
        </label>
        {conversationQuery && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConversationFilter("")}>
            {t("logs.filter.conversation.clear")}
          </button>
        )}
      </div>

      {conversationTotals && (
        <div style={{ marginBottom: 12 }}>
          <Notice tone="ok">
            {t("logs.conversation.totals", {
              requests: conversationTotals.requests,
              tokens: formatTokens(conversationTotals.totalTokens, localeTag ?? locale),
              cost: formatEstimatedUsdValue(conversationTotals.estimatedCostUsd, localeTag),
            })}
            {" "}
            <span className="muted">
              {t("logs.conversation.scope")}
              {(conversationTotals.unpricedRequests + conversationTotals.unmeteredRequests) > 0
                ? ` ${t("logs.conversation.excluded", {
                  unpriced: conversationTotals.unpricedRequests,
                  unmetered: conversationTotals.unmeteredRequests,
                })}`
                : ""}
            </span>
          </Notice>
        </div>
      )}

      {error ? (
        <Notice tone="err">
          {error}{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void fetchLogs()} disabled={loading}>
            {t("common.retry")}
          </button>
        </Notice>
      ) : loading && logs.length === 0 ? (
        <EmptyState title={t("common.loading")} />
      ) : filteredLogs.length === 0 ? (
        <EmptyState title={t("logs.noRequests")} />
      ) : (
        <>
        <div ref={scrollContainerRef} className="tbl-wrap" style={{ overflowY: "auto", maxHeight: "calc(100vh - 260px)" }}>
          <table className="tbl logs-table">
            <thead style={{ position: "sticky", top: 0, zIndex: 1, background: "var(--surface)" }}>
             <tr>
               <th>{t("logs.col.time")}</th>
                <th className="num log-col-tokens">{t("logs.col.tokens")}</th>
                <th className="num log-col-rate" title={t("logs.metric.tokPerSecTitle")}>{t("logs.col.tokPerSec")}</th>
                <th className="num log-col-cost" title={t("logs.metric.estimatedCostTitle")}>{t("logs.col.estimatedCost")}</th>
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
                  <td colSpan={10} style={{ height: paddingTop, padding: 0, border: 0 }} />
                </tr>
              )}
              {virtualRows.map(virtualRow => {
                const log = filteredLogs[filteredLogs.length - 1 - virtualRow.index];
                const reasoningWire = reasoningWireLabel(log);
                return (
               <tr
                 key={log.requestId ?? `${log.timestamp}-${virtualRow.index}`}
                 data-index={virtualRow.index}
                 ref={rowVirtualizer.measureElement}
               >
                 <td className="muted mono">{formatLogTimestamp(log.timestamp, localeTag)}</td>
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
                                  {t(isCursorUsageProvider(log.provider) ? "logs.tokens.noCacheCursor" : "logs.tokens.noCache")}
                                </span>
                              )}
                            </span>
                          )
                        : <span className="muted">{t(`logs.tokens.${log.usageStatus ?? "unreported"}`)}</span>;
                    })()}
                  </td>
                  <td className="num mono log-col-rate">
                    {formatTokPerSecond(log.displayMetrics?.tokPerSecond, localeTag)}
                  </td>
                  <td className="num mono log-col-cost">
                    {formatEstimatedUsd(log.displayMetrics?.cost, localeTag)}
                  </td>
                 <td className="mono log-col-model" title={modelTitle(log)}>
                   <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span>{modelLabel(log.resolvedModel ?? log.model)}</span>
                      {log.surface === "claude" && <span className="badge badge-accent">{t("logs.badge.claude")}</span>}
                      {speedLabel(log) && <span className="badge badge-amber">{speedLabel(log)}</span>}
                    </span>
                  </td>
                  <td className="mono log-reasoning-cell" title={reasoningWire}>
                    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                      <span>{effortLabel(log)}</span>
                      {reasoningWire && <span className="muted text-caption leading-tight">{reasoningWire}</span>}
                    </span>
                  </td>
                  <td className="muted">{log.provider}</td>
                  <td>
                    <span className="log-status-cell">
                      <span className="mono font-semibold" style={{ color: statusColor(log.status) }}>{log.status}</span>
                      <button
                        type="button"
                        className="log-detail-btn"
                        onClick={() => setDetail(log)}
                        aria-label={`${t("logs.details")}: ${log.requestId ?? log.status}`}
                      >
                        {t("logs.details")}
                      </button>
                    </span>
                 </td>
                  <td className="muted mono"><span className="log-reqid" title={log.requestId}>{log.requestId ?? "-"}</span></td>
                 <td className="num">{log.durationMs}ms</td>
                </tr>
                );
              })}
              {paddingBottom > 0 && (
                <tr>
                  <td colSpan={10} style={{ height: paddingBottom, padding: 0, border: 0 }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </>
      )}

      {detail && (
        <LogDetailDialog
          detail={detail}
          detailInfo={detailInfo}
          localeCode={locale}
          localeTag={localeTag}
          t={t}
          onClose={() => setDetail(null)}
          onFilterConversation={id => {
            setConversationFilter(id);
            setDetail(null);
          }}
        />
      )}
      </div>
      )}
    </>
  );
}

function useModalDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);
  return ref;
}

function LogDetailDialog({
  detail, detailInfo, localeCode, localeTag, t, onClose, onFilterConversation,
}: {
  detail: LogEntry;
  detailInfo: ReturnType<typeof statusCodeInfo> | null;
  localeCode: string;
  localeTag?: string;
  t: TFn;
  onClose: () => void;
  onFilterConversation?: (conversationId: string) => void;
}) {
  const dialogRef = useModalDialog(true);
  const [copied, setCopied] = useState(false);
  const tokenSplit = cacheSplit(detail);
  const cost = detail.displayMetrics?.cost;
  const reasoningWire = reasoningWireLabel(detail);

  const copyRequestId = async () => {
    if (!detail.requestId) return;
    try {
      await navigator.clipboard.writeText(detail.requestId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // copy failure must not break the dialog
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="log-detail-title"
      onCancel={e => { e.preventDefault(); onClose(); }}
    >
      <div className="modal-card log-detail-card">
        <div className="modal-head">
          <h3 id="log-detail-title">
            <span className="mono" style={{ color: statusColor(detail.status) }}>{detail.status}</span>
            {detailInfo && <span style={{ marginLeft: 8 }}>{detailInfo.label}</span>}
          </h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t("common.cancel")}><IconX /></button>
        </div>
        {detailInfo && <p className="modal-desc">{detailInfo.description}</p>}

        <section className="log-detail-section" aria-labelledby="log-detail-basic">
          <h4 id="log-detail-basic" className="log-detail-section-title">{t("logs.detail.section.basic")}</h4>
          <div className="log-detail-grid">
            <span className="muted">{t("logs.col.time")}</span><span className="mono">{formatLogDateTime(detail.timestamp, localeTag)}</span>
            <span className="muted">{t("logs.col.request")}</span>
            <span className="log-detail-request-row">
              <span className="mono log-detail-break">{detail.requestId ?? "\u2014"}</span>
              {detail.requestId && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyRequestId()}>
                  {t(copied ? "logs.detail.copied" : "logs.detail.copyRequestId")}
                </button>
              )}
            </span>
            {detail.conversationId && (
              <>
                <span className="muted">{t("logs.detail.conversation")}</span>
                <span className="log-detail-request-row">
                  <span className="mono log-detail-break">{detail.conversationId}</span>
                  {onFilterConversation && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => onFilterConversation(detail.conversationId!)}
                    >
                      {t("logs.filter.conversation.apply")}
                    </button>
                  )}
                </span>
              </>
            )}
            <span className="muted">{t("logs.col.model")}</span><span className="mono">{modelLabel(detail.resolvedModel ?? detail.model)}</span>
            <span className="muted">{t("logs.col.provider")}</span><span>{detail.provider}</span>
            {(detail.requestedEffort || detail.effectiveEffort) && (
              <><span className="muted">{t("logs.col.effort")}</span><span className="mono">{effortLabel(detail)}{reasoningWire ? ` (${reasoningWire})` : ""}</span></>
            )}
            {detail.errorCode && (<><span className="muted">{t("logs.col.error")}</span><span className="mono">{detail.errorCode}</span></>)}
            {detail.upstreamError && (<><span className="muted">{t("logs.col.upstreamReason")}</span><span className="mono log-detail-break">{detail.upstreamError}</span></>)}
          </div>
        </section>

        <section className="log-detail-section" aria-labelledby="log-detail-performance">
          <h4 id="log-detail-performance" className="log-detail-section-title">{t("logs.detail.section.performance")}</h4>
          <div className="log-detail-grid">
            <span className="muted">{t("logs.col.duration")}</span><span className="mono">{detail.durationMs}ms</span>
            <span className="muted">{t("logs.col.tokPerSec")}</span><span className="mono">{formatTokPerSecond(detail.displayMetrics?.tokPerSecond, localeTag)}</span>
            {detail.firstOutputMs !== undefined && (
              <><span className="muted">{t("logs.detail.ttft")}</span><span className="mono">{detail.firstOutputMs}ms</span></>
            )}
          </div>
          {detail.displayMetrics?.tokPerSecond.kind === "unavailable" && (
            <p className="log-detail-notes-line muted">{t(metricReasonKey(detail.displayMetrics.tokPerSecond.reason))}</p>
          )}
        </section>

        <section className="log-detail-section" aria-labelledby="log-detail-cost">
          <h4 id="log-detail-cost" className="log-detail-section-title">{t("logs.detail.section.cost")}</h4>
          <p className="log-detail-notes-line muted">{t("usage.cost.disclaimer")}</p>
          {cost?.kind === "value" ? (
            <>
              <div className="log-detail-grid">
                <span className="muted">{t("logs.detail.costTotal")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.total, localeTag)}</span>
                <span className="muted">{t("logs.tokens.input")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.input, localeTag)}</span>
                <span className="muted">{t("logs.tokens.cacheRead")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.cacheRead, localeTag)}</span>
                <span className="muted">{t("logs.tokens.cacheWrite")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.cacheWrite, localeTag)}</span>
                <span className="muted">{t("logs.tokens.output")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.output, localeTag)}</span>
                {cost.estimate.price && (
                  <>
                    <span className="muted">{t("logs.detail.matchedKey")}</span>
                    <span className="mono log-detail-break">{cost.estimate.price.jawcodeProvider ?? cost.estimate.price.provider}/{cost.estimate.price.modelId}</span>
                    <span className="muted">{t("logs.detail.priceSource")}</span>
                    <span>{t(`logs.detail.source.${cost.estimate.price.source}`)} · {t(verificationKey(cost.estimate.price.status))}</span>
                  </>
                )}
              </div>
              {cost.estimateReasons.length > 0 && (
                <ul className="log-detail-notes">
                  {cost.estimateReasons.map(reason => <li key={reason}>{t(estimateReasonKey(reason))}</li>)}
                </ul>
              )}
            </>
          ) : (
            <div className="log-detail-grid">
              <span className="muted">{t("logs.detail.costTotal")}</span><span className="mono">{"\u2014"}</span>
              <span className="muted">{t("logs.detail.unavailableReason")}</span>
              <span>{cost?.kind === "unavailable" ? t(metricReasonKey(cost.reason)) : t("logs.detail.reason.usage_missing")}</span>
            </div>
          )}
        </section>

        {detail.attempts?.length ? (
          <section className="log-detail-section" aria-labelledby="log-detail-attempts">
            <h4 id="log-detail-attempts" className="log-detail-section-title">{t("logs.detail.section.attempts")}</h4>
            <p className="log-detail-notes-line muted">{t("logs.detail.attempt.e2eNote")}</p>
            <div className="log-detail-attempts-wrap">
              <table className="tbl log-detail-attempts">
                <thead><tr>
                  <th className="num">#</th>
                  <th>{t("logs.detail.attempt.target")}</th>
                  <th className="num">{t("logs.col.duration")}</th>
                  <th className="num">{t("logs.col.tokPerSec")}</th>
                  <th className="num">{t("logs.col.estimatedCost")}</th>
                  <th>{t("logs.detail.attempt.reason")}</th>
                </tr></thead>
                <tbody>{detail.attempts.toSorted((a, b) => a.ordinal - b.ordinal).map(attempt => {
                  const attemptCost = attempt.displayMetrics?.cost;
                  const attemptReasoningWire = reasoningWireLabel(attempt);
                  const matched = attemptCost?.kind === "value" ? attemptCost.estimate.price : undefined;
                  const reason = attempt.errorCode
                    ?? (attempt.recoveryKinds.length ? attempt.recoveryKinds.join(", ") : undefined)
                    ?? (attemptCost?.kind === "unavailable" ? t(metricReasonKey(attemptCost.reason)) : t("logs.detail.attempt.completed"));
                  return (
                    <tr key={`${attempt.ordinal}-${attempt.provider}-${attempt.model}`}>
                      <td className="num mono">{attempt.ordinal}</td>
                      <td>
                        <span>{attempt.provider}</span><br />
                        <span className="mono muted log-detail-break">{attempt.model}</span>
                        {(attempt.requestedEffort || attempt.effectiveEffort) && (
                          <>
                            <br />
                            <span className="mono muted text-caption log-detail-break">
                              {effortLabel(attempt)}{attemptReasoningWire ? ` (${attemptReasoningWire})` : ""}
                            </span>
                          </>
                        )}
                        {matched && (
                          <>
                            <br />
                            <span className="muted text-caption log-detail-break">
                              {matched.jawcodeProvider ?? matched.provider}/{matched.modelId} · {t(`logs.detail.source.${matched.source}`)} · {t(verificationKey(matched.status))}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="num mono">{attempt.durationMs}ms</td>
                      <td className="num mono">{formatTokPerSecond(attempt.displayMetrics?.tokPerSecond, localeTag)}</td>
                      <td className="num mono">{formatEstimatedUsd(attemptCost, localeTag)}</td>
                      <td className="log-detail-break">{reason}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className="log-detail-section" aria-labelledby="log-detail-usage">
          <h4 id="log-detail-usage" className="log-detail-section-title">{t("logs.detail.section.usage")}</h4>
          <div className="log-detail-grid">
            <span className="muted">{t("logs.tokens.input")}</span><span className="mono">{detail.usage ? formatTokens(detail.usage.inputTokens, localeCode) : "\u2014"}</span>
            <span className="muted">{t("logs.tokens.output")}</span><span className="mono">{detail.usage ? formatTokens(detail.usage.outputTokens, localeCode) : "\u2014"}</span>
            <span className="muted">{t("logs.tokens.cacheRead")}</span><span className="mono">{tokenSplit.read !== undefined ? formatTokens(tokenSplit.read, localeCode) : "\u2014"}</span>
            <span className="muted">{t("logs.tokens.cacheWrite")}</span><span className="mono">{tokenSplit.write !== undefined ? formatTokens(tokenSplit.write, localeCode) : "\u2014"}</span>
            <span className="muted">{t("logs.tokens.reasoning")}</span><span className="mono">{detail.usage?.reasoningOutputTokens !== undefined ? formatTokens(detail.usage.reasoningOutputTokens, localeCode) : "\u2014"}</span>
            <span className="muted">{t("logs.detail.totalTokens")}</span><span className="mono">{displayTokenTotal(detail) !== undefined ? formatTokens(displayTokenTotal(detail)!, localeCode) : "\u2014"}</span>
          </div>
          {detail.usageStatus === "estimated" && (
            <p className="log-detail-notes-line muted">{t("logs.tokens.estimatedNote")}</p>
          )}
        </section>

        <details className="log-detail-raw">
          <summary>{t("logs.detailRaw")}</summary>
          <pre className="log-detail-json">{JSON.stringify(detail, null, 2)}</pre>
        </details>
      </div>
    </dialog>
  );
}
