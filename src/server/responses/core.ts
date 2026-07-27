import type { Server } from "bun";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse, type ResponsesTerminalStatus } from "../../bridge";
import { formatPassthroughUpstreamError } from "./passthrough-error";
import {
  getConfigPath,
  multiAgentGuidanceEnabled,
  resolveEnvValue,
} from "../../config";
import { parseRequest } from "../../responses/parser";
import { buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary, extractCompactUserMessages } from "../../responses/compaction";
import { FORWARD_HEADERS, sanitizeReasoningInputContent } from "../../adapters/openai-responses";
import { expandPreviousResponseInput, previousResponseProviderState, rememberResponseState } from "../../responses/state";
import { routeModel, type RouteResult } from "../../router";
import {
  advanceComboAfterFailure,
  comboDefaultEffort,
  comboFailureDecision,
  comboIdFromRawBody,
  concreteComboRequestBody,
  getCombo,
  isComboTargetInCooldown,
  NoAvailableComboTargetsError,
  noteComboSuccess,
  parseRetryAfterMs,
  pickComboTarget,
  targetKey,
} from "../../combos";
import { isInjectionDebugEnabled } from "../../lib/debug-settings";
import { injectionDebugLog } from "../../lib/injection-debug-log";
import { resolveClientRetryAfter } from "../../lib/retry-after";
import { modelInList, namespacedToolName } from "../../types";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig, OcxProviderContinuationState, OcxUsage } from "../../types";
import {
  forceRefreshOAuthAccessSnapshot,
  getOAuthCredentialApiBaseUrl,
  getOAuthCredentialProjectId,
  getValidAccessTokenSnapshot,
  type OAuthAccessSnapshot,
  UnsupportedOAuthProviderError,
} from "../../oauth";
import { buildWebSearchTool, planWebSearch, runWithWebSearch, shouldResolveOpenAiWebSearchSidecar } from "../../web-search";
import { buildImageTool, planImageBridge, runWithImageBridge, clampImageMaxRounds, IMAGE_GEN_TOOL_NAME } from "../../images";
import { describeImagesInPlace, planVisionSidecar, shouldResolveOpenAiVisionSidecar, stripImagesInPlace } from "../../vision";
import { createAdapterEventQueue, preflightAdapterEvents } from "../../adapters/run-turn-queue";
import {
  applyCodexAuthContextToProvider,
  CodexAccountCooldownError,
  cooldownErrorResponse,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  codexProbeLeaseId,
  releaseCodexAuthContextProbeLease,
  stripCodexRuntimeProviderFields,
  type CodexAuthContext,
} from "../../codex/auth-context";
import {
  formatCodexProviderForLog,
  previewCodexAccountForRequest,
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "../../codex/routing";
import { fetchWithResetRetry, fetchWithTransientRetry, applyUpstreamRecoveryInit } from "../../lib/upstream-retry";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "../auth-cors";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar, type ResolvedOpenAiForwardSidecar } from "../../providers/openai-sidecar";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { slugsEquivalent } from "../../providers/slug-codec";
import { applyOpenAiVirtualModel, resolveOpenAiCompactModel } from "../../providers/openai-virtual-models";
import { isUsageDebugEnabled } from "../../usage/debug";
import { readJsonRequestBody, DecompressedBodyTooLargeError, UnsupportedContentEncodingError } from "../request-decompress";
import { resolveAdapter, resolveWireProtocolOverride } from "../adapter-resolve";
import { hasKeyPoolFailover, rotateProviderTransportOn429 } from "../../providers/key-failover";
import { shouldAttemptImageTierRetry } from "../image-retry";
import { resolveProviderTransport } from "../../providers/xai-transport";
import type { WsData } from "../ws-bridge";
import { registerTurn, trackStreamLifetime, unregisterTurn } from "../lifecycle";
import { redactSecretString } from "../../lib/redact";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { supportedLadderFor } from "../effort-policy";
import { isThreadSpawnRequest } from "../effort-policy";
import {
  applySubagentModelFallback,
  maybePrimeSubagentQuota,
  recordSubagentQuotaFailureForThreadSpawn,
} from "../../codex/subagent-model-fallback";
import {
  beginRequestAttempt,
  catalogModelSupportsServiceTier,
  finishRequestAttempt,
  inspectResponseLogJson,
  noteAttemptSend,
  readConfiguredCodexServiceTier,
  recordAdapterReasoning,
  recordAttemptRequestedEffort,
  requestLogSpeedLabel,
  sealRequestAttemptIdentity,
  usageFromResponsesPayload,
  type RequestLogContext,
} from "../request-log";
import {
  conversationIdFromResponsesRequest,
  normalizeLogConversationId,
  sessionIdHeaderFromRequest,
} from "../request-log-conversation";
import type { AttemptRecoveryKind } from "../../usage/log";
import {
  consumeForInspection,
  consumeForResponseLogMetadata,
  createSseInspector,
  markNativePassthroughSseResponse,
  relaySseWithFailedTail,
  relayWithAbort,
  sanitizePassthroughHeaders,
} from "../relay";
import { relaySseEagerBounded } from "../relay-eager";
import { decideEagerRelay } from "../../lib/bun-stream-caps";
import { cancelBodyOnAbort } from "../../lib/abort";
import { hasResponsesItemIdRepair, relaySseWithResponsesItemIdRepair } from "../responses-item-id-repair";
import type { EffectiveSubagentRoster, SpawnAgentSurface } from "../../codex/catalog";

import { buildToolBridgeMaps, collabSurface, injectDeveloperMessage, multiAgentGuidanceText } from "./collaboration";
import { hasUnreadableEncryptedAgentTask, looksLikeBackendCiphertext, sanitizeEncryptedContentInPlace } from "./encrypted-payload";
import { fetchWithHeaderTimeout, providerFetch, safeHostLabel } from "./fetch-helpers";
import { guardTerminalEventStream } from "./terminal-guard";

/**
 * Adapters whose continuation state must survive Codex's store:false requests.
 */
export function adapterNeedsForcedContinuation(name: string): boolean {
  return name === "kiro" || name === "cursor";
}

export function sidecarOutcomeRecorder(
  config: OcxConfig,
  authCtx: CodexAuthContext,
  threadId?: string | null,
): ((outcome: CodexUpstreamOutcome) => void) | undefined {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool"
    ? outcome => recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, {
      threadId,
      probeLeaseId: authCtx.probeLeaseId,
    })
    : undefined;
}



export const DEFAULT_SHADOW_SOURCE_MODELS = ["gpt-5.4-mini", "gpt-5.6-luna"] as const;

export function isShadowSourceModel(modelId: string, configured?: unknown): boolean {
  if (modelId.includes("/")) return false;
  const configuredStrings = Array.isArray(configured)
    ? configured.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
  const prefixes = configuredStrings.length > 0 ? configuredStrings : DEFAULT_SHADOW_SOURCE_MODELS;
  return prefixes.some(prefix => modelId.startsWith(prefix.trim()));
}



export function codexLogAccountId(authCtx: CodexAuthContext): string | null {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool" ? authCtx.accountId : null;
}



export function usesCodexForwardPoolAuth(
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
): authCtx is Extract<CodexAuthContext, { kind: "pool" | "main-pool" }> {
  return (authCtx.kind === "pool" || authCtx.kind === "main-pool")
    && provider.authMode === "forward" && provider.adapter === "openai-responses";
}

function normalizeCodexUnsupportedModelDetail(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function isAllowListedCodexAccountModel400(
  status: number,
  bodyText: string,
  modelId: string,
): boolean {
  if (status !== 400) return false;
  try {
    const payload = JSON.parse(bodyText) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail !== "string") return false;
    const expected = `The '${modelId}' model is not supported when using Codex with a ChatGPT account.`;
    return normalizeCodexUnsupportedModelDetail(detail)
      === normalizeCodexUnsupportedModelDetail(expected);
  } catch {
    return false;
  }
}

async function shouldRetryCodexPoolAccountModel400(
  response: Response,
  modelId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (response.status !== 400) return false;
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    return body.displaySafe
      && !body.truncated
      && isAllowListedCodexAccountModel400(response.status, body.text, modelId);
  } catch {
    return false;
  }
}



export function codexForwardTerminalOutcomeRecorder(
  config: OcxConfig,
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
  logCtx?: RequestLogContext,
  threadId?: string | null,
): ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined {
  if (!usesCodexForwardPoolAuth(authCtx, provider)) return undefined;
  return (status, httpStatusOverride) => {
    if (status === "incomplete") {
      // Normal limit/content-filter/stall terminal — the account served the
      // request. Don't penalize account health; record success to clear any
      // prior soft-avoid so a healthy account isn't stuck avoided.
      recordCodexUpstreamOutcome(config, authCtx.accountId, 200, {
        threadId,
        probeLeaseId: codexProbeLeaseId(authCtx),
      });
      return;
    }
    // status === "completed" or "failed": use the semantic HTTP status derived
    // from the terminal SSE error payload (httpStatusFromTerminalError in
    // request-log inspection) instead of collapsing every non-completed terminal
    // to 502. A 400 invalid_request_error must not soft-avoid the account or
    // rebind threads — only genuine transport/5xx failures should trigger
    // transient health recording.
    // httpStatusOverride: the combo WS path inspects SSE payloads into the parent
    // logCtx, but this recorder closes over the child logCtx. The caller passes
    // the parent's terminalHttpStatus so the semantic status is not lost.
    const outcome = status === "completed"
      ? 200
      : (httpStatusOverride ?? logCtx?.terminalHttpStatus ?? 502);
    recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, {
      threadId,
      probeLeaseId: codexProbeLeaseId(authCtx),
    });
  };
}



