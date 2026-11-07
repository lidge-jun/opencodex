import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n, LOCALES, type TFn } from "../i18n/shared";
import { formatProviderDisplayName } from "../provider-icons";
import { formatTokens } from "../format-tokens";
import { hashLogConversationQuery } from "../log-conversation-id";
import { statusCodeInfo } from "../status-codes";
import { IconChevron, IconX } from "../icons";
import { modelLabel } from "../model-display";
import { cn } from "@/lib/utils";
import { panel, panelBody } from "../components/v2-logs/classes";
import { ColumnsMenu } from "../components/v2-logs/columns-menu";
import { LiveToggle } from "../components/v2-logs/live-toggle";
import { StatusPill } from "../components/v2-logs/status-pill";
import { LOGS_OPTIONAL_COLUMNS, useLogsColumns } from "./logs-columns";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { EmptyState, Notice } from "../ui";
import Debug from "./Debug";
import { LogsFilterBar } from "./logs-filter-bar";
import { LogsClientChip } from "./logs-client-chip";
import { ProtocolBadge } from "../components/protocols/ProtocolBadge";
import { ProtocolTracePanel } from "../components/protocols/ProtocolTracePanel";
import { logsClockAnchor, logsClockNow, type LogsClockAnchor } from "./logs-clock";
import { DEFAULT_LOG_FILTER_STATE, extractLogFilterOptions, filterLogs, hasActiveLogFilters, type LogFilterState } from "./logs-filter";

import type { LogsTab } from "./logs-tab-keydown";
import { logsTabKeyDown, readTabFromHash, selectLogsTab } from "./logs-tab-keydown";
import { isModelRerouted, modelTitle, type ModelTitleTierOutcome } from "./logs-model-title";
import { speedLabel } from "./logs-speed-label";
import { decodeRateLabelKeys } from "./logs-decode-rate";
import { failureAttributionLabels, failureDetailLabel, failureSummary, upstreamConditionLabel } from "./logs-failure-summary";
import "./logs-decode-rate.css";
import { formatEstimatedUsd, formatEstimatedUsdValue, summarizeEstimatedCosts } from "./logs-cost-format";
import { cacheSplit, isCursorUsageProvider, tokensTitle } from "./logs-token-title";
import {
  sanitizeLogEntryRouteDecision,
  validCachedRouteDecision,
} from "./log-route-decision";
import { mergeLogDelta, parseLogPollResponse } from "./log-poll";
import type {
  AttemptRecoveryKind,
  RequestFailureCause,
  RequestFailureStage,
  RequestSpendTotals,
  ResendPermission,
} from "../../../src/usage/telemetry-contract";
import {
  classifyRequestOutcome,
  type RequestOutcomeClass,
} from "../../../src/usage/request-outcome";

function logsCacheKey(apiBase: string): string {
  return `ocx.logs.list.v1:${apiBase}`;
}

const EMPTY_LOGS: LogEntry[] = [];

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
  | "invalid_usage" | "combo_attempt_unavailable"
  | "ttft_missing" | "decode_window_too_short";

type CostEstimateReason =
  | "usage_estimated"
  | "cache_detail_missing"
  | "expected_price_overlay"
  | "provider_cost_overlay"
  | "priority_lower_bound";

type TokPerSecondResult =
  | { kind: "value"; value: number; estimated: boolean }
  | { kind: "unavailable"; reason: MetricUnavailableReason };

type DecodeTokPerSecondResult =
  | (Extract<TokPerSecondResult, { kind: "value" }> & { timingBasis?: string })
  | Extract<TokPerSecondResult, { kind: "unavailable" }>;

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
  /**
   * Estimated decode throughput (#4038). Optional because a row cached by an older build has no
   * such field; absent renders nothing rather than an empty slot.
   */
  decodeTokPerSecond?: DecodeTokPerSecondResult;
  cost: CostResult;
}

/**
 * The durable attribution and the verdict the API derives from it.
 *
 * `resendPermission` arrives computed rather than stored: the tables that decide it live in the
 * proxy and a row must not be able to assert a permission the current tables would refuse. The
 * page renders the answer and derives nothing of its own, which is the same rule that keeps the
 * outcome class agreeing with the exporter.
 */
interface LogFailureAttribution {
  failureStage?: RequestFailureStage;
  failureCause?: RequestFailureCause;
  resendPermission?: ResendPermission;
}

