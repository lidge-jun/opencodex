import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ResponsesTerminalStatus } from "../bridge";
import {
  classifyError,
  CYBER_POLICY_ERROR_CODE,
  httpStatusFromTerminalError as httpStatusFromClassifiedTerminalError,
  isClientClosedMessage,
  isCyberPolicyCode,
  isCyberPolicyMessage,
  upstreamErrorMessageFromPayload,
} from "../lib/errors";
import { CODEX_CONFIG_PATH, readRootTomlString } from "../codex/paths";
import { readCodexCatalogPath } from "../codex/catalog";
import type { AttemptTierOutcome, OcxUsage } from "../types";
import { normalizeRouteDecisionTrace, type RouteDecisionTraceV1 } from "../routing/trace";
import type { AdapterRequest } from "../adapters/base";
import type { AdapterTierMetadata } from "../providers/fastwire";
import { redactSecretString, sanitizeLogMetadataString } from "../lib/redact";
import {
  appendUsageEntry,
  isKnownAdmissionKind,
  isKnownInboundProtocol,
  isKnownUsageSurface,
  isCodexUsageAccountLogLabel,
  isValidReasoningWireValue,
  normalizeStreamDiagnostics,
  readRecentUsageEntries,
  usageForFinalLog,
  usageStatusForFinalLog,
  usageTotalTokens,
  type AttemptRecoveryKind,
  type FailureSide,
  type FailureStage,
  type PersistedUsageAttempt,
  type PersistedUsageEntry,
  type StreamTimeline,
  type TerminalSource,
  type TransportPhase,
  type UsageStatus,
} from "../usage/log";
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
import { modelRecordValue } from "../reasoning-effort";

export interface RequestLogContext {
  model: string;
  provider: string;
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
  affinity?: "reused" | "new_bind" | "rebound" | "cleared";
  transportPhase?: TransportPhase;
  terminalSource?: TerminalSource;
  streamTimeline?: StreamTimeline;
  failureSide?: FailureSide;
  failureStage?: FailureStage;
  /** Bounded route-decision trace (RI-01); never contains secrets. */
  routeDecision?: RouteDecisionTraceV1;
}

export interface RequestLogEntry {
  requestId: string;
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
  /** Codex pool affinity decision for this request (diagnostics for #186). */
  affinity?: "reused" | "new_bind" | "rebound" | "cleared";
  /** Where the upstream terminal/failure was observed. */
  transportPhase?: TransportPhase;
  /** Whether the terminal came from a real upstream SSE event or a proxy synthetic tail. */
  terminalSource?: TerminalSource;
  streamTimeline?: StreamTimeline;
  failureSide?: FailureSide;
  failureStage?: FailureStage;
  /** Bounded route-decision trace (RI-01); never contains secrets. */
  routeDecision?: RouteDecisionTraceV1;
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
  return {
    requestId: entry.requestId,
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
    ...(entry.streamTimeline ? { streamTimeline: entry.streamTimeline } : {}),
    ...(entry.failureSide ? { failureSide: entry.failureSide } : {}),
    ...(entry.failureStage ? { failureStage: entry.failureStage } : {}),
    ...(entry.transportPhase ? { transportPhase: entry.transportPhase } : {}),
    ...(entry.terminalSource ? { terminalSource: entry.terminalSource } : {}),
    ...(routeDecision ? { routeDecision } : {}),
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
      ...failureDiagnostics,
      ...(entry.streamTimeline ? { streamTimeline: entry.streamTimeline } : {}),
      ...(entry.failureSide ? { failureSide: entry.failureSide } : {}),
      ...(entry.failureStage ? { failureStage: entry.failureStage } : {}),
      ...(entry.transportPhase ? { transportPhase: entry.transportPhase } : {}),
      ...(entry.terminalSource ? { terminalSource: entry.terminalSource } : {}),
      ...(entry.routeDecision ? { routeDecision: entry.routeDecision } : {}),
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
  if (requestStartedAt && !logCtx.requestStartedAt) {
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
    logCtx.usage = usage;
    if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
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
      incomplete_details?: { code?: unknown; message?: unknown };
    };
  },
): void {
  if (logCtx.terminalHttpStatus !== undefined) return;
  const type = json.type;
  if (type !== "response.failed" && type !== "response.incomplete" && type !== "error") return;
  const responseError = json.response?.error;
  const responseDetails = json.response?.incomplete_details;
  const candidates = [json.error, json.last_error, responseError, responseDetails, json];
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

export function addFinalRequestLog(
  requestId: string,
  start: number,
  logCtx: RequestLogContext,
  status: number,
  meta?: Pick<RequestLogEntry, "terminalStatus" | "closeReason">,
  addLog: (entry: RequestLogEntry) => void = addRequestLog,
): void {
  if (!logCtx.requestStartedAt) logCtx.requestStartedAt = start;
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
      logCtx.usage,
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
    ...(attempt.usage ? { usage: { ...attempt.usage } } : {}),
    ...(attempt.tierOutcome ? { tierOutcome: { ...attempt.tierOutcome } } : {}),
  }));
  const isCombo = logCtx.comboId !== undefined && (attempts?.length ?? 0) > 0;
  const aggregate = isCombo ? aggregateAttemptUsage(attempts ?? []) : null;
  const loggedUsage = aggregate?.usage ?? existing.usage;
  const usageStatus = aggregate?.status ?? existing.status;
  const totalTokens = aggregate?.totalTokens ?? existing.totalTokens;
  // Sanitize at the logging layer, not only at the one call site that populates this today.
  // The value originates in an upstream-supplied model id, so an unsanitized newline would
  // let a single field forge a record boundary in any line-oriented log viewer. Doing it here
  // means a future caller cannot reintroduce the hole by forgetting to sanitize first, and
  // the in-memory /api/logs row matches what usage.jsonl already stores.
  const shadowCallRewrittenFrom = sanitizeLogMetadataString(logCtx.shadowCallRewrittenFrom);
  addLog({
    requestId,
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
    ...(logCtx.affinity ? { affinity: logCtx.affinity } : {}),
    ...(logCtx.transportPhase ? { transportPhase: logCtx.transportPhase } : {}),
    ...(logCtx.terminalSource ? { terminalSource: logCtx.terminalSource } : {}),
    ...(logCtx.streamTimeline ? { streamTimeline: logCtx.streamTimeline } : {}),
    ...(logCtx.failureSide ? { failureSide: logCtx.failureSide } : {}),
    ...(logCtx.failureStage ? { failureStage: logCtx.failureStage } : {}),
    ...(logCtx.routeDecision ? { routeDecision: logCtx.routeDecision } : {}),
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
  attempt.provider = provider;
  attempt.adapter = adapter;
  if (isCodexUsageAccountLogLabel(accountLogLabel)) attempt.accountLogLabel = accountLogLabel;
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