export function decodeRequestErrorResponse(err: unknown, label: string): Response {
  if (err instanceof UnsupportedContentEncodingError) {
    return formatErrorResponse(415, "invalid_request_error", err.message);
  }
  if (err instanceof DecompressedBodyTooLargeError) {
    return formatErrorResponse(413, "invalid_request_error", err.message);
  }
  console.warn(`[${label}] request body decode/parse failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  return formatErrorResponse(400, "invalid_request_error", "Invalid JSON body");
}



export function comboUnavailableResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "server_error", code: "combo_unavailable" },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}



export interface ConsumedComboFailure {
  response: Response;
  classificationText: string;
  /** Structured upstream `error.code` when present in the failure body. */
  upstreamCode?: string;
  /** Valid numeric/date value used only for cooldown calculation. */
  retryAfter?: string;
  /** Reserved for 040 usage attribution without adding another body read. */
  usage?: OcxUsage;
}



export interface HandleResponsesOptions {
  forceEmptyResponseId?: boolean;
  abortSignal?: AbortSignal;
  /** One-shot TTFT callback: first non-empty model output observed (WP4). */
  onFirstOutput?: () => void;
  onCodexAuthContextResolved?: (context: CodexAuthContext | undefined) => void;
  recordTerminalOutcomes?: boolean;
  setTerminalOutcomeRecorder?: (recorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined) => void;
  onNativePassthroughTerminal?: (status: ResponsesTerminalStatus) => void;
  onNativePassthroughCancel?: () => void;
  /** Internal recursion guard; callers outside this module must not set it. */
  comboAttempt?: boolean;
  /** 030-owned handoff when a child consumed the original failure under bounds. */
  onConsumedComboFailure?: (failure: ConsumedComboFailure) => void;
}



export function clientCancelledResponse(): Response {
  return formatErrorResponse(499, "client_cancelled", "Client cancelled request");
}



export function sanitizedRetryAfter(value: string | null, now: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return parseRetryAfterMs(trimmed, now) !== undefined ? trimmed : undefined;
}



export async function consumeComboFailure(
  response: Response,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<ConsumedComboFailure> {
  const fallback = `Provider error ${response.status}`;
  let classificationText = fallback;
  let usage: OcxUsage | undefined;
  let upstreamCode: string | undefined;
  try {
    const body = await readBoundedResponseBody(response, { signal });
    usage = usageFromComboFailureText(body.text);
    if (body.displaySafe) {
      const safeText = redactSecretString(body.text).slice(0, 500);
      if (safeText) classificationText = safeText;
      try {
        const parsed = JSON.parse(body.text) as { error?: { code?: unknown } | string };
        const nested = typeof parsed?.error === "object" && parsed.error ? parsed.error.code : undefined;
        if (typeof nested === "string" && nested.length > 0) upstreamCode = nested;
      } catch {
        /* non-JSON upstream body — message-only classification */
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    classificationText = fallback;
  }
  const message = classificationText === fallback
    ? fallback
    : `${fallback}: ${classificationText}`;
  const upstreamRetryAfter = response.headers.get("retry-after");
  // Client response may get the synthetic "2" fallback; cooldown metadata must not —
  // otherwise coolComboTarget treats it as a 2s cooldown instead of the 60s default.
  const clientRetryAfter = resolveClientRetryAfter({
    status: response.status,
    message,
    upstreamRetryAfter,
    now,
  });
  const cooldownRetryAfter = resolveClientRetryAfter({
    status: response.status,
    message,
    upstreamRetryAfter,
    now,
    includeDefault: false,
  });
  return {
    response: formatErrorResponse(response.status, "upstream_error", message, {
      ...(upstreamCode !== undefined ? { code: upstreamCode } : {}),
      ...(clientRetryAfter !== undefined ? { retryAfter: clientRetryAfter } : {}),
    }),
    classificationText,
    ...(upstreamCode !== undefined ? { upstreamCode } : {}),
    ...(cooldownRetryAfter !== undefined ? { retryAfter: cooldownRetryAfter } : {}),
    ...(usage ? { usage } : {}),
  };
}



export function usageFromComboFailureText(text: string): OcxUsage | undefined {
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const nested = payload.response;
    const source = nested && typeof nested === "object" && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : payload;
    return usageFromResponsesPayload(source.usage);
  } catch {
    return undefined;
  }
}



export function createChildPassthroughCallbackGate(options: HandleResponsesOptions) {
  type Pending =
    | { kind: "terminal"; status: ResponsesTerminalStatus }
    | { kind: "cancel" };
  let state: "pending" | "committed" | "discarded" = "pending";
  let pending: Pending | undefined;
  let accepted = false;
  const publish = (value: Pending): void => {
    if (value.kind === "terminal") options.onNativePassthroughTerminal?.(value.status);
    else options.onNativePassthroughCancel?.();
  };
  const receive = (value: Pending): void => {
    if (state === "discarded" || accepted) return;
    accepted = true;
    if (state === "committed") return publish(value);
    pending ??= value;
  };
  return {
    onTerminal: (status: ResponsesTerminalStatus) => receive({ kind: "terminal", status }),
    onCancel: () => receive({ kind: "cancel" }),
    commit: () => {
      if (state !== "pending") return;
      state = "committed";
      if (pending) publish(pending);
      pending = undefined;
    },
    discard: () => {
      state = "discarded";
      pending = undefined;
    },
  };
}



export function buildComboChildHeaders(parentHeaders: HeadersInit): Headers {
  const childHeaders = new Headers(parentHeaders);
  // Combo children re-serialize already-decoded JSON. Keeping transport metadata from
  // the parent would make the child decoder treat plain JSON as compressed bytes.
  childHeaders.delete("content-length");
  childHeaders.delete("content-encoding");
  return childHeaders;
}

const UNREADABLE_ENCRYPTED_AGENT_TASK_MESSAGE =
  "Routed V2 worker task is encrypted for the native ChatGPT backend and cannot be read by the selected provider. Use plaintext V2 agent-message delivery or select a native ChatGPT model.";

function unreadableEncryptedAgentTaskResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: UNREADABLE_ENCRYPTED_AGENT_TASK_MESSAGE,
        type: "invalid_request_error",
        code: "unreadable_encrypted_agent_task",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

type ResponsesAuthResolution =
  | { ok: true; authCtx: CodexAuthContext; headers: Headers }
  | { ok: false; response: Response };

/**
 * Resolve Codex auth for a route. On unusable contexts, releases any probe lease
 * before returning the 401 (nothing reaches upstream).
 */
async function resolveResponsesCodexAuth(
  req: Request,
  config: OcxConfig,
  route: RouteResult,
  options: HandleResponsesOptions,
): Promise<ResponsesAuthResolution> {
  try {
    if (route.codexAccountMode === "direct") validateForwardAdmissionCredential(req.headers, config);
    let authCtx: CodexAuthContext;
    if (route.codexAccountMode) {
      authCtx = await resolveCodexAuthContext(req.headers, config, route.codexAccountMode);
      options.onCodexAuthContextResolved?.(authCtx);
    } else {
      authCtx = { kind: "main", accountId: null };
      options.onCodexAuthContextResolved?.(undefined);
    }
    if (!isCodexAuthContextUsable(authCtx, config)) {
      releaseCodexAuthContextProbeLease(authCtx);
      return {
        ok: false,
        response: formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication"),
      };
    }
    return {
      ok: true,
      authCtx,
      headers: headersForCodexAuthContext(req.headers, authCtx),
    };
  } catch (err) {
    if (err instanceof CodexAccountCooldownError) {
      return { ok: false, response: cooldownErrorResponse(err) };
    }
    if (err instanceof CodexThreadAffinityExpiredError) {
      return {
        ok: false,
        response: formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session"),
      };
    }
    if (err instanceof CodexAuthContextError) {
      const safeAccountLabel = formatCodexProviderForLog(route.providerName, err.accountId, config);
      console.error(`[codex-auth] Pool account ${safeAccountLabel} token failed; reauthentication required`);
      return {
        ok: false,
        response: formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication"),
      };
    }
    if (err instanceof CodexPoolAuthenticationError) {
      return { ok: false, response: formatErrorResponse(401, "authentication_error", err.message) };
    }
    if (err instanceof CodexDirectAuthenticationError) {
      return { ok: false, response: formatErrorResponse(401, "authentication_error", err.message) };
    }
    if (err instanceof ForwardAdmissionCredentialError) {
      return { ok: false, response: formatErrorResponse(401, "authentication_error", err.message) };
    }
    throw err;
  }
}

/**
 * Apply every route-dependent request mutation against the final selected route.
 * Must run only after subagent fallback has settled the model/provider.
 */
async function applyFinalRouteRequestNormalization(args: {
  parsed: OcxParsedRequest;
  route: RouteResult;
  config: OcxConfig;
  req: Request;
  logCtx: RequestLogContext;
}): Promise<void> {
  const { parsed, route, config, req, logCtx } = args;

  // Apply the routed model id upstream: routing may strip a "<provider>/" namespace.
  if (route.modelId !== parsed.modelId) {
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as { model?: string }).model = route.modelId;
    }
    parsed.modelId = route.modelId;
  }
  // Settle the wire once so logging, fast-mode, auth, and sidecars read the adapter
  // this request will actually use (#404).
  route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
  logCtx.model = route.modelId;
  logCtx.provider = route.providerName;
  logCtx.providerAdapter = route.provider.adapter;

  // Final selected model before virtual wire-model rewriting (Pro aliases).
  const finalSelectedModelId = route.modelId;

  // Virtual model rewriting: Pro aliases → base model + reasoning.mode="pro".
  applyOpenAiVirtualModel(parsed, route, logCtx);

  // Fast mode override for OpenAI-routed models.
  if (config.fastMode !== undefined && route.provider.adapter === "openai-responses") {
    const tier = config.fastMode ? "priority" : undefined;
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      if (tier) (parsed._rawBody as Record<string, unknown>).service_tier = tier;
      else delete (parsed._rawBody as Record<string, unknown>).service_tier;
    }
    parsed.options.serviceTier = tier;
  }

  {
    const guidance = await multiAgentGuidanceText(parsed, {
      multiAgentGuidanceEnabled: config.multiAgentGuidanceEnabled,
      injectionModel: config.injectionModel,
      injectionEffort: config.injectionEffort,
      subagentModels: config.subagentModels,
      subagentModelFallback: config.subagentModelFallback,
      injectionPrompt: config.injectionPrompt,
    });
    if (guidance) {
      injectDeveloperMessage(parsed, guidance);
      if (isInjectionDebugEnabled()) {
        injectionDebugLog(`[opencodex] ${route.modelId}: multi-agent guidance injected (surface=${collabSurface(parsed)}, guidanceEnabled=${multiAgentGuidanceEnabled(config)}, ${guidance.length} chars)`);
      }
    } else if (isInjectionDebugEnabled() && collabSurface(parsed) !== null) {
      injectionDebugLog(`[opencodex] ${route.modelId}: collab surface=${collabSurface(parsed)}, guidance silent (effort=${parsed.options.reasoning ?? "unset"}, injectionModel=${config.injectionModel ?? "unset"})`);
    }
  }

  {
    const { applyEffortCap, effortCapAppliesTo, supportedLadderFor } = await import("../effort-policy");
    const surface = collabSurface(parsed);
    if (effortCapAppliesTo(surface, req.headers, config, parsed._compactionRequest === true)) {
      const capped = applyEffortCap(parsed, req.headers, config, supportedLadderFor(route));
      if (capped) {
        logCtx.requestedEffort = `${capped.from}->${capped.to}`;
        if (isInjectionDebugEnabled()) {
          injectionDebugLog(`[opencodex] ${route.modelId}: effort cap applied (${capped.from} -> ${capped.to}, ${capped.subagent ? "sub-agent" : "main"} turn)`);
        }
      }
    } else if (isInjectionDebugEnabled() && (config.effortCap || config.subagentEffortCap)) {
      injectionDebugLog(`[opencodex] ${route.modelId}: effort cap skipped (surface=${surface ?? "none"}, v2 feature only)`);
    }
  }

  {
    const { nativeEffortClamp, shouldApplyNativeEffortClamp } = await import("../../codex/catalog");
    const clamped = shouldApplyNativeEffortClamp(route.providerName, route.provider, finalSelectedModelId)
      ? nativeEffortClamp(route.modelId, parsed.options.reasoning)
      : null;
    if (clamped) {
      parsed.options.reasoning = clamped;
      const raw = parsed._rawBody as { reasoning?: { effort?: string } } | undefined;
      if (raw?.reasoning && typeof raw.reasoning === "object") raw.reasoning.effort = clamped;
      logCtx.requestedEffort = `${logCtx.requestedEffort ?? "max"}->${clamped}`;
    }
  }
  recordAttemptRequestedEffort(logCtx);
  logCtx.modelSupportsServiceTier = catalogModelSupportsServiceTier(
    route.modelId,
    logCtx.requestedServiceTier ?? logCtx.configuredServiceTier,
  );
}



export async function handleComboResponses(
  req: Request,
  rawBody: unknown,
  comboId: string,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions,
): Promise<Response> {
  const requestedModel = typeof (rawBody as { model?: unknown } | null)?.model === "string"
    ? (rawBody as { model: string }).model
    : `combo/${comboId}`;
  Object.assign(logCtx, {
    requestedModel,
    model: requestedModel,
    provider: "combo",
    comboId,
  });
  const combo = getCombo(config, comboId);
  if (!combo) {
    return formatErrorResponse(404, "invalid_request_error", `Unknown combo: ${comboId}`);
  }
  const adoptFailedChildLog = (childLog: RequestLogContext): void => {
    // Attempts remain the complete physical history; the logical row mirrors the most recent
    // failed target so an exhausted combo still has useful top-level reasoning diagnostics.
    Object.assign(logCtx, childLog, {
      requestedModel,
      model: requestedModel,
      provider: "combo",
      comboId,
      attempts: logCtx.attempts,
      activeAttempt: undefined,
      activeAttemptStartedAt: undefined,
    });
  };

  const unreadableEncryptedAgentTask = hasUnreadableEncryptedAgentTask(
    (rawBody as { input?: unknown } | undefined)?.input,
  );
  const canDecryptUnreadableAgentTask = (target: (typeof combo.targets)[number]): boolean => {
    const provider = config.providers[target.provider];
    if (!provider || provider.disabled === true) return false;
    try {
      const route = routeModel(config, `${target.provider}/${target.model}`);
      return isCanonicalOpenAiForwardProvider(route.provider);
    } catch {
      return false;
    }
  };
  const payloadEligible = (target: (typeof combo.targets)[number]): boolean =>
    !unreadableEncryptedAgentTask || canDecryptUnreadableAgentTask(target);

  if (unreadableEncryptedAgentTask && !combo.targets.some(canDecryptUnreadableAgentTask)) {
    return unreadableEncryptedAgentTaskResponse();
  }

  const initialNow = Date.now();
  let pick = pickComboTarget(config, comboId, {
    eligible: target => payloadEligible(target)
      && !isComboTargetInCooldown(comboId, target, initialNow),
  });
  if (!pick) {
    return comboUnavailableResponse(`No available targets for combo: ${comboId}`);
  }

  let lastFailure: Response | null = null;
  while (pick) {
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    const childLog: RequestLogContext = {
      model: pick.target.model,
      provider: pick.target.provider,
      ...(logCtx.conversationId ? { conversationId: logCtx.conversationId } : {}),
      ...(logCtx.surface ? { surface: logCtx.surface } : {}),
    };
    const targetRoute = routeModel(config, `${pick.target.provider}/${pick.target.model}`);
    const childBody = concreteComboRequestBody(
      rawBody,
      pick.target,
      comboDefaultEffort(config, comboId),
      supportedLadderFor({ provider: targetRoute.provider, modelId: targetRoute.modelId }),
    );
    const childHeaders = buildComboChildHeaders(req.headers);
    const childRequest = new Request(req.url, {
      method: req.method,
      headers: childHeaders,
      body: JSON.stringify(childBody),
    });
    let resolvedAuth: CodexAuthContext | undefined;
    let terminalRecorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined;
    const started = Date.now();
    const attempt = beginRequestAttempt(
      (logCtx.attempts?.length ?? 0) + 1,
      pick.target.provider,
      pick.target.model,
      config.providers[pick.target.provider]!.adapter,
    );
    childLog.activeAttempt = attempt;
    let attemptRetained = false;
    const retainCancelledAttempt = (): void => {
      if (attemptRetained) return;
      sealRequestAttemptIdentity(
        attempt,
        childLog.provider,
        childLog.providerAdapter ?? attempt.adapter,
      );
      finishRequestAttempt(attempt, 499, Date.now() - started, childLog.usage);
      (logCtx.attempts ??= []).push(attempt);
      attemptRetained = true;
    };
    let consumedChildFailure: ConsumedComboFailure | undefined;
    const callbackGate = createChildPassthroughCallbackGate(options);
    let response: Response;
    try {
      response = await handleResponses(childRequest, config, childLog, {
        ...options,
        comboAttempt: true,
        // Attempt-relative TTFT is recorded HERE (not via childLog.firstOutputMs — a later
        // Object.assign(logCtx, childLog) would overwrite the request-relative value).
        onFirstOutput: () => {
          if (attempt.firstOutputMs === undefined) {
            attempt.firstOutputMs = Math.max(0, Date.now() - started);
          }
          options.onFirstOutput?.();
        },
        onCodexAuthContextResolved: value => { resolvedAuth = value; },
        setTerminalOutcomeRecorder: value => { terminalRecorder = value; },
        onConsumedComboFailure: value => { consumedChildFailure = value; },
        onNativePassthroughTerminal: callbackGate.onTerminal,
        onNativePassthroughCancel: callbackGate.onCancel,
      });
    } catch (error) {
      callbackGate.discard();
      if (options.abortSignal?.aborted) {
        retainCancelledAttempt();
        return clientCancelledResponse();
      }
      throw error;
    }

    if (options.abortSignal?.aborted) {
      callbackGate.discard();
      retainCancelledAttempt();
      return clientCancelledResponse();
    }

    if (response.ok) {
      sealRequestAttemptIdentity(
        attempt,
        childLog.provider,
        childLog.providerAdapter ?? attempt.adapter,
      );
      (logCtx.attempts ??= []).push(attempt);
      attemptRetained = true;
      noteComboSuccess(comboId, combo, pick.target);
      Object.assign(logCtx, childLog, {
        requestedModel,
        model: requestedModel,
        provider: "combo",
        comboId,
        attempts: logCtx.attempts,
        activeAttempt: attempt,
        activeAttemptStartedAt: started,
        resolvedModel: childLog.resolvedModel ?? childLog.model,
      });
      options.onCodexAuthContextResolved?.(resolvedAuth);
      options.setTerminalOutcomeRecorder?.(terminalRecorder);
      callbackGate.commit();
      return response;
    }

    callbackGate.discard();
    if (response.status === 499) {
      retainCancelledAttempt();
      return clientCancelledResponse();
    }
    let failure: ConsumedComboFailure;
    try {
      failure = consumedChildFailure
        ?? await consumeComboFailure(response, options.abortSignal);
    } catch (error) {
      if (options.abortSignal?.aborted) {
        retainCancelledAttempt();
        return clientCancelledResponse();
      }
      throw error;
    }
    if (options.abortSignal?.aborted) {
      retainCancelledAttempt();
      return clientCancelledResponse();
    }
    sealRequestAttemptIdentity(
      attempt,
      childLog.provider,
      childLog.providerAdapter ?? attempt.adapter,
    );
    finishRequestAttempt(
      attempt,
      response.status,
      Date.now() - started,
      failure.usage,
    );
    (logCtx.attempts ??= []).push(attempt);
    attemptRetained = true;
    lastFailure = failure.response;
    if (comboFailureDecision(failure.response.status, failure.classificationText, {
      code: failure.upstreamCode,
    }) === "stop") {
      adoptFailedChildLog(childLog);
      return lastFailure;
    }
    console.warn(
      `[combo] ${comboId}: ${targetKey(pick.target)} failed with ${response.status} after ${Date.now() - started}ms`,
    );
    const nextPick = advanceComboAfterFailure(config, pick, {
      retryAfter: failure.retryAfter,
      now: Date.now(),
      eligible: payloadEligible,
    });
    if (!nextPick) adoptFailedChildLog(childLog);
    pick = nextPick;
  }
  return lastFailure!;
}



export async function handleResponses(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions = {},
): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    return decodeRequestErrorResponse(err, "responses");
  }
  const comboId = !options.comboAttempt ? comboIdFromRawBody(body, config) : null;
  if (comboId && Object.hasOwn(config.combos ?? {}, comboId)) {
    return handleComboResponses(req, body, comboId, config, logCtx, options);
  }
  const unreadableEncryptedAgentTask = hasUnreadableEncryptedAgentTask(
    (body as { input?: unknown } | undefined)?.input,
  );
  const originalBody = body;
  body = expandPreviousResponseInput(body);
  const previousResponseInputExpanded = body !== originalBody;

  // Spawn-message compatibility (both directions): agent_message task payloads ride in
  // encrypted_content slots as plaintext. Rewrite them to input_text on the RAW body BEFORE
  // parsing so every consumer sees the payload: parseRequest (routed/translated providers read
  // the parsed messages) and the native passthrough (_rawBody is this same object, serialized
  // verbatim). Genuine backend ciphertext is left byte-identical (looksLikeBackendCiphertext).
  {
    const rewritten = sanitizeEncryptedContentInPlace(
      (body as { input?: unknown } | undefined)?.input,
    );
    if (rewritten > 0)
      console.warn(
        `[opencodex] rewrote ${rewritten} plaintext encrypted_content part(s) to input_text (spawn-message compatibility)`,
      );
  }

  let parsed;
  try {
    parsed = parseRequest(body);
    if (previousResponseInputExpanded) parsed._previousResponseInputExpanded = true;
    parsed._providerContinuation = previousResponseProviderState(parsed.previousResponseId);
    parsed._cursorConversationId = parsed._providerContinuation?.cursor?.conversationId;
    const clientThreadId = req.headers.get("x-codex-parent-thread-id")?.trim();
    if (clientThreadId) parsed._clientThreadId = clientThreadId;
  } catch (err) {
    return formatErrorResponse(400, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  // Prefer a pre-populated id (routed Claude) over Responses headers that may be
  // absent or synthetically injected (session_id from prompt_cache_key).
  if (!logCtx.conversationId) {
    logCtx.conversationId = conversationIdFromResponsesRequest({
      clientThreadId: parsed._clientThreadId,
      sessionIdHeader: sessionIdHeaderFromRequest(req.headers),
      threadIdHeader: req.headers.get("thread-id"),
      cursorConversationId: parsed._cursorConversationId,
    });
  }
  logCtx.requestedModel = parsed.modelId;
  logCtx.requestedEffort = parsed.options.reasoning;
  logCtx.requestedServiceTier = parsed.options.serviceTier;
  logCtx.requestedSpeedLabel = requestLogSpeedLabel(parsed.options.serviceTier);
  logCtx.configuredServiceTier = readConfiguredCodexServiceTier();
  logCtx.configuredSpeedLabel = requestLogSpeedLabel(logCtx.configuredServiceTier);

  // Shadow call intercept: rewrite Codex's hard-coded helper calls
  // (gpt-5.4-mini on older clients, gpt-5.6-luna on 0.145.0+)
  const _sci = config.shadowCallIntercept;
  if (_sci?.enabled && _sci.model && isShadowSourceModel(parsed.modelId, _sci.sourceModels)) {
    const _sciOriginal = parsed.modelId;
    parsed.modelId = _sci.model;
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as { model?: string }).model = _sci.model;
    }
    // Force effort to low for shadow/helper calls (matching upstream behavior)
    parsed.options.reasoning = "low";
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as Record<string, unknown>).reasoning = { effort: "low" };
    }
    (logCtx as unknown as Record<string, unknown>).shadowCallRewrittenFrom = _sciOriginal;
    // Helpers must not resume/append into the parent thread's Cursor conversation.
    parsed._cursorIsolateConversation = true;
  }
  if (parsed._compactionRequest === true) parsed._cursorIsolateConversation = true;

  if (isThreadSpawnRequest(req.headers)) {
    await maybePrimeSubagentQuota(config);
  }

  let route: RouteResult;
  try {
    route = routeModel(config, parsed.modelId);
  } catch (err) {
    if (err instanceof NoAvailableComboTargetsError) {
      return comboUnavailableResponse(err.message);
    }
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  let authCtx: CodexAuthContext = { kind: "main", accountId: null };
  let selectedForwardHeaders = req.headers;
  let subagentFallbackAccountId = config.activeCodexAccountId ?? null;
  let subagentQuotaFailureModel = parsed.modelId;

  // Subagent fallback must settle the final model/provider BEFORE route-dependent
  // normalization (virtual models, effort caps, service tier, wire protocol).
  // Preview the preferred Codex account without acquiring a probe lease or refreshing
  // tokens — auth is resolved only after the final route is selected.
  if (isThreadSpawnRequest(req.headers) && !options.comboAttempt) {
    const threadId = req.headers.get("x-codex-parent-thread-id");
    const previewAccountId = previewCodexAccountForRequest(threadId, config);
    subagentFallbackAccountId = previewAccountId ?? config.activeCodexAccountId ?? null;
    const fallback = applySubagentModelFallback(
      parsed,
      req.headers,
      config,
      previewAccountId,
      Date.now(),
      unreadableEncryptedAgentTask,
    );
    if (fallback) {
      (logCtx as unknown as Record<string, unknown>).subagentModelFallbackFrom = fallback.from;
      (logCtx as unknown as Record<string, unknown>).subagentModelFallbackTo = fallback.to;
      if (isInjectionDebugEnabled()) {
        injectionDebugLog(`[opencodex] subagent model fallback ${fallback.from} -> ${fallback.to}`);
      }
    }
    subagentQuotaFailureModel = fallback?.to ?? parsed.modelId;

    if (fallback?.to && !slugsEquivalent(fallback.to, route.modelId)) {
      try {
        route = routeModel(config, fallback.to);
      } catch (err) {
        if (err instanceof NoAvailableComboTargetsError) {
          return comboUnavailableResponse(err.message);
        }
        return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Encrypted child tasks may only reach the canonical native backend. This check
  // runs against the FINAL route so native-only fallback can rescue a routed primary.
  if (!isCanonicalOpenAiForwardProvider(route.provider) && unreadableEncryptedAgentTask) {
    return unreadableEncryptedAgentTaskResponse();
  }

  await applyFinalRouteRequestNormalization({ parsed, route, config, req, logCtx });

  {
    const finalAuth = await resolveResponsesCodexAuth(req, config, route, options);
    if (!finalAuth.ok) return finalAuth.response;
    authCtx = finalAuth.authCtx;
    selectedForwardHeaders = finalAuth.headers;
  }

  route.provider = applyCodexAuthContextToProvider(route.provider, authCtx, route.codexAccountMode);
  logCtx.provider = formatCodexProviderForLog(route.providerName, codexLogAccountId(authCtx), config);
  // Prefer Codex pool account as the Cursor thread namespace when present. Cursor routes without
  // codexAccountMode still get a credential-derived scope inside the Cursor adapter.
  const identityScope = codexLogAccountId(authCtx);
  if (identityScope) parsed._cursorIdentityScope = identityScope;
  subagentFallbackAccountId = authCtx.kind === "pool" || authCtx.kind === "main-pool"
    ? authCtx.accountId
    : config.activeCodexAccountId ?? null;

  // OAuth providers: swap in a fresh access token (auto-refreshed) as the Bearer key, so the
  // existing openai-chat / anthropic adapters authenticate with no change.
  const isOAuth401ReplayProvider = (route.providerName === "xai" || route.providerName === "github-copilot" || route.providerName === "kiro")
    && route.provider.authMode === "oauth";
  let sentOAuthSnapshot: OAuthAccessSnapshot | undefined;
  if (route.provider.authMode === "oauth") {
    try {
      const resolved = await getValidAccessTokenSnapshot(route.providerName);
      if (isOAuth401ReplayProvider) sentOAuthSnapshot = resolved;
      route.provider = { ...route.provider, apiKey: resolved.accessToken };
      if (route.providerName === "kiro") {
        // `{}` is intentional: this is an account-scoped request with no stored routing metadata.
        // Only genuinely accountless adapter calls leave the context undefined and use local/env fallback.
        parsed._kiroAuthContext = { ...(resolved.kiro ?? {}) };
      }
      // Antigravity (cloud-code-assist) needs the discovered Cloud Code Assist project id in the
      // CCA envelope; the server injects only the bare token, so pull project from the credential.
      if (route.provider.googleMode === "cloud-code-assist" && !route.provider.project) {
        const projectId = getOAuthCredentialProjectId(route.providerName);
        if (projectId) route.provider = { ...route.provider, project: projectId };
      }
    } catch (err) {
      if (err instanceof UnsupportedOAuthProviderError) {
        return formatErrorResponse(
          400,
          "invalid_request_error",
          `${err.message}. Remove or reconfigure provider '${route.providerName}' in ${getConfigPath()}.`,
        );
      }
      return formatErrorResponse(401, "authentication_error", err instanceof Error ? err.message : String(err));
    }
  }
  route.provider = resolveProviderTransport(
    route.providerName,
    route.provider,
    parsed.options.promptCacheKey,
    route.providerName === "github-copilot" ? getOAuthCredentialApiBaseUrl(route.providerName) : undefined,
  );
  const adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider);
  const adapter = resolveAdapter(adapterProvider, config.cacheRetention);
  logCtx.providerAdapter = adapter.name;
  sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, adapter.name);
  const isPassthrough = "passthrough" in adapter && !!adapter.passthrough;

  if (adapter.name === "kiro" && parsed.previousResponseId && !parsed._previousResponseInputExpanded) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Kiro continuation state is missing; start a new session instead of reusing this previous_response_id.",
    );
  }

  let openAiSidecar: ResolvedOpenAiForwardSidecar | undefined;
  const needsOpenAiVision = shouldResolveOpenAiVisionSidecar(config, route.provider, route.modelId, parsed);
  const needsOpenAiSearch = shouldResolveOpenAiWebSearchSidecar(config, parsed, isPassthrough);
  if (needsOpenAiVision || needsOpenAiSearch) {
    try {
      openAiSidecar = await resolveFirstUsableOpenAiSidecar(
        listOpenAiForwardSidecarCandidates(config),
        req.headers,
        config,
      );
    } catch (err) {
      // Sidecars are optional helpers for an otherwise independent routed turn.
      // An unavailable/cooling/expired Multi credential disables the helper; it
      // must not turn a valid routed-provider request into a Codex-auth failure.
      if (
        !(err instanceof CodexPoolAuthenticationError)
        && !(err instanceof CodexAuthContextError)
        && !(err instanceof CodexAccountCooldownError)
        && !(err instanceof CodexThreadAffinityExpiredError)
      ) throw err;
    }
  }

  // Vision sidecar: the routed model can't see images (provider.noVisionModels). Describe each
  // attached image through the selected sidecar backend and replace it with text BEFORE the main
  // call, so the text-only model can reason about it.
  const visionPlan = planVisionSidecar(config, route.provider, route.modelId, parsed, openAiSidecar);
  const recordSidecarOutcome = openAiSidecar?.recordOutcome;
  if (visionPlan) {
    await describeImagesInPlace(parsed, visionPlan, openAiSidecar?.headers ?? selectedForwardHeaders, options.abortSignal, recordSidecarOutcome);
  } else if (modelInList(route.provider.noVisionModels, route.modelId)) {
    // Sidecar-covered model but NO plan (no forward provider / missing forwarded auth / sidecar
    // disabled): fail closed — never forward raw images to a text-only upstream.
    stripImagesInPlace(parsed);
  }

  const recordTerminalOutcomes = options.recordTerminalOutcomes !== false;

  const continuationStateForResponse = (
    emitted?: OcxProviderContinuationState,
  ): OcxProviderContinuationState | undefined => {
    const cursorConversationId = parsed._cursorConversationId;
    const inherited = parsed._providerContinuation;
    if (!emitted && !inherited && !cursorConversationId) return undefined;
    return {
      ...(inherited ?? {}),
      ...(emitted ?? {}),
      ...((inherited?.kiro || emitted?.kiro)
        ? { kiro: { ...(inherited?.kiro ?? {}), ...(emitted?.kiro ?? {}) } }
        : {}),
      ...(cursorConversationId
        ? {
            cursor: {
              ...(inherited?.cursor ?? {}),
              ...(emitted?.cursor ?? {}),
              conversationId: cursorConversationId,
            },
          }
        : {}),
    };
  };

  // Remote compaction v2 on a ROUTED model: Codex sent `compaction_trigger` and requires exactly
  // one `{type:"compaction"}` output item (codex-rs compact_remote_v2.rs). Passthrough handles it
  // natively upstream; here we run the routed model as a plain summarizer — no tools, no web-search
  // sidecar — and the bridge appends the synthetic compaction item (src/responses/compaction.ts).
  // A Responses-shaped wire does not imply support for Codex's private
  // `compaction_trigger` item — only the canonical ChatGPT backend speaks that
  // contract. An API-key gateway would receive the trigger, answer with an ordinary
  // message, and leave Codex fataling on a missing compaction item (#422).
  const routedCompaction = parsed._compactionRequest === true
    && !isCanonicalOpenAiForwardProvider(route.provider);
  if (routedCompaction) {
    delete parsed.context.tools;
    delete parsed._webSearch;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  if ("passthrough" in adapter && adapter.passthrough && !routedCompaction) {
    // Local continuation cache for the ChatGPT passthrough. Codex WS turns chain with
    // previous_response_id, ocx converts them to internal HTTP requests, and the ChatGPT Codex
    // REST backend rejects the parameter — the adapter strips it in forward mode, so the ONLY
    // way a chained turn keeps its earlier context is the local replay expansion. Record
    // completed passthrough responses (force bypasses Codex's blanket store:false) so the next
    // turn's expansion hits. Never record a body whose own previous_response_id failed to
    // expand: its input is a delta, and storing it would replay a truncated conversation.
    // Compaction turns are excluded: _rawBody still carries the full pre-compaction history and
    // recording it would let a later expansion rehydrate the chain Codex just replaced.
    const passthroughRecordEligible = parsed._compactionRequest !== true
      && (!parsed.previousResponseId || parsed._previousResponseInputExpanded === true);
    const rememberPassthroughResponse = passthroughRecordEligible
      ? (response: { id?: unknown; output?: unknown; status?: unknown }) =>
        rememberResponseState(parsed._rawBody, response, undefined, { force: true })
      : undefined;
    if (parsed.previousResponseId && !parsed._previousResponseInputExpanded) {
      console.warn(
        `[responses] previous_response_id ${parsed.previousResponseId} not found in local replay state `
        + `(model ${parsed.modelId}); forwarding without it — earlier turns may be missing from this request`,
      );
    }
    let request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders });
    recordAdapterReasoning(logCtx, request);
    const passthroughEstimate = typeof request.usageLog?.inputTokens === "number"
      ? request.usageLog.inputTokens
      : undefined;
    if (passthroughEstimate !== undefined) {
      logCtx.usageLogInputTokens = passthroughEstimate;
    }
    // Abort the upstream if the client disconnects. A directly-relayed body does not propagate the
    // consumer's cancel to a signalled fetch, so we pass the signal and relay through relayWithAbort,
    // whose cancel() aborts the upstream — preventing leaked connections (RC2, passthrough path).
    const upstream = new AbortController();
    linkAbortSignal(upstream, options.abortSignal);
    const connectMs = config.connectTimeoutMs ?? 200_000;
    let upstreamResponse: Response;
    const transportFailureResponse = (err: unknown): Response => {
      upstream.abort();
      if (options.abortSignal?.aborted) return clientCancelledResponse();
      const outcome = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "connect_error";
      if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
        recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, {
          threadId: req.headers.get("x-codex-parent-thread-id"),
          probeLeaseId: codexProbeLeaseId(authCtx),
        });
      }
      const msg = outcome === "timeout"
        ? `Provider connect timeout after ${connectMs}ms`
        : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
      return formatErrorResponse(502, "upstream_error", msg);
    };
    try {
      // Transient-5xx pre-stream retry (devlog/_plan/260716_claudecode_hardening/010):
      // the ChatGPT backend emits transient 502/520s that an immediate retry absorbs.
      // Body is a replayable string; nothing has streamed to the client yet.
      upstreamResponse = await fetchWithTransientRetry(
        recovery => {
          noteAttemptSend(logCtx.activeAttempt, passthroughEstimate, recovery);
          return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
            method: request.method,
            headers: request.headers,
            body: request.body,
          }, recovery), upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
        },
        { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
      );
    } catch (err) {
      return transportFailureResponse(err);
    }

    if (
      usesCodexForwardPoolAuth(authCtx, route.provider)
      && await shouldRetryCodexPoolAccountModel400(
        upstreamResponse,
        route.modelId,
        options.abortSignal,
      )
    ) {
      const firstAuthCtx = authCtx;
      let retryAuthCtx: CodexAuthContext | undefined;
      try {
        retryAuthCtx = await resolveCodexAuthContext(
          req.headers,
          config,
          "pool",
          { excludeAccountId: firstAuthCtx.accountId },
        );
      } catch (error) {
        if (
          !(error instanceof CodexPoolAuthenticationError)
          && !(error instanceof CodexAuthContextError)
          && !(error instanceof CodexAccountCooldownError)
        ) throw error;
      }

      if (retryAuthCtx?.kind === "pool" || retryAuthCtx?.kind === "main-pool") {
        recordCodexUpstreamOutcome(config, firstAuthCtx.accountId, 400, {
          threadId: req.headers.get("x-codex-parent-thread-id"),
          probeLeaseId: codexProbeLeaseId(firstAuthCtx),
        });

        const retryHeaders = headersForCodexAuthContext(req.headers, retryAuthCtx);
        const retryProvider = applyCodexAuthContextToProvider(
          stripCodexRuntimeProviderFields(route.provider),
          retryAuthCtx,
          "pool",
        );
        const retryAdapter = resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, retryProvider),
          config.cacheRetention,
        );
        request = await retryAdapter.buildRequest(parsed, { headers: retryHeaders });
        recordAdapterReasoning(logCtx, request);

        await upstreamResponse.body?.cancel().catch(() => undefined);
        authCtx = retryAuthCtx;
        options.onCodexAuthContextResolved?.(retryAuthCtx);
        selectedForwardHeaders = retryHeaders;
        route.provider = retryProvider;
        logCtx.provider = formatCodexProviderForLog(
          route.providerName,
          retryAuthCtx.accountId,
          config,
        );

        noteAttemptSend(logCtx.activeAttempt, passthroughEstimate);
        try {
          upstreamResponse = await fetchWithHeaderTimeout(
            request.url,
            {
              method: request.method,
              headers: request.headers,
              body: request.body,
            },
            upstream.signal,
            connectMs,
            parsed.stream,
            providerFetch(route.provider),
          );
        } catch (err) {
          return transportFailureResponse(err);
        }
      }
    }
    const headers = sanitizePassthroughHeaders(upstreamResponse.headers);
    const resolvedModel = headers.get("openai-model")?.trim();
    if (resolvedModel) logCtx.resolvedModel = resolvedModel;
    if (isUsageDebugEnabled()) {
      const upstreamContentType = upstreamResponse.headers.get("content-type");
      if (upstreamContentType) logCtx.usageDebugContentType = upstreamContentType;
    }
    // The chatgpt backend may omit Content-Type on SSE responses. Fall back to
    // treating a successful body as SSE when the caller requested streaming.
    const passthroughCt = headers.get("content-type")?.toLowerCase();
    const isEventStream = passthroughCt?.includes("text/event-stream")
      || (upstreamResponse.ok && !!upstreamResponse.body && !passthroughCt && parsed.stream);
    const terminalRecorder = codexForwardTerminalOutcomeRecorder(
      config,
      authCtx,
      route.provider,
      logCtx,
      req.headers.get("x-codex-parent-thread-id"),
    );
    const terminalBodyWillRecord = !!terminalRecorder && upstreamResponse.ok && isEventStream;
    // Capture quota from upstream response for multi-account tracking
   if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
      // primary was the 5h window; it now carries weekly data for GPT plans.
      // Prefer primary when present, fall back to secondary for compatibility.
      const retryAfterRaw = upstreamResponse.headers.get("retry-after");
      const { applyAccountQuotaFromUpstreamHeaders } = await import("../../codex/auth-api");
      applyAccountQuotaFromUpstreamHeaders(authCtx.accountId, upstreamResponse.headers);
      if (terminalBodyWillRecord) {
        options.setTerminalOutcomeRecorder?.((status, httpStatusOverride) => {
          terminalRecorder(status, httpStatusOverride);
          if (status === "failed") {
            const quotaFailureMessage = httpStatusOverride === 429 || httpStatusOverride === 402
              || logCtx.terminalHttpStatus === 429
              || logCtx.terminalHttpStatus === 402
              ? (httpStatusOverride ?? logCtx.terminalHttpStatus)
              : undefined;
            if (quotaFailureMessage !== undefined) {
              recordSubagentQuotaFailureForThreadSpawn(
                req.headers,
                subagentQuotaFailureModel,
                quotaFailureMessage,
                config,
                subagentFallbackAccountId,
              );
            }
          }
          options.onNativePassthroughTerminal?.(status);
        });
      } else {
        recordCodexUpstreamOutcome(config, authCtx.accountId, upstreamResponse.status, {
        retryAfter: retryAfterRaw,
         resetAt: [
           upstreamResponse.headers.get("x-codex-primary-reset-at"),
           upstreamResponse.headers.get("x-codex-secondary-reset-at"),
           upstreamResponse.headers.get("x-codex-tertiary-reset-at"),
         ].filter(Boolean),
         threadId: req.headers.get("x-codex-parent-thread-id"),
         probeLeaseId: codexProbeLeaseId(authCtx),
        });
      }
    }

    // Non-2xx passthrough failures must never reach Codex as an empty body —
    // Codex renders that as the opaque "Unknown error" (#452). Combo attempts
    // keep their typed failure envelope. Non-empty bodies are relayed verbatim
    // (headers included) so pool-retry Activation B/D and client diagnostics stay intact.
    if (!upstreamResponse.ok) {
      if (options.comboAttempt) {
        const failure = await consumeComboFailure(upstreamResponse, options.abortSignal);
        options.onConsumedComboFailure?.(failure);
        return failure.response;
      }
      const errorText = await upstreamResponse.text().catch(() => "");
      return formatPassthroughUpstreamError(upstreamResponse.status, errorText, {
        statusText: upstreamResponse.statusText,
        headers,
      });
    }

    // Bun#32111 workaround: passthrough SSE uses tee()+native relay to avoid the
    // async-pull segfault on Windows. Branch[0] goes directly to the Response (Bun
    // native relay, never enters JS Sink.write); branch[1] is consumed in the
    // background for terminal-outcome/quota inspection only.
    // #314 alternative shape: on win32 (no repair) with a runtime carrying the
    // Bun#32111 fix — or explicit `streamMode: "eager-relay"` opt-in — the tee
    // is skipped entirely and relaySseEagerBounded provides a single eager
    // bounded reader with inline inspection (see src/server/relay-eager.ts and
    // devlog/_plan/260723_win_mem_safestream/020). Default on the bundled
    // known-bad runtime remains the tee path below.
    if (isEventStream && upstreamResponse.body) {
      const repairConfig = route.provider.responsesItemIdRepair;
      const winNoRepair = process.platform === "win32" && !hasResponsesItemIdRepair(repairConfig);
      const eagerDecision = winNoRepair ? decideEagerRelay(config.streamMode ?? "auto") : null;
      if (eagerDecision?.useEagerRelay) {
        const turnAc = new AbortController();
        linkAbortSignal(upstream, turnAc.signal);
        registerTurn(turnAc);
        const reportNativeTerminal = recordTerminalOutcomes
          ? (status: ResponsesTerminalStatus, httpStatusOverride?: number) => {
            terminalRecorder?.(status, httpStatusOverride);
            if (status === "failed") {
              const quotaFailureMessage = httpStatusOverride === 429 || httpStatusOverride === 402
                || logCtx.terminalHttpStatus === 429
                || logCtx.terminalHttpStatus === 402
                ? (httpStatusOverride ?? logCtx.terminalHttpStatus)
                : undefined;
              if (quotaFailureMessage !== undefined) {
                recordSubagentQuotaFailureForThreadSpawn(
                  req.headers,
                  subagentQuotaFailureModel,
                  quotaFailureMessage,
                  config,
                  subagentFallbackAccountId,
                );
              }
            }
            options.onNativePassthroughTerminal?.(status);
          }
          : undefined;
        const inspector = createSseInspector({
          onTerminal: reportNativeTerminal,
          logCtx,
          onCompletedResponse: rememberPassthroughResponse,
          onFirstOutput: options.onFirstOutput,
        });
        const eagerBody = relaySseEagerBounded(upstreamResponse.body, turnAc, {
          inspectChunk: chunk => inspector.feed(chunk),
          finishInspection: () => inspector.finish(),
          sawTerminal: () => inspector.reported(),
          onSynthetic: kind => {
            if (!reportNativeTerminal) return;
            if (kind === "incomplete") {
              logCtx.terminalSource = "synthetic";
              reportNativeTerminal("incomplete");
            } else {
              logCtx.transportPhase = "mid_stream";
              logCtx.terminalSource = "synthetic";
              reportNativeTerminal("failed", 502);
            }
          },
          onClientCancel: () => options.onNativePassthroughCancel?.(),
          onDone: () => unregisterTurn(turnAc),
        });
        if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
        return markNativePassthroughSseResponse(new Response(eagerBody, {
          status: upstreamResponse.status,
          headers,
        }));
      }
      const [nativeBody, inspectBody] = upstreamResponse.body.tee();
      const turnAc = new AbortController();
      linkAbortSignal(upstream, turnAc.signal);
      registerTurn(turnAc);
      if (recordTerminalOutcomes) {
        // A real terminal was parsed from the (teed) inspection stream — record it as the outcome
        // even if the client has already disconnected: the turn genuinely reached that terminal, so
        // it must log as completed/failed, not be dropped or downgraded to a cancel (#44). A pure
        // client-cancel (no terminal seen) is finalized separately via consumeForInspection's onCancel.
        const reportNativeTerminal = (status: ResponsesTerminalStatus, httpStatusOverride?: number) => {
          terminalRecorder?.(status, httpStatusOverride);
          if (status === "failed") {
            const quotaFailureMessage = httpStatusOverride === 429 || httpStatusOverride === 402
              || logCtx.terminalHttpStatus === 429
              || logCtx.terminalHttpStatus === 402
              ? (httpStatusOverride ?? logCtx.terminalHttpStatus)
              : undefined;
            if (quotaFailureMessage !== undefined) {
              recordSubagentQuotaFailureForThreadSpawn(
                req.headers,
                subagentQuotaFailureModel,
                quotaFailureMessage,
                config,
                subagentFallbackAccountId,
              );
            }
          }
          options.onNativePassthroughTerminal?.(status);
        };
        consumeForInspection(
          inspectBody,
          reportNativeTerminal,
          turnAc.signal,
          () => unregisterTurn(turnAc),
          logCtx,
          () => options.onNativePassthroughCancel?.(),
          rememberPassthroughResponse,
          options.onFirstOutput,
        );
      } else {
        consumeForResponseLogMetadata(
          inspectBody,
          logCtx,
          turnAc.signal,
          () => unregisterTurn(turnAc),
          rememberPassthroughResponse,
          options.onFirstOutput,
        );
      }
      if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
      // win32 must keep the pure native relay (Bun#32111 JS-sink segfault); elsewhere a JS pull
      // relay is established practice (relayWithAbort, relaySseWithHeartbeat) and lets a
      // mid-stream reset end with a clean response.failed terminal instead of a raw socket error.
      const repairedBody = hasResponsesItemIdRepair(repairConfig)
        ? relaySseWithResponsesItemIdRepair(nativeBody, repairConfig!)
        : nativeBody;
      const clientBody = process.platform === "win32" && !hasResponsesItemIdRepair(repairConfig)
        ? nativeBody
        : relaySseWithFailedTail(repairedBody, upstream);
      return markNativePassthroughSseResponse(new Response(clientBody, {
        status: upstreamResponse.status,
        headers,
      }));
    }
    if (headers.get("content-type")?.toLowerCase().includes("application/json")) {
      const text = await upstreamResponse.text();
      inspectResponseLogJson(logCtx, text);
      if (rememberPassthroughResponse) {
        try {
          rememberPassthroughResponse(JSON.parse(text) as { id?: unknown; output?: unknown; status?: unknown });
        } catch { /* non-JSON despite content-type; recording is best-effort */ }
      }
      return new Response(text, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    }
    const body = relayWithAbort(upstreamResponse.body, upstream);
    const turnAc = new AbortController();
    const tracked = body ? trackStreamLifetime(body, turnAc) : null;
    return new Response(tracked, {
      status: upstreamResponse.status,
      headers,
    });
  }

  // Image / web-search sidecars: plan once, then dispatch with runTurn-aware priority.
  // Routed-compaction turns must NOT hit the image bridge: compaction clears tools/_webSearch but
  // leaves _imageGeneration, so planImageBridge would activate and return a normal Responses
  // completion instead of the synthetic compaction item Codex expects (#424).
  //
  // Web-search's loop only supports buildRequest/fetch/parseStream — NOT adapter.runTurn. Sending
  // Cursor/runTurn requests into runWithWebSearch produces empty HTTP failures. So:
  //   - non-runTurn: web-search wins over image when both eligible (documented priority)
  //   - runTurn: image bridge may run (it supports runTurn); web-search is skipped so runTurn
  //     can proceed for web-search-only turns
  const wsPlan = !routedCompaction
    ? planWebSearch(config, parsed, false, route.provider, route.modelId, openAiSidecar)
    : undefined;
  const imgPlan = !routedCompaction ? await planImageBridge(config, parsed, route.provider) : undefined;
  const canRunWebSearch = !!wsPlan && !adapter.runTurn;
  if (imgPlan && (!wsPlan || adapter.runTurn)) {
    // The bridge forces stream:true internally and returns SSE. Non-streaming requests can't be
    // served — reject explicitly rather than returning SSE to a client expecting JSON.
    if (!parsed.stream) {
      return formatErrorResponse(400, "invalid_request_error", "image bridge requires stream=true");
    }
    // Replace any pre-existing image_gen alias instead of appending a duplicate wire name.
    const priorTools = parsed.context.tools ?? [];
    parsed.context.tools = [
      ...priorTools.filter(t => {
        if (t.imageGeneration) return false;
        if (imgPlan.toolNames.has(t.name)) return false;
        if (t.namespace && imgPlan.toolNames.has(namespacedToolName(t.namespace, t.name))) return false;
        return true;
      }),
      buildImageTool(),
    ];
    // Hosted image_generation tool_choice / allowed_tools must target the synthetic function name.
    const tc = parsed.options.toolChoice;
    if (tc && typeof tc === "object" && "allowedTools" in tc && Array.isArray(tc.allowedTools)) {
      const mapped = tc.allowedTools.map(name =>
        name === "image_generation" || name === "image_gen" || imgPlan.toolNames.has(name)
          ? IMAGE_GEN_TOOL_NAME
          : name,
      );
      parsed.options.toolChoice = { ...tc, allowedTools: [...new Set(mapped)] };
    } else if (tc && typeof tc === "object" && "name" in tc && typeof tc.name === "string"
      && (tc.name === "image_generation" || imgPlan.toolNames.has(tc.name))) {
      parsed.options.toolChoice = { ...tc, name: IMAGE_GEN_TOOL_NAME };
    }
    const imgResponse = await runWithImageBridge({
      parsed, adapter,
      plan: imgPlan,
      forwardHeaders: selectedForwardHeaders,
      onAttemptSend: () => noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens),
      abortSignal: options.abortSignal,
      maxRounds: clampImageMaxRounds(config.images?.maxRounds),
      connectTimeoutMs: config.connectTimeoutMs ?? 200_000,
      stallTimeoutSec: config.stallTimeoutSec,
      fetchImpl: providerFetch(route.provider),
      onRequestBuilt: request => recordAdapterReasoning(logCtx, request),
      onUsage: usage => {
        // Cursor may assign _cursorConversationId inside the image loop's first runTurn;
        // backfill so Logs can filter/total that opening request (parity with the normal
        // runTurn branch).
        if (!logCtx.conversationId && parsed._cursorConversationId) {
          logCtx.conversationId = normalizeLogConversationId(parsed._cursorConversationId);
        }
        logCtx.usageFromBridge = true;
        if (usage) {
          logCtx.usage = usage;
          if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
        }
      },
      on429: retryAfter => {
        const rotated = rotateProviderTransportOn429(config, route.providerName, {
          retryAfter,
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: parsed.options.promptCacheKey,
        });
        if (!rotated) return null;
        route.provider = rotated;
        return resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider),
          config.cacheRetention,
        );
      },
      ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
      ...(options.forceEmptyResponseId ? { forceEmptyResponseId: true } : {}),
      onCompletedResponse: (response, providerState) =>
        rememberResponseState(
          parsed._rawBody,
          response,
          continuationStateForResponse(providerState),
          adapterNeedsForcedContinuation(adapter.name) ? { force: true } : undefined,
        ),
    });
    if (imgResponse.body) {
      const imgTurnAc = new AbortController();
      return new Response(trackStreamLifetime(imgResponse.body, imgTurnAc), {
        status: imgResponse.status,
        headers: imgResponse.headers,
      });
    }
    return imgResponse;
  }

  // Web-search sidecar: Codex enabled web_search but this is a routed (non-OpenAI) model that can't
  // run it server-side. Expose web_search as a function tool and run searches via the gpt-mini sidecar
  // through the ChatGPT passthrough, looping until the model answers. Otherwise take the normal path.
  // Placed BEFORE the runTurn early-return for non-runTurn adapters so dual-tool turns dispatch
  // through web-search instead of being swallowed. runTurn adapters never enter this branch.
  if (canRunWebSearch && wsPlan) {
    parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
    noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens);
    const wsResponse = await runWithWebSearch({
      parsed, adapter,
      backend: wsPlan.backend,
      forwardProvider: wsPlan.forwardSidecar?.provider,
      anthropicSidecar: wsPlan.anthropicSidecar,
      hostedTool: wsPlan.hostedTool,
      selectedForwardHeaders: wsPlan.forwardSidecar?.headers ?? selectedForwardHeaders,
      settings: wsPlan.settings,
      maxSearches: wsPlan.maxSearches,
      forceEmptyResponseId: true,
      abortSignal: options.abortSignal,
      ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
      onRequestBuilt: request => recordAdapterReasoning(logCtx, request),
      onUsage: usage => {
        logCtx.usageFromBridge = true;
        if (usage) {
          logCtx.usage = usage;
          if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
        }
      },
      recordSidecarOutcome: wsPlan.forwardSidecar?.recordOutcome,
      connectTimeoutMs: config.connectTimeoutMs ?? 200_000,
      routedModelStallTimeoutMs: wsPlan.routedModelStallTimeoutMs,
      stallTimeoutSec: wsPlan.stallTimeoutSec,
      on429: retryAfter => {
        const rotated = rotateProviderTransportOn429(config, route.providerName, {
          retryAfter,
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: parsed.options.promptCacheKey,
        });
        if (!rotated) return null;
        route.provider = rotated;
        return resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider),
          config.cacheRetention,
        );
      },
    });
    // Register the sidecar stream as an active turn so drainAndShutdown waits for (or aborts)
    // in-flight web-search turns instead of skipping them during graceful shutdown.
    if (wsResponse.body) {
      const wsTurnAc = new AbortController();
      return new Response(trackStreamLifetime(wsResponse.body, wsTurnAc), {
        status: wsResponse.status,
        headers: wsResponse.headers,
      });
    }
    return wsResponse;
  }

  if (adapter.runTurn) {
    const runTurnAbort = new AbortController();
    linkAbortSignal(runTurnAbort, options.abortSignal);
    const queue = createAdapterEventQueue({
      onBacklogExceeded: () => runTurnAbort.abort(),
    });
    const runTurn = async (): Promise<void> => {
      try {
        noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens);
        await adapter.runTurn?.(
          parsed,
          { headers: selectedForwardHeaders, abortSignal: runTurnAbort.signal },
          queue.push,
        );
      } catch (err) {
        queue.push({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Cursor assigns a stable conversation id inside runTurn on the first headerless
        // turn; backfill so Logs can filter/total that opening request (#330 / #522).
        if (!logCtx.conversationId && parsed._cursorConversationId) {
          logCtx.conversationId = normalizeLogConversationId(parsed._cursorConversationId);
        }
        queue.close();
      }
    };

    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    if (parsed.stream) {
      void runTurn();
      let eventSource: AsyncIterable<AdapterEvent> = queue.stream();
      if (options.comboAttempt) {
        const preflight = await preflightAdapterEvents(eventSource);
        if (preflight.error || preflight.empty) {
          runTurnAbort.abort();
          queue.close();
          const message = preflight.error?.message ?? "Adapter ended before producing a response";
          return formatErrorResponse(502, "upstream_error", redactSecretString(message));
        }
        eventSource = preflight.stream;
      }
      const sseStream = bridgeToResponsesSSE(
        eventSource, parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
        () => {
          runTurnAbort.abort();
          queue.close();
        }, 2_000,
        {
          ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
          stallTimeoutSec: config.stallTimeoutSec,
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
          ...(routedCompaction ? { compaction: true } : {}),
          onUsage: usage => {
            // Raw adapter usage, pre wire-normalization: the bridged SSE now always carries
            // zero-default detail objects, so provenance must come from here (cache_detail_missing).
            logCtx.usageFromBridge = true;
            if (usage) {
              logCtx.usage = usage;
              if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
            }
          },
          ...(routedCompaction ? {} : {
            onCompletedResponse: (response: Record<string, unknown>, providerState?: OcxProviderContinuationState) =>
              rememberResponseState(
                parsed._rawBody,
                response,
                continuationStateForResponse(providerState),
                adapterNeedsForcedContinuation(adapter.name) ? { force: true } : undefined,
              ),
          }),
        },
      );
      const bridgeTurnAc = new AbortController();
      const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc);
      return new Response(trackedSse, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
      });
    }

    await runTurn();
    const events = await queue.collect();
    if (options.comboAttempt) {
      const firstMeaningful = events.find(event => event.type !== "heartbeat");
      if (!firstMeaningful || firstMeaningful.type === "error") {
        const message = firstMeaningful?.type === "error"
          ? firstMeaningful.message
          : "Adapter ended before producing a response";
        return formatErrorResponse(502, "upstream_error", redactSecretString(message));
      }
    }
    let providerState: OcxProviderContinuationState | undefined;
    const json = buildResponseJSON(events, parsed.modelId, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      freeformToolNames,
      toolSearchToolNames,
      ...(routedCompaction ? { compaction: true } : {}),
      onProviderState: state => { providerState = state; },
      onUsage: usage => {
        logCtx.usageFromBridge = true;
        if (usage) {
          logCtx.usage = usage;
          if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
        }
      },
    });
    if (!routedCompaction) {
      rememberResponseState(
        parsed._rawBody,
        json,
        continuationStateForResponse(providerState),
        adapterNeedsForcedContinuation(adapter.name) ? { force: true } : undefined,
      );
    }
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  const upstream = new AbortController();
  const cleanupUpstreamAbort = linkAbortSignal(upstream, options.abortSignal);
  const connectMs = config.connectTimeoutMs ?? 200_000;
  let activeAdapter = adapter;

  const request = await activeAdapter.buildRequest(parsed, { headers: selectedForwardHeaders });
  recordAdapterReasoning(logCtx, request);
  const inputTokenEstimate = typeof request.usageLog?.inputTokens === "number"
    ? request.usageLog.inputTokens
    : undefined;
  if (inputTokenEstimate !== undefined) logCtx.usageLogInputTokens = inputTokenEstimate;
  let upstreamResponse: Response;
  try {
    if (activeAdapter.fetchResponse) {
      noteAttemptSend(logCtx.activeAttempt, inputTokenEstimate);
      upstreamResponse = await activeAdapter.fetchResponse(request, {
        abortSignal: upstream.signal,
        timeoutMs: connectMs,
        stream: parsed.stream,
      });
    } else {
      upstreamResponse = await fetchWithResetRetry(
        recovery => {
          noteAttemptSend(logCtx.activeAttempt, inputTokenEstimate, recovery);
          return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
            method: request.method,
            headers: request.headers,
            body: request.body,
          }, recovery), upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
        },
        { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
      );
    }
  } catch (err) {
    cleanupUpstreamAbort();
    upstream.abort();
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    const msg = err instanceof Error && err.name === "TimeoutError"
      ? `Provider connect timeout after ${connectMs}ms`
      : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return formatErrorResponse(502, "upstream_error", msg);
  }

  if (!upstreamResponse.ok) {
    // Recovery loop: multi-key 429 failover + at most ONE anthropic 413 tightened retry
    // (devlog/260714_image_normalization_pipeline/030). One mutable activeAdapter serves
    // both paths so a 429→413 sequence never rebuilds against a stale pre-rotation
    // adapter, and imageTierBias — once armed — rides EVERY subsequent rebuild so a
    // 413→429 rotation cannot silently undo the tightening.
    let imageTierBias = 0;
    let imageRetryAttempted = false;
    let oauth401ReplayAttempted = false;
    const rebuildAndRefetch = async (
      recovery: AttemptRecoveryKind,
    ): Promise<Response | { failed: Response }> => {
      const retryRequest = await activeAdapter.buildRequest(parsed, {
        headers: selectedForwardHeaders,
        ...(imageTierBias > 0 ? { imageTierBias } : {}),
      });
      recordAdapterReasoning(logCtx, retryRequest);
      const retryEstimate = typeof retryRequest.usageLog?.inputTokens === "number"
        ? retryRequest.usageLog.inputTokens
        : undefined;
      if (retryEstimate !== undefined) logCtx.usageLogInputTokens = retryEstimate;
      logCtx.providerAdapter = activeAdapter.name;
      sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, activeAdapter.name);
      noteAttemptSend(logCtx.activeAttempt, retryEstimate, recovery);
      try {
        return activeAdapter.fetchResponse
          ? await activeAdapter.fetchResponse(retryRequest, { abortSignal: upstream.signal, timeoutMs: connectMs, stream: parsed.stream })
          : await fetchWithHeaderTimeout(retryRequest.url, {
              method: retryRequest.method, headers: retryRequest.headers, body: retryRequest.body,
            }, upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
      } catch (err) {
        cleanupUpstreamAbort();
        upstream.abort();
        if (options.abortSignal?.aborted) {
          return { failed: clientCancelledResponse() };
        }
        const msg = err instanceof Error && err.name === "TimeoutError"
          ? `Provider connect timeout after ${connectMs}ms`
          : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}`;
        return { failed: formatErrorResponse(502, "upstream_error", msg) };
      }
    };
    recovery: for (;;) {
      if (
        upstreamResponse.status === 401
        && isOAuth401ReplayProvider
        && sentOAuthSnapshot
        && !oauth401ReplayAttempted
      ) {
        oauth401ReplayAttempted = true;
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        let refreshed: OAuthAccessSnapshot;
        try {
          refreshed = await forceRefreshOAuthAccessSnapshot(sentOAuthSnapshot);
        } catch (err) {
          cleanupUpstreamAbort();
          return formatErrorResponse(401, "authentication_error", err instanceof Error ? err.message : String(err));
        }
        sentOAuthSnapshot = refreshed;
        if (route.providerName === "kiro") {
          parsed._kiroAuthContext = { ...(refreshed.kiro ?? {}) };
        }
        const refreshedProvider = resolveProviderTransport(
          route.providerName,
          { ...route.provider, apiKey: refreshed.accessToken },
          parsed.options.promptCacheKey,
          route.providerName === "github-copilot" ? getOAuthCredentialApiBaseUrl(route.providerName) : undefined,
        );
        route.provider = refreshedProvider;
        activeAdapter = resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, refreshedProvider),
          config.cacheRetention,
        );
        const result = await rebuildAndRefetch("oauth-401");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
        continue recovery;
      }

      // Multi-key 429 failover: rotate to the next pool key (cooldown-aware) and retry the
      // SAME request once per remaining key. OAuth/forward providers and single-key pools
      // return null immediately, so this stays a no-op for them (src/providers/key-failover.ts).
      while (upstreamResponse.status === 429 && hasKeyPoolFailover(route.provider)) {
        const rotated = rotateProviderTransportOn429(config, route.providerName, {
          retryAfter: upstreamResponse.headers.get("retry-after"),
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: parsed.options.promptCacheKey,
        });
        if (!rotated) break;
        // Release the failed response's socket before retrying; unread bodies otherwise linger
        // until runtime cleanup (one per rotated key under a rate-limit storm).
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        route.provider = rotated;
        activeAdapter = resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider),
          config.cacheRetention,
        );
        const result = await rebuildAndRefetch("key-429");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
      }
      // Anthropic 413 request_too_large: rebuild once with every image one tier lower
      // (spiral guard: single attempt). The biased response re-enters the 429 check above.
      if (shouldAttemptImageTierRetry({
        status: upstreamResponse.status,
        adapterName: activeAdapter.name,
        parsed,
        alreadyAttempted: imageRetryAttempted,
      })) {
        imageRetryAttempted = true;
        imageTierBias = 1;
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        const result = await rebuildAndRefetch("image-413");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
        continue recovery;
      }
      break;
    }
    if (!upstreamResponse.ok) {
      if (options.comboAttempt) {
        const failure = await consumeComboFailure(upstreamResponse, options.abortSignal)
          .finally(cleanupUpstreamAbort);
        options.onConsumedComboFailure?.(failure);
        return failure.response;
      }
      const errorText = await upstreamResponse.text().catch(() => "unknown error");
      cleanupUpstreamAbort();
      recordSubagentQuotaFailureForThreadSpawn(
        req.headers,
        subagentQuotaFailureModel,
        upstreamResponse.status === 429 || upstreamResponse.status === 402
          ? upstreamResponse.status
          : `Provider error ${upstreamResponse.status}: ${redactSecretString(errorText.slice(0, 500))}`,
        config,
        subagentFallbackAccountId,
      );
      // Upstreams occasionally echo request details in error bodies — scrub token-shaped
      // material before it reaches the client-facing error surface.
      const message = `Provider error ${upstreamResponse.status}: ${redactSecretString(errorText.slice(0, 500))}`;
      const retryAfter = resolveClientRetryAfter({
        status: upstreamResponse.status,
        message,
        upstreamRetryAfter: upstreamResponse.headers.get("retry-after"),
      });
      return formatErrorResponse(upstreamResponse.status, "upstream_error", message, {
        ...(retryAfter !== undefined ? { retryAfter } : {}),
      });
    }
  }

  cancelBodyOnAbort(upstreamResponse.body, upstream.signal);

  // Claude can return a clean end_turn after announcing an edit without emitting any tool call.
  // Keep the normal request/recovery path above intact, and use this bounded callback only for the
  // one internal continuation pass. A continuation failure becomes an in-stream adapter error so
  // the client never sees a second hidden HTTP response or an unbounded retry loop.
  const terminalGuardEnabled = activeAdapter.name === "anthropic" && !options.comboAttempt && !routedCompaction;
  const fetchTerminalGuardContinuation = async function* (nextParsed: OcxParsedRequest): AsyncGenerator<AdapterEvent> {
    let imageTierBias = 0;
    let response: Response | undefined;
    while (true) {
      try {
        const continuationRequest = await activeAdapter.buildRequest(nextParsed, {
          headers: selectedForwardHeaders,
          ...(imageTierBias > 0 ? { imageTierBias } : {}),
        });
        recordAdapterReasoning(logCtx, continuationRequest);
        const continuationEstimate = typeof continuationRequest.usageLog?.inputTokens === "number"
          ? continuationRequest.usageLog.inputTokens
          : undefined;
        if (continuationEstimate !== undefined) logCtx.usageLogInputTokens = continuationEstimate;
        if (activeAdapter.fetchResponse) {
          noteAttemptSend(logCtx.activeAttempt, continuationEstimate);
          response = await activeAdapter.fetchResponse(continuationRequest, {
              abortSignal: upstream.signal,
              timeoutMs: connectMs,
              stream: nextParsed.stream,
            });
        } else {
          response = await fetchWithResetRetry(
              recovery => {
                noteAttemptSend(logCtx.activeAttempt, continuationEstimate, recovery);
                return fetchWithHeaderTimeout(
                  continuationRequest.url,
                  applyUpstreamRecoveryInit({
                    method: continuationRequest.method,
                    headers: continuationRequest.headers,
                    body: continuationRequest.body,
                  }, recovery),
                  upstream.signal,
                  connectMs,
                  nextParsed.stream,
                  providerFetch(route.provider),
                );
              },
              { abortSignal: upstream.signal, label: safeHostLabel(continuationRequest.url) },
            );
        }
      } catch (error) {
        if (options.abortSignal?.aborted) {
          yield { type: "error", message: "client closed request during terminal continuation", status: 499 };
        } else {
          yield { type: "error", message: `Provider continuation failed: ${error instanceof Error ? error.message : String(error)}` };
        }
        return;
      }

      if (response.status === 429 && hasKeyPoolFailover(route.provider)) {
        const rotated = rotateProviderTransportOn429(config, route.providerName, {
          retryAfter: response.headers.get("retry-after"),
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: nextParsed.options.promptCacheKey,
        });
        if (rotated) {
          try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
          route.provider = rotated;
          activeAdapter = resolveAdapter(
            resolveWireProtocolOverride(route.providerName, route.modelId, route.provider),
            config.cacheRetention,
          );
          continue;
        }
      }
      if (shouldAttemptImageTierRetry({
        status: response.status,
        adapterName: activeAdapter.name,
        parsed: nextParsed,
        alreadyAttempted: imageTierBias > 0,
      })) {
        imageTierBias = 1;
        try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
        continue;
      }
      break;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      yield {
        type: "error",
        status: response.status,
        message: `Provider continuation error ${response.status}: ${redactSecretString(errorText.slice(0, 500))}`,
      };
      return;
    }

    try {
      // Protect the continuation body against a client abort landing between fetch resolution and
      // reader attach, exactly as the initial response is guarded above (#390/366e3053). Without
      // this, a client cancel during the continuation reopens the Bun fetch-to-reader abort race.
      const detachContinuationBodyGuard = cancelBodyOnAbort(response.body, upstream.signal);
      try {
        if (nextParsed.stream) {
          yield* activeAdapter.parseStream(response);
        } else if (activeAdapter.parseResponse) {
          yield* await activeAdapter.parseResponse(response);
        } else {
          yield { type: "error", message: "Provider continuation does not support response parsing" };
        }
      } finally {
        detachContinuationBodyGuard();
      }
    } catch (error) {
      if (options.abortSignal?.aborted) {
        yield { type: "error", message: "client closed request during terminal continuation", status: 499 };
      } else {
        yield { type: "error", message: `Provider continuation parse failed: ${redactSecretString(error instanceof Error ? error.message : String(error))}` };
      }
    }
  };

  if (parsed.stream) {
    const initialEventStream = activeAdapter.parseStream(upstreamResponse);
    const eventStream = terminalGuardEnabled
      ? guardTerminalEventStream({
          parsed,
          firstEvents: initialEventStream,
          adapterName: activeAdapter.name,
          maxAutoContinuations: 1,
          continuation: fetchTerminalGuardContinuation,
        })
      : initialEventStream;
    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    const sseStream = bridgeToResponsesSSE(
      eventStream, parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
      () => upstream.abort(), 2_000,
      {
        ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
        stallTimeoutSec: config.stallTimeoutSec,
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
        ...(routedCompaction ? { compaction: true } : {}),
        onUsage: usage => {
          // Raw adapter usage, pre wire-normalization (see the runTurn branch above).
          logCtx.usageFromBridge = true;
          if (usage) {
            logCtx.usage = usage;
            if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
          }
        },
        // Compaction turns must NOT enter the continuation cache: _rawBody still holds the full
        // PRE-compaction history, and a later previous_response_id expansion would rehydrate the
        // giant stale chain Codex just replaced.
        ...(routedCompaction ? {} : {
          onCompletedResponse: (response: Record<string, unknown>, providerState?: OcxProviderContinuationState) =>
            rememberResponseState(
              parsed._rawBody,
              response,
              continuationStateForResponse(providerState),
              activeAdapter.name === "kiro" ? { force: true } : undefined,
            ),
        }),
      },
    );
    const bridgeTurnAc = new AbortController();
    const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc, cleanupUpstreamAbort);
    return new Response(trackedSse, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
    });
  }

  if (activeAdapter.parseResponse) {
    let events: AdapterEvent[];
    try {
      const initialEvents = await activeAdapter.parseResponse(upstreamResponse);
      if (terminalGuardEnabled) {
        events = [];
        for await (const event of guardTerminalEventStream({
          parsed,
          firstEvents: (async function* () { yield* initialEvents; })(),
          adapterName: activeAdapter.name,
          maxAutoContinuations: 1,
          continuation: fetchTerminalGuardContinuation,
        })) events.push(event);
      } else {
        events = initialEvents;
      }
    } finally {
      cleanupUpstreamAbort();
    }
    const { toolNsMap, freeformToolNames, toolSearchToolNames } = buildToolBridgeMaps(parsed);
    let providerState: OcxProviderContinuationState | undefined;
    const json = buildResponseJSON(events, parsed.modelId, {
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      freeformToolNames,
      toolSearchToolNames,
      ...(routedCompaction ? { compaction: true } : {}),
      onProviderState: state => { providerState = state; },
      onUsage: usage => {
        logCtx.usageFromBridge = true;
        if (usage) {
          logCtx.usage = usage;
          if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
        }
      },
    });
    // See the streaming branch: compaction turns skip the continuation cache.
    if (!routedCompaction) {
      rememberResponseState(
        parsed._rawBody,
        json,
        continuationStateForResponse(providerState),
        activeAdapter.name === "kiro" ? { force: true } : undefined,
      );
    }
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  return formatErrorResponse(400, "invalid_request_error", "Non-streaming not supported by this adapter");
}



export function linkAbortSignal(upstream: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    upstream.abort(signal.reason);
    return () => {};
  }
  const onAbort = () => upstream.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
