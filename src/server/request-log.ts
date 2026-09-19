import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { stampApiKeyAccountLabel, usesApiKeyAccount } from "../providers/label";
import { KEY_ACCOUNT_LOG_LABEL_RE } from "../codex/account-label";
import { readBoundedResponseBody } from "../lib/bounded-body";
import type { ResponsesTerminalStatus } from "../bridge";
import {
  classifyError,
  CYBER_POLICY_ERROR_CODE,
  httpStatusFromTerminalError as httpStatusFromClassifiedTerminalError,
  isClientClosedMessage,
  isCyberPolicyCode,
  isCyberPolicyMessage,
  isRateLimitOrQuotaFailureMessage,
  upstreamErrorMessageFromPayload,
} from "../lib/errors";
import { CODEX_CONFIG_PATH, readRootTomlString } from "../codex/paths";
import type { CodexAffinityMove, CodexAffinityReason } from "../codex/routing";
import { readCodexCatalogPath } from "../codex/catalog";
import type { AttemptTierOutcome, OcxProviderConfig, OcxUsage } from "../types";
import { normalizeRouteDecisionTrace, type RouteDecisionTraceV1 } from "../routing/trace";
import type { AdapterRequest } from "../adapters/base";
import type { RequestSpendSettlement } from "./responses/request-spend";
import type { AdapterTierMetadata } from "../providers/fastwire";
import { redactSecretString, sanitizeLogMetadataString } from "../lib/redact";
import {
  appendUsageEntry,
  classifyCacheTelemetryProvenance,
  isKnownAdmissionKind,
  isKnownAffinityMove,
  isKnownAffinityReason,
  isKnownCacheTelemetryProvenance,
  isKnownInboundProtocol,
  isKnownUsageSurface,
  isCodexUsageAccountLogLabel,
  isLogicalRequestId,
  isValidReasoningWireValue,
  normalizeClaudeCompatibilityUsageLog,
  normalizeRequestSpend,
  normalizeStreamDiagnostics,
  readRecentUsageEntries,
  usageForFinalLog,
  usageStatusForFinalLog,
  usageTotalTokens,
  type AttemptRecoveryKind,
  type AttemptRecoveryWithheld,
  type CacheTelemetryProvenance,
  type PersistedRequestSpend,
  type FailureSide,
  type FailureStage,
  type PersistedUsageAttempt,
  type PersistedUsageEntry,
  type PersistedClaudeCompatibilityLog,
  type StreamTimeline,
  type TerminalSource,
  type TransportPhase,
  type UsageStatus,
} from "../usage/log";
import type { RequestExecutionBudget } from "../lib/request-execution-budget";
import {
  appendUsageDebug,
  isUsageDebugEnabled,
  truncateForDebug,
  USAGE_DEBUG_BODY_SAMPLE_BYTES,
  type UsageDebugBodyKind,
} from "../usage/debug";
import { matchesLogConversationId } from "./request-log-conversation";
import { enforceAppOwnedMemoryBudget, type RetainedStoreSnapshot } from "../lib/app-owned-memory";
import { capEstimateAtContextWindow } from "../lib/token-estimate";
import { inferCursorContextWindow } from "../adapters/cursor/discovery";
import { KIRO_MODEL_CONTEXT_WINDOWS, normalizeKiroModelId } from "../providers/kiro-models";
import { DEVIN_MODEL_CONTEXT_WINDOWS } from "../adapters/devin/live-models";
import { modelRecordValue } from "../reasoning-effort";

export interface RequestLogContext {
  model: string;
  provider: string;
  /**
   * Identity of the ONE logical request this context serves (#4546). Set from the execution
   * budget minted at ingress; a retry leg, a repair refetch and a combo child share it.
   */
  logicalRequestId?: string;
  /**
   * Internal live reference to this request's execution budget; omitted from RequestLogEntry and
   * JSONL. Read at final-log time so the row reports the budget's FINAL state rather than a
   * snapshot taken before the recovery legs that the row is meant to explain.
   */
  executionBudget?: RequestExecutionBudget;
  /**
   * True once usage counts were taken from a response wire rather than reported raw by the
   * adapter. It decides cache provenance: the normalizer writes zero-default token-detail
   * objects, so an all-zero cache detail from a parsed wire is not a measured cache miss.
   */
  usageWireParsed?: boolean;
  /**
   * Every affinity reason recorded for this request, in order. `affinityReason` keeps the final
   * one for the existing row shape; a request that moved twice has two causes and losing the
   * first one loses the more expensive half of the story.
   */
  affinityMoveReasons?: CodexAffinityReason[];
  /** Internal request start timestamp in wall-clock ms. */
  requestStartedAt?: number;
  /** TTFT: ms from request start to the first non-empty model output delta (WP4, devlog 040). */
  firstOutputMs?: number;
  /** Best-effort chat/session correlation for Logs grouping (#330). Opaque; omit when unknown. */
  conversationId?: string;
  surface?: "claude" | "claude-desktop" | "grok";
  /** The matched configured key's id. Set ONLY for admissionKind "configured" —
   *  never a sentinel, so a hand-edited entry whose id happens to be "loopback"
   *  cannot absorb unrelated traffic. */
  apiKeyId?: string;
  /** Which kind of admission opened this request. Carries no secret. */
  admissionKind?: "configured" | "environment" | "loopback";
  /** Which inbound wire was used. Orthogonal to `surface`, which names the client
   *  product: widening that enum would merge Responses and Chat Completions,
   *  since both leave it undefined. */
  inboundProtocol?: "responses" | "chat" | "messages";
  /**
   * Set when an adapter answered the turn locally and no upstream request was made
   * (`ProviderAdapter.localTerminal`). A fixed identifier naming the code path, never
   * conversation-derived: it exists so a request log showing zero sends is explainable
   * rather than looking like a lost request.
   */
  localTerminalReason?: string;
  /** Stable non-PII Codex Pool account identity for durable usage attribution. */
  accountLogLabel?: string;
  requestedModel?: string;
  /** User-facing alias selector when routing resolved one; native model remains `model`. */
  requestedAlias?: string;
  /** Original bare helper model when the opt-in shadow-call route rewrote this request. */
  shadowCallRewrittenFrom?: string;
  /** Internal structural combo identity; omitted from RequestLogEntry/JSONL. */
  comboId?: string;
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number | boolean;
  callerServiceTier?: string;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  modelSupportsServiceTier?: boolean;
  responseServiceTier?: string;
  /** Final-attempt tier summary; attempt rows remain the accounting source of truth. */
  tierOutcome?: AttemptTierOutcome;
  resolvedModel?: string;
  /** Internal: client-facing response metadata must not replace the physical routed model. */
  preserveResolvedModelFromRoute?: boolean;
  usage?: OcxUsage;
  usageLogInputTokens?: number;
  /**
   * The output ceiling this request may actually spend, for the durable spend reservation
   * (#4707). Captured from the caller's `max_output_tokens`; absent when the caller omitted it
   * and the adapter's own provider/model default decides, in which case only the input estimate
   * is reserved up front and settlement corrects it.
   */
  spendOutputCeilingTokens?: number;
  /** Settles this request's durable spend entries from `addFinalRequestLog`. */
  spendTracker?: RequestSpendSettlement;
  attempts?: PersistedUsageAttempt[];
  /** Internal mutable final attempt; omitted from RequestLogEntry/JSONL. */
  activeAttempt?: PersistedUsageAttempt;
  /** Internal wall-clock origin for the committed final attempt; never persisted. */
  activeAttemptStartedAt?: number;
  /** Internal adapter response observer paired with activeAttempt.tierOutcome. */
  activeTierMetadata?: AdapterTierMetadata;
  usageDebugBodyKind?: UsageDebugBodyKind;
  usageDebugBodySample?: string;
  usageDebugContentType?: string;
  /** Route adapter type ("cursor"/"kiro"/"anthropic"/…): drives estimated-usage detection
   *  independent of the user-chosen provider NAME (devlog 130 B2). */
  providerAdapter?: string;
  /** Set when the bridge reported raw adapter usage via onUsage: the bridged wire now always
   *  carries synthetic zero-default token-detail objects (strict-client normalization, see
   *  responsesUsage in src/bridge.ts), so SSE/JSON re-parsing must not overwrite the raw
   *  provenance — a synthetic cached_tokens:0 is NOT a measured cache read. */
  usageFromBridge?: boolean;
  /** Secret-redacted upstream error reason (e.g. the granular Cursor "rate limit exceeded…"
   * message) extracted from a `response.failed` SSE payload or non-streaming error body, so the
   * request log / GUI shows the actual upstream failure rather than only the HTTP-mapped code. */
  upstreamError?: string;
  /** HTTP status derived from a terminal `response.failed` SSE payload (429/401/503/etc.). */
  terminalHttpStatus?: number;
  /** Recognized structured terminal code whose exact identity must survive status mapping. */
  terminalErrorCode?: typeof CYBER_POLICY_ERROR_CODE;
  /**
   * Proxy-owned error code for a request OpenCodex terminated locally, before or instead of an
   * upstream send. Status-derived classification cannot name these: there is no upstream
   * message to classify, and the status alone would read as a provider failure.
   */
  errorCode?: string;
  /** Structured reason from `response.incomplete`; internal-only input to log classification. */
  terminalIncompleteReason?: string;
  affinity?: CodexAffinityMove;
  /** Why the binding was kept, moved, or released (#4546). */
  affinityReason?: CodexAffinityReason;
  /**
   * Set when this request dropped account-bound continuation because the serving
   * Codex pool account was not the issuer. Never an account identifier.
   */
  conversationStateScrub?: "account-change";
  transportPhase?: TransportPhase;
  terminalSource?: TerminalSource;
  streamTimeline?: StreamTimeline;
  failureSide?: FailureSide;
  failureStage?: FailureStage;
  /** Bounded route-decision trace (RI-01); never contains secrets. */
  routeDecision?: RouteDecisionTraceV1;
  /** Opt-in shadow evidence, normalized again at the logging boundary. */
  claudeCompatibility?: PersistedClaudeCompatibilityLog;
}

