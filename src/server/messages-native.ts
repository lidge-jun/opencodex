/**
 * Managed native Messages lane (PF-08, behind `protocols.rollout.managedMessagesNative`).
 *
 * A Messages request whose settled route is a proxy-managed key on the `anthropic` adapter is
 * sent as Messages: the source body (after the ingress's managed-client steps) cut to a field
 * allowlist, the wire model, and the provider's own key. With `managedMessagesNativeOAuth` on
 * (PF-10), an unpooled Anthropic OAuth account is sent the same way with the access token the
 * existing OAuth selection resolves at dispatch (`messages-native-oauth.ts`). Modelled on the native Chat lane and
 * built on the same shared pieces — attempt row, finish-once final log, spend tracker, proactive
 * key selection, key failover and 429 replay, connection policy — so nothing the Responses
 * pipeline enforces is bypassed.
 *
 * Authority. This lane reads no caller header. The ingress hands over one value, the caller's
 * `anthropic-beta`, which the builder reduces to an allowlist. The caller-forward passthrough in
 * `claude-messages.ts` (the caller's own Anthropic credential) is a different branch decided
 * before this one, and nothing here can reach it or be reached from it.
 *
 * Loaded lazily by `claude-messages.ts` only when the switch is on and a route is eligible.
 */
import { enforceAnthropicImageLimits } from "../adapters/anthropic-image-guard";
import { normalizeAnthropicImages } from "../adapters/anthropic-image-normalize";
import { formatAnthropicErrorBody } from "../adapters/anthropic";
import {
  anthropicMessagesNativeWireBody,
  buildAnthropicMessagesPassthroughRequest,
  type AnthropicMessagesPassthroughRequest,
} from "../adapters/anthropic/passthrough";
import { resolveInboundModel } from "../claude/inbound";
import { anthropicErrorBody, anthropicErrorResponse, collectAnthropicMessage } from "../claude/outbound";
import type { AdmissionLease } from "../lib/admission";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { classifyError } from "../lib/errors";
import { redactSecretString } from "../lib/redact";
import { resolveClientRetryAfter } from "../lib/retry-after";
import { isTranslatorBudgetExceededError, type TranslatorBudget } from "../lib/translator-budget";
import {
  applyReplayRefusalClientHeaders,
  applyUpstreamRecoveryInit,
  fetchWithResetRetry,
  fetchWithTransientRetry,
  isNonReplayableResponse,
  isReplayRefusalResponse,
  isTransientUpstreamStatus,
  prepareSameTarget429Wait,
  REPLAY_REFUSED_STATUS,
  retainReplayRefusal,
  UpstreamRetryEvidenceError,
  type UpstreamSendRecovery,
  UPSTREAM_RESET_REPLAY_REFUSED_CODE,
} from "../lib/upstream-retry";
import { providerApiKeySelectionIsCurrent, resolveCurrentProviderApiKeyTransport } from "../providers/api-key-selection";
import {
  hasKeyPoolFailover,
  rateLimitRetryDelayMs,
  rateLimitRetryPolicyFor,
  rotateProviderTransportOn401,
  rotateProviderTransportOn429,
  selectProactiveApiKeyTransport,
  transientRetryPolicyFor,
} from "../providers/key-failover";
import { stampApiKeyAccountLabel, stampOAuthAccountLabel } from "../providers/label";
import { publicOAuthAuthenticationErrorMessage } from "../oauth";
import { hasAnthropicFailoverQuorum } from "../oauth/anthropic-routing";
import { resolveProtocolSettings } from "../protocols/settings";
import { addProtocolEntryReason, markProtocolBlocked } from "../protocols/trace";
import type { OcxProviderTransport } from "../providers/xai-transport";
import { preservesPhysicalComboProvider, resolveComboId } from "../combos";
import { captureRouteStaticPolicy, routeModel, type RouteResult } from "../router";
import { POLICY_NAMESPACE, resolvePolicyProfileId } from "../routing/profile";
import type { OcxConfig, OcxProviderConfig, OcxUsage } from "../types";
import { resolveWireProtocolOverride } from "./adapter-resolve";
import {
  anthropicUsageToOcx,
  estimateClaudeRequestTokens,
  resolvePassthroughBodyGuard,
  sanitizePassthroughToolCallIds,
  tapAnthropicSseForLog,
} from "./claude-messages";
import { beginInferenceAttempt } from "./inference/attempt";
import { createFinalRequestLog, type FinalRequestLogMeta } from "./inference/final-log";
import { registerTurn, unregisterTurn } from "./lifecycle";
import { nativeMessagesDeclineReason, type NativeMessagesSelector } from "./messages-native-eligibility";
import {
  nativeOAuthBindingIsCurrent,
  NativeOAuthSelectionChangedError,
  resolveNativeOAuthBinding,
  restoreOAuthToolNamesInMessage,
  restoreOAuthToolNamesInSse,
  type NativeOAuthBinding,
} from "./messages-native-oauth";
import {
  noteProviderAttemptSend,
  recordAttemptCredentialSource,
  recordFirstOutput,
  recordKeyAttemptFailure,
  recordKeyWireAttemptUsage,
  type RequestLogContext,
} from "./request-log";
import { fetchWithHeaderTimeout, providerFetch, safeHostLabel, sendWithConnectionPolicy } from "./responses/fetch-helpers";
import { linkAbortSignal } from "./responses/core-lifetime";
import { attachRequestSpendTracker } from "./responses/request-spend";
import { workflowRefusalResponse } from "./workflow-refusal";
import { sseFieldValue } from "../lib/sse-decoder";

