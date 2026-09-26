import type { AdapterEvent, OcxConfig } from "../../types";
import { routeConcreteModel, type RouteResult } from "../../router";
import { copyPlainData } from "../../lib/plain-data";
import { jsonUtf8Bytes } from "../../lib/json-byte-size";
import type { TranslatorBudget } from "../../lib/translator-budget";
import { readBoundedResponseBytes } from "../../lib/bounded-body";
import { isRequestExecutionBudget, type RequestExecutionBudget, type SingleUseDispatchPermit } from "../../lib/request-execution-budget";
import { isNonReplayableResponse, isNonReplayableUpstreamCode, markResponseNonReplayable, TRANSIENT_RETRY_MAX_ATTEMPTS } from "../../lib/upstream-retry";
import { isCyberPolicyCode, isTerminalRefusalCode } from "../../lib/errors";
import { isCanonicalOpenAiForwardProvider, supportsNativeResponsesCompactEndpoint } from "../../providers/openai-tiers";
import { bridgeToResponsesSSE, formatErrorResponse } from "../../bridge";
import { buildCompactV1Output, decodeCompactionSummary, encodeCompactionSummary, extractCompactUserMessages } from "../../responses/compaction";
import { finishRequestAttempt, usageFromResponsesPayload, type RequestLogContext } from "../request-log";
import { linkRequestSessionLane } from "../request-log-conversation";
import { isNativePassthroughSseResponse, markNativePassthroughSseResponse, isEagerRelaySseResponse, markEagerRelaySseResponse } from "../relay";
import type { HandleResponsesOptions } from "./core-options";
import { consumeComboFailure, createChildPassthroughCallbackGate } from "./core-combo-failure";
import { preflightComboStreamResponse } from "./combo-stream-preflight";
import { conversationCarriesUploadedFiles } from "./account-change-state";
import { selfContainedResponsesBody } from "./reset-replay";
import { decideCompactionRecovery, readCompactionRecoveryConfig } from "./compaction-recovery-policy";

type Options = HandleResponsesOptions & { translatorBudget: TranslatorBudget };
type Dispatch = (req: Request, config: OcxConfig, log: RequestLogContext, options: Options) => Promise<Response>;
const MAX_BYTES = 32 * 1024 * 1024;
const RETAINED_USER_CHARS = 80_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const token = (value: unknown): string | undefined => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;

function identity(route: RouteResult): string {
  return JSON.stringify([route.providerName, route.modelId, route.codexAccountMode ?? "", route.codexAccountNamespace ?? ""]);
}

function physicalSends(log: RequestLogContext): number {
  // activeAttempt normally also belongs to attempts: count each receipt exactly once.
  const attempts = new Set([...(log.attempts ?? []), ...(log.activeAttempt ? [log.activeAttempt] : [])]);
  return [...attempts].reduce((sum, attempt) => sum + Math.max(0, attempt.sendCount), 0);
}

/** Reconcile only this leg's physical receipts; never charge already-booked adapter sends again. */
function settlePhysicalSends(log: RequestLogContext, budget: RequestExecutionBudget, beforeSends: number, beforeUsed: number, reported: number, permit?: SingleUseDispatchPermit): number {
  const sent = Math.max(0, physicalSends(log) - beforeSends);
  // A legacy fetch leg does not claim the hop through adapterDispatchBudget. Settle its
  // prepaid booking explicitly; an adapter-owned leg already claimed it, making this a no-op.
  if (sent > 0) permit?.assumeCharge();
  else permit?.release();
  // An external report may settle a prepaid booking without changing used. Its explicit
  // receipt outranks the numeric delta, or the same source send would be charged twice.
  const unreported = Math.max(0, sent - Math.max(reported, Math.max(0, budget.used - beforeUsed)));
  if (unreported > 0) budget.used += unreported;
  return sent;
}

function portableBody(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.input) || body.store === true || conversationCarriesUploadedFiles(body)) return false;
  // Native ciphertext cannot be summarized by another provider. Never silently replace it with a note.
  if (body.input.some(item => record(item) && ["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))
    && typeof item.encrypted_content === "string" && !item.encrypted_content.startsWith("ocx1:"))) return false;
  const input = body.input.filter(item => !record(item) || item.type !== "compaction_trigger");
  return selfContainedResponsesBody({ ...body, store: false, input });
}

function routed(route: RouteResult): boolean {
  return !route.combo && route.routeKind !== "policy" && route.routeReason !== "default-provider"
    && !isCanonicalOpenAiForwardProvider(route.provider)
    && !supportsNativeResponsesCompactEndpoint(route.providerName, route.provider);
}