interface LogAttempt extends LogFailureAttribution {
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

export interface LogEntry extends LogFailureAttribution {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  /** Closed client classification from the proxy; validate API and cached values before display. */
  client?: unknown;
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
  // #2455: qualifies responseServiceTier in the model tooltip — the echoed tier alone
  // cannot say whether Fast was granted on a backend whose echo is not authoritative.
  tierOutcome?: ModelTitleTierOutcome;
  resolvedModel?: string;
  servedModel?: string;
  wireModel?: string;
  modelSupportsServiceTier?: boolean;
  status: number;
  durationMs: number;
  errorCode?: string;
  /** Classified upstream condition (closed enum) and proxy-authored failure text; never upstream text. */
  upstreamCondition?: string;
  failureDetail?: unknown;
  /**
   * Semantic terminal facts. `/api/logs` has always carried these -- `requestLogDto` spreads the
   * whole durable entry -- but this page declared neither, so it classified every request by its
   * numeric HTTP status alone and reported an incomplete 200 as a plain success.
   */
  terminalStatus?: string;
  closeReason?: "terminal" | "client_cancel" | "non_stream" | "body_stall" | "body_overflow";
  /** Upstream spend for the whole logical request, aggregated across attempts and combo children. */
  spend?: RequestSpendTotals;
  usageStatus?: LogUsageStatus;
  usage?: UsageBreakdown;
  totalTokens?: number;
  firstOutputMs?: number;
  attempts?: LogAttempt[];
  attemptNormalizationDropped?: boolean;
  displayMetrics?: LogDisplayMetrics;
  /** Bounded route-decision trace (RI-01); absent for pre-trace rows. */
  routeDecision?: {
    routeKind?: string;
    profile?: { id?: string; revision?: string };
    selected?: { provider?: string; model?: string; reason?: string };
    candidates?: Array<{ provider?: string; model?: string; eligible?: boolean; exclusions?: Array<{ code?: string }> }>;
  };
  /** Observed protocol path (PF-02). Untrusted JSON; rendered only after `parseProtocolTraceV1`. */
  protocolTrace?: unknown;
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

function servedModelLabel(log: { model: string; resolvedModel?: string; servedModel?: string; wireModel?: string }): ReactNode {
  if (isModelRerouted(log)) {
    return <>{modelLabel(log.wireModel ?? log.model)}{" → "}{modelLabel(log.servedModel!)}</>;
  }
  return modelLabel(log.servedModel ?? log.resolvedModel ?? log.model);
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
// Relative time filters must advance even when the polled snapshot is unchanged. Keep the
// refresh independent from the network poll so an active 15m/1h/24h window expires rows while
// the proxy is idle.
const LOGS_FILTER_CLOCK_INTERVAL_MS = 30_000;
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
  ttft_missing: "logs.detail.reason.ttft_missing",
  decode_window_too_short: "logs.detail.reason.decode_window_too_short",
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
 *
 * The union is now the durable roster rather than a copy of it. The copy had drifted to nine of
 * thirteen members, so `key-401`, `oauth-account-429`, `opaque-blob-rejection` and
 * `reasoning-effort-downgrade` all reached the operator as "Unknown recovery reason" -- four real
 * causes rendered as an absence of information. `satisfies Record<AttemptRecoveryKind, string>` is
 * what now makes the next added kind a typecheck failure here instead of a silent blank.
 */
const RECOVERY_KIND_KEYS = {
  "transient-5xx": "logs.detail.attempt.recovery.transient5xx",
  "connection-reset": "logs.detail.attempt.recovery.connectionReset",
  "oauth-401": "logs.detail.attempt.recovery.oauth401",
  "oauth-account-403": "logs.detail.attempt.recovery.oauthAccount403",
  "key-401": "logs.detail.attempt.recovery.key401",
  "key-429": "logs.detail.attempt.recovery.key429",
  "rate-limit-429": "logs.detail.attempt.recovery.rateLimit429",
  "anthropic-oauth-429": "logs.detail.attempt.recovery.anthropicOauth429",
  "oauth-account-429": "logs.detail.attempt.recovery.oauthAccount429",
  "oauth-account-402": "logs.detail.attempt.recovery.oauthAccount402",
  "image-413": "logs.detail.attempt.recovery.image413",
  "empty-completion": "logs.detail.attempt.recovery.emptyCompletion",
  "console-go-upload-retry": "logs.detail.attempt.recovery.consoleGoUpload",
  "opaque-blob-rejection": "logs.detail.attempt.recovery.opaqueBlobRejection",
  "reasoning-effort-downgrade": "logs.detail.attempt.recovery.reasoningEffortDowngrade",
  "anthropic-fast-downgrade": "logs.detail.attempt.recovery.anthropicFastDowngrade",
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

/** i18n key for each shared outcome class, total by construction. */
const OUTCOME_KEYS = {
  completed: "logs.detail.outcome.completed",
  failed: "logs.detail.outcome.failed",
  incomplete: "logs.detail.outcome.incomplete",
  aborted: "logs.detail.outcome.aborted",
} as const satisfies Record<RequestOutcomeClass, string>;

/**
 * How this request ended, using the same classifier the Prometheus exporter uses.
 *
 * Calling the shared function rather than reimplementing the precedence is the point: the numeric
 * status beside it can be 200 while the answer was never delivered, and reading the status first
 * is exactly the disagreement this removes.
 */
function outcomeKey(entry: Pick<LogEntry, "status" | "terminalStatus" | "closeReason">) {
  return OUTCOME_KEYS[classifyRequestOutcome(entry)];
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

/** The Logs / Debug tab buttons: a raised plate on the selected one. */
function tabClass(selected: boolean): string {
  return cn(
    "ui-v2 inline-flex h-7 cursor-pointer items-center rounded-[8px] px-3 text-[13px] font-medium transition-colors duration-200",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-highlight",
    selected ? "bg-raised text-fg shadow-sm ring-1 ring-line dark:bg-surface-2" : "text-fg-subtle hover:text-fg-muted",
  );
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
  const [filters, setFilters] = useState<LogFilterState>(DEFAULT_LOG_FILTER_STATE);
  const [filterClockNow, setFilterClockNow] = useState(() => Date.now());
  const filterClockRef = useRef<{
    key: string; anchor?: LogsClockAnchor; active: boolean; request: number;
  }>({ key: resourceKey, active: false, request: 0 });
  const logPollRef = useRef<{ key: string; cursor: string | null; rows: LogEntry[] }>(
    { key: resourceKey, cursor: null, rows: [] },
  );
  // Invalidate the old resource at commit, before passive resource-loader effects.
  // A late body read must not mutate this page's clock, cache or retry state.
  useLayoutEffect(() => {
    const clock = { key: resourceKey, active: true, request: 0 };
    filterClockRef.current = clock;
    // Cached display rows never establish a cursor, including A -> B -> A.
    logPollRef.current = { key: resourceKey, cursor: null, rows: [] };
    setFilterClockNow(Date.now());
    return () => { clock.active = false; };
  }, [resourceKey]);
  const readFilterClockNow = useCallback(() => {
    const clock = filterClockRef.current;
    return logsClockNow(clock.key === resourceKey ? clock.anchor : undefined, performance.now(), Date.now());
  }, [resourceKey]);
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
    const clock = filterClockRef.current;
    if (signal.aborted || !clock.active || clock.key !== resourceKey) {
      throw signal.reason ?? new DOMException("Obsolete log request", "AbortError");
    }
    const request = ++clock.request;
    const isCurrent = () => !signal.aborted && clock.active
      && filterClockRef.current === clock && clock.request === request;
    let retry = logRetryRef.current;
    if (retry.key !== resourceKey) {
      retry = { key: resourceKey, failures: 0, nextAttemptAt: 0, error: null };
      logRetryRef.current = retry;
    }
    if (retry.failures > 0 && Date.now() < retry.nextAttemptAt) throw retry.error;
    const poll = logPollRef.current;
    const cursor = poll.key === resourceKey ? poll.cursor : null;
    const url = `${apiBase}/api/logs?limit=2000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      const body: unknown = await res.json();
      const receivedAt = performance.now();
      const parsed = parseLogPollResponse<LogEntry>(body);
      const incoming = parsed.rows.map(sanitizeLogEntryRouteDecision);
      const next = cursor && parsed.cursor && !parsed.reset
        ? mergeLogDelta(poll.rows, incoming) : incoming;
      // The resource-store generation guard runs only after this loader returns.
      // Guard these local side effects here as fetch/body readers may ignore abort.
      if (!isCurrent()) throw signal.reason ?? new DOMException("Obsolete log request", "AbortError");
      logPollRef.current = { key: resourceKey, cursor: parsed.cursor, rows: next };
      // Reconcile when the accepted snapshot changes, using the latest user state
      // rather than filters captured when the request started. Persist disappearance
      // as All so a later ring cannot resurrect a cleared selection.
      const options = extractLogFilterOptions(next);
      setFilters(previous => {
        const model = previous.model.trim().toLowerCase();
        const provider = previous.provider.trim().toLowerCase();
        const nextModel = model
          ? options.models.find(option => option.trim().toLowerCase() === model) ?? ""
          : "";
        const nextProvider = provider
          ? options.providers.find(option => option.trim().toLowerCase() === provider) ?? ""
          : "";
        if (previous.model === nextModel && previous.provider === nextProvider) return previous;
        return { ...previous, model: nextModel, provider: nextProvider };
      });
      const sample = logsClockAnchor(parsed.generatedAt, receivedAt);
      if (sample) clock.anchor = sample;
      setFilterClockNow(logsClockNow(clock.anchor, receivedAt, Date.now()));
      logRetryRef.current = { key: resourceKey, failures: 0, nextAttemptAt: 0, error: null };
      writeSessionListCache(resourceKey, next);
      return next;
    } catch (error) {
      if (!isCurrent()) throw error;
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
  const logs = logsState.data ?? cachedLogs ?? EMPTY_LOGS;
  const fetchLogs = logsResource.refresh;
  const retryLogs = useCallback(() => {
    logRetryRef.current = { key: resourceKey, failures: 0, nextAttemptAt: 0, error: null };
    logPollRef.current = { key: resourceKey, cursor: null, rows: [] };
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
  const conversationQuery = filters.conversationId.trim();

  useEffect(() => {
    if (filters.timeWindow === "all" || tab !== "logs") return;
    setFilterClockNow(readFilterClockNow());
    const timer = window.setInterval(() => setFilterClockNow(readFilterClockNow()), LOGS_FILTER_CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [filters.timeWindow, tab, readFilterClockNow]);

  useEffect(() => {
    let cancelled = false;
    if (!conversationQuery) {
      setFilters(prev => prev.conversationQueryHash === undefined ? prev : { ...prev, conversationQueryHash: undefined });
      return;
    }
    void hashLogConversationQuery(conversationQuery).then(hashes => {
      if (!cancelled) setFilters(prev =>
        prev.conversationQueryHash?.join(" ") === hashes.join(" ")
          ? prev
          : { ...prev, conversationQueryHash: hashes });
    });
    return () => { cancelled = true; };
  }, [conversationQuery]);

  const filterOptions = useMemo(() => extractLogFilterOptions(logs), [logs]);
  const activeFilters = hasActiveLogFilters(filters);
  const filteredLogs = useMemo(() => filterLogs(logs, filters, filterClockNow), [logs, filters, filterClockNow]);
  const conversationTotals = conversationQuery ? summarizeFilteredLogs(filteredLogs) : null;
  const failedInView = useMemo(
    () => filteredLogs.reduce((count, log) => count + (classifyRequestOutcome(log) === "failed" ? 1 : 0), 0),
    [filteredLogs],
  );
  const { columns, toggle: toggleColumn } = useLogsColumns();
  const columnCount = 5 + LOGS_OPTIONAL_COLUMNS.filter(column => columns[column.key]).length;

  // TanStack Virtual returns unstable function identities; React Compiler skips this call.
  // eslint-disable-next-line react-hooks/incompatible-library -- known useVirtualizer limitation
  const rowVirtualizer = useVirtualizer({
    count: filteredLogs.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 60,
    overscan: 15,
    getItemKey: index => {
      const log = filteredLogs[filteredLogs.length - 1 - index]!;
      return log.requestId ?? `${log.timestamp}:${log.model}:${log.provider}`;
    },
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length > 0
    ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;

  return (
    <div className="logs-page flex min-w-0 flex-col gap-5 font-sans text-fg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-title font-semibold tracking-[-0.025em]">{t("nav.logs")}</h2>
        <div
          className="inline-flex items-center gap-0.5 rounded-control bg-surface p-0.5 ring-1 ring-inset ring-line"
          role="tablist"
          aria-label={t("nav.logs")}
        >
          <button
            type="button"
            role="tab"
            id="logs-tab-logs"
            aria-selected={tab === "logs"}
            aria-controls="logs-panel-logs"
            tabIndex={tab === "logs" ? 0 : -1}
            className={tabClass(tab === "logs")}
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
            className={tabClass(tab === "debug")}
            onClick={() => selectTab("debug")}
            onKeyDown={logsTabKeyDown}
          >
            {t("logs.tabDebug")}
          </button>
        </div>
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
      <section className={panel} aria-labelledby="logs-requests-title">
        <div className="flex min-w-0 flex-col gap-3 px-4 pt-3.5 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 id="logs-requests-title" className="m-0 text-[15px] leading-5 font-semibold tracking-[-0.01em]">{t("logsV2.requests")}</h3>
              <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium", autoRefresh ? "text-fg" : "text-fg-subtle")}>
                <span aria-hidden className={cn("size-1.5 rounded-full", autoRefresh ? "bg-success" : "ring-1 ring-current")} />
                {t(autoRefresh ? "logsV2.live" : "logsV2.paused")}
              </span>
              {logs.length > 0 && (
                <span className="text-[13px] text-fg-subtle tabular-nums">
                  {t("logsV2.countLine", { shown: filteredLogs.length, total: logs.length })}
                  {failedInView > 0 && <span className="text-danger"> · {t("logsV2.failedCount", { count: failedInView })}</span>}
                </span>
              )}
            </div>
            <LiveToggle
              className="logs-auto-refresh"
              checked={autoRefresh}
              onChange={setAutoRefresh}
              label={t("logs.autoRefresh")}
              title={t("logsV2.liveHint")}
            />
          </div>

          <LogsFilterBar
            filters={filters}
            options={filterOptions}
            hasActiveFilters={activeFilters}
            filteredCount={filteredLogs.length}
            totalCount={logs.length}
            t={t}
            onFilterChange={setFilters}
            onResetFilters={() => setFilters(DEFAULT_LOG_FILTER_STATE)}
            trailing={(
              <ColumnsMenu
                options={LOGS_OPTIONAL_COLUMNS.map(column => ({ key: column.key, label: t(column.label) }))}
                visible={columns}
                onToggle={toggleColumn}
                label={t("logsV2.columns")}
                menuLabel={t("logsV2.columnsMenu")}
              />
            )}
          />

          {conversationTotals && (
            <div className="logs-conversation-totals m-0">
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
        </div>

      {/* A cold failure must not also render the empty state: "nothing came back" and "there is
          nothing to show" are different answers, and showing both at once tells the user neither. */}
      {logsState.kind === "failed-cold" ? null : logsState.showSkeleton && logs.length === 0 ? (
        <div className={cn(panelBody, "p-3")}>
          <DataSurfaceSkeleton label={t("common.loading")} rows={6} />
        </div>
      ) : filteredLogs.length === 0 ? (
        <div className={panelBody}>
          <EmptyState title={logs.length > 0 && activeFilters ? t("logs.noMatchingRequests") : t("logs.noRequests")} />
        </div>
      ) : (
        <div className={panelBody}>
        <div ref={scrollContainerRef} className="logs-table-wrap max-h-[calc(100dvh-300px)] overflow-auto [overflow-anchor:none]">
          <table
            className={cn(
              "logs-table ui-v2 w-full min-w-[1020px] table-fixed border-collapse text-[13px] font-normal text-fg",
              "[&_th]:h-9 [&_th]:px-3 [&_th]:text-left [&_th]:text-[12px] [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-fg-subtle",
              "[&_td]:px-3 [&_td]:py-2.5 [&_td]:align-middle",
            )}
          >
            <colgroup>
              {/* Keep the protocol badge readable alongside the added client column. */}
              <col className="logs-col-client w-[48px]" />
              <col className="logs-col-time w-[120px]" />
              <col className="logs-col-status w-[80px]" />
              <col className="logs-col-model" style={{ width: 280 }} />
              {columns.effort && <col className="logs-col-effort w-[104px]" />}
              {columns.tokens && <col className="logs-col-tokens w-[84px]" />}
              {columns.rate && <col className="logs-col-rate w-[84px]" />}
              {columns.cost && <col className="logs-col-cost w-[84px]" />}
              {columns.duration && <col className="logs-col-duration w-[84px]" />}
              <col className="logs-col-actions w-[40px]" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-bg shadow-[inset_0_-1px_0_var(--ocx-line)]">
             <tr>
               <th scope="col"><span className="sr-only">{t("logsV2.client")}</span></th>
               <th scope="col">{t("logs.col.time")}</th>
               <th scope="col">{t("logs.col.status")}</th>
               <th scope="col">{t("logs.col.provider")} · {t("logs.col.model")}</th>
               {columns.effort && <th scope="col">{t("logs.col.effort")}</th>}
               {columns.tokens && <th scope="col" className="text-right!">{t("logs.col.tokens")}</th>}
               {columns.rate && <th scope="col" className="text-right!" title={t("logs.metric.tokPerSecTitle")}>{t("logs.col.tokPerSec")}</th>}
               {columns.cost && <th scope="col" className="text-right!" title={t("logs.metric.estimatedCostTitle")}>{t("logs.col.estimatedCost")}</th>}
               {columns.duration && <th scope="col" className="text-right!">{t("logs.col.duration")}</th>}
               <th scope="col"><span className="sr-only">{t("logs.details")}</span></th>
             </tr>
            </thead>
            <tbody>
              {paddingTop > 0 && (
                <tr>
                  <td colSpan={columnCount} className="logs-virtual-spacer p-0!" style={{ height: paddingTop }} />
                </tr>
              )}
              {virtualRows.map(virtualRow => {
                const log = filteredLogs[filteredLogs.length - 1 - virtualRow.index];
                const reasoningWire = reasoningWireLabel(log);
                const decodeRate = log.displayMetrics?.decodeTokPerSecond;
                const decodeRateLabels = decodeRateLabelKeys(decodeRate?.kind === "value" ? decodeRate : {});
                const when = formatLogDateParts(log.timestamp, localeTag, serverTimeZone);
                const detailLabel = `${t("logs.details")}: ${log.requestId ?? log.status}`;
                return (
               <tr
                 key={virtualRow.key}
                 data-index={virtualRow.index}
                 ref={rowVirtualizer.measureElement}
                 className="group cursor-pointer border-b border-line transition-colors last:border-b-0 hover:bg-accent-soft"
                 onClick={event => {
                   // Opens the detail like the button does; a drag that selected text is a copy, not a click.
                   if ((event.target as HTMLElement).closest("button")) return;
                   if (window.getSelection?.()?.toString()) return;
                   setDetail(log);
                 }}
               >
                 <td><LogsClientChip client={log.client} t={t} /></td>
                 <td>
                   <span className="flex flex-col leading-tight">
                     <span className="font-mono text-[12.5px] whitespace-nowrap text-fg tabular-nums">{when.time}</span>
                     <span className="mt-0.5 text-[11.5px] whitespace-nowrap text-fg-subtle tabular-nums">{when.date}</span>
                   </span>
                 </td>
                 <td>
                   <StatusPill status={log.status} outcome={classifyRequestOutcome(log)} label={t(outcomeKey(log))} />
                 </td>
                 <td title={modelTitle(log, t)}>
                   <span className="flex min-w-0 flex-col gap-1">
                     <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                       <span className="text-fg-muted">{formatProviderDisplayName(log.provider, t)}</span>
                       <span aria-hidden className="text-fg-subtle">·</span>
                       <span className="min-w-0 font-mono text-[12.5px] break-words text-fg">{servedModelLabel(log)}</span>
                       {log.shadowCallRewrittenFrom && (
                         <span className="badge badge-muted whitespace-nowrap" title={t("logs.badge.interceptedHelperTitle")}>
                           {t("logs.badge.interceptedHelper", { model: log.shadowCallRewrittenFrom })}
                         </span>
                       )}
                       {speedLabel(log) && <span className="badge badge-amber">{speedLabel(log)}</span>}
                       <ProtocolBadge trace={log.protocolTrace} t={t} />
                     </span>
                     <span className="log-reqid block max-w-full truncate font-mono text-[11.5px] text-fg-subtle" title={log.requestId}>{log.requestId ?? "-"}</span>
                   </span>
                 </td>
                  {/* The wire field (reasoning_effort=high) stays in the title and the detail
                      dialog; as a second line it repeated the label and, in mono, outgrew the
                      column and painted over the next cell. */}
                  {columns.effort && <td className="mono log-reasoning-cell" title={reasoningWire}>{effortLabel(log)}</td>}
                  {columns.tokens && (
                  <td className="text-right font-mono tabular-nums" title={tokensTitle(log, t)}>
                    {(() => {
                      const tokenTotal = displayContextTokenTotal(log);
                      const { read, write } = cacheSplit(log);
                      return tokenTotal !== undefined
                        ? (
                            <span className="logs-stack-end">
                              <span>{log.usageStatus === "estimated" ? "~" : ""}{formatTokens(tokenTotal, locale)}</span>
                              {(read !== undefined && read > 0) && (
                                <span className="text-[11.5px] leading-tight text-fg-subtle">
                                  c {formatTokens(read, locale)}
                                </span>
                              )}
                              {(write !== undefined && write > 0) && (
                                <span className="text-[11.5px] leading-tight text-fg-subtle">
                                  w {formatTokens(write, locale)}
                                </span>
                              )}
                              {(log.usageStatus === "estimated" && read === undefined && write === undefined) && (
                                <span className="text-[11.5px] leading-tight text-fg-subtle">
                                  {t(isCursorUsageProvider(log.provider) ? "logs.tokens.noCacheCursor" : "logs.tokens.noCache")}
                                </span>
                              )}
                            </span>
                          )
                        : <span className="font-sans text-fg-subtle">{t(`logs.tokens.${log.usageStatus ?? "unreported"}`)}</span>;
                    })()}
                  </td>
                  )}
                  {columns.rate && (
                  <td className="log-col-rate text-right font-mono tabular-nums">
                    <span className="logs-stack-end max-w-full">
                      <span>{formatTokPerSecond(log.displayMetrics?.tokPerSecond, localeTag)}</span>
                      {/* #4038: decode rate stacked under the end-to-end rate it is easy to mistake
                          for delivery speed. Only rendered when it actually resolved — a row whose
                          decode window was too short shows the e2e rate alone rather than a blank. */}
                      {decodeRate?.kind === "value" && (
                        <span className="logs-stack-end logs-decode-rate max-w-full text-fg-subtle" title={t(decodeRateLabels.detail)}>
                          <span>{formatTokPerSecond(decodeRate, localeTag)}</span>
                          <span className="block max-w-full truncate font-sans text-[11px]">{t(decodeRateLabels.short)}</span>
                        </span>
                      )}
                    </span>
                  </td>
                  )}
                  {columns.cost && (
                  <td className={cn("text-right tabular-nums", log.displayMetrics?.cost?.kind === "value" ? "font-mono" : "font-sans text-fg-subtle")}>
                    {formatEstimatedUsd(log.displayMetrics?.cost, t, localeTag)}
                  </td>
                  )}
                  {columns.duration && <td className="text-right font-mono whitespace-nowrap text-fg-muted tabular-nums">{log.durationMs}ms</td>}
                  <td className="px-1!">
                    <button
                      type="button"
                      className="log-detail-btn ui-v2 inline-grid size-7 cursor-pointer place-items-center rounded-[8px] text-fg-subtle no-underline transition-colors group-hover:text-fg hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-highlight"
                      onClick={() => setDetail(log)}
                      aria-label={detailLabel}
                      title={t("logs.details")}
                    >
                      <IconChevron aria-hidden className="size-4" />
                    </button>
                  </td>
                </tr>
                );
              })}
              {paddingBottom > 0 && (
                <tr>
                  <td colSpan={columnCount} className="logs-virtual-spacer p-0!" style={{ height: paddingBottom }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </div>
      )}
      </section>

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
            setFilters(prev => ({ ...prev, conversationId: id }));
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
  const decodeRate = detail.displayMetrics?.decodeTokPerSecond;
  const decodeRateLabels = decodeRateLabelKeys(decodeRate?.kind === "value" ? decodeRate : {});
  const reasoningWire = reasoningWireLabel(detail);
  const detailFailure = failureAttributionLabels(detail, t);
  const summary = failureSummary(detail, detailInfo, t);

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
          <h3 id="log-detail-title" className="flex min-w-0 flex-wrap items-center gap-2.5">
            <StatusPill status={detail.status} outcome={classifyRequestOutcome(detail)} label={t(outcomeKey(detail))} announce={false} className="h-6 text-[13px]" />
            {summary.label && <span className="logs-detail-info m-0">{summary.label}</span>}
          </h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t("common.cancel")}><IconX /></button>
        </div>
        {summary.description && <p className="modal-desc">{summary.description}</p>}

        <section className="log-detail-section" aria-labelledby="log-detail-basic">
          <h4 id="log-detail-basic" className="log-detail-section-title">{t("logs.detail.section.basic")}</h4>
          <div className="log-detail-grid">
            <span className="muted">{t("logs.col.time")}</span><span className="mono">{formatLogDateTime(detail.timestamp, localeTag, serverTimeZone)}</span>
            <span className="muted">{t("logs.detail.outcome.label")}</span>
            <span>{t(outcomeKey(detail))}</span>
            {detailFailure.cause && (
              <>
                <span className="muted">{t("logs.detail.cause.label")}</span>
                <span>
                  {detailFailure.cause}
                  {detailFailure.stage && ` (${t("logs.detail.stage.label")}: ${detailFailure.stage})`}
                </span>
              </>
            )}
            {detailFailure.resend && (
              <>
                <span className="muted">{t("logs.detail.resend.label")}</span>
                <span>{detailFailure.resend}</span>
              </>
            )}
            <span className="muted">{t("logs.detail.sends.label")}</span>
            <span className="mono">
              {summary.sends === undefined ? t("logs.detail.sends.unavailable") : summary.sends}
              {summary.unresolved !== undefined && summary.unresolved > 0
                && ` (${t("logs.detail.sends.unresolved")}: ${summary.unresolved})`}
            </span>
            {summary.retries !== undefined && <>
              <span className="muted">{t("logs.detail.retries.label")}</span>
              <span className="mono">{summary.retries}</span>
            </>}
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
            <span className="muted">{t("logs.col.model")}</span><span className="mono">{servedModelLabel(detail)}</span>
            <span className="muted">{t("logs.col.provider")}</span><span>{formatProviderDisplayName(detail.provider, t)}</span>
            {(detail.requestedEffort || detail.effectiveEffort) && (
              <><span className="muted">{t("logs.col.effort")}</span><span className="mono">{effortLabel(detail)}{reasoningWire ? ` (${reasoningWire})` : ""}</span></>
            )}
            {detail.errorCode && (<><span className="muted">{t("logs.col.error")}</span><span className="mono">{detail.errorCode}</span></>)}
            {upstreamConditionLabel(detail.upstreamCondition, t) && (<><span className="muted">{t("logs.col.upstreamReason")}</span><span>{upstreamConditionLabel(detail.upstreamCondition, t)}</span></>)}
            {failureDetailLabel(detail.failureDetail, t) && (<><span className="muted">{t("logs.col.failureDetail")}</span><span>{failureDetailLabel(detail.failureDetail, t)}</span></>)}
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

        <ProtocolTracePanel trace={detail.protocolTrace} t={t} />

        <section className="log-detail-section" aria-labelledby="log-detail-performance">
          <h4 id="log-detail-performance" className="log-detail-section-title">{t("logs.detail.section.performance")}</h4>
          <div className="log-detail-grid log-detail-performance-grid">
            <span className="muted">{t("logs.col.duration")}</span><span className="mono">{detail.durationMs}ms</span>
            <span className="muted">{t("logs.detail.endToEndTokPerSec")}</span><span className="mono">{formatTokPerSecond(detail.displayMetrics?.tokPerSecond, localeTag)}</span>
            {decodeRate?.kind === "value" && (
              <>
                <span className="muted" title={t(decodeRateLabels.hint)}>{t(decodeRateLabels.detail)}</span><span className="mono">{formatTokPerSecond(decodeRate, localeTag)}</span>
                <span className="logs-decode-basis-hint muted text-caption">{t(decodeRateLabels.hint)}</span>
              </>
            )}
            {detail.firstOutputMs !== undefined && (
              <><span className="muted">{t("logs.detail.ttft")}</span><span className="mono">{detail.firstOutputMs}ms</span></>
            )}
          </div>
          {detail.displayMetrics?.tokPerSecond.kind === "unavailable" && (
            <p className="log-detail-notes-line muted">{t(metricReasonKey(detail.displayMetrics.tokPerSecond.reason))}</p>
          )}
          {detail.displayMetrics?.decodeTokPerSecond?.kind === "unavailable" && (
            <p className="log-detail-notes-line muted">
              {t("logs.detail.decodeTokPerSec")}: {t(metricReasonKey(detail.displayMetrics.decodeTokPerSecond.reason))}
            </p>
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
                  <th className="num" title={t("logs.detail.endToEndTokPerSec")}>{t("logs.col.tokPerSec")}</th>
                  <th className="num">{t("logs.col.estimatedCost")}</th>
                  <th>{t("logs.detail.attempt.reason")}</th>
                </tr></thead>
                <tbody>{detail.attempts.toSorted((a, b) => a.ordinal - b.ordinal).map(attempt => {
                  const attemptCost = attempt.displayMetrics?.cost;
                  const decodeRate = attempt.displayMetrics?.decodeTokPerSecond;
                  const decodeRateLabels = decodeRateLabelKeys(decodeRate?.kind === "value" ? decodeRate : {});
                  const attemptReasoningWire = reasoningWireLabel(attempt);
                  const matched = attemptCost?.kind === "value" ? attemptCost.estimate.price : undefined;
                  const attemptFailure = failureAttributionLabels(attempt, t);
                  // The derived cause leads, because it is the one value in this row that says
                  // WHY in a vocabulary an operator can act on. `errorCode` stays behind it
                  // rather than being dropped: it is the exact wire code, which is what a bug
                  // report needs.
                  const reason = attemptFailure.cause
                    ?? attempt.errorCode
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
                      <td className="num mono">
                        {formatTokPerSecond(attempt.displayMetrics?.tokPerSecond, localeTag)}
                        {/* #4038: the DTO already carries a per-attempt decode rate measured on
                            that attempt's own TTFT, so the attempt table stacks it the same way
                            the parent row and the list do. */}
                        {decodeRate?.kind === "value" && (
                          <span className="logs-stack-end logs-decode-rate muted" title={t(decodeRateLabels.detail)}>
                            <span>{formatTokPerSecond(decodeRate, localeTag)}</span>
                            <span className="text-caption">{t(decodeRateLabels.short)}</span>
                          </span>
                        )}
                      </td>
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
