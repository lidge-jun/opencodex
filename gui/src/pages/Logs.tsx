import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n, LOCALES, type TFn } from "../i18n/shared";
import { formatProviderDisplayName } from "../provider-icons";
import { formatTokens } from "../format-tokens";
import { hashLogConversationQuery, matchesLogConversationId } from "../log-conversation-id";
import { statusCodeInfo } from "../status-codes";
import { IconX } from "../icons";
import { modelLabel } from "../model-display";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { EmptyState, Notice } from "../ui";
import Debug from "./Debug";

import type { LogsTab } from "./logs-tab-keydown";
import { logsTabKeyDown, readTabFromHash, selectLogsTab } from "./logs-tab-keydown";
import { modelTitle } from "./logs-model-title";
import { speedLabel } from "./logs-speed-label";
import { formatEstimatedUsd, formatEstimatedUsdValue, summarizeEstimatedCosts } from "./logs-cost-format";
import { cacheSplit, isCursorUsageProvider, tokensTitle } from "./logs-token-title";
import type { LogSurface, LogSurfaceFilter } from "./logs-surface-filter";
import { logMatchesSurface } from "./logs-surface-filter";
import { logMatchesModelQuery } from "./logs-model-filter";
import {
  sanitizeLogEntryRouteDecision,
  validCachedRouteDecision,
} from "./log-route-decision";

function logsCacheKey(apiBase: string): string {
  return `ocx.logs.list.v1:${apiBase}`;
}

interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  /** Absolute active-context snapshot after the response (stateful providers such as Kiro). */
  contextTotalTokens?: number;
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

type CostEstimateReason =
  | "usage_estimated"
  | "cache_detail_missing"
  | "expected_price_overlay"
  | "provider_cost_overlay"
  | "priority_lower_bound";

type TokPerSecondResult =
  | { kind: "value"; value: number; estimated: boolean }
  | { kind: "unavailable"; reason: MetricUnavailableReason };

interface MatchedPriceInfo {
  provider: string;
  modelId: string;
  jawcodeProvider?: string;
  source: "jawcode" | "expected" | "user";
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
      priorityLowerBound?: boolean;
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

/**
 * Recovery kinds recorded on a log attempt; rendered as localized labels in the logs
 * detail dialog instead of raw wire values.
 */
type AttemptRecoveryKind =
  | "transient-5xx"
  | "connection-reset"
  | "oauth-401"
  | "key-429"
  | "rate-limit-429"
  | "anthropic-oauth-429"
  | "image-413"
  | "empty-completion";

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
  reasoningWireValue?: string | number | boolean;
  displayMetrics?: LogDisplayMetrics;
}

export interface LogEntry {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  surface?: LogSurface;
  conversationId?: string;
  /**
   * The original helper model, when Shadow Call Intercept rewrote this request.
   *
   * Present ONLY for an intercepted request. A helper request that was not intercepted --
   * interception off, no replacement model, or a slug the matcher does not recognize -- is
   * indistinguishable here from ordinary traffic, which is why the filter below says
   * "intercepted" rather than "helper".
   */
  shadowCallRewrittenFrom?: string;
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number | boolean;
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
  /** Bounded route-decision trace (RI-01); absent for pre-trace rows. */
  routeDecision?: {
    routeKind?: string;
    profile?: { id?: string; revision?: string };
    selected?: { provider?: string; model?: string; reason?: string };
    candidates?: Array<{ provider?: string; model?: string; eligible?: boolean; exclusions?: Array<{ code?: string }> }>;
  };
}

function validCachedLogs(cached: LogEntry[] | null): LogEntry[] | null {
  if (!Array.isArray(cached)) return null;
  for (const entry of cached) {
    if (
      !entry
      || typeof entry !== "object"
      || typeof entry.timestamp !== "number"
      || typeof entry.model !== "string"
      || typeof entry.provider !== "string"
      || typeof entry.status !== "number"
      || typeof entry.durationMs !== "number"
      || (entry.shadowCallRewrittenFrom !== undefined && typeof entry.shadowCallRewrittenFrom !== "string")
      || !validCachedRouteDecision(entry.routeDecision)
    ) {
      return null;
    }
  }
  return cached;
}