export interface RequestLogEntry {
  requestId: string;
  /** The logical request this row belongs to (#4546); absent on rows written without a budget. */
  logicalRequestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  /** TTFT: ms from request start to the first non-empty model output delta; unset for non-streaming/tool-only. */
  firstOutputMs?: number;
  surface?: "claude" | "claude-desktop" | "grok";
  /**
   * Set when the proxy answered this turn locally and sent nothing upstream. Without it a zero-send
   * row is indistinguishable from a request that vanished. A fixed adapter-supplied identifier,
   * never conversation-derived.
   */
  localTerminalReason?: string;
  /** The matched configured key's id. Set ONLY for admissionKind "configured" —
   *  never a sentinel, so a hand-edited entry whose id happens to be "loopback"
   *  cannot absorb unrelated traffic. */
  apiKeyId?: string;
  /** Which kind of admission opened this request. Carries no secret. */
  admissionKind?: "configured" | "environment" | "loopback";
  /** Which inbound wire was used. Orthogonal to `surface`, which names the client
   *  product: widening that enum would merge Responses and Chat Completions,
   *  since both leave it undefined. */
  inboundProtocol?: "responses" | "chat" | "messages";
  accountLogLabel?: string;
  /** Best-effort chat/session correlation for Logs grouping (#330). */
  conversationId?: string;
  requestedModel?: string;
  requestedAlias?: string;
  /** Original bare helper model when the opt-in shadow-call route rewrote this request. */
  shadowCallRewrittenFrom?: string;
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number | boolean;
  callerServiceTier?: string;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  modelSupportsServiceTier?: boolean;
  responseServiceTier?: string;
  tierOutcome?: AttemptTierOutcome;
  resolvedModel?: string;
  status: number;
  durationMs: number;
  errorCode?: string;
  terminalStatus?: ResponsesTerminalStatus;
  closeReason?: "terminal" | "client_cancel" | "non_stream" | "body_stall" | "body_overflow";
  /** Secret-redacted upstream error reason, surfaced in /api/logs and the GUI detail modal. */
  upstreamError?: string;
  usageStatus: UsageStatus;
  usage?: OcxUsage;
  totalTokens?: number;
  attempts?: PersistedUsageAttempt[];
  /**
   * Upstream spend for the whole logical request: sends aggregated across attempts and combo
   * children, split into settled and unresolved, with the budget state and move reasons that
   * explain them. Per-attempt `sendCount` stays the accounting source; this is the total.
   */
  spend?: PersistedRequestSpend;
  /** Whether this row's cache detail was observed, synthesized for the wire, or absent. */
  cacheProvenance?: CacheTelemetryProvenance;
  /** Codex pool affinity decision for this request (diagnostics for #186). */
  affinity?: CodexAffinityMove;
  /** Why that decision was made (#4546): a move is the expensive event, so it names its cause. */
  affinityReason?: CodexAffinityReason;
  /**
   * Set when this request dropped account-bound continuation after a Codex pool
   * account change. Never an account identifier.
   */
  conversationStateScrub?: "account-change";
  /** Where the upstream terminal/failure was observed. */
  transportPhase?: TransportPhase;
  /**
   * Whether the HTTP status and message originated upstream or were synthesized by this
   * proxy. Covers SSE tails and pre-stream JSON refusals. Management surfaces this so a
   * local refusal cannot be presented as an upstream reason.
   */
  terminalSource?: TerminalSource;
  streamTimeline?: StreamTimeline;
  failureSide?: FailureSide;
  failureStage?: FailureStage;
  /** Bounded route-decision trace (RI-01); never contains secrets. */
  routeDecision?: RouteDecisionTraceV1;
  /** Closed Claude protocol codes; no request or header values. */
  claudeCompatibility?: PersistedClaudeCompatibilityLog;
}

const requestLog: RequestLogEntry[] = [];
const MAX_LOG_SIZE = 2000;
const requestLogEntryBytes = new WeakMap<RequestLogEntry, number>();
let requestLogBytes = 0;
/** True after hydrateRequestLogsFromDisk ran once in this process. */
let requestLogsHydratedFromDisk = false;

