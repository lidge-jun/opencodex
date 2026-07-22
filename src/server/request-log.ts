import { existsSync, readFileSync } from "node:fs";
import type { ResponsesTerminalStatus } from "../bridge";
import {
  classifyError,
  httpStatusFromTerminalError as httpStatusFromClassifiedTerminalError,
  isClientClosedMessage,
} from "../lib/errors";
import { CODEX_CONFIG_PATH, readRootTomlString } from "../codex/paths";
import { readCodexCatalogPath } from "../codex/catalog";
import type { OcxUsage } from "../types";
import { redactSecretString } from "../lib/redact";
import {
  appendUsageEntry,
  readRecentUsageEntries,
  usageForFinalLog,
  usageStatusForFinalLog,
  usageTotalTokens,
  type AttemptRecoveryKind,
  type PersistedUsageAttempt,
  type PersistedUsageEntry,
  type UsageStatus,
} from "../usage/log";
import {
  appendUsageDebug,
  isUsageDebugEnabled,
  truncateForDebug,
  USAGE_DEBUG_BODY_SAMPLE_BYTES,
  type UsageDebugBodyKind,
} from "../usage/debug";

export interface RequestLogContext {
  model: string;
  provider: string;
  /** TTFT: ms from request start to the first non-empty model output delta (WP4, devlog 040). */
  firstOutputMs?: number;
  surface?: "claude";
  requestedModel?: string;
  /** Internal structural combo identity; omitted from RequestLogEntry/JSONL. */
  comboId?: string;
  requestedEffort?: string;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  modelSupportsServiceTier?: boolean;
  responseServiceTier?: string;
  resolvedModel?: string;
  usage?: OcxUsage;
  usageLogInputTokens?: number;
  attempts?: PersistedUsageAttempt[];
  /** Internal mutable final attempt; omitted from RequestLogEntry/JSONL. */
  activeAttempt?: PersistedUsageAttempt;
  /** Internal wall-clock origin for the committed final attempt; never persisted. */
  activeAttemptStartedAt?: number;
  usageDebugBodyKind?: UsageDebugBodyKind;
  usageDebugBodySample?: string;
  usageDebugContentType?: string;
  /** Route adapter type ("cursor"/"kiro"/"anthropic"/…): drives estimated-usage detection
   *  independent of the user-chosen provider NAME (devlog 130 B2). */
  providerAdapter?: string;
  /** Secret-redacted upstream error reason (e.g. the granular Cursor "rate limit exceeded…"
   * message) extracted from a `response.failed` SSE payload or non-streaming error body, so the
   * request log / GUI shows the actual upstream failure rather than only the HTTP-mapped code. */
  upstreamError?: string;
  /** HTTP status derived from a terminal `response.failed` SSE payload (429/401/503/etc.). */
  terminalHttpStatus?: number;
  affinity?: "reused" | "new_bind" | "rebound" | "cleared";
  transportPhase?: "pre_headers" | "mid_stream" | "terminal_sse";
  terminalSource?: "upstream" | "synthetic";
}

export interface RequestLogEntry {
  requestId: string;
  timestamp: number;
  model: string;
  provider: string;
  /** TTFT: ms from request start to the first non-empty model output delta; unset for non-streaming/tool-only. */
  firstOutputMs?: number;
  surface?: "claude";
  requestedModel?: string;
  requestedEffort?: string;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  modelSupportsServiceTier?: boolean;
  responseServiceTier?: string;
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
  transportPhase?: "pre_headers" | "mid_stream" | "terminal_sse";
  /** Whether the terminal came from a real upstream SSE event or a proxy synthetic tail. */
  terminalSource?: "upstream" | "synthetic";
}