function displayTokenTotal(log: LogEntry): number | undefined {
  if (!log.usage) return typeof log.totalTokens === "number" ? log.totalTokens : undefined;
  // inputTokens is inclusive of cache read/write (canonical convention, devlog 070);
  // never re-add cache detail. max() keeps legacy pre-070 rows honest.
  const baseTotal = log.usage.inputTokens + log.usage.outputTokens;
  const explicitTotal = log.usage.totalTokens ?? log.totalTokens;
  return typeof explicitTotal === "number" ? Math.max(explicitTotal, baseTotal) : baseTotal;
}

/**
 * Row/detail display total that also honors an absolute context checkpoint.
 *
 * Stateful providers (Kiro) report per-attempt usage only, so their per-request total stays
 * small while the real active context grows. `contextTotalTokens` is that absolute snapshot.
 *
 * NEVER SUM THIS ACROSS REQUESTS. A checkpoint is not a per-request delta: adding it up over
 * a conversation counts the same context once per request and inflates aggregates wildly.
 * Aggregate rollups must keep using `displayTokenTotal`.
 */
function displayContextTokenTotal(log: LogEntry): number | undefined {
  const base = displayTokenTotal(log);
  const contextTotal = log.usage?.contextTotalTokens;
  if (typeof contextTotal !== "number") return base;
  return Math.max(base ?? 0, contextTotal) || undefined;
}

interface ReasoningLogFields {
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number | boolean;
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

const LOGS_POLL_INTERVAL_MS = 2000;
const LOGS_POLL_BACKOFF_MAX_EXPONENT = 4;
/** Consecutive failed polls before a stale table is called out. */
const STALE_POLL_FAILURE_LIMIT = 3;

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
  provider_cost_overlay: "logs.detail.estimate.provider_cost_overlay",
  priority_lower_bound: "logs.detail.estimate.priority_lower_bound",
} as const satisfies Record<CostEstimateReason, string>;

/**
 * i18n keys for every {@link AttemptRecoveryKind}, so the logs detail dialog renders a
 * localized label instead of the raw wire value (e.g. `rate-limit-429`).
 */
const RECOVERY_KIND_KEYS = {
  "transient-5xx": "logs.detail.attempt.recovery.transient5xx",
  "connection-reset": "logs.detail.attempt.recovery.connectionReset",
  "oauth-401": "logs.detail.attempt.recovery.oauth401",
  "key-429": "logs.detail.attempt.recovery.key429",
  "rate-limit-429": "logs.detail.attempt.recovery.rateLimit429",
  "anthropic-oauth-429": "logs.detail.attempt.recovery.anthropicOauth429",
  "image-413": "logs.detail.attempt.recovery.image413",
  "empty-completion": "logs.detail.attempt.recovery.emptyCompletion",
} as const satisfies Record<AttemptRecoveryKind, string>;

/** Map a metric-unavailable reason to its i18n key. */
function metricReasonKey(reason: MetricUnavailableReason) {
  return METRIC_REASON_KEYS[reason];
}

/** Map a cost-estimate reason to its i18n key. */
function estimateReasonKey(reason: CostEstimateReason) {
  return ESTIMATE_REASON_KEYS[reason];
}

/**
 * Map one attempt recovery kind to its i18n key for the logs detail dialog.
 */
function recoveryKindKey(kind: AttemptRecoveryKind) {
  // A stale/malformed cached row can carry a kind outside the known set; fall back to a
  // localized label instead of handing `t()` an undefined key.
  return RECOVERY_KIND_KEYS[kind] ?? "logs.detail.attempt.recovery.unknown";
}

function verificationKey(status: MatchedPriceInfo["status"]): "logs.detail.verification.verified" | "logs.detail.verification.derived" {
  return status === "verified" ? "logs.detail.verification.verified" : "logs.detail.verification.derived";
}

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return "var(--green)";
  if (status >= 400) return "var(--red)";
  return "var(--amber)";
}

/** Date and time as separate locale strings (no joining comma) for stacked table cells. */
function formatLogDateParts(ts: number, localeTag?: string, timeZone?: string): { date: string; time: string } {
  const zone = timeZone ? { timeZone } : undefined;
  try {
    return {
      date: new Date(ts).toLocaleDateString(localeTag, zone),
      time: new Date(ts).toLocaleTimeString(localeTag, zone),
    };
  } catch {
    // An IANA zone the browser's ICU build does not know throws RangeError.
    return {
      date: new Date(ts).toLocaleDateString(localeTag),
      time: new Date(ts).toLocaleTimeString(localeTag),
    };
  }
}