/** One reader, bounded bytes, and an exact replacement body; never clone a live stream. */
async function bufferedJson(response: Response, signal: AbortSignal): Promise<{ response: Response; json?: Record<string, unknown> }> {
  const bytes = await readBoundedResponseBytes(response, { signal, maxBytes: MAX_BYTES, inactivityTimeoutMs: 300_000 });
  if (bytes.oversized) return { response: formatErrorResponse(502, "translation_buffer_limit", "Compaction recovery response exceeded its byte limit") };
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  const replacement = new Response(bytes.bytes, { status: response.status, statusText: response.statusText, headers });
  if (isNonReplayableResponse(response)) markResponseNonReplayable(replacement);
  try {
    const json: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.bytes));
    return { response: replacement, ...(record(json) ? { json } : {}) };
  } catch { return { response: replacement }; }
}

/**
 * Opt-in recovery for routed compaction only. Native compact/ciphertext, stored continuations,
 * policy/combo routes and hosted tools retain their original failure. This owns no credentials.
 */
export async function runWithCompactionRecovery(
  req: Request, config: OcxConfig, logCtx: RequestLogContext, options: Options, dispatch: Dispatch,
): Promise<Response> {
  const recovery = readCompactionRecoveryConfig(config.compactionRecovery);
  if (!recovery || options.compactionRecoveryAttempted || options.comboAttempt || (options.inboundWire && options.inboundWire !== "responses")) {
    return dispatch(req, config, logCtx, options);
  }
  let snapshot: Record<string, unknown> | undefined;
  let snapshotBytes = 0;
  let sourceRoute: RouteResult | undefined;
  let partialOutput = false;
  let replayUnsafe = false;
  let adapterError: Extract<AdapterEvent, { type: "error" }> | undefined;
  let sourceFailure: Response | undefined;
  let recoveryPermit: SingleUseDispatchPermit | undefined;
  let restoreSourceLog: ((attemptStatus?: number) => void) | undefined;
  let sourceReportedSends = 0;
  const gate = createChildPassthroughCallbackGate(options);
  const signal = options.abortSignal ?? req.signal;
  const spentBefore = options.sendBudget?.used ?? 0;
  const sendsBefore = physicalSends(logCtx);
  const firstOptions: Options = {
    ...options,
    onCompactionRecoverySendsReported(count) {
      sourceReportedSends += count;
      options.onCompactionRecoverySendsReported?.(count);
    },
    onRequestBodyParsed(body) {
      options.onRequestBodyParsed?.(body);
      if (!record(body) || !Array.isArray(body.input) || typeof body.model !== "string"
        || !body.input.some(item => record(item) && item.type === "compaction_trigger") || !portableBody(body)) return;
      const users = extractCompactUserMessages(body.input);
      if ((users.at(-1)?.length ?? 0) > RETAINED_USER_CHARS) return;
      try {
        const bytes = jsonUtf8Bytes(body, MAX_BYTES);
        const reservation = options.translatorBudget.reserveTransient(bytes, { kind: "request_copies" });
        try {
          const copy = copyPlainData(body);
          if (!copy.ok) return;
          snapshot = copy.value;
          snapshotBytes = bytes;
          reservation.commitRetained();
        } finally { reservation.release(); }
      } catch { /* Optional recovery cannot reject an otherwise valid original request. */ }
    },
    onCompactionRecoveryRoute(route) {
      options.onCompactionRecoveryRoute?.(route);
      if (snapshot && routed(route)) sourceRoute = { ...route };
    },
    onCompactionRecoveryAdapterEvent(event) {
      options.onCompactionRecoveryAdapterEvent?.(event);
      if (!snapshot) return;
      if (event.type === "heartbeat") replayUnsafe ||= event.replayUnsafe === true;
      else if (event.type === "error") adapterError = event;
      else if (event.type !== "done") partialOutput = true;
    },
    onResponseComplete: model => snapshot ? gate.onResponseComplete(model) : options.onResponseComplete?.(model),
    onNativePassthroughTerminal: status => snapshot ? gate.onTerminal(status) : options.onNativePassthroughTerminal?.(status),
    onNativePassthroughCancel: () => snapshot ? gate.onCancel() : options.onNativePassthroughCancel?.(),
  };
  try {
    let response = await dispatch(req, config, logCtx, firstOptions);
    const keep = (value: Response) => { gate.commit(); return value; };
    if (!snapshot || !sourceRoute || signal.aborted || req.signal.aborted || isNonReplayableResponse(response)) return keep(response);
    let target: RouteResult;
    try { target = routeConcreteModel(config, recovery.model); } catch { return keep(response); }
    if (!routed(target) || identity(sourceRoute) === identity(target)) return keep(response);
    const originalModel = firstOptions.compactionRoutingOverride?.sourceModel ?? String(snapshot.model);
    // Use the established protocol commit boundary. For runTurn streams the direct event
    // observer additionally preserves side-effect heartbeats that the bridge does not publish.
    if (response.ok && response.headers.get("content-type")?.includes("text/event-stream")) {
      const native = isNativePassthroughSseResponse(response);
      const eager = isEagerRelaySseResponse(response);
      const preflight = await preflightComboStreamResponse(response, logCtx);
      response = preflight.response;
      if (preflight.kind !== "failed") {
        if (native) markNativePassthroughSseResponse(response);
        if (eager) markEagerRelaySseResponse(response);
        return keep(response);
      }
    } else if (response.ok) {
      const buffered = await bufferedJson(response, signal);
      response = buffered.response;
      const json = buffered.json;
      if (!json || json.status !== "failed" || (Array.isArray(json.output) && json.output.length > 0)) return keep(response);
      // HTTP 200 can carry a failed terminal. The original structured error remains intact.
      response = Response.json({ error: json.error, response: json }, { status: adapterError?.status ?? 502 });
    }
    if (response.ok || replayUnsafe || partialOutput || signal.aborted || req.signal.aborted) {
      if (replayUnsafe) markResponseNonReplayable(response);
      return keep(response);
    }
    const failure = await consumeComboFailure(response, signal);
    response = failure.response;
    const code = token(adapterError?.code) ?? token(failure.upstreamCode);
    const errorType = token(adapterError?.errorType) ?? token(failure.upstreamType);
    const budget = options.sendBudget;
    // Reset-only fetch legs report their physical receipt but historically leave used alone.
    // Reconcile only a failed, eligible compaction; successful/disabled requests stay unchanged.
    const sourceSends = budget && isRequestExecutionBudget(budget)
      ? settlePhysicalSends(logCtx, budget, sendsBefore, spentBefore, sourceReportedSends) : 0;
    const decision = decideCompactionRecovery(recovery, {
      requestKind: options.compactionRecoveryKind ?? "compaction-v2", recoveryAttempts: 0,
      cancelled: signal.aborted || req.signal.aborted, nonReplayable: !!failure.nonReplayable || isNonReplayableUpstreamCode(code),
      partialOutput, toolEffects: replayUnsafe,
      remainingSends: budget && isRequestExecutionBudget(budget) ? budget.remainingBaseSends(TRANSIENT_RETRY_MAX_ATTEMPTS) : 0,
      originalModel: identity(sourceRoute), fallbackModel: identity(target), provider: sourceRoute.provider.adapter,
      httpStatus: adapterError?.status ?? response.status, responseStatus: "failed", errorCode: code, errorType,
      authenticationDenied: response.status === 401 || response.status === 403,
      policyDenied: isCyberPolicyCode(code), budgetDenied: code === "translation_buffer_limit",
      refusal: isTerminalRefusalCode(code), upstreamFailure: sourceSends > 0,
    });
    if (!decision.recover || !budget || !isRequestExecutionBudget(budget)) return keep(response);
    const fallbackBeforeSends = physicalSends(logCtx);
    const fallbackBeforeUsed = budget.used;
    const reservation = budget.reserveDispatch({ sendClass: "combo-failover", targetKey: `compaction:${identity(target)}`, countedExternally: true, replaySafe: true });
    if (!reservation.allowed) return keep(response);
    recoveryPermit = reservation.permit;
    sourceFailure = response;
    gate.discard();
    // Finish the first physical attempt while retaining its receipt in attempts[].
    if (logCtx.activeAttempt) finishRequestAttempt(logCtx.activeAttempt, response.status,
      Math.max(0, Date.now() - (logCtx.activeAttemptStartedAt ?? Date.now())), logCtx.activeAttempt.usage ?? logCtx.usage);
    // Snapshot the original log fields before the fallback rewrites them: a failed fallback
    // returns the original failure, so the log must keep describing that failure, not the
    // fallback's model, provider, route decision or terminal error.
    const SOURCE_LOG_FIELDS = [
      "model", "provider", "providerAdapter", "requestedAlias", "servedModel", "wireModel",
      "resolvedModel", "routeDecision", "tierOutcome", "activeTierMetadata", "usage",
      "usageFromBridge", "upstreamError", "terminalHttpStatus", "terminalErrorCode",
      "terminalIncompleteReason", "errorCode",
    ] as const;
    const sourceLog: Partial<Record<keyof RequestLogContext, unknown>> = {};
    const logFields = logCtx as unknown as Record<string, unknown>;
    for (const field of SOURCE_LOG_FIELDS) sourceLog[field] = logCtx[field];
    restoreSourceLog = (attemptStatus?: number) => {
      if (logCtx.activeAttempt) finishRequestAttempt(logCtx.activeAttempt, attemptStatus ?? sourceFailure!.status,
        Math.max(0, Date.now() - (logCtx.activeAttemptStartedAt ?? Date.now())), logCtx.activeAttempt.usage ?? logCtx.usage);
      delete logCtx.activeAttempt;
      delete logCtx.activeAttemptStartedAt;
      for (const field of SOURCE_LOG_FIELDS) {
        if (sourceLog[field] === undefined) delete logFields[field];
        else logFields[field] = sourceLog[field];
      }
    };
    delete logCtx.activeAttempt;
    delete logCtx.activeAttemptStartedAt;
    delete logCtx.usage;
    delete logCtx.usageFromBridge;
    delete logCtx.upstreamError;
    delete logCtx.terminalHttpStatus;
    delete logCtx.terminalErrorCode;
    delete logCtx.terminalIncompleteReason;
    const headers = new Headers(req.headers);
    headers.delete("authorization");
    headers.delete("chatgpt-account-id");
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json");
    const nextBody = { ...snapshot, model: decision.model, stream: false, store: false };
    const bytes = jsonUtf8Bytes(nextBody, MAX_BYTES);
    const serialization = options.translatorBudget.reserveTransient(bytes, { kind: "request_copies" });
    let fallback: Response;
    let fallbackReportedSends = 0;
    try {
      const child = new Request(req.url, { method: "POST", headers, body: JSON.stringify(nextBody), signal: req.signal });
      linkRequestSessionLane(req, child);
      fallback = await dispatch(child, config, logCtx, {
        ...options, compactionRecoveryAttempted: true, compactionRecoveryPermit: recoveryPermit,
        compactionRoutingOverride: { sourceModel: originalModel },
        onRequestBodyRead: undefined, onRequestBodyParsed: undefined,
        onCompactionRecoveryRoute: undefined, onCompactionRecoveryAdapterEvent: undefined,
        onCompactionRecoverySendsReported: count => {
          fallbackReportedSends += count;
          options.onCompactionRecoverySendsReported?.(count);
        },
        onResponseComplete: undefined, onNativePassthroughTerminal: undefined, onNativePassthroughCancel: undefined,
      });
    } finally {
      settlePhysicalSends(logCtx, budget, fallbackBeforeSends, fallbackBeforeUsed, fallbackReportedSends, recoveryPermit);
      serialization.release();
    }
    if (signal.aborted || req.signal.aborted) {
      void fallback.body?.cancel().catch(() => undefined);
      return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    }
    if (!fallback.ok) {
      void fallback.body?.cancel().catch(() => undefined);
      restoreSourceLog?.(fallback.status);
      return response;
    }
    const completed = await bufferedJson(fallback, signal);
    const json = completed.json;
    const items = json && Array.isArray(json.output) ? json.output : [];
    const compactions = items.filter(value => record(value) && value.type === "compaction");
    const permitted = items.every(value => record(value) && (value.type === "compaction" || value.type === "reasoning"));
    const item = permitted && compactions.length === 1 ? compactions[0] as Record<string, unknown> : undefined;
    const summary = item && typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
    if (json?.status !== "completed" || !summary?.trim()) {
      void completed.response.body?.cancel().catch(() => undefined);
      restoreSourceLog?.(completed.response.status);
      return response;
    }
    // v1 unpacks this text through buildCompactV1Output, which already re-adds retained user
    // messages as items; embedding them here too would duplicate the same text in the output.
    const preserved = options.compactionRecoveryKind === "compaction-v1" ? summary : (() => {
      const retained = buildCompactV1Output(extractCompactUserMessages(snapshot.input), summary).slice(0, -1);
      const userText = extractCompactUserMessages(retained).map((text, index) => `User message ${index + 1}:\n${text}`).join("\n\n");
      return `${summary}\n\nRetained original user messages (verbatim; preserve their goals and constraints):\n${userText}`;
    })();
    item!.encrypted_content = encodeCompactionSummary(preserved);
    json.model = originalModel;
    void completed.response.body?.cancel().catch(() => undefined);
    void response.body?.cancel().catch(() => undefined);
    if (snapshot.stream === true) {
      const usage = usageFromResponsesPayload(json.usage);
      async function* events(): AsyncGenerator<AdapterEvent> {
        yield { type: "text_delta", text: preserved };
        yield { type: "done", ...(usage ? { usage } : {}) };
      }
      return new Response(bridgeToResponsesSSE(events(), originalModel, undefined, undefined, undefined, undefined, 2_000,
        { compaction: true, translatorBudget: options.translatorBudget, onCompletedResponse: () => options.onResponseComplete?.(originalModel) }), { headers: { "content-type": "text/event-stream" } });
    }
    options.onResponseComplete?.(originalModel);
    return Response.json(json);
  } catch (error) {
    gate.discard();
    if (signal.aborted || req.signal.aborted) return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    if (sourceFailure) { restoreSourceLog?.(); return sourceFailure; }
    throw error;
  } finally {
    if (snapshotBytes) options.translatorBudget.releaseRetained(snapshotBytes, { kind: "request_copies" });
    recoveryPermit?.release();
    snapshot = undefined;
  }
}