function retainedRequestLogBytes(entry: RequestLogEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

function removeOldestRequestLogEntry(): number {
  const entry = requestLog.shift();
  if (!entry) return 0;
  const bytes = requestLogEntryBytes.get(entry) ?? retainedRequestLogBytes(entry);
  requestLogEntryBytes.delete(entry);
  requestLogBytes = Math.max(0, requestLogBytes - bytes);
  return bytes;
}

function retainRequestLogEntry(entry: RequestLogEntry): void {
  const bytes = retainedRequestLogBytes(entry);
  requestLog.push(entry);
  requestLogEntryBytes.set(entry, bytes);
  requestLogBytes += bytes;
  while (requestLog.length > MAX_LOG_SIZE) removeOldestRequestLogEntry();
  enforceAppOwnedMemoryBudget();
}

export function requestLogRetainedStoreSnapshot(): RetainedStoreSnapshot {
  return {
    count: requestLog.length,
    bytes: requestLogBytes,
    evictableBytes: requestLogBytes,
    pinnedBytes: 0,
    oldestAt: requestLog[0]?.timestamp ?? null,
  };
}

export function evictOldestRequestLogForBudget(): number {
  return removeOldestRequestLogEntry();
}

function asTerminalStatus(value: string | undefined): ResponsesTerminalStatus | undefined {
  if (value === "completed" || value === "failed" || value === "incomplete") return value;
  return undefined;
}

function asCloseReason(value: string | undefined): RequestLogEntry["closeReason"] | undefined {
  switch (value) {
    case "terminal":
    case "client_cancel":
    case "non_stream":
    case "body_stall":
    case "body_overflow":
      return value;
    default:
      return undefined;
  }
}

/** Project a persisted usage.jsonl row back into the in-memory /api/logs shape. */
export function requestLogEntryFromPersistedUsage(entry: PersistedUsageEntry): RequestLogEntry {
  const terminalStatus = asTerminalStatus(entry.terminalStatus);
  const closeReason = asCloseReason(entry.closeReason);
  const routeDecision = normalizeRouteDecisionTraceForLog(entry.routeDecision);
  const claudeCompatibility = normalizeClaudeCompatibilityUsageLog(entry.claudeCompatibility);
  const spend = normalizeRequestSpend(entry.spend);
  return {
    requestId: entry.requestId,
    ...(isLogicalRequestId(entry.logicalRequestId) ? { logicalRequestId: entry.logicalRequestId } : {}),
    timestamp: entry.timestamp,
    model: entry.model,
    provider: entry.provider,
    ...(entry.firstOutputMs !== undefined ? { firstOutputMs: entry.firstOutputMs } : {}),
    ...(isKnownUsageSurface(entry.surface) ? { surface: entry.surface } : {}),
    ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
    ...(isCodexUsageAccountLogLabel(entry.accountLogLabel)
      ? { accountLogLabel: entry.accountLogLabel }
      : {}),
    ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
    ...(entry.requestedAlias ? { requestedAlias: entry.requestedAlias } : {}),
    ...(entry.shadowCallRewrittenFrom
      ? { shadowCallRewrittenFrom: entry.shadowCallRewrittenFrom }
      : {}),
    ...(entry.requestedEffort ? { requestedEffort: entry.requestedEffort } : {}),
    ...(entry.effectiveEffort ? { effectiveEffort: entry.effectiveEffort } : {}),
    ...(entry.reasoningWireField ? { reasoningWireField: entry.reasoningWireField } : {}),
    ...(entry.reasoningWireValue !== undefined ? { reasoningWireValue: entry.reasoningWireValue } : {}),
    ...(entry.callerServiceTier ? { callerServiceTier: entry.callerServiceTier } : {}),
    ...(entry.requestedServiceTier ? { requestedServiceTier: entry.requestedServiceTier } : {}),
    ...(entry.requestedSpeedLabel ? { requestedSpeedLabel: entry.requestedSpeedLabel } : {}),
    ...(entry.configuredServiceTier ? { configuredServiceTier: entry.configuredServiceTier } : {}),
    ...(entry.configuredSpeedLabel ? { configuredSpeedLabel: entry.configuredSpeedLabel } : {}),
    ...(entry.modelSupportsServiceTier !== undefined
      ? { modelSupportsServiceTier: entry.modelSupportsServiceTier }
      : {}),
    ...(entry.responseServiceTier ? { responseServiceTier: entry.responseServiceTier } : {}),
    ...(entry.tierOutcome ? { tierOutcome: entry.tierOutcome } : {}),
    ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
    status: entry.status,
    durationMs: entry.durationMs,
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    ...(terminalStatus ? { terminalStatus } : {}),
    ...(closeReason ? { closeReason } : {}),
    ...(entry.upstreamError ? { upstreamError: entry.upstreamError } : {}),
    usageStatus: entry.usageStatus,
    ...(entry.usage ? { usage: entry.usage } : {}),
    ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
    ...(entry.attempts !== undefined ? { attempts: entry.attempts } : {}),
    ...(spend ? { spend } : {}),
    ...(isKnownCacheTelemetryProvenance(entry.cacheProvenance)
      ? { cacheProvenance: entry.cacheProvenance }
      : {}),
    ...persistedAffinityFields(entry),
    ...normalizeStreamDiagnostics(entry),
    ...(routeDecision ? { routeDecision } : {}),
    ...(claudeCompatibility ? { claudeCompatibility } : {}),
    ...(entry.conversationStateScrub === "account-change"
      ? { conversationStateScrub: "account-change" }
      : {}),
  };
}

/**
 * Affinity survived only in memory before this: `addFinalRequestLog` set it on the row and the
 * field-by-field disk projection never named it, so the move that discarded a warm prefix was
 * gone at the next restart — the same whitelist trap #4592 hit one layer up.
 */
function persistedAffinityFields(
  entry: Pick<RequestLogEntry, "affinity" | "affinityReason">,
): Pick<PersistedUsageEntry, "affinity" | "affinityReason"> {
  if (!isKnownAffinityMove(entry.affinity)) return {};
  return {
    affinity: entry.affinity,
    ...(isKnownAffinityReason(entry.affinityReason) ? { affinityReason: entry.affinityReason } : {}),
  };
}

/**
 * Hydration guard: persisted traces are re-normalized before they enter the
 * in-memory ring buffer so a hand-edited or corrupt row cannot poison the DTO.
 * A row that fails validation is dropped, never forwarded unvalidated.
 */
function normalizeRouteDecisionTraceForLog(
  entry: RouteDecisionTraceV1 | undefined,
): RouteDecisionTraceV1 | null {
  return entry ? normalizeRouteDecisionTrace(entry) : null;
}

/**
 * Seed the in-memory Logs ring buffer from usage.jsonl so GUI /api/logs survives
 * `ocx stop` / `ocx start` (process restart). Idempotent per process; no-ops when
 * the buffer already has live entries. Read failures are non-fatal (same as /api/usage).
 */
export function hydrateRequestLogsFromDisk(
  reader: () => PersistedUsageEntry[] = () => readRecentUsageEntries(MAX_LOG_SIZE),
): number {
  if (requestLogsHydratedFromDisk) return 0;
  if (requestLog.length > 0) {
    requestLogsHydratedFromDisk = true;
    return 0;
  }
  try {
    const persisted = reader();
    requestLogsHydratedFromDisk = true;
    if (persisted.length === 0) return 0;
    const slice = persisted.length > MAX_LOG_SIZE
      ? persisted.slice(persisted.length - MAX_LOG_SIZE)
      : persisted;
    for (const entry of slice) retainRequestLogEntry(requestLogEntryFromPersistedUsage(entry));
    return slice.length;
  } catch (err) {
    requestLogsHydratedFromDisk = true;
    console.warn(
      `[request-log] failed to hydrate from usage.jsonl: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

export function addRequestLog(entry: RequestLogEntry) {
  // Sanitize ONCE, at the ingress, and use that one value for both destinations.
  //
  // `addFinalRequestLog` is not the only way in: `addRequestLog` is exported and callable
  // directly, and it retained the caller's entry verbatim in the in-memory ring while only the
  // field-by-field disk projection below saw a sanitized value. That split let `/api/logs`
  // serve a raw upstream-supplied marker — a newline in it can forge a record boundary in a
  // line-oriented viewer — while `usage.jsonl` looked clean, which is the worst shape for a
  // sanitization bug because the safe surface is the one you check.
  const shadowCallRewrittenFrom = sanitizeLogMetadataString(entry.shadowCallRewrittenFrom);
  const claudeCompatibility = normalizeClaudeCompatibilityUsageLog(entry.claudeCompatibility);
  const diagnostics = normalizeStreamDiagnostics(entry);
  const attempts = entry.attempts?.map(attempt => {
    const normalized = { ...attempt };
    const attemptDiagnostics = normalizeStreamDiagnostics(attempt);
    if (!attemptDiagnostics.streamTimeline) delete normalized.streamTimeline;
    if (!attemptDiagnostics.failureSide) delete normalized.failureSide;
    if (!attemptDiagnostics.failureStage) delete normalized.failureStage;
    if (!attemptDiagnostics.transportPhase) delete normalized.transportPhase;
    if (!attemptDiagnostics.terminalSource) delete normalized.terminalSource;
    return { ...normalized, ...attemptDiagnostics };
  });
  const retained: RequestLogEntry = {
    ...entry,
    ...(shadowCallRewrittenFrom ? { shadowCallRewrittenFrom } : {}),
    ...(attempts ? { attempts } : {}),
    ...diagnostics,
  };
  if (!shadowCallRewrittenFrom) delete retained.shadowCallRewrittenFrom;
  if (!diagnostics.streamTimeline) delete retained.streamTimeline;
  if (!diagnostics.failureSide) delete retained.failureSide;
  if (!diagnostics.failureStage) delete retained.failureStage;
  if (!diagnostics.transportPhase) delete retained.transportPhase;
  if (!diagnostics.terminalSource) delete retained.terminalSource;
  if (claudeCompatibility) retained.claudeCompatibility = claudeCompatibility;
  else delete retained.claudeCompatibility;
  entry = retained;
  retainRequestLogEntry(entry);
  try {
    // Failure diagnostics survive the 200-entry ring buffer by riding the persisted
    // usage entry (devlog/_plan/260716_claudecode_hardening/030). Success rows stay
    // in their existing shape; the >=400 gate deliberately includes 499 client-cancels.
    const failureDiagnostics = entry.status >= 400 || (entry.terminalStatus && entry.terminalStatus !== "completed")
      ? {
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
        ...(entry.terminalStatus ? { terminalStatus: entry.terminalStatus } : {}),
        ...(entry.closeReason ? { closeReason: entry.closeReason } : {}),
        ...(entry.upstreamError ? { upstreamError: entry.upstreamError } : {}),
      }
      : {};
    appendUsageEntry({
      requestId: entry.requestId,
      ...(isLogicalRequestId(entry.logicalRequestId) ? { logicalRequestId: entry.logicalRequestId } : {}),
      timestamp: entry.timestamp,
      provider: entry.provider,
      model: entry.model,
      ...(isKnownUsageSurface(entry.surface) ? { surface: entry.surface } : {}),
      // This function REBUILDS the persisted row field by field rather than
      // spreading it, so a field missing here reaches /api/logs and never
      // reaches usage.jsonl — which is where the per-key rollup reads from.
      ...(entry.apiKeyId ? { apiKeyId: entry.apiKeyId } : {}),
      ...(isKnownAdmissionKind(entry.admissionKind) ? { admissionKind: entry.admissionKind } : {}),
      ...(isKnownInboundProtocol(entry.inboundProtocol) ? { inboundProtocol: entry.inboundProtocol } : {}),
      ...(isCodexUsageAccountLogLabel(entry.accountLogLabel)
        ? { accountLogLabel: entry.accountLogLabel }
        : {}),
      ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
      ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
      ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
      ...(entry.requestedAlias ? { requestedAlias: entry.requestedAlias } : {}),
      ...(entry.shadowCallRewrittenFrom
        ? { shadowCallRewrittenFrom: entry.shadowCallRewrittenFrom }
        : {}),
      ...(entry.requestedEffort ? { requestedEffort: entry.requestedEffort } : {}),
      ...(entry.effectiveEffort ? { effectiveEffort: entry.effectiveEffort } : {}),
      ...(entry.reasoningWireField ? { reasoningWireField: entry.reasoningWireField } : {}),
      ...(entry.reasoningWireValue !== undefined ? { reasoningWireValue: entry.reasoningWireValue } : {}),
      ...(entry.callerServiceTier ? { callerServiceTier: entry.callerServiceTier } : {}),
      ...(entry.requestedServiceTier ? { requestedServiceTier: entry.requestedServiceTier } : {}),
      ...(entry.requestedSpeedLabel ? { requestedSpeedLabel: entry.requestedSpeedLabel } : {}),
      ...(entry.configuredServiceTier ? { configuredServiceTier: entry.configuredServiceTier } : {}),
      ...(entry.configuredSpeedLabel ? { configuredSpeedLabel: entry.configuredSpeedLabel } : {}),
      ...(entry.modelSupportsServiceTier !== undefined
        ? { modelSupportsServiceTier: entry.modelSupportsServiceTier }
        : {}),
      ...(entry.responseServiceTier ? { responseServiceTier: entry.responseServiceTier } : {}),
      ...(entry.tierOutcome ? { tierOutcome: entry.tierOutcome } : {}),
      status: entry.status,
      durationMs: entry.durationMs,
      ...(entry.firstOutputMs !== undefined ? { firstOutputMs: entry.firstOutputMs } : {}),
      usageStatus: entry.usageStatus,
      ...(entry.usage ? { usage: entry.usage } : {}),
      ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
      ...(entry.attempts !== undefined ? { attempts: entry.attempts } : {}),
      ...(entry.spend ? { spend: entry.spend } : {}),
      ...(isKnownCacheTelemetryProvenance(entry.cacheProvenance)
        ? { cacheProvenance: entry.cacheProvenance }
        : {}),
      ...persistedAffinityFields(entry),
      ...failureDiagnostics,
      ...diagnostics,
      ...(entry.routeDecision ? { routeDecision: entry.routeDecision } : {}),
      ...(entry.claudeCompatibility ? { claudeCompatibility: entry.claudeCompatibility } : {}),
      ...(entry.conversationStateScrub === "account-change"
        ? { conversationStateScrub: "account-change" }
        : {}),
    });
  } catch {
    /* request logging must never fail a user request */
  }
}

export function nextRequestLogId(_timestamp = Date.now()): string {
  return `ocx-${randomBytes(16).toString("hex")}`;
}

/**
 * One-shot TTFT recorder (WP4). Records the first non-empty model output moment
 * relative to the request start, and — when a combo attempt is in flight —
 * relative to that attempt's start as well. Later calls are no-ops, so both the
 * bridge callback and the deferred SSE tap may fire without double-recording.
 */
export function recordFirstOutput(
  logCtx: RequestLogContext,
  requestStartedAt: number,
  now = Date.now(),
): void {
  if (!Number.isFinite(requestStartedAt) || !Number.isFinite(now)) return;
  const requestElapsed = Math.max(0, now - requestStartedAt);
  if (logCtx.firstOutputMs === undefined) logCtx.firstOutputMs = requestElapsed;
  if (logCtx.activeAttempt && logCtx.activeAttempt.firstOutputMs === undefined) {
    const attemptStartedAt = logCtx.activeAttemptStartedAt ?? requestStartedAt;
    logCtx.activeAttempt.firstOutputMs = Math.max(0, now - attemptStartedAt);
  }
}

export function noteStreamTimelineEvent(
  logCtx: RequestLogContext | undefined,
  event: keyof StreamTimeline,
  requestStartedAt?: number,
  now = Date.now(),
): void {
  if (!logCtx) return;
  if (requestStartedAt !== undefined && logCtx.requestStartedAt === undefined) {
    logCtx.requestStartedAt = requestStartedAt;
  }
  if (!logCtx.streamTimeline) logCtx.streamTimeline = {};
  const origin = requestStartedAt ?? logCtx.requestStartedAt ?? logCtx.activeAttemptStartedAt;
  if (origin !== undefined && logCtx.streamTimeline[event] === undefined) {
    logCtx.streamTimeline[event] = Math.max(0, now - origin);
  }
  if (logCtx.activeAttempt) {
    if (!logCtx.activeAttempt.streamTimeline) logCtx.activeAttempt.streamTimeline = {};
    const attemptOrigin = logCtx.activeAttemptStartedAt ?? requestStartedAt ?? logCtx.requestStartedAt;
    if (attemptOrigin !== undefined && logCtx.activeAttempt.streamTimeline[event] === undefined) {
      logCtx.activeAttempt.streamTimeline[event] = Math.max(0, now - attemptOrigin);
    }
  }
}

/** Snapshot target-specific requested effort even for runTurn adapters with no AdapterRequest. */
export function recordAttemptRequestedEffort(logCtx: RequestLogContext): void {
  const attempt = logCtx.activeAttempt;
  if (!attempt) return;
  delete attempt.requestedEffort;
  try {
    if (typeof logCtx.requestedEffort === "string" && logCtx.requestedEffort) {
      attempt.requestedEffort = redactSecretString(logCtx.requestedEffort).slice(0, 64);
    }
  } catch {
    // Request logging is best-effort and must not affect request delivery.
  }
}

/** Copy the adapter's exact outbound reasoning parameter into the durable request log. */
export function recordAdapterReasoning(
  logCtx: RequestLogContext,
  request: AdapterRequest,
): void {
  delete logCtx.effectiveEffort;
  delete logCtx.reasoningWireField;
  delete logCtx.reasoningWireValue;
  const attempt = logCtx.activeAttempt;
  if (attempt) {
    delete attempt.effectiveEffort;
    delete attempt.reasoningWireField;
    delete attempt.reasoningWireValue;
  }
  recordAttemptRequestedEffort(logCtx);

  // Diagnostics must never make an otherwise valid upstream request fail. Config files
  // written by older versions (or edited by hand) can contain values that violate the
  // current TypeScript shape, so validate the runtime object before redacting strings.
  try {
    const raw: unknown = request.reasoningLog;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const reasoning = raw as Record<string, unknown>;
    if (typeof reasoning.effectiveEffort !== "string" || !reasoning.effectiveEffort
      || (reasoning.wireField !== "reasoning_effort"
        && reasoning.wireField !== "reasoning.enabled"
        && reasoning.wireField !== "reasoning.effort"
        && reasoning.wireField !== "thinking_budget"
        && reasoning.wireField !== "thinking.type")
      || !isValidReasoningWireValue(reasoning.wireField, reasoning.wireValue)) {
      return;
    }

    const effectiveEffort = redactSecretString(reasoning.effectiveEffort).slice(0, 64);
    const wireValue = typeof reasoning.wireValue === "string"
      ? redactSecretString(reasoning.wireValue).slice(0, 64)
      : reasoning.wireValue;
    logCtx.effectiveEffort = effectiveEffort;
    logCtx.reasoningWireField = reasoning.wireField;
    logCtx.reasoningWireValue = wireValue;
    if (attempt) {
      attempt.effectiveEffort = effectiveEffort;
      attempt.reasoningWireField = reasoning.wireField;
      attempt.reasoningWireValue = wireValue;
    }
  } catch {
    // Request logging is best-effort and must not affect request delivery.
  }
}

/** Attach the serializing adapter's tier observation to the active durable attempt. */
export function recordAdapterTier(
  logCtx: RequestLogContext,
  request: AdapterRequest,
): void {
  recordAdapterTierMetadata(logCtx, request.tierLog);
}

/** Attach adapter-owned metadata for transports that expose no AdapterRequest (runTurn). */
export function recordAdapterTierMetadata(
  logCtx: RequestLogContext,
  metadata: AdapterTierMetadata | undefined,
): void {
  delete logCtx.tierOutcome;
  delete logCtx.activeTierMetadata;
  const attempt = logCtx.activeAttempt;
  if (attempt) delete attempt.tierOutcome;

  try {
    const outcome = metadata?.outcome;
    if (!metadata || !outcome) return;
    logCtx.tierOutcome = outcome;
    logCtx.activeTierMetadata = metadata;
    if (attempt) attempt.tierOutcome = outcome;
  } catch {
    // Request logging is best-effort and must not affect request delivery.
  }
}

export function requestLogErrorCode(
  status: number,
  upstreamError?: string,
  terminalErrorCode?: string,
): string | undefined {
  if (status >= 200 && status < 400) return undefined;
  // A structured terminal code is authoritative even when the provider message is localized,
  // generic, or absent. Only preserve the one narrowly recognized policy code here: broadly
  // forwarding arbitrary upstream codes would change unrelated request-log taxonomy.
  if (isCyberPolicyCode(terminalErrorCode)) return CYBER_POLICY_ERROR_CODE;
  const classifiedCode = upstreamError?.trim()
    ? classifyError(status, "upstream_error", upstreamError).code
    : undefined;
  // Defense in depth: mid-stream web-search aborts used to land as 502 with this message.
  if (status === 499 || classifiedCode === "client_closed_request") {
    return "client_closed_request";
  }
  // Keep the high-confidence message fallback for runtimes/providers that stripped the
  // structured code before emitting response.failed.
  if (classifiedCode === CYBER_POLICY_ERROR_CODE) return CYBER_POLICY_ERROR_CODE;
  if (status === 400 || status === 409) return "invalid_request_error";
  if (status === 401) return "invalid_api_key";
  if (status === 403) {
    // Prefer message-aware codes (e.g. Ollama Cloud subscription gates) over a blunt
    // invalid_api_key — 403 usually means authenticated but not allowed.
    if (upstreamError?.trim()) {
      const code = classifyError(403, "upstream_error", upstreamError).code;
      if (code) return code;
    }
    return "permission_denied";
  }
  if (status === 429) return "rate_limit_exceeded";
  if (status === 503) return "server_is_overloaded";
  if (status >= 500) return "upstream_server_error";
  return `http_${status}`;
}

export function requestLogSpeedLabel(serviceTier: string | undefined): string | undefined {
  const normalized = serviceTier?.trim().toLowerCase();
  if (normalized === "priority" || normalized === "fast") return "fast";
  // Ultra Fast is labelled even though nothing in the shipped catalog advertises it: the
  // reporter on #3429 reached it by hand-editing their own catalog, the request completed,
  // and the Logs column stayed empty because this returned undefined. A tier the proxy
  // forwarded but refuses to name is an observability hole, not a feature gate — the flag
  // decides whether the tier survives, not whether we admit to carrying it.
  if (normalized === "ultrafast") return "ultrafast";
  return undefined;
}

export function readConfiguredCodexServiceTier(): string | undefined {
  try {
    if (!existsSync(CODEX_CONFIG_PATH)) return undefined;
    return readRootTomlString(readFileSync(CODEX_CONFIG_PATH, "utf-8"), "service_tier") ?? undefined;
  } catch {
    return undefined;
  }
}

export function catalogModelSupportsServiceTier(modelId: string, serviceTier: string | undefined): boolean | undefined {
  if (!serviceTier) return undefined;
  const requestTier = serviceTier.trim().toLowerCase() === "fast" ? "priority" : serviceTier.trim();
  try {
    const catalogPath = readCodexCatalogPath();
    if (!existsSync(catalogPath)) return undefined;
    const catalog = JSON.parse(readFileSync(catalogPath, "utf-8")) as { models?: unknown };
    const models = Array.isArray(catalog.models) ? catalog.models : [];
    const entry = models.find(model => {
      if (!model || typeof model !== "object") return false;
      return (model as { slug?: unknown; id?: unknown }).slug === modelId
        || (model as { slug?: unknown; id?: unknown }).id === modelId;
    });
    if (!entry || typeof entry !== "object") return undefined;
    const tiers = (entry as { service_tiers?: unknown }).service_tiers;
    return Array.isArray(tiers) && tiers.some(tier => (
      tier && typeof tier === "object" && (tier as { id?: unknown }).id === requestTier
    ));
  } catch {
    return undefined;
  }
}

export function applyResponseLogMetadata(logCtx: RequestLogContext, payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const source = "response" in payload && typeof (payload as { response?: unknown }).response === "object"
    ? (payload as { response?: unknown }).response
    : payload;
  if (!source || typeof source !== "object") return;
  const model = (source as { model?: unknown }).model;
  if (
    !logCtx.preserveResolvedModelFromRoute
    && typeof model === "string"
    && model.trim()
  ) logCtx.resolvedModel = model;
  const serviceTier = (source as { service_tier?: unknown }).service_tier;
  if (typeof serviceTier === "string" && serviceTier.trim()) {
    const sanitized = sanitizeLogMetadataString(serviceTier);
    if (sanitized) logCtx.responseServiceTier = sanitized;
    logCtx.activeTierMetadata?.observeResponseServiceTier(serviceTier);
  } else if (Object.prototype.hasOwnProperty.call(source, "service_tier")) {
    logCtx.activeTierMetadata?.observeResponseServiceTier(serviceTier);
  }
  const usage = usageFromResponsesPayload((source as { usage?: unknown }).usage);
  if (usage && !logCtx.usageFromBridge) {
    if (!recordKeyWireAttemptUsage(logCtx, usage)) {
      logCtx.usage = usage;
      if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
    }
    // Counts taken off a wire, not reported raw. The zero-default token-detail objects strict
    // clients require are indistinguishable here from a measured zero, so the cache detail these
    // counts carry is recorded as synthesized rather than as an observed miss.
    logCtx.usageWireParsed = true;
  }
}

export function usageFromResponsesPayload(usage: unknown): OcxUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const raw = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
    output_tokens_details?: { reasoning_tokens?: unknown };
    total_tokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  if (typeof raw.input_tokens === "number" && typeof raw.output_tokens === "number") {
    return {
      inputTokens: raw.input_tokens,
      outputTokens: raw.output_tokens,
      ...(typeof raw.total_tokens === "number" ? { totalTokens: raw.total_tokens } : {}),
      ...(typeof raw.input_tokens_details?.cached_tokens === "number"
        ? {
            cachedInputTokens: raw.input_tokens_details.cached_tokens,
            cacheReadInputTokens: raw.input_tokens_details.cached_tokens,
          }
        : {}),
      ...(typeof raw.input_tokens_details?.cache_write_tokens === "number"
        ? { cacheCreationInputTokens: raw.input_tokens_details.cache_write_tokens }
        : {}),
      ...(typeof raw.output_tokens_details?.reasoning_tokens === "number"
        ? { reasoningOutputTokens: raw.output_tokens_details.reasoning_tokens }
        : {}),
    };
  }
  if (typeof raw.prompt_tokens === "number" && typeof raw.completion_tokens === "number") {
    return {
      inputTokens: raw.prompt_tokens,
      outputTokens: raw.completion_tokens,
      ...(typeof raw.total_tokens === "number" ? { totalTokens: raw.total_tokens } : {}),
      ...(typeof raw.prompt_tokens_details?.cached_tokens === "number"
        ? {
            cachedInputTokens: raw.prompt_tokens_details.cached_tokens,
            cacheReadInputTokens: raw.prompt_tokens_details.cached_tokens,
          }
        : {}),
      ...(typeof raw.prompt_tokens_details?.cache_write_tokens === "number"
        ? { cacheCreationInputTokens: raw.prompt_tokens_details.cache_write_tokens }
        : {}),
      ...(typeof raw.completion_tokens_details?.reasoning_tokens === "number"
        ? { reasoningOutputTokens: raw.completion_tokens_details.reasoning_tokens }
        : {}),
    };
  }
  return undefined;
}

/**
 * Mark a refusal this proxy synthesized locally. Sets origin to `synthetic` and a
 * distinct local reason so the request log cannot be read as an upstream overload.
 */
// Typed by the two fields it writes rather than by the whole context: the durable-spend tracker
// has to mark a row from a narrow view of it, and widening that view to the full context there
// would pull the entire log shape into a module that touches two of its fields.
export function markLocalRequestLogRefusal(
  logCtx: Pick<RequestLogContext, "localTerminalReason" | "terminalSource">,
  reason: string,
): void {
  logCtx.localTerminalReason = reason;
  logCtx.terminalSource = "synthetic";
}

export function inspectResponseLogJson(logCtx: RequestLogContext, text: string): void {
  try {
    applyResponseLogMetadata(logCtx, JSON.parse(text));
  } catch {
    logCtx.activeTierMetadata?.markResponseUnparseable();
    /* body may not be JSON; request log metadata is best-effort only */
  }
  captureUpstreamError(logCtx, text);
  if (isUsageDebugEnabled() && logCtx.usageDebugBodyKind === undefined) {
    logCtx.usageDebugBodyKind = "json";
    logCtx.usageDebugBodySample = truncateForDebug(text);
  }
}

export function inspectResponseLogSsePayload(logCtx: RequestLogContext, payload: string | null): void {
  if (!payload || payload.trim() === "[DONE]") return;
  let parsed: unknown | undefined;
  try {
    parsed = JSON.parse(payload);
  } catch {
    /* SSE block payload may not be JSON; metadata inspection is best-effort */
  }
  inspectResponseLogSsePayloadParsed(logCtx, payload, parsed);
}

/** Inspect an SSE payload using the caller's single best-effort JSON parse. */
export function inspectResponseLogSsePayloadParsed(
  logCtx: RequestLogContext,
  payload: string | null,
  parsed: unknown | undefined,
): void {
  if (!payload || payload.trim() === "[DONE]") return;
  const debugEnabled = isUsageDebugEnabled();
  const sseAlreadyMarked = logCtx.usageDebugBodyKind === "sse";
  if (parsed !== undefined) applyResponseLogMetadata(logCtx, parsed);
  else logCtx.activeTierMetadata?.markResponseUnparseable();
  captureUpstreamErrorParsed(logCtx, payload, parsed);
  if (debugEnabled) {
    if (!sseAlreadyMarked) {
      logCtx.usageDebugBodyKind = "sse";
      logCtx.usageDebugBodySample = truncateForDebug(payload);
    } else if (typeof logCtx.usageDebugBodySample === "string"
      && logCtx.usageDebugBodySample.length < USAGE_DEBUG_BODY_SAMPLE_BYTES) {
      const combined = `${logCtx.usageDebugBodySample}\n${payload}`;
      logCtx.usageDebugBodySample = truncateForDebug(combined);
    }
  }
}

/**
 * Capture the upstream error reason into the request log context. Codex/consumer surfaces only
 * see an HTTP-mapped error code (502 → upstream_server_error); the granular reason lives inside
 * a `response.failed` SSE payload's `error.message` (the adapter's redacted upstream message) or
 * a non-streaming JSON error body. We keep the FIRST non-empty reason (the original failure) and
 * run it through redactSecretString so secrets never reach /api/logs. Pure; safe on any text.
 */
function captureUpstreamError(logCtx: RequestLogContext, text: string | null): void {
  if (!text) return;
  let parsed: unknown | undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* retain the raw malformed payload for the bounded fallback below */
  }
  captureUpstreamErrorParsed(logCtx, text, parsed);
}

function captureUpstreamErrorParsed(
  logCtx: RequestLogContext,
  text: string,
  parsed: unknown | undefined,
): void {
  if (parsed !== undefined && parsed !== null) {
    const json = parsed as {
      type?: unknown;
      error?: { message?: unknown };
      last_error?: { message?: unknown };
      response?: {
        error?: { type?: unknown; code?: unknown; message?: unknown };
        incomplete_details?: { reason?: unknown; message?: unknown };
      };
    };
    captureTerminalHttpStatus(logCtx, json);
    const reason = json?.response?.incomplete_details?.reason;
    if (json.type === "response.incomplete"
      && logCtx.terminalIncompleteReason === undefined
      && typeof reason === "string"
      && reason.trim()) {
      logCtx.terminalIncompleteReason = reason.trim();
    }
    if (logCtx.upstreamError) return;
    const message = upstreamErrorMessageFromPayload(parsed);
    if (typeof message === "string" && message.trim()) {
      logCtx.upstreamError = redactSecretString(message).slice(0, 500);
      return;
    }
    // No human-readable error message: fall back to the structured incomplete reason emitted by
    // the bridge on a stall-timeout or adapter EOF (response.incomplete). Maps the raw reason to a
    // reader-facing label so a generic 502 in /api/logs explains WHY the turn ended, not just the
    // mapped HTTP code.
    if (typeof reason === "string" && reason.trim()) {
      logCtx.upstreamError = redactSecretString(incompleteReasonLabel(reason.trim())).slice(0, 500);
    }
    return;
  }
  if (logCtx.upstreamError) return;
  const trimmed = text.trim();
  if (trimmed) {
    logCtx.upstreamError = redactSecretString(trimmed).slice(0, 500);
  }
}

/** Map a raw `incomplete_details.reason` (emitted by the bridge) to a reader-facing label. */
function incompleteReasonLabel(reason: string): string {
  switch (reason) {
    case "max_output_tokens":
      return `Output reached the requested token limit (${reason})`;
    case "upstream_stall_timeout":
      return `Upstream stalled: no data for the stall-timeout window (${reason})`;
    case "adapter_eof":
      return `Upstream stream ended unexpectedly without a terminal event (${reason})`;
    default:
      return `Upstream incomplete: ${reason}`;
  }
}

function captureTerminalHttpStatus(
  logCtx: RequestLogContext,
  json: {
    type?: unknown;
    code?: unknown;
    message?: unknown;
    error?: { type?: unknown; code?: unknown; message?: unknown };
    last_error?: { type?: unknown; code?: unknown; message?: unknown };
    response?: {
      error?: { type?: unknown; code?: unknown; message?: unknown };
      incomplete_details?: { code?: unknown; message?: unknown; reason?: unknown };
    };
  },
): void {
  if (logCtx.terminalHttpStatus !== undefined) return;
  const type = json.type;
  if (type !== "response.failed" && type !== "response.incomplete" && type !== "error") return;
  const responseError = json.response?.error;
  const responseDetails = json.response?.incomplete_details;
  const candidates: Array<{ type?: unknown; code?: unknown; message?: unknown } | undefined> = [
    json.error, json.last_error, responseError, responseDetails, json,
  ];
  const policy = candidates.some(candidate => (
    candidate?.code === null || typeof candidate?.code === "string"
  ) && isCyberPolicyCode(candidate.code as string | null | undefined))
    || candidates.some(candidate => (
      typeof candidate?.message === "string"
      && candidate.message.trim().length > 0
      && isCyberPolicyMessage(candidate.message)
    ));
  if (policy) {
    logCtx.terminalErrorCode = CYBER_POLICY_ERROR_CODE;
    logCtx.terminalHttpStatus = 400;
    return;
  }
  // A quota terminal can carry only a structured reason, without an error message.
  // Keep this separate from normal output limits and from the policy precedence above.
  const quotaTag = (value: unknown): boolean => value === "usage_limit_reached"
    || value === "rate_limit_exceeded" || value === "insufficient_quota";
  const structuredRefusal = candidates.some(candidate => [400, 401, 403, 499].includes(
    httpStatusFromTerminalError({
      type: typeof candidate?.type === "string" ? candidate.type : undefined,
      code: typeof candidate?.code === "string" ? candidate.code : undefined,
    }),
  ));
  const ordinaryIncompleteReason = typeof responseDetails?.reason === "string"
    && ["max_output_tokens", "content_filter", "steered", "upstream_stall_timeout", "adapter_eof"].includes(responseDetails.reason);
  if (type === "response.incomplete" && !structuredRefusal && (quotaTag(responseDetails?.reason) || candidates.some(candidate =>
    quotaTag(candidate?.code)
    || quotaTag(candidate?.type) || candidate?.type === "rate_limit_error"
    || (!ordinaryIncompleteReason && typeof candidate?.message === "string" && isRateLimitOrQuotaFailureMessage(candidate.message))
  ))) {
    // The shared quota classifier also accepts a numeric HTTP status as its message.
    // Preserve explicit payment-required evidence rather than relabeling it as 429.
    logCtx.terminalHttpStatus = candidates.some(candidate => typeof candidate?.message === "string"
      && Number(candidate.message.trim()) === 402) ? 402 : 429;
    return;
  }
  if (type !== "response.failed" || !responseError || typeof responseError !== "object") return;
  const responseCode = responseError.code === null || typeof responseError.code === "string"
    ? responseError.code
    : undefined;
  logCtx.terminalHttpStatus = httpStatusFromTerminalError({
    type: typeof responseError.type === "string" ? responseError.type : undefined,
    code: responseCode,
    message: typeof responseError.message === "string" ? responseError.message : undefined,
  });
}

/** Map a terminal Responses error object to the HTTP status we record in /api/logs. */
export function httpStatusFromTerminalError(error: {
  type?: string;
  code?: string | null;
  message?: string;
} | undefined): number {
  return httpStatusFromClassifiedTerminalError(error);
}

export function httpStatusForTerminalStatus(status: ResponsesTerminalStatus): number {
  return status === "completed" ? 200 : 502;
}

export function httpStatusForRequestLogTerminal(
  status: ResponsesTerminalStatus,
  logCtx?: RequestLogContext,
): number {
  if (status === "incomplete" && (logCtx?.terminalHttpStatus === 429 || logCtx?.terminalHttpStatus === 402)) {
    return logCtx.terminalHttpStatus;
  }
  /**
   * [Decision Log]
   * - 목적과 의도: Keep request logs aligned with the successful HTTP/SSE contract.
   * - 기존 구현 및 제약 조건: All incomplete terminals were recorded as 502 even when the
   *   client-requested output limit was reached normally.
   * - 검토한 주요 대안: Treat every incomplete as success, or infer the reason from display text.
   * - 선택한 방식: Only structured max_output_tokens incompletes map to 200.
   * - 다른 대안 대신 이 방식을 선택한 이유: Stall, EOF, and unknown incompletes must remain
   *   visible failures, and display text is not a stable classification contract.
   * - 장점, 단점 및 영향: Logs stop reporting false upstream errors while retaining the
   *   incomplete terminal detail; native callers without a structured reason keep old behavior.
   */
  if (status === "incomplete" && logCtx?.terminalIncompleteReason === "max_output_tokens") {
    return 200;
  }
  if (status === "failed" && logCtx?.terminalHttpStatus !== undefined) {
    return logCtx.terminalHttpStatus;
  }
  return httpStatusForTerminalStatus(status);
}

/**
 * Aggregate one logical request's upstream spend from the rows that recorded it.
 *
 * Attempts are the accounting source and combo children are attempts of the same context, so a
 * sum over `logCtx.attempts` is the send count for one user turn — the number the amplification
 * in #4546 is measured in. A terminal status is what makes a send explainable, so the split is
 * drawn there rather than at success: a 502 is settled spend, an attempt abandoned in flight is
 * not. The budget's own counter is folded in as `reserved` because a leg that re-sent without
 * opening an attempt row is charged and unobserved, and that difference belongs in
 * `unresolved` rather than quietly inflating `settled`.
 */
export function requestSpendRecord(
  logCtx: Pick<RequestLogContext, "executionBudget" | "affinityMoveReasons" | "affinityReason">,
  attempts: readonly PersistedUsageAttempt[] | undefined,
): PersistedRequestSpend | undefined {
  const rows = attempts ?? [];
  const budget = logCtx.executionBudget;
  const reasons = [...new Set(
    (logCtx.affinityMoveReasons ?? (logCtx.affinityReason ? [logCtx.affinityReason] : []))
      .filter(isKnownAffinityReason),
  )];
  if (rows.length === 0 && !budget && reasons.length === 0) return undefined;
  const sends = rows.reduce((total, attempt) => total + attempt.sendCount, 0);
  const settled = rows.reduce(
    (total, attempt) => attempt.status >= 100 ? total + attempt.sendCount : total,
    0,
  );
  const charged = Math.max(sends, budget?.used ?? 0);
  return {
    sends,
    settled,
    unresolved: Math.max(0, charged - settled),
    ...(budget ? { reserved: budget.used, policyVersion: budget.policyVersion } : {}),
    ...(reasons.length > 0 ? { moveReasons: reasons } : {}),
  };
}

/**
 * Record an affinity decision so both the row's final answer and the sequence survive. A request
 * that moved for `quota_refusal` and then again for `transient` paid for two discarded prefixes,
 * and the single-valued field can only report the second.
 */
export function noteAffinityMove(
  logCtx: RequestLogContext,
  move: CodexAffinityMove,
  reason: CodexAffinityReason,
): void {
  logCtx.affinity = move;
  logCtx.affinityReason = reason;
  (logCtx.affinityMoveReasons ??= []).push(reason);
}

/**
 * The affinity scope a released binding belonged to: one thread, one model lane.
 *
 * Both halves are part of the key. A thread holds a separate binding per model lane, so a
 * quota refusal on one lane and a transient streak on another are two releases; keyed by thread
 * alone the second overwrites the first and one of the two rows reports a cause that never
 * happened on it.
 */
export interface AffinityModelLane {
  model: string;
  /** Thread/conversation that owns the binding; omitted when the caller has no thread identity. */
  conversationId?: string;
}

/**
 * Release reasons waiting for the request that can report them (#4546, #4598).
 *
 * Bounded like the routing-side map it mirrors: this is a diagnostic, and an unbounded map keyed
 * by conversation is a leak.
 */
const pendingNoAccountReasons = new Map<string, CodexAffinityReason>();
const MAX_PENDING_NO_ACCOUNT_REASONS = 1024;

function affinityLaneKey(lane: AffinityModelLane): string {
  return `${lane.conversationId ?? ""}\u0000${lane.model}`;
}

export function noteNoAccountAffinityReason(lane: AffinityModelLane, reason: CodexAffinityReason): void {
  if (!isKnownAffinityReason(reason)) return;
  const key = affinityLaneKey(lane);
  if (!pendingNoAccountReasons.has(key) && pendingNoAccountReasons.size >= MAX_PENDING_NO_ACCOUNT_REASONS) {
    const oldest = pendingNoAccountReasons.keys().next();
    if (!oldest.done) pendingNoAccountReasons.delete(oldest.value);
  }
  pendingNoAccountReasons.set(key, reason);
}

/** Read and forget one lane's reason. Other lanes on the same thread keep theirs. */
export function takeNoAccountAffinityReason(lane: AffinityModelLane): CodexAffinityReason | undefined {
  const key = affinityLaneKey(lane);
  const reason = pendingNoAccountReasons.get(key);
  if (reason !== undefined) pendingNoAccountReasons.delete(key);
  return reason;
}

/** Test-only process-state reset for isolated harnesses. */
export function clearNoAccountAffinityReasonsForTests(): void {
  pendingNoAccountReasons.clear();
}

/**
 * Report a selection that produced no account, on the request that failed because of it.
 *
 * A no-account resolve reaches no auth context, so until now its cause was handed to whichever
 * later resolve happened to succeed — and a pool that stays exhausted never produces one, leaving
 * the failure permanently unexplained. Attaching the reason to THIS request's own record is what
 * makes the failure self-describing: the row is written, persisted and hydrated like any other,
 * and it survives a restart.
 *
 * Deliberately not a separate synthetic row. `/api/usage` counts one row as one request, so an
 * extra event row would report a request that never existed and skew the very cost totals this
 * work exists to make trustworthy.
 */
export function recordNoAccountAffinityFailure(
  logCtx: RequestLogContext,
  lane: AffinityModelLane,
  reason?: CodexAffinityReason,
): CodexAffinityReason | undefined {
  const resolved = isKnownAffinityReason(reason) ? reason : takeNoAccountAffinityReason(lane);
  if (resolved === undefined) return undefined;
  noteAffinityMove(logCtx, "cleared", resolved);
  logCtx.errorCode ??= "codex_no_account";
  return resolved;
}
// Attempt identity can change in place while a combo parent retains an older context copy.
// These objects own their usage even after a rotation to an unknown key identity.
const keyUsageOwners = new WeakSet<PersistedUsageAttempt>();
const keyWireUsageBaselines = new WeakMap<PersistedUsageAttempt, OcxUsage | undefined>();

function cloneKeyUsage(usage: OcxUsage | undefined): OcxUsage | undefined {
  return usage ? { ...usage } : undefined;
}

/** Replace this physical send's wire snapshot against the pre-send baseline; repeats do not sum. */
export function recordKeyWireAttemptUsage(logCtx: RequestLogContext, usage: OcxUsage | undefined): boolean {
  if (!usage) return false;
  const attempt = logCtx.activeAttempt;
  if (!attempt || !keyUsageOwners.has(attempt) || !keyWireUsageBaselines.has(attempt)) return false;
  const baseline = keyWireUsageBaselines.get(attempt);
  const current = { ...usage };
  attempt.usage = baseline
    ? aggregateAttemptUsage([
      { ...attempt, usage: baseline, usageStatus: baseline.estimated ? "estimated" : "reported" },
      { ...attempt, usage: current, usageStatus: current.estimated ? "estimated" : "reported" },
    ]).usage
    : current;
  logCtx.usage = attempt.usage;
  return true;
}

export function addFinalRequestLog(
  requestId: string,
  start: number,
  logCtx: RequestLogContext,
  status: number,
  meta?: Pick<RequestLogEntry, "terminalStatus" | "closeReason">,
  addLog: (entry: RequestLogEntry) => void = addRequestLog,
): void {
  if (logCtx.requestStartedAt === undefined) logCtx.requestStartedAt = start;
  // Mid-stream web-search aborts used to emit response.failed and land as 502/upstream_server_error.
  // Prefer the client-close classification whenever the captured reason says so.
  const effectiveStatus = status >= 500 && logCtx.upstreamError && isClientClosedMessage(logCtx.upstreamError)
    ? 499
    : status;
  // A locally assigned code wins: it names a refusal this proxy made itself, which no
  // status-plus-upstream-message classification can reconstruct.
  const errorCode = logCtx.errorCode ?? requestLogErrorCode(
    effectiveStatus,
    logCtx.upstreamError,
    logCtx.terminalErrorCode,
  );
  // A response.failed whose classified status is 499 is still a client cancel, not an upstream
  // terminal failure — keep /api/logs closeReason aligned with that.
  const closeReason = effectiveStatus === 499
    ? "client_cancel"
    : meta?.closeReason;
  if (logCtx.activeAttempt) {
    finishRequestAttempt(
      logCtx.activeAttempt,
      effectiveStatus,
      Date.now() - (logCtx.activeAttemptStartedAt ?? start),
      keyUsageOwners.has(logCtx.activeAttempt)
        ? logCtx.activeAttempt.usage
        : logCtx.usage,
    );
    // The final row and its active physical attempt describe the same terminal. Preserve the
    // semantic code on both so detailed attempt telemetry cannot regress to a generic status code.
    if (errorCode) logCtx.activeAttempt.errorCode = errorCode;
    else delete logCtx.activeAttempt.errorCode;
    if (logCtx.streamTimeline && !logCtx.activeAttempt.streamTimeline) {
      logCtx.activeAttempt.streamTimeline = { ...logCtx.streamTimeline };
    }
    if (logCtx.failureSide) logCtx.activeAttempt.failureSide = logCtx.failureSide;
    if (logCtx.failureStage) logCtx.activeAttempt.failureStage = logCtx.failureStage;
    if (logCtx.transportPhase) logCtx.activeAttempt.transportPhase = logCtx.transportPhase;
    if (logCtx.terminalSource) logCtx.activeAttempt.terminalSource = logCtx.terminalSource;
  }
  // The one seam every request passes exactly once, whatever transport served it and however
  // it ended. The terminal usage belongs to the last send that left; the ledger resolves every
  // earlier send of this request as unresolved spend rather than handing its tokens back.
  logCtx.spendTracker?.settle(logCtx.usage);
  const existing = finalizedUsage(
    logCtx.providerAdapter ?? logCtx.provider,
    logCtx.usage,
    logCtx.usageLogInputTokens,
    contextWindowForModel(logCtx.providerAdapter ?? logCtx.provider, logCtx.model),
    logCtx.localTerminalReason !== undefined,
  );
  const attempts = logCtx.attempts?.map(attempt => ({
    ...attempt,
    recoveryKinds: [...attempt.recoveryKinds],
    ...(attempt.recoveryWithheld?.length ? { recoveryWithheld: [...attempt.recoveryWithheld] } : {}),
    ...(attempt.usage ? { usage: { ...attempt.usage } } : {}),
    ...(attempt.tierOutcome ? { tierOutcome: { ...attempt.tierOutcome } } : {}),
  }));
  const isCombo = logCtx.comboId !== undefined && (attempts?.length ?? 0) > 0;
  const aggregate = isCombo ? aggregateAttemptUsage(attempts ?? []) : null;
  const loggedUsage = aggregate?.usage ?? existing.usage;
  const usageStatus = aggregate?.status ?? existing.status;
  const totalTokens = aggregate?.totalTokens ?? existing.totalTokens;
  const spend = requestSpendRecord(logCtx, attempts);
  const cacheProvenance = classifyCacheTelemetryProvenance(loggedUsage, {
    wireParsed: logCtx.usageWireParsed === true,
  });
  const logicalRequestId = logCtx.logicalRequestId ?? logCtx.executionBudget?.logicalRequestId;
  // Sanitize at the logging layer, not only at the one call site that populates this today.
  // The value originates in an upstream-supplied model id, so an unsanitized newline would
  // let a single field forge a record boundary in any line-oriented log viewer. Doing it here
  // means a future caller cannot reintroduce the hole by forgetting to sanitize first, and
  // the in-memory /api/logs row matches what usage.jsonl already stores.
  const shadowCallRewrittenFrom = sanitizeLogMetadataString(logCtx.shadowCallRewrittenFrom);
  const claudeCompatibility = normalizeClaudeCompatibilityUsageLog(logCtx.claudeCompatibility);
  addLog({
    requestId,
    ...(isLogicalRequestId(logicalRequestId) ? { logicalRequestId } : {}),
    timestamp: start,
    model: isCombo ? logCtx.requestedModel! : logCtx.model,
    provider: isCombo ? "combo" : logCtx.provider,
    ...(logCtx.surface ? { surface: logCtx.surface } : {}),
    ...(logCtx.apiKeyId ? { apiKeyId: logCtx.apiKeyId } : {}),
    ...(logCtx.admissionKind ? { admissionKind: logCtx.admissionKind } : {}),
    ...(logCtx.inboundProtocol ? { inboundProtocol: logCtx.inboundProtocol } : {}),
    ...(logCtx.localTerminalReason
      ? { localTerminalReason: sanitizeLogMetadataString(logCtx.localTerminalReason) }
      : {}),
    ...(isCodexUsageAccountLogLabel(logCtx.accountLogLabel)
      ? { accountLogLabel: logCtx.accountLogLabel }
      : {}),
    ...(logCtx.conversationId ? { conversationId: logCtx.conversationId } : {}),
    ...(logCtx.requestedModel ? { requestedModel: logCtx.requestedModel } : {}),
    ...(logCtx.requestedAlias ? { requestedAlias: logCtx.requestedAlias } : {}),
    ...(shadowCallRewrittenFrom ? { shadowCallRewrittenFrom } : {}),
    ...(logCtx.requestedEffort ? { requestedEffort: logCtx.requestedEffort } : {}),
    ...(logCtx.effectiveEffort ? { effectiveEffort: logCtx.effectiveEffort } : {}),
    ...(logCtx.reasoningWireField ? { reasoningWireField: logCtx.reasoningWireField } : {}),
    ...(logCtx.reasoningWireValue !== undefined ? { reasoningWireValue: logCtx.reasoningWireValue } : {}),
    ...(logCtx.callerServiceTier ? { callerServiceTier: logCtx.callerServiceTier } : {}),
    ...(logCtx.requestedServiceTier ? { requestedServiceTier: logCtx.requestedServiceTier } : {}),
    ...(logCtx.requestedSpeedLabel ? { requestedSpeedLabel: logCtx.requestedSpeedLabel } : {}),
    ...(logCtx.configuredServiceTier ? { configuredServiceTier: logCtx.configuredServiceTier } : {}),
    ...(logCtx.configuredSpeedLabel ? { configuredSpeedLabel: logCtx.configuredSpeedLabel } : {}),
    ...(logCtx.modelSupportsServiceTier !== undefined ? { modelSupportsServiceTier: logCtx.modelSupportsServiceTier } : {}),
    ...(logCtx.responseServiceTier ? { responseServiceTier: logCtx.responseServiceTier } : {}),
    ...((attempts?.at(-1)?.tierOutcome ?? logCtx.tierOutcome)
      ? { tierOutcome: attempts?.at(-1)?.tierOutcome ?? { ...logCtx.tierOutcome! } }
      : {}),
    ...(logCtx.resolvedModel ? { resolvedModel: logCtx.resolvedModel } : {}),
    status: effectiveStatus,
    durationMs: Date.now() - start,
    ...(logCtx.firstOutputMs !== undefined ? { firstOutputMs: logCtx.firstOutputMs } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(meta?.terminalStatus ? { terminalStatus: meta.terminalStatus } : {}),
    ...(closeReason ? { closeReason } : {}),
    ...(logCtx.upstreamError ? { upstreamError: logCtx.upstreamError } : {}),
    usageStatus,
    ...(loggedUsage ? { usage: loggedUsage } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(spend ? { spend } : {}),
    // "unknown" is recorded rather than omitted whenever usage exists: a row that reported tokens
    // with no cache detail at all is a different fact from a row with no usage, and the summary
    // has to refuse both as a hit-rate denominator.
    ...(loggedUsage || cacheProvenance !== "unknown" ? { cacheProvenance } : {}),
    ...(logCtx.affinity ? { affinity: logCtx.affinity } : {}),
    ...(logCtx.affinityReason ? { affinityReason: logCtx.affinityReason } : {}),
    ...(logCtx.conversationStateScrub === "account-change"
      ? { conversationStateScrub: "account-change" }
      : {}),
    ...(logCtx.transportPhase ? { transportPhase: logCtx.transportPhase } : {}),
    ...(logCtx.terminalSource ? { terminalSource: logCtx.terminalSource } : {}),
    ...(logCtx.streamTimeline ? { streamTimeline: logCtx.streamTimeline } : {}),
    ...(logCtx.failureSide ? { failureSide: logCtx.failureSide } : {}),
    ...(logCtx.failureStage ? { failureStage: logCtx.failureStage } : {}),
    ...(logCtx.routeDecision ? { routeDecision: logCtx.routeDecision } : {}),
    ...(claudeCompatibility ? { claudeCompatibility } : {}),
  });
  if (isUsageDebugEnabled()) {
    appendUsageDebug({
      ts: Date.now(),
      requestId,
      provider: logCtx.provider,
      model: logCtx.model,
      upstreamContentType: logCtx.usageDebugContentType ?? null,
      upstreamStatus: effectiveStatus,
      bodyKind: logCtx.usageDebugBodyKind ?? "none",
      bodySample: logCtx.usageDebugBodySample ?? "",
      extractedUsage: loggedUsage ?? null,
    });
  }
}

export function filterRequestLogs(logs: RequestLogEntry[], params: URLSearchParams): RequestLogEntry[] {
  let filtered = logs;
  const provider = params.get("provider")?.trim();
  if (provider) {
    filtered = filtered.filter(entry => entry.provider === provider
      || entry.attempts?.some(attempt => attempt.provider === provider));
  }
  const conversationId = params.get("conversationId")?.trim() || params.get("conversation")?.trim();
  if (conversationId) {
    filtered = filtered.filter(entry => matchesLogConversationId(entry.conversationId, conversationId));
  }
  // #2704: there was no `model` clause at all, so `?model=x` was ACCEPTED and silently
  // ignored -- worse than an error, because it yields wrong conclusions from output that
  // looks correct. Attempts are matched for the same reason `provider` matches them: a
  // request that failed over should be findable by the model that actually served it.
  const model = params.get("model")?.trim();
  if (model) {
    filtered = filtered.filter(entry => entry.model === model
      || entry.attempts?.some(attempt => attempt.model === model));
  }
  // #4057: "which account served this request" is the first question asked when one provider
  // holds several accounts, and until now the only way to answer it was to grep usage.jsonl by
  // hand. Attempts are matched for the same reason `provider` and `model` match them: when a
  // request failed over between pool accounts, a search for the account that finally served it
  // has to find that request, not only the account that first refused it.
  const account = params.get("account")?.trim();
  if (account) {
    filtered = filtered.filter(entry => entry.accountLogLabel === account
      || entry.attempts?.some(attempt => attempt.accountLogLabel === account));
  }
  const status = params.get("status")?.trim().toLowerCase();
  if (status) {
    filtered = /^[1-5]xx$/.test(status)
      ? filtered.filter(entry => Math.floor(entry.status / 100) === Number(status[0]))
      : filtered.filter(entry => String(entry.status) === status);
  }
  const tailRaw = params.get("tail")?.trim();
  if (tailRaw) {
    const tail = Number.parseInt(tailRaw, 10);
    if (Number.isFinite(tail) && tail > 0) filtered = filtered.slice(-Math.min(tail, MAX_LOG_SIZE));
  }
  const offsetRaw = params.get("offset")?.trim();
  const limitRaw = params.get("limit")?.trim();
  if (limitRaw) {
    const limit = Number.parseInt(limitRaw, 10);
    const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : 0;
    if (Number.isFinite(limit) && limit > 0) {
      const capped = Math.min(limit, MAX_LOG_SIZE);
      const startOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
      const end = filtered.length - startOffset;
      if (end <= 0) filtered = [];
      else {
        const begin = Math.max(0, end - capped);
        filtered = filtered.slice(begin, end);
      }
    }
  }
  return filtered;
}

export function filteredRequestLogCount(logs: RequestLogEntry[], params: URLSearchParams): number {
  const withoutPagination = new URLSearchParams(params);
  withoutPagination.delete("limit");
  withoutPagination.delete("offset");
  return filterRequestLogs(logs, withoutPagination).length;
}

interface FinalizedUsageResult {
  usage?: OcxUsage;
  status: UsageStatus;
  totalTokens?: number;
}

/**
 * Context window for the routed model, used to cap the token estimate (codex-router PR #140):
 * a request the provider answered cannot have exceeded the window, so the estimate must never
 * claim it did. The family is picked by the route ADAPTER, not the model id alone, because
 * claude-family ids are shared between Kiro and Cursor with different windows. Kiro "auto" is
 * a router with no fixed window and is never guessed; unknown adapters/models stay uncapped.
 */
function contextWindowForModel(adapter: string, modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  if (adapter === "kiro" || adapter.startsWith("kiro-")) {
    const normalized = normalizeKiroModelId(modelId);
    if (normalized === "auto") return undefined;
    return modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, modelId)
      ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, normalized);
  }
  if (adapter === "cursor" || adapter.startsWith("cursor-")) {
    return inferCursorContextWindow(modelId);
  }
  if (adapter === "devin") {
    return modelRecordValue(DEVIN_MODEL_CONTEXT_WINDOWS, modelId);
  }
  return undefined;
}

function finalizedUsage(
  adapter: string,
  usage: OcxUsage | undefined,
  inputTokenEstimate: number | undefined,
  contextWindow: number | undefined,
  locallyAnswered = false,
): FinalizedUsageResult {
  // The ESTIMATE itself is capped at the model's context window (codex-router PR #140). The
  // combined value below keeps its max(inputTokens, estimate) behavior — a provider-reported
  // positive count is never reduced by this cap, only the estimate that could substitute it.
  const estimate = typeof inputTokenEstimate === "number"
    && Number.isFinite(inputTokenEstimate)
    && inputTokenEstimate >= 0
    ? capEstimateAtContextWindow(inputTokenEstimate, contextWindow)
    : undefined;
  const finalUsage = usageForFinalLog(adapter, usage, locallyAnswered);
  const usageFallback = !finalUsage && estimate !== undefined
    ? { inputTokens: estimate, outputTokens: 0, estimated: true }
    : undefined;
  const combinedInputTokens = finalUsage && estimate !== undefined
    ? Math.max(finalUsage.inputTokens, estimate)
    : undefined;
  const loggedUsage = finalUsage && combinedInputTokens !== undefined
    ? {
        ...finalUsage,
        inputTokens: combinedInputTokens,
        totalTokens: combinedInputTokens + finalUsage.outputTokens,
        estimated: true,
      }
    : finalUsage
      // When the adapter alone produced an estimated count and no local estimate
      // exists, cap it at the context window — an adapter estimate above the window
      // misleads the usage dashboard.  The combined branch (above) already caps the
      // ESTIMATE via capEstimateAtContextWindow, and Math.max preserves a real
      // provider-reported count, so it needs no further reduction.
      ? (finalUsage.estimated && contextWindow !== undefined && finalUsage.inputTokens > contextWindow
          ? {
              ...finalUsage,
              inputTokens: contextWindow,
              totalTokens: contextWindow + finalUsage.outputTokens,
            }
          : finalUsage)
      : usageFallback;
  const totalTokens = usageTotalTokens(loggedUsage);
  return {
    status: usageStatusForFinalLog(loggedUsage),
    ...(loggedUsage ? { usage: loggedUsage } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

export function beginRequestAttempt(
  ordinal: number,
  provider: string,
  model: string,
  adapter: string,
): PersistedUsageAttempt {
  return {
    ordinal,
    provider,
    model,
    adapter,
    status: 0,
    durationMs: 0,
    sendCount: 0,
    recoveryKinds: [],
    usageStatus: "unreported",
  };
}

export function sealRequestAttemptIdentity(
  attempt: PersistedUsageAttempt | undefined,
  provider: string,
  adapter: string,
  accountLogLabel?: string,
): void {
  if (!attempt) return;
  if (attempt.provider !== provider || attempt.adapter !== adapter) delete attempt.credentialSource;
  attempt.provider = provider;
  attempt.adapter = adapter;
  if (isCodexUsageAccountLogLabel(accountLogLabel)) attempt.accountLogLabel = accountLogLabel;
  else delete attempt.accountLogLabel;
}

/** Preserve metered JSON failures before key recovery consumes/cancels their body. */
export async function recordKeyAttemptFailure(logCtx: RequestLogContext, response: Response, signal?: AbortSignal): Promise<void> {
  const attempt = logCtx.activeAttempt;
  if (!attempt || !KEY_ACCOUNT_LOG_LABEL_RE.test(attempt.accountLogLabel ?? "")) return;
  attempt.status = response.status;
  const cancelOriginal = (): void => { try { void response.body?.cancel().catch(() => {}); } catch { /* closed */ } };
  signal?.addEventListener("abort", cancelOriginal, { once: true });
  try {
    if (signal?.aborted) { cancelOriginal(); return; }
    const body = await readBoundedResponseBody(response.clone(), { signal, totalTimeoutMs: 1000, inactivityTimeoutMs: 1000 });
    if (body.truncated || body.oversized) return;
    const value = JSON.parse(body.text);
    const usage = usageFromResponsesPayload(value?.usage ?? value?.response?.usage);
    if (usage) recordKeyWireAttemptUsage(logCtx, usage);
  } catch { /* Absent/malformed usage remains unknown; recovery still owns the response. */ }
  finally { signal?.removeEventListener("abort", cancelOriginal); }
}

/** Add raw per-response usage before a bridge combines multiple rounds for the client. */
export function recordKeyAttemptUsage(logCtx: RequestLogContext, usage: OcxUsage | undefined): void {
  const attempt = logCtx.activeAttempt;
  if (!attempt || !usage) return;
  attempt.usage = attempt.usage
    ? aggregateAttemptUsage([{ ...attempt, usageStatus: attempt.usage.estimated ? "estimated" : "reported" },
      { ...attempt, usage, usageStatus: usage.estimated ? "estimated" : "reported" }]).usage
    : { ...usage };
  logCtx.usage = attempt.usage;
}

/** A stable active object lets combo/stream callbacks keep pointing at the final attempt.
 * Earlier key segments are immutable, flat snapshots inserted before that active object. */
export function noteProviderAttemptSend(
  logCtx: RequestLogContext,
  providerName: string,
  provider: OcxProviderConfig,
  inputTokenEstimate: number | undefined,
  recovery?: AttemptRecoveryKind,
): void {
  const attempt = logCtx.activeAttempt;
  const previous = attempt?.accountLogLabel;
  stampApiKeyAccountLabel(logCtx, providerName, provider);
  const next = logCtx.accountLogLabel;
  if (attempt && usesApiKeyAccount(provider)) keyUsageOwners.add(attempt);
  if (attempt && attempt.sendCount > 0 && previous !== next
    && (KEY_ACCOUNT_LOG_LABEL_RE.test(previous ?? "") || KEY_ACCOUNT_LOG_LABEL_RE.test(next ?? ""))) {
    // An input estimate is not evidence that a failed send used that many tokens.
    delete attempt.inputTokenEstimate;
    finishRequestAttempt(attempt, attempt.status >= 100 ? attempt.status
      : recovery === "key-401" ? 401 : recovery?.includes("429") ? 429 : 502,
    Date.now() - (logCtx.activeAttemptStartedAt ?? Date.now()), attempt.usage);
    const completed = { ...attempt, recoveryKinds: [...attempt.recoveryKinds],
      ...(attempt.usage ? { usage: { ...attempt.usage } } : {}),
      ...(attempt.tierOutcome ? { tierOutcome: { ...attempt.tierOutcome } } : {}) };
    const attempts = logCtx.attempts ??= [attempt];
    const index = attempts.indexOf(attempt);
    if (index >= 0) attempts.splice(index, 0, completed);
    else attempts.push(completed, attempt);
    const fresh = beginRequestAttempt(completed.ordinal + 1, providerName, completed.model, completed.adapter);
    // Effort/tier metadata describes the request and is captured before the physical send.
    for (const key of ["requestedEffort", "effectiveEffort", "reasoningWireField", "reasoningWireValue", "tierOutcome"] as const) {
      if (completed[key] !== undefined) Object.assign(fresh, { [key]: completed[key] });
    }
    for (const key of Object.keys(attempt)) delete (attempt as unknown as Record<string, unknown>)[key];
    Object.assign(attempt, fresh);
    delete logCtx.usage;
    logCtx.activeAttemptStartedAt = Date.now();
  }
  if (attempt) {
    sealRequestAttemptIdentity(attempt, logCtx.provider, attempt.adapter, next);
    recordAttemptCredentialSource(attempt, providerName, provider, attempt.adapter);
  }
  noteAttemptSend(attempt, inputTokenEstimate, recovery);
  if (attempt && keyUsageOwners.has(attempt)) {
    keyWireUsageBaselines.set(attempt, cloneKeyUsage(attempt.usage));
  }
}

/** Capture only the resolved upstream route; inbound auth and today's config cannot label old usage. */
export function recordAttemptCredentialSource(
  attempt: PersistedUsageAttempt | undefined,
  providerName: string,
  provider: Pick<OcxProviderConfig, "authMode" | "baseUrl" | "adapter">,
  adapterName: string = provider.adapter,
): void {
  if (!attempt) return;
  // Rebinding an attempt to an unrecognized route must not retain its previous attribution.
  delete attempt.credentialSource;
  if (providerName !== "xai"
    || !["openai-chat", "openai-responses"].includes(adapterName)) return;
  try {
    const url = new URL(provider.baseUrl ?? "");
    if (url.protocol !== "https:" || url.port || url.username || url.password
      || url.search || url.hash || !["/v1", "/v1/"].includes(url.pathname)) return;
    if (provider.authMode === "oauth" && url.hostname === "cli-chat-proxy.grok.com") {
      attempt.credentialSource = "grok-oauth";
    } else if ((provider.authMode === "key" || provider.authMode === undefined)
      && url.hostname === "api.x.ai") {
      attempt.credentialSource = "xai-api-key";
    }
  } catch {
    // Invalid/custom destinations have no known subscription provenance.
  }
}

export function noteAttemptSend(
  attempt: PersistedUsageAttempt | undefined,
  inputTokenEstimate: number | undefined,
  recovery?: AttemptRecoveryKind,
): void {
  if (!attempt) return;
  attempt.sendCount += 1;
  if (typeof inputTokenEstimate === "number"
    && Number.isFinite(inputTokenEstimate)
    && inputTokenEstimate >= 0) {
    // Store the ESTIMATE field already capped at the model's window (codex-router PR #140):
    // what gets persisted, and later merged into usage, never claims a count above the window.
    attempt.inputTokenEstimate = capEstimateAtContextWindow(
      inputTokenEstimate,
      contextWindowForModel(attempt.adapter, attempt.model),
    );
  }
  if (recovery && !attempt.recoveryKinds.includes(recovery)) {
    attempt.recoveryKinds.push(recovery);
  }
}

/**
 * Record that a recovery this attempt was eligible for did not happen.
 *
 * Deliberately NOT `noteAttemptSend`: nothing was sent, so `sendCount` must not move. The two
 * together are what make a one-send log readable — no kind and no withheld reason means nothing
 * was eligible, a withheld reason means something was and the budget refused it (#5044).
 */
export function noteAttemptRecoveryWithheld(
  attempt: PersistedUsageAttempt | undefined,
  reason: AttemptRecoveryWithheld,
): void {
  if (!attempt) return;
  if (!attempt.recoveryWithheld) attempt.recoveryWithheld = [];
  if (!attempt.recoveryWithheld.includes(reason)) attempt.recoveryWithheld.push(reason);
}

export function finishRequestAttempt(
  attempt: PersistedUsageAttempt,
  status: number,
  durationMs: number,
  usage?: OcxUsage,
): PersistedUsageAttempt {
  const finalized = finalizedUsage(
    attempt.adapter,
    usage ?? attempt.usage,
    attempt.inputTokenEstimate,
    contextWindowForModel(attempt.adapter, attempt.model),
    attempt.locallyAnswered === true,
  );
  attempt.status = status;
  attempt.durationMs = Math.max(0, durationMs);
  attempt.usageStatus = finalized.status;
  if (finalized.usage) attempt.usage = finalized.usage;
  else delete attempt.usage;
  if (finalized.totalTokens !== undefined) attempt.totalTokens = finalized.totalTokens;
  else delete attempt.totalTokens;
  const errorCode = requestLogErrorCode(status);
  if (errorCode) attempt.errorCode = errorCode;
  else delete attempt.errorCode;
  return attempt;
}

export function aggregateAttemptUsage(
  attempts: readonly PersistedUsageAttempt[],
): FinalizedUsageResult {
  const status: UsageStatus = attempts.length > 0
    && attempts.every(attempt => attempt.usageStatus === "unsupported")
    ? "unsupported"
    : attempts.some(attempt => (
        attempt.usageStatus === "unreported" || attempt.usageStatus === "unsupported"
      ))
      ? "unreported"
      : attempts.some(attempt => attempt.usageStatus === "estimated")
        ? "estimated"
        : attempts.length > 0
          ? "reported"
          : "unreported";

  const usages = attempts.flatMap(attempt => attempt.usage ? [attempt.usage] : []);
  if (usages.length === 0) return { status };

  const sumOptional = (
    key: "cachedInputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens"
      | "reasoningOutputTokens",
  ): number | undefined => {
    const present = usages.flatMap(usage => (
      typeof usage[key] === "number" ? [usage[key] as number] : []
    ));
    return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
  };
  const cachedInputTokens = sumOptional("cachedInputTokens");
  const cacheReadInputTokens = sumOptional("cacheReadInputTokens");
  const cacheCreationInputTokens = sumOptional("cacheCreationInputTokens");
  const reasoningOutputTokens = sumOptional("reasoningOutputTokens");
  const totalTokens = usages.reduce(
    (sum, usage) => sum + (usageTotalTokens(usage) ?? 0),
    0,
  );
  const aggregate: OcxUsage = {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    totalTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(status === "estimated" ? { estimated: true } : {}),
  };
  return { usage: aggregate, status, totalTokens };
}

export function getRequestLogEntries(): RequestLogEntry[] { return requestLog; }

/** Test-only process-state reset for isolated integration harnesses. */
export function clearRequestLogsForTests(): void {
  requestLog.length = 0;
  requestLogBytes = 0;
  requestLogsHydratedFromDisk = false;
}