export {
  isNativeMessagesRouteEligible,
  nativeMessagesDeclineReason,
  type NativeMessagesDeclineReason,
} from "./messages-native-eligibility";

type Rec = Record<string, unknown>;

const MAX_NATIVE_MESSAGES_JSON_BYTES = 32 * 1024 * 1024;
const MAX_NATIVE_MESSAGES_ERROR_BYTES = 64 * 1024;

class NativeMessagesSpendRefusal extends Error {}

/** A rebuild for a destination that cannot carry the body's opaque state, under `reject`. */
class NativeOpaqueStateRefusal extends Error {
  constructor() {
    super("The selected route cannot carry thinking signatures or redacted_thinking blocks");
  }
}

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface HandleNativeMessagesOptions {
  req: Request;
  config: OcxConfig;
  logCtx: RequestLogContext;
  logIds?: { requestId: string; start: number; turnAdmissionLease?: AdmissionLease };
  /** The settled, eligible route (see `isNativeMessagesRouteEligible`). */
  route: RouteResult;
  /**
   * The Messages body after the ingress's managed-client steps. Owned by this lane from here
   * on: a fresh envelope copy when an envelope exists, otherwise the ingress's own body.
   */
  body: Rec;
  /** The selector the client sent, echoed on the request log. */
  requestedModel: string;
  translatorBudget: TranslatorBudget;
  /** The facts the ingress judged eligibility with; re-applied if key selection changes. */
  selector?: NativeMessagesSelector;
  /**
   * The caller's `anthropic-beta` header, handed over by the ingress. The builder keeps only
   * allowlisted values; no other caller header reaches this lane.
   */
  callerAnthropicBeta?: string | null;
}

type FinishLog = (status: number, message?: string, closeReason?: FinalRequestLogMeta["closeReason"]) => void;