const requestLog: RequestLogEntry[] = [];
const MAX_LOG_SIZE = 200;
let requestLogSeq = 0;
/** True after hydrateRequestLogsFromDisk ran once in this process. */
let requestLogsHydratedFromDisk = false;

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
  return {
    requestId: entry.requestId,
    timestamp: entry.timestamp,
    model: entry.model,
    provider: entry.provider,
    ...(entry.firstOutputMs !== undefined ? { firstOutputMs: entry.firstOutputMs } : {}),
    ...(entry.surface === "claude" ? { surface: entry.surface } : {}),
    ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
    ...(entry.requestedEffort ? { requestedEffort: entry.requestedEffort } : {}),
    ...(entry.requestedServiceTier ? { requestedServiceTier: entry.requestedServiceTier } : {}),
    ...(entry.requestedSpeedLabel ? { requestedSpeedLabel: entry.requestedSpeedLabel } : {}),
    ...(entry.configuredServiceTier ? { configuredServiceTier: entry.configuredServiceTier } : {}),
    ...(entry.configuredSpeedLabel ? { configuredSpeedLabel: entry.configuredSpeedLabel } : {}),
    ...(entry.modelSupportsServiceTier !== undefined
      ? { modelSupportsServiceTier: entry.modelSupportsServiceTier }
      : {}),
    ...(entry.responseServiceTier ? { responseServiceTier: entry.responseServiceTier } : {}),
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
    ...(entry.attempts?.length ? { attempts: entry.attempts } : {}),
  };
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
    for (const entry of slice) requestLog.push(requestLogEntryFromPersistedUsage(entry));
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
  requestLog.push(entry);
  if (requestLog.length > MAX_LOG_SIZE) requestLog.shift();
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
      ...(entry.surface === "claude" ? { surface: entry.surface } : {}),
      ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
      ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
      ...(entry.requestedEffort ? { requestedEffort: entry.requestedEffort } : {}),
      ...(entry.requestedServiceTier ? { requestedServiceTier: entry.requestedServiceTier } : {}),
      ...(entry.requestedSpeedLabel ? { requestedSpeedLabel: entry.requestedSpeedLabel } : {}),
      ...(entry.configuredServiceTier ? { configuredServiceTier: entry.configuredServiceTier } : {}),
      ...(entry.configuredSpeedLabel ? { configuredSpeedLabel: entry.configuredSpeedLabel } : {}),
      ...(entry.modelSupportsServiceTier !== undefined
        ? { modelSupportsServiceTier: entry.modelSupportsServiceTier }
        : {}),
      ...(entry.responseServiceTier ? { responseServiceTier: entry.responseServiceTier } : {}),
      status: entry.status,
      durationMs: entry.durationMs,
      ...(entry.firstOutputMs !== undefined ? { firstOutputMs: entry.firstOutputMs } : {}),
      usageStatus: entry.usageStatus,
      ...(entry.usage ? { usage: entry.usage } : {}),
      ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
      ...(entry.attempts?.length ? { attempts: entry.attempts } : {}),
      ...failureDiagnostics,
    });
  } catch {
    /* request logging must never fail a user request */
  }
}