function formatLogDateTime(ts: number, localeTag?: string, timeZone?: string): string {
  const { date, time } = formatLogDateParts(ts, localeTag, timeZone);
  return `${date} ${time}`;
}

function summarizeFilteredLogs(entries: LogEntry[]): {
  requests: number;
  totalTokens: number;
  estimatedCostUsd: number;
  priorityLowerBound: boolean;
  unpricedRequests: number;
  unmeteredRequests: number;
} {
  let totalTokens = 0;
  for (const entry of entries) {
    const tokens = displayTokenTotal(entry);
    if (tokens !== undefined) totalTokens += tokens;
  }
  return {
    requests: entries.length,
    totalTokens,
    ...summarizeEstimatedCosts(entries),
  };
}

export default function Logs({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const resourceKey = logsCacheKey(apiBase);
  const cachedLogs = validCachedLogs(readSessionListCache<LogEntry[]>(resourceKey));
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [failureStreak, setFailureStreak] = useState<{ error: unknown; count: number }>(
    { error: null, count: 0 },
  );
  const [detail, setDetail] = useState<LogEntry | null>(null);
  const [surfaceFilter, setSurfaceFilter] = useState<LogSurfaceFilter>("all");
  const [interceptedHelpersOnly, setInterceptedHelpersOnly] = useState(false);
  const [conversationFilter, setConversationFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [conversationQueryHash, setConversationQueryHash] = useState<string | undefined>();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const logRetryRef = useRef<{ key: string; failures: number; nextAttemptAt: number; error: unknown }>(
    { key: resourceKey, failures: 0, nextAttemptAt: 0, error: null },
  );
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  // The proxy's own zone, so timestamps read the same as the server's logs rather than being
  // silently shifted into the viewer's zone (#725). Fetched once: it cannot change while the
  // page is open, so it must not join the 2s log poll. Undefined until it arrives, which
  // formats browser-local exactly as before.
  const [serverTimeZone, setServerTimeZone] = useState<string | undefined>();
  useEffect(() => {
    const controller = new AbortController();
    // Abort already rejects the in-flight fetch, but the flag keeps the guarantee
    // local: the setter is visibly gated without having to reason about whether
    // the abort propagates through the body read.
    let cancelled = false;
    fetch(`${apiBase}/api/settings`, { signal: controller.signal })
      .then(res => (res.ok ? res.json() as Promise<{ timeZone?: unknown }> : null))
      .then(body => {
        if (cancelled || !body) return;
        if (typeof body.timeZone === "string" && body.timeZone.trim()) {
          setServerTimeZone(body.timeZone.trim());
        }
      })
      .catch(() => {
        // Offline or an older proxy without the field: keep browser-local formatting.
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiBase]);
  // The hash is the source of truth for the active tab (#logs vs #logs/debug),
  // so refresh/bookmark/back-forward keep the tab choice.
  const [tab, setTab] = useState<LogsTab>(readTabFromHash);
  // Lazy-mount Debug on first visit, then keep it mounted so switch toggles
  // and Logs↔Debug hops do not remount (avoids settings/log refetch storms).
  const [debugMounted, setDebugMounted] = useState(() => readTabFromHash() === "debug");

  useEffect(() => {
    const onHash = () => setTab(readTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (tab === "debug") setDebugMounted(true);
  }, [tab]);

  const selectTab = selectLogsTab;

  const loadLogs = useCallback(async (signal: AbortSignal): Promise<LogEntry[]> => {
    let retry = logRetryRef.current;
    if (retry.key !== resourceKey) {
      retry = { key: resourceKey, failures: 0, nextAttemptAt: 0, error: null };
      logRetryRef.current = retry;
    }
    if (retry.failures > 0 && Date.now() < retry.nextAttemptAt) throw retry.error;
    try {
      const res = await fetch(`${apiBase}/api/logs?limit=2000`, { signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      const body = await res.json() as LogEntry[] | { logs?: LogEntry[] };
      const raw = Array.isArray(body) ? body : (body.logs ?? []);
      const next = raw.map(sanitizeLogEntryRouteDecision);
      logRetryRef.current = { key: resourceKey, failures: 0, nextAttemptAt: 0, error: null };
      writeSessionListCache(resourceKey, next);
      return next;
    } catch (error) {
      if (signal.aborted) throw error;
      const normalized = error ?? new Error("log request failed");
      const failures = retry.failures + 1;
      const backoffMs = LOGS_POLL_INTERVAL_MS * (2 ** Math.min(
        failures,
        LOGS_POLL_BACKOFF_MAX_EXPONENT,
      ));
      logRetryRef.current = { key: resourceKey, failures, nextAttemptAt: Date.now() + backoffMs, error: normalized };
      throw normalized;
    }
  }, [apiBase, resourceKey]);

  // The resource layer owns the request and the 2s base poll. loadLogs backs off actual network
  // attempts after failures while preserving those shared scheduler ticks and held rows.
  const logsResource = useDataSurface<LogEntry[]>(
    resourceKey,
    [apiBase],
    loadLogs,
    {
      isEmpty: rows => rows.length === 0,
      enabled: tab === "logs",
      pollMs: autoRefresh ? LOGS_POLL_INTERVAL_MS : undefined,
      initialData: cachedLogs ?? undefined,
    },
  );
  const logsState = logsResource.state;
  const logs = logsState.data ?? cachedLogs ?? [];
  const fetchLogs = logsResource.refresh;
  const retryLogs = useCallback(() => {
    logRetryRef.current = { key: resourceKey, failures: 0, nextAttemptAt: 0, error: null };
    fetchLogs({ forceLoading: true });
  }, [fetchLogs, resourceKey]);

  // A single failed tick on a two-second poll is noise, but an outage that never recovers must not
  // leave the user reading stale rows as if they were current. Count consecutive failures and speak
  // up once it is clearly not transient.
  const settledFailure = !logsResource.refreshing && logsState.showError;
  const settledSuccess = !logsResource.refreshing && !logsState.showError && logsState.data !== undefined;
  // Derived from the settlement itself, so there is no second copy of this state to keep
  // in sync and no frame painted with a stale banner. `streak` counts CONSECUTIVE failed
  // settlements: it is stored keyed by the error identity that produced it, so repeated
  // renders of the same failure do not inflate the count and a success clears it.
  if (settledSuccess && failureStreak.count !== 0) {
    setFailureStreak({ error: null, count: 0 });
  } else if (settledFailure && failureStreak.error !== logsState.error) {
    setFailureStreak(previous => ({ error: logsState.error, count: previous.count + 1 }));
  }
  // Auto-refresh off: one settled failure is enough — there is no next poll to recover quietly.
  const pollFailing =
    failureStreak.count >= STALE_POLL_FAILURE_LIMIT
    || (!autoRefresh && settledFailure);

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
    logMatchesSurface(log, surfaceFilter)
    && (!interceptedHelpersOnly || Boolean(log.shadowCallRewrittenFrom))
    && logMatchesModelQuery(log, modelFilter)
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
    <div className="logs-page">
      <div className="page-head">
        <h2>{t("nav.logs")}</h2>
        {tab === "logs" && (
          <label className="muted text-control logs-auto-refresh">
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

      {debugMounted && (
        <div
          role="tabpanel"
          id="logs-panel-debug"
          aria-labelledby="logs-tab-debug"
          hidden={tab !== "debug"}
        >
          <Debug apiBase={apiBase} embedded active={tab === "debug"} />
        </div>
      )}

      <div
        role="tabpanel"
        id="logs-panel-logs"
        aria-labelledby="logs-tab-logs"
        hidden={tab !== "logs"}
      >
      <p className="page-sub">{t("logs.subtitle")}</p>

      <div className="logs-toolbar">
        <span className="muted text-control">{t("logs.filter.surface.label")}</span>
        <div className="segmented logs-segmented" role="radiogroup" aria-label={t("logs.filter.surface.label")}>
          {(["all", "claude", "codex", "grok"] as const).map(surface => (
            <button
              key={surface}
              type="button"
              role="radio"
              aria-checked={surfaceFilter === surface}
              className={`btn btn-sm${surfaceFilter === surface ? " btn-primary" : " btn-ghost"}`}
              style={{ background: surfaceFilter === surface ? undefined : "transparent", color: surfaceFilter === surface ? undefined : "var(--muted)" }}
              onClick={() => setSurfaceFilter(surface)}
            >
              {t(`logs.filter.surface.${surface}`)}
            </button>
          ))}
        </div>
        {/*
          "Intercepted", not "helper". The marker only exists when Shadow Call Intercept
          rewrote the request, so a helper request that was not intercepted looks exactly like
          ordinary traffic here. A broader label would promise a classification this data
          cannot support.
        */}
        <label className="muted text-control logs-filter-field">
          <input
            type="checkbox"
            checked={interceptedHelpersOnly}
            onChange={event => setInterceptedHelpersOnly(event.target.checked)}
          />
          {t("logs.filter.interceptedHelpersOnly")}
        </label>
        <label className="muted text-control logs-filter-field">
          {t("logs.filter.conversation.label")}
          <input
            type="search"
            className="input mono"
            value={conversationFilter}
            onChange={e => setConversationFilter(e.target.value)}
            placeholder={t("logs.filter.conversation.placeholder")}
            aria-label={t("logs.filter.conversation.label")}
          />
        </label>
        <label className="muted text-control logs-filter-field">
          {t("logs.filter.model.label")}
          <input
            type="search"
            className="input mono"
            value={modelFilter}
            onChange={e => setModelFilter(e.target.value)}
            placeholder={t("logs.filter.model.placeholder")}
            aria-label={t("logs.filter.model.label")}
          />
        </label>
        {conversationQuery && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConversationFilter("")}>
            {t("logs.filter.conversation.clear")}
          </button>
        )}
      </div>

      {conversationTotals && (
        <div className="logs-conversation-totals">
          <Notice tone="ok">
            {t("logs.conversation.totals", {
              requests: conversationTotals.requests,
              tokens: formatTokens(conversationTotals.totalTokens, localeTag ?? locale),
              cost: formatEstimatedUsdValue(
                conversationTotals.estimatedCostUsd,
                t,
                localeTag,
                conversationTotals.priorityLowerBound,
              ),
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

      {/*
        Only a cold failure or a user-initiated retry surfaces here. This tab polls every two
        seconds, so a transient 5xx would otherwise flash the banner on and off under a table
        that is still perfectly readable — noise, not information. A quiet poll failure keeps the
        held rows and waits for the next tick, which is the behaviour the auto-refresh tests pin.
      */}
      {logsState.kind === "failed-cold" && (
        <Notice tone="err">
          {logsState.error instanceof Error ? `${t("logs.loadError")} ${logsState.error.message}` : t("logs.loadError")}{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={retryLogs} disabled={logsState.refreshing}>
            {t("common.retry")}
          </button>
        </Notice>
      )}
      {/* Stale rows after a sustained poll outage, or any settled failure while auto-refresh is
          off (no next tick will recover). Cleared by the first successful fetch. */}
      {pollFailing && logs.length > 0 && (
        <Notice tone="err">
          {t("logs.loadError")}{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={retryLogs} disabled={logsResource.refreshing}>
            {t("common.retry")}
          </button>
        </Notice>
      )}

      {/* A cold failure must not also render the empty state: "nothing came back" and "there is
          nothing to show" are different answers, and showing both at once tells the user neither. */}
      {logsState.kind === "failed-cold" ? null : logsState.showSkeleton && logs.length === 0 ? (
        <DataSurfaceSkeleton label={t("common.loading")} rows={6} />
      ) : filteredLogs.length === 0 ? (
        <EmptyState title={t("logs.noRequests")} />
      ) : (
        <>
        <div ref={scrollContainerRef} className="tbl-wrap logs-table-wrap">
          <table className="tbl logs-table">
            <thead>
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
               <th className="num log-col-duration">{t("logs.col.duration")}</th>
             </tr>
            </thead>
            <tbody>
              {paddingTop > 0 && (
                <tr>
                  <td colSpan={10} className="logs-virtual-spacer" style={{ height: paddingTop }} />
                </tr>
              )}
              {virtualRows.map(virtualRow => {
                const log = filteredLogs[filteredLogs.length - 1 - virtualRow.index];
                const reasoningWire = reasoningWireLabel(log);
                const when = formatLogDateParts(log.timestamp, localeTag, serverTimeZone);
                return (
               <tr
                 key={log.requestId ?? `${log.timestamp}-${virtualRow.index}`}
                 data-index={virtualRow.index}
                 ref={rowVirtualizer.measureElement}
               >
                 <td className="muted mono log-col-time">
                   <span className="logs-stack-start">
                     <span>{when.date}</span>
                     <span>{when.time}</span>
                   </span>
                 </td>
                  <td className="num mono log-col-tokens" title={tokensTitle(log, t)}>
                    {(() => {
                      const tokenTotal = displayContextTokenTotal(log);
                      const { read, write } = cacheSplit(log);
                      return tokenTotal !== undefined
                        ? (
                            <span className="logs-stack-end">
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
                    {formatEstimatedUsd(log.displayMetrics?.cost, t, localeTag)}
                  </td>
                 <td className="mono log-col-model" title={modelTitle(log, t)}>
                  <span className="logs-model-cell">
                   <span>{modelLabel(log.resolvedModel ?? log.model)}</span>
                      {log.shadowCallRewrittenFrom && (
                        <span
                          className="badge badge-muted"
                          style={{ whiteSpace: "nowrap" }}
                          title={t("logs.badge.interceptedHelperTitle")}
                        >
                          {t("logs.badge.interceptedHelper", { model: log.shadowCallRewrittenFrom })}
                        </span>
                      )}
                      {(log.surface === "claude" || log.surface === "claude-desktop") && (
                        <span className="badge badge-accent">{t("logs.badge.claude")}</span>
                      )}
                      {log.surface === "grok" && <span className="badge badge-accent">{t("logs.badge.grok")}</span>}
                      {speedLabel(log) && <span className="badge badge-amber">{speedLabel(log)}</span>}
                    </span>
                  </td>
                  <td className="mono log-reasoning-cell" title={reasoningWire}>
                    <span className="logs-stack-start">
                      <span>{effortLabel(log)}</span>
                      {reasoningWire && <span className="muted text-caption leading-tight">{reasoningWire}</span>}
                    </span>
                  </td>
                  <td className="muted">{formatProviderDisplayName(log.provider, t)}</td>
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
                 <td className="num log-col-duration">{log.durationMs}ms</td>
                </tr>
                );
              })}
              {paddingBottom > 0 && (
                <tr>
                  <td colSpan={10} className="logs-virtual-spacer" style={{ height: paddingBottom }} />
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
          serverTimeZone={serverTimeZone}
          t={t}
          onClose={() => setDetail(null)}
          onFilterConversation={id => {
            setConversationFilter(id);
            setDetail(null);
          }}
        />
      )}
      </div>
    </div>
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
  detail, detailInfo, localeCode, localeTag, serverTimeZone, t, onClose, onFilterConversation,
}: {
  detail: LogEntry;
  detailInfo: ReturnType<typeof statusCodeInfo> | null;
  localeCode: string;
  localeTag?: string;
  serverTimeZone?: string;
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
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onClose} />
      <div className="modal-card log-detail-card" onClick={event => event.stopPropagation()} role="document">
        <div className="modal-head">
          <h3 id="log-detail-title">
            <span className="mono" style={{ color: statusColor(detail.status) }}>{detail.status}</span>
            {detailInfo && <span className="logs-detail-info">{detailInfo.label}</span>}
          </h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t("common.cancel")}><IconX /></button>
        </div>
        {detailInfo && <p className="modal-desc">{detailInfo.description}</p>}

        <section className="log-detail-section" aria-labelledby="log-detail-basic">
          <h4 id="log-detail-basic" className="log-detail-section-title">{t("logs.detail.section.basic")}</h4>
          <div className="log-detail-grid">
            <span className="muted">{t("logs.col.time")}</span><span className="mono">{formatLogDateTime(detail.timestamp, localeTag, serverTimeZone)}</span>
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
            <span className="muted">{t("logs.col.provider")}</span><span>{formatProviderDisplayName(detail.provider, t)}</span>
            {(detail.requestedEffort || detail.effectiveEffort) && (
              <><span className="muted">{t("logs.col.effort")}</span><span className="mono">{effortLabel(detail)}{reasoningWire ? ` (${reasoningWire})` : ""}</span></>
            )}
            {detail.errorCode && (<><span className="muted">{t("logs.col.error")}</span><span className="mono">{detail.errorCode}</span></>)}
            {detail.upstreamError && (<><span className="muted">{t("logs.col.upstreamReason")}</span><span className="mono log-detail-break">{detail.upstreamError}</span></>)}
          </div>
        </section>

        <section className="log-detail-section" aria-labelledby="log-detail-route">
          <h4 id="log-detail-route" className="log-detail-section-title">{t("logs.detail.route.section")}</h4>
          {detail.routeDecision ? (
            <div className="log-detail-grid">
              <span className="muted">{t("logs.detail.route.kind")}</span><span className="mono">{detail.routeDecision.routeKind ?? "–"}</span>
              {detail.routeDecision.profile?.id && (
                <><span className="muted">{t("logs.detail.route.profile")}</span>
                  <span className="mono">{detail.routeDecision.profile.id} ({detail.routeDecision.profile.revision})</span></>
              )}
              {detail.routeDecision.selected?.provider && (
                <><span className="muted">{t("logs.detail.route.selected")}</span>
                  <span className="mono">
                    {detail.routeDecision.selected.provider}/{detail.routeDecision.selected.model}
                    {detail.routeDecision.selected.reason ? ` — ${detail.routeDecision.selected.reason}` : ""}
                  </span></>
              )}
              <span className="muted">{t("logs.detail.route.candidates")}</span>
              <span className="mono">
                {(detail.routeDecision.candidates ?? []).map(candidate => {
                  const provider = typeof candidate.provider === "string" && candidate.provider.length > 0
                    ? candidate.provider
                    : "–";
                  const model = typeof candidate.model === "string" && candidate.model.length > 0
                    ? candidate.model
                    : "–";
                  const mark = candidate.eligible === true
                    ? " ✓"
                    : candidate.eligible === false
                      ? " ✗"
                      : " ?";
                  return `${provider}/${model}${mark}`;
                }).join("  ") || "–"}
              </span>
            </div>
          ) : (
            <p className="log-detail-notes-line muted">{t("logs.detail.route.unknown")}</p>
          )}
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
                <span className="muted">{t("logs.detail.costTotal")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.total, t, localeTag, cost.estimate.priorityLowerBound)}</span>
                <span className="muted">{t("logs.tokens.input")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.input, t, localeTag, cost.estimate.priorityLowerBound)}</span>
                <span className="muted">{t("logs.tokens.cacheRead")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.cacheRead, t, localeTag, cost.estimate.priorityLowerBound)}</span>
                <span className="muted">{t("logs.tokens.cacheWrite")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.cacheWrite, t, localeTag, cost.estimate.priorityLowerBound)}</span>
                <span className="muted">{t("logs.tokens.output")}</span><span className="mono">{formatEstimatedUsdValue(cost.estimate.cost.output, t, localeTag, cost.estimate.priorityLowerBound)}</span>
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
              <span className="muted">{t("logs.detail.costTotal")}</span><span className="mono">{t("logs.cost.unavailable")}</span>
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
                    ?? (attempt.recoveryKinds.length
                      ? attempt.recoveryKinds.map(kind => t(recoveryKindKey(kind))).join(", ")
                      : undefined)
                    ?? (attemptCost?.kind === "unavailable" ? t(metricReasonKey(attemptCost.reason)) : t("logs.detail.attempt.completed"));
                  return (
                    <tr key={`${attempt.ordinal}-${attempt.provider}-${attempt.model}`}>
                      <td className="num mono">{attempt.ordinal}</td>
                      <td>
                        <span>{formatProviderDisplayName(attempt.provider, t)}</span><br />
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
                      <td className="num mono">{formatEstimatedUsd(attemptCost, t, localeTag)}</td>
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
            <span className="muted">{t("logs.detail.totalTokens")}</span><span className="mono">{displayContextTokenTotal(detail) !== undefined ? formatTokens(displayContextTokenTotal(detail)!, localeCode) : "\u2014"}</span>
            {detail.usage?.contextTotalTokens !== undefined && (
              <>
                <span className="muted">{t("logs.tokens.contextTotal")}</span>
                <span className="mono">{formatTokens(detail.usage.contextTotalTokens, localeCode)}</span>
              </>
            )}
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