/** Relay an upstream body unchanged, recording first output on its first non-empty chunk. */
function observeFirstChunk(body: ReadableStream<Uint8Array>, onFirst: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let seen = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (!seen && value.byteLength > 0) {
        seen = true;
        onFirst();
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** How far into a stream the `message_start` frame is looked for before relaying untouched. */
const MODEL_ECHO_SCAN_BYTES = 64 * 1024;

/** The `message_start` frame with `message.model` set to `model`, or undefined for any other frame. */
function messageStartWithModel(frame: string, model: string): string | undefined {
  const data = frame
    .split("\n")
    .map(line => sseFieldValue(line, "data"))
    .filter((value): value is string => value !== null)
    .join("");
  if (!data) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return undefined; }
  if (!isRec(parsed) || parsed.type !== "message_start" || !isRec(parsed.message)) return undefined;
  parsed.message.model = model;
  return `event: message_start\ndata: ${JSON.stringify(parsed)}\n\n`;
}

/**
 * Echo the client's selector in `message_start.message.model`, as the translated lane does
 * (`responsesSseToAnthropicSse` is given the requested model). Works on bytes: frames before and
 * including `message_start` are split on the blank line, and everything after is relayed as is.
 */
function echoRequestedModel(body: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let pending = new Uint8Array(0);
  let scanning = true;
  let scanned = 0;
  const frameEnd = (bytes: Uint8Array): number => {
    for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 10 && bytes[i + 1] === 10) return i + 2;
    return -1;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (pending.length > 0) controller.enqueue(pending);
        pending = new Uint8Array(0);
        controller.close();
        return;
      }
      if (!scanning) {
        controller.enqueue(value);
        return;
      }
      scanned += value.byteLength;
      const joined = new Uint8Array(pending.length + value.byteLength);
      joined.set(pending);
      joined.set(value, pending.length);
      pending = joined;
      let end: number;
      while (scanning && (end = frameEnd(pending)) !== -1) {
        const frame = pending.subarray(0, end);
        pending = pending.subarray(end);
        const rewritten = messageStartWithModel(decoder.decode(frame), model);
        if (rewritten !== undefined) {
          controller.enqueue(encoder.encode(rewritten));
          scanning = false;
        } else {
          controller.enqueue(frame);
        }
      }
      if (scanning && scanned > MODEL_ECHO_SCAN_BYTES) scanning = false;
      if (!scanning && pending.length > 0) {
        controller.enqueue(pending);
        pending = new Uint8Array(0);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** A minimal valid Messages stream for a streaming caller whose upstream answered JSON. */
function messageAsSse(message: Rec): string {
  const frames: string[] = [];
  const emit = (name: string, data: Rec) => frames.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  emit("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } });
  const blocks = Array.isArray(message.content) ? message.content.filter(isRec) : [];
  blocks.forEach((block, index) => {
    emit("content_block_start", { type: "content_block_start", index, content_block: block });
    emit("content_block_stop", { type: "content_block_stop", index });
  });
  emit("message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason ?? "end_turn", stop_sequence: message.stop_sequence ?? null },
    usage: message.usage ?? {},
  });
  emit("message_stop", { type: "message_stop" });
  return frames.join("");
}

/** Reject a body the Messages API cannot carry before anything is sent. */
async function prepareNativeBody(body: Rec, signal: AbortSignal): Promise<void> {
  if (!Array.isArray(body.messages)) return;
  // The adapter normally owns these; this lane bypasses it, so it runs the same steps as the
  // caller-forward passthrough: tier-normalize and guard images, then repair tool-call ids.
  await normalizeAnthropicImages(body.messages, { abortSignal: signal });
  enforceAnthropicImageLimits(body.messages);
  sanitizePassthroughToolCallIds(body.messages);
}

/**
 * Handle one eligible Messages request natively. Opens the attempt, owns the request's final
 * log row, and answers in the Messages wire (SSE or JSON per the caller's own `stream`).
 */
export async function handleNativeMessages(options: HandleNativeMessagesOptions): Promise<Response> {
  const { req, config, logCtx, logIds, route, body, requestedModel, translatorBudget } = options;
  const requestedStream = body.stream === true;
  logCtx.inboundProtocol = "messages";
  logCtx.model = route.modelId;
  logCtx.provider = route.providerName;
  logCtx.providerAdapter = route.provider.adapter;
  logCtx.requestedModel = requestedModel;
  if (route.routeReason === "model-alias" || route.modelId !== requestedModel) logCtx.requestedAlias = requestedModel;
  logCtx.requestedServiceTier = typeof body.service_tier === "string" ? body.service_tier : undefined;
  // Reserve spend the way native Chat does: an input estimate that never enters usage, and the
  // caller's own output ceiling.
  if (logCtx.usageLogInputTokens === undefined) {
    logCtx.spendInputEstimateTokens = estimateClaudeRequestTokens(body, requestedModel);
  }
  if (typeof body.max_tokens === "number" && body.max_tokens > 0) {
    logCtx.spendOutputCeilingTokens = Math.trunc(body.max_tokens);
  }

  const attemptHandle = beginInferenceAttempt(logCtx, {
    provider: route.providerName,
    model: route.modelId,
    adapter: "anthropic",
  });
  attemptHandle.seal(logCtx.accountLogLabel);
  const { attempt } = attemptHandle;
  const finalLog = createFinalRequestLog(logIds, logCtx);
  const finishLog: FinishLog = (status, message, closeReason = "non_stream") => {
    if (finalLog.finished()) return;
    if (message) logCtx.upstreamError = redactSecretString(message).slice(0, 500);
    finalLog.finish(status, { closeReason });
  };
  const bindUsage = (usage: OcxUsage | undefined) => {
    if (!usage) return;
    if (!recordKeyWireAttemptUsage(logCtx, usage)) {
      logCtx.usage = usage;
      attempt.usage = usage;
    }
  };
  const fail = (status: number, message: string, type?: string, code?: string): Response => {
    const safeMessage = redactSecretString(message);
    finishLog(status, safeMessage);
    return anthropicErrorResponse(status, safeMessage, type, code);
  };

  try {
    await prepareNativeBody(body, req.signal);
  } catch (error) {
    if (req.signal.aborted) return fail(499, "Client cancelled request", "api_error");
    if (isTranslatorBudgetExceededError(error)) {
      return fail(413, "request translation buffer exceeded the safe limit", "request_too_large", "translation_buffer_limit");
    }
    // An AnthropicRequestError (empty tool id) or an image the guard cannot carry.
    return fail(400, error instanceof Error ? error.message : String(error), "invalid_request_error");
  }

  const upstream = new AbortController();
  const cleanupAbort = linkAbortSignal(upstream, req.signal);
  let streamTurnRegistered = false;
  const transferTurnToStream = () => {
    const lease = logIds?.turnAdmissionLease;
    if (!lease || typeof (lease as { bindAbortController?: unknown }).bindAbortController !== "function") return;
    registerTurn(upstream, lease);
    streamTurnRegistered = true;
  };
  const releaseStreamTurn = () => {
    if (!streamTurnRegistered) return;
    streamTurnRegistered = false;
    unregisterTurn(upstream);
  };
  const connectMs = config.connectTimeoutMs ?? 200_000;
  // An OAuth route is served by the account the existing OAuth selection commits now, at
  // dispatch; the token lives on this lane's provider copy only, never on the shared route.
  let oauthBinding: NativeOAuthBinding | undefined;
  const oauthProvider = (binding: NativeOAuthBinding): OcxProviderConfig => ({ ...route.provider, apiKey: binding.snapshot.accessToken });
  if (route.provider.authMode === "oauth") {
    try {
      oauthBinding = await resolveNativeOAuthBinding(config);
    } catch (error) {
      cleanupAbort();
      upstream.abort();
      if (req.signal.aborted) return fail(499, "Client cancelled request", "api_error");
      if (error instanceof NativeOAuthSelectionChangedError) return fail(409, error.message, "api_error");
      return fail(401, publicOAuthAuthenticationErrorMessage(error), "authentication_error");
    }
  } else {
    // Same pre-dispatch key preference every direct send path applies (see chat-native.ts).
    const proactiveKeyProvider = selectProactiveApiKeyTransport(config, route.providerName, route.provider);
    if (proactiveKeyProvider) route.provider = proactiveKeyProvider;
  }
  let activeProvider: OcxProviderConfig = oauthBinding ? oauthProvider(oauthBinding) : route.provider;
  stampApiKeyAccountLabel(logCtx, route.providerName, activeProvider);
  if (oauthBinding) stampOAuthAccountLabel(logCtx, route.providerName, activeProvider, oauthBinding.snapshot.accountId);
  const spendTracker = attachRequestSpendTracker(req, logCtx);
  let activeRequest: AnthropicMessagesPassthroughRequest;
  let retainedRequestBytes = 0;
  const releaseRetainedRequest = () => {
    if (retainedRequestBytes === 0) return;
    translatorBudget.releaseRetained(retainedRequestBytes, { kind: "request_copies" });
    retainedRequestBytes = 0;
  };
  const retainRequest = (request: AnthropicMessagesPassthroughRequest) => {
    const bytes = Buffer.byteLength(request.body);
    translatorBudget.chargeRetained(bytes, { kind: "request_copies" });
    retainedRequestBytes = bytes;
  };
  // Every rebuild reads the same `body`; the builder copies and never mutates it, so no
  // credential, header or stripped block from an earlier build reaches the next one, and a build
  // for another credential domain decides opaque state from the full source again.
  const rejectUnrepresentable = resolveProtocolSettings(config).unrepresentable === "reject";
  const buildActiveRequest = () => {
    recordAttemptCredentialSource(attempt, route.providerName, activeProvider, "anthropic");
    const built = buildAnthropicMessagesPassthroughRequest(activeProvider, route.modelId, body, config, {
      callerAnthropicBeta: options.callerAnthropicBeta,
    });
    if (built.strippedOpaqueState && rejectUnrepresentable) throw new NativeOpaqueStateRefusal();
    if (built.droppedBetas) addProtocolEntryReason(logCtx, "anthropic-beta-dropped");
    if (built.strippedOpaqueState) addProtocolEntryReason(logCtx, "opaque-state-stripped");
    return built;
  };
  const rebuildFor = (provider: OcxProviderConfig) => {
    activeProvider = provider;
    stampApiKeyAccountLabel(logCtx, route.providerName, activeProvider);
    releaseRetainedRequest();
    activeRequest = buildActiveRequest();
    retainRequest(activeRequest);
  };
  try {
    activeRequest = buildActiveRequest();
    retainRequest(activeRequest);
  } catch (error) {
    releaseRetainedRequest();
    cleanupAbort();
    upstream.abort();
    if (isTranslatorBudgetExceededError(error)) {
      return fail(413, "request translation buffer exceeded the safe limit", "request_too_large", "translation_buffer_limit");
    }
    if (error instanceof NativeOpaqueStateRefusal) {
      // Nothing was sent: this is a refusal before any upstream send.
      markProtocolBlocked(logCtx, { inbound: "messages", reasonCodes: ["feature-unrepresentable", "opaque-state-stripped"] });
      logCtx.errorCode = "unsupported_feature";
      return fail(400, error.message, "invalid_request_error", "unsupported_feature");
    }
    return fail(400, error instanceof Error ? error.message : String(error), "invalid_request_error");
  }

  // One inbound request owns one transient send allowance, captured before any key rotation.
  const requestTransientPolicy = transientRetryPolicyFor(activeProvider);
  let transientSendsUsed = 0;
  const remainingTransientSends = (): number => requestTransientPolicy
    ? Math.max(0, requestTransientPolicy.attempts - transientSendsUsed)
    : Number.POSITIVE_INFINITY;
  const transientSendAvailable = (): boolean => remainingTransientSends() > 0;
  const selector: NativeMessagesSelector = options.selector ?? {};

  const send = async (recovery?: "rate-limit-429" | "key-429" | "key-401"): Promise<Response> => {
    const remaining = remainingTransientSends();
    if (requestTransientPolicy && remaining <= 0) {
      throw new Error("native Messages transient send budget exhausted before recovery dispatch");
    }
    const fetchWithPolicy = requestTransientPolicy ? fetchWithTransientRetry : fetchWithResetRetry;
    const request = activeRequest;
    return await fetchWithPolicy(
      (transportRecovery?: UpstreamSendRecovery) => fetchWithHeaderTimeout(
        request.url,
        applyUpstreamRecoveryInit({ method: "POST", headers: request.headers, body: request.body }, transportRecovery),
        upstream.signal,
        connectMs,
        requestedStream,
        providerFetch(activeProvider, undefined, {
          providerName: route.providerName,
          modelId: route.modelId,
          dispatchOverride: async (_input, init, execute) => {
            if (oauthBinding) {
              // The OAuth twin of the key check below: re-resolve through the same selection
              // owner when the committed account or its credential moved since the build.
              if (!nativeOAuthBindingIsCurrent(oauthBinding)) {
                try {
                  oauthBinding = await resolveNativeOAuthBinding(config);
                } catch {
                  throw new NativeOAuthSelectionChangedError();
                }
                rebuildFor(oauthProvider(oauthBinding));
                stampOAuthAccountLabel(logCtx, route.providerName, activeProvider, oauthBinding.snapshot.accountId);
              }
            } else if (!providerApiKeySelectionIsCurrent(config, route.providerName, activeProvider)) {
              const current = resolveCurrentProviderApiKeyTransport(config, route.providerName, activeProvider);
              if (!current || nativeMessagesDeclineReason({ ...route, provider: current }, body, config, selector) !== undefined) {
                throw new Error("Provider key selection is no longer available for native Messages");
              }
              rebuildFor(current);
            }
            // The retry closure may hold a pre-reselection request: send the current one whole.
            const wire = activeRequest;
            const headers = new Headers(wire.headers);
            const encoding = new Headers(init.headers).get("accept-encoding");
            if (!headers.has("accept-encoding") && encoding) headers.set("accept-encoding", encoding);
            if (init.signal?.aborted) throw init.signal.reason;
            if (!spendTracker.charge()) throw new NativeMessagesSpendRefusal();
            noteProviderAttemptSend(logCtx, route.providerName, activeProvider, logCtx.usageLogInputTokens, transportRecovery ?? recovery);
            const dispatched = await sendWithConnectionPolicy(
              (activeProvider as OcxProviderTransport).fetch ?? execute,
              wire.url,
              applyUpstreamRecoveryInit({ ...init, method: "POST", headers, body: wire.body }, transportRecovery),
              { providerName: route.providerName, provider: activeProvider },
            );
            if (!dispatched.ok) await recordKeyAttemptFailure(logCtx, dispatched, init.signal ?? upstream.signal);
            return dispatched;
          },
        }),
      ),
      {
        abortSignal: upstream.signal,
        label: safeHostLabel(request.url),
        ...(requestTransientPolicy
          ? {
            attempts: remaining,
            onSendsConsumed: (sends: number) => { transientSendsUsed += Math.max(0, sends); },
          }
          : {}),
      },
    );
  };
  const discard = (response: Response) => {
    try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
  };

  let response: Response;
  try {
    response = await send();
    // A credential-scoped 401 on a static key pool says nothing about the sibling keys.
    while (response.status === 401 && hasKeyPoolFailover(activeProvider) && transientSendAvailable()) {
      const rotated = rotateProviderTransportOn401(config, route.providerName, activeProvider, {
        now: Date.now(),
        attemptedKey: activeProvider.apiKey,
      });
      if (!rotated) break;
      discard(response);
      rebuildFor(rotated);
      response = await send("key-401");
    }
    const retryPolicy = rateLimitRetryPolicyFor(activeProvider);
    let retries = 0;
    // A refusal this proxy synthesized for a reset replay is not a provider rate limit.
    while (
      response.status === 429
      && !isNonReplayableResponse(response)
      && retryPolicy
      && retries < retryPolicy.attempts
      && transientSendAvailable()
    ) {
      retries += 1;
      for await (const _ of prepareSameTarget429Wait({
        body: response.body,
        signal: upstream.signal,
        delayMs: rateLimitRetryDelayMs(retryPolicy, response.headers.get("retry-after"), Date.now()),
      })) { /* pre-stream wait */ }
      if (upstream.signal.aborted) throw upstream.signal.reason;
      response = await send("rate-limit-429");
    }
    while (response.status === 429 && !isNonReplayableResponse(response) && hasKeyPoolFailover(activeProvider)) {
      const rotated = rotateProviderTransportOn429(config, route.providerName, activeProvider, {
        retryAfter: response.headers.get("retry-after"),
        now: Date.now(),
        attemptedKey: activeProvider.apiKey,
        attemptedSelection: activeProvider._apiKeyAttempt,
      });
      if (!rotated) break;
      // Rotation already recorded the cooldown; keep the terminal 429 when no send remains.
      if (!transientSendAvailable()) break;
      discard(response);
      rebuildFor(rotated);
      response = await send("key-429");
    }
  } catch (error) {
    releaseRetainedRequest();
    cleanupAbort();
    upstream.abort();
    if (req.signal.aborted) return fail(499, "Client cancelled request", "api_error");
    const sendError = error instanceof UpstreamRetryEvidenceError ? error.cause : error;
    if (sendError instanceof NativeMessagesSpendRefusal) {
      const refusal = workflowRefusalResponse("workflow-spend-exhausted", logCtx);
      finishLog(429);
      return refusal;
    }
    if (sendError instanceof NativeOAuthSelectionChangedError) return fail(409, sendError.message, "api_error");
    if (sendError instanceof NativeOpaqueStateRefusal) {
      logCtx.errorCode = "unsupported_feature";
      return fail(400, sendError.message, "invalid_request_error", "unsupported_feature");
    }
    if (isTranslatorBudgetExceededError(error)) {
      return fail(413, "request translation buffer exceeded the safe limit", "request_too_large", "translation_buffer_limit");
    }
    return fail(502, error instanceof Error ? error.message : String(error), "api_error");
  }
  releaseRetainedRequest();

  if (!response.ok) {
    let bodyText = "";
    try {
      const read = await readBoundedResponseBody(response, { signal: upstream.signal, maxBytes: MAX_NATIVE_MESSAGES_ERROR_BYTES });
      if (read.displaySafe) bodyText = read.text;
    } catch { /* status-only fallback */ }
    cleanupAbort();
    if (req.signal.aborted) {
      upstream.abort();
      return fail(499, "Client cancelled request", "api_error");
    }
    return nativeMessagesErrorResponse(response, bodyText, finishLog);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream") && response.body) {
    const bodyGuard = resolvePassthroughBodyGuard(config, req.signal);
    const observed = logIds ? observeFirstChunk(response.body, () => recordFirstOutput(logCtx, logIds.start)) : response.body;
    const renamed = activeRequest.oauthToolNames
      ? restoreOAuthToolNamesInSse(observed, activeRequest.oauthToolNames, translatorBudget)
      : observed;
    const source = echoRequestedModel(renamed, requestedModel);
    if (requestedStream) {
      transferTurnToStream();
      const relayed = tapAnthropicSseForLog(source, logCtx, (status, meta) => {
        try {
          cleanupAbort();
          bindUsage(logCtx.usage);
          finishLog(status, undefined, meta.closeReason);
          if (meta.closeReason !== "terminal") upstream.abort();
        } finally {
          releaseStreamTurn();
        }
      }, bodyGuard);
      return new Response(relayed, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" },
      });
    }
    // A non-streaming caller whose upstream streamed anyway: fold the stream into one message.
    const tapState: { closeReason?: FinalRequestLogMeta["closeReason"] } = {};
    const tapped = tapAnthropicSseForLog(source, logCtx, (_status, meta) => {
      tapState.closeReason = meta.closeReason;
    }, bodyGuard);
    try {
      const message = await collectAnthropicMessage(tapped, requestedModel, translatorBudget);
      cleanupAbort();
      if (tapState.closeReason === "client_cancel" || req.signal.aborted) {
        return fail(499, "Client cancelled request", "api_error");
      }
      bindUsage(logCtx.usage);
      if (message.type === "error") {
        const error = isRec(message.error) ? message.error : {};
        return fail(502, typeof error.message === "string" ? error.message : "upstream stream failed", "api_error");
      }
      finishLog(200);
      return Response.json(message);
    } catch (error) {
      cleanupAbort();
      upstream.abort();
      if (req.signal.aborted) return fail(499, "Client cancelled request", "api_error");
      if (isTranslatorBudgetExceededError(error)) {
        return fail(413, "upstream translation buffer exceeded the safe limit", "request_too_large", "translation_buffer_limit");
      }
      return fail(502, error instanceof Error ? error.message : String(error), "api_error");
    }
  }

  let read;
  try {
    read = await readBoundedResponseBody(response, {
      signal: upstream.signal,
      maxBytes: MAX_NATIVE_MESSAGES_JSON_BYTES,
      totalTimeoutMs: Math.max(connectMs, 5_000),
      inactivityTimeoutMs: Math.max(connectMs, 5_000),
    });
  } catch (error) {
    cleanupAbort();
    upstream.abort();
    if (req.signal.aborted) return fail(499, "Client cancelled request", "api_error");
    return fail(502, error instanceof Error ? error.message : String(error), "api_error");
  }
  cleanupAbort();
  if (read.oversized) {
    upstream.abort();
    return fail(502, "upstream response exceeded the safe limit", "api_error", "translation_buffer_limit");
  }
  let parsedMessage: unknown;
  try {
    parsedMessage = JSON.parse(read.text);
  } catch {
    return fail(502, "upstream returned malformed Messages JSON", "api_error");
  }
  if (!isRec(parsedMessage) || parsedMessage.type !== "message") {
    return fail(502, "upstream response was not a Messages result", "api_error");
  }
  const message = activeRequest.oauthToolNames
    ? restoreOAuthToolNamesInMessage(parsedMessage, activeRequest.oauthToolNames)
    : parsedMessage;
  bindUsage(anthropicUsageToOcx(isRec(message.usage) ? message.usage : undefined));
  if (logIds) recordFirstOutput(logCtx, logIds.start);
  try {
    translatorBudget.chargeRetained(Buffer.byteLength(read.text) * 2, { kind: "live_transient" });
  } catch (error) {
    if (isTranslatorBudgetExceededError(error)) {
      return fail(502, "upstream translation buffer exceeded the safe limit", "api_error", "translation_buffer_limit");
    }
    throw error;
  }
  // The client's selector, not the wire id, as the translated lane answers.
  message.model = requestedModel;
  const serialized = JSON.stringify(message);
  finishLog(200);
  if (requestedStream) {
    return new Response(messageAsSse(message), {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }
  return new Response(serialized, { status: 200, headers: { "Content-Type": "application/json" } });
}

/**
 * A non-OK upstream answer in Anthropic shape. Status and retry policy follow the translated
 * Messages path, so a client sees the same contract on either lane: transient 5xx become 529
 * with a retry hint, and a proxy-side replay refusal keeps its no-retry marking.
 */
function nativeMessagesErrorResponse(response: Response, bodyText: string, finishLog: FinishLog): Response {
  let upstreamType: string | undefined;
  let upstreamMessage: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as Rec;
    const details = isRec(parsed.error) ? parsed.error : parsed;
    if (typeof details.type === "string") upstreamType = details.type;
    if (typeof details.message === "string" && details.message.trim()) {
      upstreamMessage = redactSecretString(details.message.trim());
    }
  } catch { /* keep generic classification */ }
  const detail = formatAnthropicErrorBody(response.status, response.headers, bodyText);
  const message = upstreamMessage
    ?? (detail ? `Provider error ${response.status}: ${detail}` : `Provider error ${response.status}`);
  const classified = classifyError(
    response.status,
    upstreamType ?? (response.status === 401 ? "authentication_error"
      : response.status === 429 ? "rate_limit_error"
        : response.status >= 500 ? "api_error" : "invalid_request_error"),
    message,
  );
  const safeMessage = redactSecretString(classified.message);
  const replayRefusal = isReplayRefusalResponse(response);
  const transient = !replayRefusal && isTransientUpstreamStatus(response.status);
  const status = replayRefusal ? REPLAY_REFUSED_STATUS : transient ? 529 : response.status;
  const upstreamRetryAfter = response.headers.get("retry-after");
  const retryAfter = replayRefusal
    ? undefined
    : resolveClientRetryAfter({ status: response.status, message: safeMessage, upstreamRetryAfter })
      ?? (upstreamRetryAfter?.trim() === "0" ? "0" : undefined);
  finishLog(response.status, safeMessage);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (retryAfter) headers.set("Retry-After", retryAfter);
  else if (transient) headers.set("Retry-After", "2");
  if (replayRefusal) applyReplayRefusalClientHeaders(headers);
  const out = new Response(JSON.stringify(anthropicErrorBody(
    status,
    safeMessage,
    transient ? "overloaded_error" : upstreamType,
    replayRefusal ? UPSTREAM_RESET_REPLAY_REFUSED_CODE : undefined,
  )), { status, headers });
  return replayRefusal ? retainReplayRefusal(out) : out;
}

/**
 * The body `count_tokens` should count for this selector: what the native lane would send when
 * the route is eligible, else `undefined` so the caller keeps its existing estimate. Reads config
 * and the router's deterministic branches only; sends nothing.
 */
export function nativeMessagesCountBody(
  config: OcxConfig,
  cc: OcxConfig["claudeCode"],
  body: Rec,
  rows: Pick<NativeMessagesSelector, "effortRow" | "fastRow">,
): Rec | undefined {
  if (typeof body.model !== "string") return undefined;
  try {
    const selectorId = resolveInboundModel(body.model, cc);
    // Combo and policy selectors are never eligible, and routing them would advance round-robin
    // state or run the policy evaluator for a request that sends nothing.
    if (resolvePolicyProfileId(config, selectorId) !== null || selectorId.startsWith(`${POLICY_NAMESPACE}/`)) return undefined;
    if (!preservesPhysicalComboProvider(config) && resolveComboId(config, selectorId) !== null) return undefined;
    const route = routeModel(config, selectorId);
    route.staticPolicy = captureRouteStaticPolicy(
      route.providerName, route.modelId, route.provider, route.staticPolicy.effectiveAlias, "anthropic",
    );
    route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, "anthropic", route.staticPolicy);
    const selector: NativeMessagesSelector = {
      ...rows,
      routeSelector: selectorId,
      claudeCode: cc,
      ...(route.provider.authMode === "oauth" ? { oauthFailoverQuorum: hasAnthropicFailoverQuorum() } : {}),
    };
    if (nativeMessagesDeclineReason(route, body, config, selector) !== undefined) return undefined;
    // The body without a credential: counting never resolves or refreshes an OAuth account.
    return anthropicMessagesNativeWireBody(route.provider, route.modelId, body).wireBody;
  } catch {
    return undefined;
  }
}