export function nextRequestLogId(timestamp = Date.now()): string {
  requestLogSeq = (requestLogSeq % 1_000_000) + 1;
  return `ocx-${timestamp.toString(36)}-${requestLogSeq.toString(36)}`;
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

export function requestLogErrorCode(status: number, upstreamError?: string): string | undefined {
  if (status >= 200 && status < 400) return undefined;
  // Defense in depth: mid-stream web-search aborts used to land as 502 with this message.
  if (status === 499 || (upstreamError?.trim() && classifyError(status, "upstream_error", upstreamError).code === "client_closed_request")) {
    return "client_closed_request";
  }
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
  if (typeof model === "string" && model.trim()) logCtx.resolvedModel = model;
  const serviceTier = (source as { service_tier?: unknown }).service_tier;
  if (typeof serviceTier === "string" && serviceTier.trim()) logCtx.responseServiceTier = serviceTier;
  const usage = usageFromResponsesPayload((source as { usage?: unknown }).usage);
  if (usage) {
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
  const debugEnabled = isUsageDebugEnabled();
  const sseAlreadyMarked = logCtx.usageDebugBodyKind === "sse";
  try {
    applyResponseLogMetadata(logCtx, JSON.parse(payload));
  } catch {
    /* SSE block payload may not be JSON; metadata inspection is best-effort */
  }
  captureUpstreamError(logCtx, payload);
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
  if (!text || logCtx.upstreamError) return;
  try {
    const json = JSON.parse(text) as {
      type?: unknown;
      error?: { message?: unknown };
      last_error?: { message?: unknown };
      response?: {
        error?: { type?: unknown; code?: unknown; message?: unknown };
        incomplete_details?: { reason?: unknown };
      };
    };
    captureTerminalHttpStatus(logCtx, json);
    const message = json?.error?.message
      ?? json?.last_error?.message
      ?? json?.response?.error?.message;
    if (typeof message === "string" && message.trim()) {
      logCtx.upstreamError = redactSecretString(message).slice(0, 500);
      return;
    }
    // No human-readable error message: fall back to the structured incomplete reason emitted by
    // the bridge on a stall-timeout or adapter EOF (response.incomplete). Maps the raw reason to a
    // reader-facing label so a generic 502 in /api/logs explains WHY the turn ended, not just the
    // mapped HTTP code.
    const reason = json?.response?.incomplete_details?.reason;
    if (typeof reason === "string" && reason.trim()) {
      logCtx.upstreamError = redactSecretString(incompleteReasonLabel(reason.trim())).slice(0, 500);
    }
  } catch {
    const trimmed = text.trim();
    if (trimmed) {
      logCtx.upstreamError = redactSecretString(trimmed).slice(0, 500);
    }
  }
}

/** Map a raw `incomplete_details.reason` (emitted by the bridge) to a reader-facing label. */
function incompleteReasonLabel(reason: string): string {
  switch (reason) {
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
    response?: { error?: { type?: unknown; code?: unknown; message?: unknown } };
  },
): void {
  if (logCtx.terminalHttpStatus !== undefined) return;
  if (json.type !== "response.failed") return;
  const error = json.response?.error;
  if (!error || typeof error !== "object") return;
  logCtx.terminalHttpStatus = httpStatusFromTerminalError({
    type: typeof error.type === "string" ? error.type : undefined,
    code: error.code === null || typeof error.code === "string" ? error.code : undefined,
    message: typeof error.message === "string" ? error.message : undefined,
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
  // Mid-stream web-search aborts used to emit response.failed and land as 502/upstream_server_error.
  // Prefer the client-close classification whenever the captured reason says so.
  const effectiveStatus = status >= 500 && logCtx.upstreamError && isClientClosedMessage(logCtx.upstreamError)
    ? 499
    : status;
  const errorCode = requestLogErrorCode(effectiveStatus, logCtx.upstreamError);
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
  }
  const existing = finalizedUsage(
    logCtx.providerAdapter ?? logCtx.provider,
    logCtx.usage,
    logCtx.usageLogInputTokens,
  );
  const attempts = logCtx.attempts?.map(attempt => ({
    ...attempt,
    recoveryKinds: [...attempt.recoveryKinds],
    ...(attempt.usage ? { usage: { ...attempt.usage } } : {}),
  }));
  const isCombo = logCtx.comboId !== undefined && (attempts?.length ?? 0) > 0;
  const aggregate = isCombo ? aggregateAttemptUsage(attempts ?? []) : null;
  const loggedUsage = aggregate?.usage ?? existing.usage;
  const usageStatus = aggregate?.status ?? existing.status;
  const totalTokens = aggregate?.totalTokens ?? existing.totalTokens;
  addLog({
    requestId,
    timestamp: start,
    model: isCombo ? logCtx.requestedModel! : logCtx.model,
    provider: isCombo ? "combo" : logCtx.provider,
    ...(logCtx.surface ? { surface: logCtx.surface } : {}),
    ...(logCtx.requestedModel ? { requestedModel: logCtx.requestedModel } : {}),
    ...(logCtx.requestedEffort ? { requestedEffort: logCtx.requestedEffort } : {}),
    ...(logCtx.requestedServiceTier ? { requestedServiceTier: logCtx.requestedServiceTier } : {}),
    ...(logCtx.requestedSpeedLabel ? { requestedSpeedLabel: logCtx.requestedSpeedLabel } : {}),
    ...(logCtx.configuredServiceTier ? { configuredServiceTier: logCtx.configuredServiceTier } : {}),
    ...(logCtx.configuredSpeedLabel ? { configuredSpeedLabel: logCtx.configuredSpeedLabel } : {}),
    ...(logCtx.modelSupportsServiceTier !== undefined ? { modelSupportsServiceTier: logCtx.modelSupportsServiceTier } : {}),
    ...(logCtx.responseServiceTier ? { responseServiceTier: logCtx.responseServiceTier } : {}),
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
    ...(attempts?.length ? { attempts } : {}),
    ...(logCtx.affinity ? { affinity: logCtx.affinity } : {}),
    ...(logCtx.transportPhase ? { transportPhase: logCtx.transportPhase } : {}),
    ...(logCtx.terminalSource ? { terminalSource: logCtx.terminalSource } : {}),
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
  return filtered;
}

interface FinalizedUsageResult {
  usage?: OcxUsage;
  status: UsageStatus;
  totalTokens?: number;
}

function finalizedUsage(
  adapter: string,
  usage: OcxUsage | undefined,
  inputTokenEstimate: number | undefined,
): FinalizedUsageResult {
  const estimate = typeof inputTokenEstimate === "number"
    && Number.isFinite(inputTokenEstimate)
    && inputTokenEstimate >= 0
    ? inputTokenEstimate
    : undefined;
  const finalUsage = usageForFinalLog(adapter, usage);
  const usageFallback = !finalUsage && estimate !== undefined
    ? { inputTokens: estimate, outputTokens: 0, estimated: true }
    : undefined;
  const loggedUsage = finalUsage && estimate !== undefined
    ? {
        ...finalUsage,
        inputTokens: Math.max(finalUsage.inputTokens, estimate),
        estimated: true,
      }
    : (finalUsage ?? usageFallback);
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
): void {
  if (!attempt) return;
  attempt.provider = provider;
  attempt.adapter = adapter;
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
    attempt.inputTokenEstimate = inputTokenEstimate;
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
  requestLogSeq = 0;
  requestLogsHydratedFromDisk = false;
}
