import type { Server } from "bun";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse, type ResponsesTerminalStatus } from "../../bridge";
import { formatPassthroughUpstreamError } from "./passthrough-error";
import { describeUpstreamConnectFailure } from "./upstream-error";
import {
  getConfigPath,
  multiAgentGuidanceEnabled,
  resolveEnvValue,
} from "../../config";
import { parseRequest } from "../../responses/parser";
import { buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary, extractCompactUserMessages } from "../../responses/compaction";
import { FORWARD_HEADERS, sanitizeReasoningInputContent } from "../../adapters/openai-responses";
import {
  expandPreviousResponseInput,
  previousResponseProviderState,
  previousResponseReplayFailure,
  rememberResponseState,
} from "../../responses/state";
import { comboRouteDecisionTrace, NoEligiblePolicyCandidateError, routeModel, type RouteResult } from "../../router";
import { evidenceFromBody } from "../../routing/request-evidence";
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
  getValidAccessTokenForAccount,
  getValidAccessTokenSnapshot,
  type OAuthAccessSnapshot,
  UnsupportedOAuthProviderError,
} from "../../oauth";
import {
  ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST,
  anthropicSessionKeyFromParts,
  bindAnthropicSessionAffinity,
  formatAnthropicProviderForLog,
  getAnthropicPoolAccessToken,
  getAnthropicPoolRetryAfterSeconds,
  isAnthropicAccountPoolEnabled,
  promoteAnthropicActiveAccount,
  resolveAnthropicAccountForSession,
  rotateAnthropicAccountOn429,
} from "../../oauth/anthropic-routing";
import { buildWebSearchTool, planWebSearch, runWithWebSearch, shouldResolveOpenAiWebSearchSidecar } from "../../web-search";
import { buildImageTool, buildVideoTool, planImageBridge, planVideoBridge, runWithImageBridge, clampImageMaxRounds, IMAGE_GEN_TOOL_NAME, VIDEO_GEN_TOOL_NAME } from "../../images";
import { describeImagesInPlace, planVisionSidecar, resolveOpenAiVisionModel, shouldResolveOpenAiVisionSidecar, stripImagesInPlace } from "../../vision";
import { createAdapterEventQueue, preflightAdapterEvents } from "../../adapters/run-turn-queue";
import {
  applyCodexAuthContextToProvider,
  CodexAccountCooldownError,
  codexMainProfileDrainingResponse,
  cooldownErrorResponse,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexMainProfileDrainingError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  codexProbeLeaseId,
  codexProbeQuotaScope,
  releaseCodexAuthContextProbeLease,
  stripCodexRuntimeProviderFields,
  type CodexAuthContext,
} from "../../codex/auth-context";
import {
  computeQuotaCooldown,
  formatCodexProviderForLog,
  previewCodexAccountForRequest,
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "../../codex/routing";
import {
  applyUpstreamRecoveryInit,
  fetchWithResetRetry,
  fetchWithTransientRetry,
  prepareSameTarget429Wait,
} from "../../lib/upstream-retry";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "../auth-cors";
import { createTranslatorBudget, isTranslatorBudgetExceededError, type TranslatorBudget } from "../../lib/translator-budget";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar, type ResolvedOpenAiForwardSidecar } from "../../providers/openai-sidecar";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { slugsEquivalent } from "../../providers/slug-codec";
import { applyOpenAiVirtualModel, resolveOpenAiCompactModel } from "../../providers/openai-virtual-models";
import { isUsageDebugEnabled } from "../../usage/debug";
import { readJsonRequestBody, DecompressedBodyTooLargeError, UnsupportedContentEncodingError } from "../request-decompress";
import { resolveAdapter, resolveWireProtocolOverride } from "../adapter-resolve";
import { providerModelResponsesUpstreamStreaming, type InboundWire } from "../../providers/registry";
import type { AdapterRequest } from "../../adapters/base";
import {
  hasKeyPoolFailover,
  rateLimitRetryDelayMs,
  rateLimitRetryPolicyFor,
  rotateProviderTransportOn429,
} from "../../providers/key-failover";
import { shouldAttemptImageTierRetry } from "../image-retry";
import { resolveProviderTransport } from "../../providers/xai-transport";
import type { WsData } from "../ws-bridge";
import { codexAccountSelectionForTurn, registerTurn, trackStreamLifetime, unregisterTurn } from "../lifecycle";
import { redactSecretString } from "../../lib/redact";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import type { AdmissionLease } from "../../lib/admission";
import { supportedLadderFor } from "../effort-policy";
import { isThreadSpawnRequest } from "../effort-policy";
import {
  applySubagentModelFallback,
  maybePrimeSubagentQuota,
  recordSubagentQuotaFailureForThreadSpawn,
} from "../../codex/subagent-model-fallback";
import { isNativeMainTrafficBlocked } from "../../codex/native-profile-startup";
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
  isEagerRelaySseResponse,
  isNativePassthroughSseResponse,
  markEagerRelaySseResponse,
  markNativePassthroughSseResponse,
  relaySseWithFailedTail,
  relayWithAbort,
  sanitizePassthroughHeaders,
} from "../relay";
import { relaySseEagerBounded } from "../relay-eager";
import { isWin32EagerRewrite, selectEagerPath } from "../../lib/bun-stream-caps";
import { cancelBodyOnAbort } from "../../lib/abort";
import {
  createResponsesItemIdPayloadRewrite,
  hasResponsesItemIdRepair,
  repairResponsesJsonItemIds,
} from "../responses-item-id-repair";
import {
  createImageGenCallRestoreRewrite,
  imageGenToolCallAliases,
  restoreImageGenCallsInJson,
} from "../responses-image-gen-repair";
import { composeSsePayloadRewrites, relaySseWithPayloadRewrite } from "../sse-payload-rewrite";
import type { EffectiveSubagentRoster, SpawnAgentSurface } from "../../codex/catalog";

import { buildToolBridgeMaps, collabSurface, injectDeveloperMessage, multiAgentGuidanceText } from "./collaboration";
import { hasUnreadableEncryptedAgentTask, looksLikeBackendCiphertext, sanitizeEncryptedContentInPlace } from "./encrypted-payload";
import { fetchWithHeaderTimeout, providerFetch, safeHostLabel, safeOriginLabel } from "./fetch-helpers";
import { classifyTransportFailureKind, transportErrorCode } from "../../lib/upstream-reachability";
import { recordUpstreamHostFailure, resetUpstreamHostHealth, upstreamHostHealthKey } from "../../codex/upstream-host-health";
import {
  createResponsesSnapshotBlockRewrite,
  hasResponsesSnapshotRepair,
  repairResponsesSnapshotJson,
} from "../responses-snapshot-repair";
import {
  composeSseBlockRewrites,
  payloadRewriteAsBlockRewrite,
  relaySseWithBlockRewrite,
} from "../sse-payload-rewrite";
import { responsesJsonToSseBody } from "../responses-json-events";
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
      fixedAccount: authCtx.fixedAccount,
      probeLeaseId: authCtx.probeLeaseId,
      probeQuotaScope: authCtx.probeQuotaScope,
      writerGeneration: authCtx.writerGeneration,
    })
    : undefined;
}



import { isShadowSourceModel, shouldInterceptShadowCall } from "../../lib/shadow-call";

export { DEFAULT_SHADOW_SOURCE_MODELS, isShadowSourceModel, shadowSourceModels } from "../../lib/shadow-call";



export function codexLogAccountId(authCtx: CodexAuthContext): string | null {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool" ? authCtx.accountId : null;
}

function isFixedCodexAccount(authCtx: CodexAuthContext): boolean {
  return (authCtx.kind === "pool" || authCtx.kind === "main-pool")
    && authCtx.fixedAccount === true;
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

/** Pre-stream quota/billing rejections that warrant one alternate-account attempt (#584). */
export function shouldRetryCodexPoolAccountQuota(response: Response): boolean {
  return response.status === 402 || response.status === 429;
}

interface CodexPoolAccountRetryArgs {
  req: Request;
  config: OcxConfig;
  route: { providerName: string; modelId: string; provider: OcxProviderConfig };
  parsed: OcxParsedRequest;
  logCtx: RequestLogContext;
  options: {
    abortSignal?: AbortSignal;
    onCodexAuthContextResolved?: (ctx: CodexAuthContext) => void;
    deferCodexResetDerivedCooldown?: boolean;
    // Narrowed subset of HandleResponsesOptions: the retry rebuilds the adapter, so it
    // needs the inbound scope or the retry could land on a different wire than the
    // first attempt.
    inboundWire?: InboundWire;
    translatorBudget: TranslatorBudget;
    turnAdmissionLease?: AdmissionLease;
  };
  firstAuthCtx: Extract<CodexAuthContext, { kind: "pool" | "main-pool" }>;
  firstResponse: Response;
  outcomeStatus: number;
  upstream: AbortController;
  connectMs: number;
  passthroughEstimate?: number;
  stream: boolean;
}

type CodexPoolAccountRetryResult =
  | {
    kind: "retried";
    authCtx: Extract<CodexAuthContext, { kind: "pool" | "main-pool" }>;
    request: Awaited<ReturnType<ReturnType<typeof resolveAdapter>["buildRequest"]>>;
    upstreamResponse: Response;
    selectedForwardHeaders: Headers;
  }
  | { kind: "no-alternate" }
  | {
    kind: "transport";
    error: unknown;
    authCtx: Extract<CodexAuthContext, { kind: "pool" | "main-pool" }>;
  };

function codexQuotaOutcomeMeta(response: Response): {
  retryAfter: string | null;
  resetAt: string[];
} {
  return {
    retryAfter: response.headers.get("retry-after"),
    resetAt: [
      response.headers.get("x-codex-primary-reset-at"),
      response.headers.get("x-codex-secondary-reset-at"),
      response.headers.get("x-codex-tertiary-reset-at"),
    ].filter((value): value is string => !!value),
  };
}

/**
 * A reset timestamp describes a quota window, not an explicit instruction to
 * stop using the whole account. A combo may therefore try a later model in the
 * same request, while Retry-After and headerless quota failures remain blocking.
 */
function shouldDeferCodexResetDerivedCooldown(response: Response, enabled?: boolean): boolean {
  return enabled === true
    && (response.status === 429 || response.status === 402)
    && computeQuotaCooldown(codexQuotaOutcomeMeta(response)).source === "reset-derived";
}

/**
 * One bounded alternate-account retry for Codex pool auth. Used for allow-listed
 * model-400 and for pre-stream 429/402 quota failures (#584).
 */
async function retryCodexPoolOnAlternateAccount(
  args: CodexPoolAccountRetryArgs,
): Promise<CodexPoolAccountRetryResult> {
  const {
    req, config, route, parsed, logCtx, options, firstAuthCtx, firstResponse,
    outcomeStatus, upstream, connectMs, passthroughEstimate, stream,
  } = args;
  // Defense in depth: exact account selectors must never reach alternate-account resolution,
  // even if a future caller forgets to guard this helper.
  if (firstAuthCtx.fixedAccount) return { kind: "no-alternate" };
  const inboundWire = options.inboundWire ?? "responses";
  let retryAuthCtx: CodexAuthContext | undefined;
  try {
    retryAuthCtx = await resolveCodexAuthContext(
      req.headers,
      config,
      "pool",
      {
        excludeAccountId: firstAuthCtx.accountId,
        modelId: route.modelId,
        beginCodexAccountSelection: codexAccountSelectionForTurn(options.turnAdmissionLease),
      },
    );
  } catch (error) {
    if (
      !(error instanceof CodexPoolAuthenticationError)
      && !(error instanceof CodexAuthContextError)
      && !(error instanceof CodexAccountCooldownError)
      && !(error instanceof CodexMainProfileDrainingError)
    ) throw error;
  }
  if (retryAuthCtx?.kind !== "pool" && retryAuthCtx?.kind !== "main-pool") {
    return { kind: "no-alternate" };
  }

  const quotaMeta = codexQuotaOutcomeMeta(firstResponse);
  if (outcomeStatus === 429 || outcomeStatus === 402) {
    const { applyAccountQuotaFromUpstreamHeaders } = await import("../../codex/auth-api");
    applyAccountQuotaFromUpstreamHeaders(
      firstAuthCtx.accountId,
      firstResponse.headers,
      firstAuthCtx.writerGeneration,
    );
  }
  if (!shouldDeferCodexResetDerivedCooldown(firstResponse, options.deferCodexResetDerivedCooldown)) {
    recordCodexUpstreamOutcome(config, firstAuthCtx.accountId, outcomeStatus, {
      ...quotaMeta,
      threadId: req.headers.get("x-codex-parent-thread-id"),
      modelId: route.modelId,
      probeLeaseId: codexProbeLeaseId(firstAuthCtx),
      probeQuotaScope: codexProbeQuotaScope(firstAuthCtx),
      writerGeneration: firstAuthCtx.writerGeneration,
      // Retry already advanced the RR ring via excludeAccountId — reuse for promotion.
      ...(retryAuthCtx.accountId ? { promoteAccountId: retryAuthCtx.accountId } : {}),
    });
  }

  const retryHeaders = headersForCodexAuthContext(req.headers, retryAuthCtx);
  const retryProvider = applyCodexAuthContextToProvider(
    stripCodexRuntimeProviderFields(route.provider),
    retryAuthCtx,
    "pool",
  );
  const retryAdapter = resolveAdapter(
    resolveWireProtocolOverride(route.providerName, route.modelId, retryProvider, inboundWire),
    config.cacheRetention,
  );
  const request = await retryAdapter.buildRequest(parsed, {
    headers: retryHeaders,
    translatorBudget: options.translatorBudget,
  });
  recordAdapterReasoning(logCtx, request);

  await firstResponse.body?.cancel().catch(() => undefined);
  options.onCodexAuthContextResolved?.(retryAuthCtx);
  route.provider = retryProvider;
  logCtx.provider = formatCodexProviderForLog(
    route.providerName,
    retryAuthCtx.accountId,
    config,
  );

  noteAttemptSend(logCtx.activeAttempt, passthroughEstimate);
  try {
    const upstreamResponse = await fetchWithHeaderTimeout(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        body: request.body,
      },
      upstream.signal,
      connectMs,
      stream,
      providerFetch(route.provider),
      // Credential-bearing forward send: never follow a redirect into a
      // dead-host rejection after the credential was seen (#914).
      route.provider.authMode === "forward",
    );
    // A real HTTP response proves the host was reached (#914).
    resetUpstreamHostHealth(upstreamHostHealthKey(route.providerName, safeOriginLabel(request.url)));
    return {
      kind: "retried",
      authCtx: retryAuthCtx,
      request,
      upstreamResponse,
      selectedForwardHeaders: retryHeaders,
    };
  } catch (error) {
    // Attribute the transport failure to the alternate account (already selected).
    return { kind: "transport", error, authCtx: retryAuthCtx };
  } finally {
    request.releaseBodyObservation?.();
  }
}



export function codexForwardTerminalOutcomeRecorder(
  config: OcxConfig,
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
  modelId?: string,
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
        fixedAccount: authCtx.fixedAccount,
        modelId,
        probeLeaseId: codexProbeLeaseId(authCtx),
        probeQuotaScope: codexProbeQuotaScope(authCtx),
        writerGeneration: authCtx.writerGeneration,
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
      fixedAccount: authCtx.fixedAccount,
      modelId,
      probeLeaseId: codexProbeLeaseId(authCtx),
      probeQuotaScope: codexProbeQuotaScope(authCtx),
      writerGeneration: authCtx.writerGeneration,
    });
  };
}



export function decodeRequestErrorResponse(err: unknown, label: string): Response {
  if (isTranslatorBudgetExceededError(err)) {
    return formatErrorResponse(413, "request_too_large", "request translation buffer exceeded the safe limit", {
      code: "translation_buffer_limit",
    });
  }
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
  turnAdmissionLease?: AdmissionLease;
  forceEmptyResponseId?: boolean;
  abortSignal?: AbortSignal;
  /** One-shot TTFT callback: first non-empty model output observed (WP4). */
  onFirstOutput?: () => void;
  onCodexAuthContextResolved?: (context: CodexAuthContext | undefined) => void;
  recordTerminalOutcomes?: boolean;
  setTerminalOutcomeRecorder?: (recorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined) => void;
  onNativePassthroughTerminal?: (status: ResponsesTerminalStatus) => void;
  onNativePassthroughCancel?: () => void;
  /**
   * When true, body `prompt_cache_key` is a Claude Desktop shared cache cohort
   * (system/tools hash), not a per-session id — do not use it for Anthropic pool affinity.
   */
  promptCacheKeyIsSharedCohort?: boolean;
  /**
   * Wire protocol the ORIGINAL client spoke. The Chat and Anthropic surfaces translate
   * their body into a Responses shape and replay through this function, so without an
   * explicit value the replay would look like a native Responses request and an
   * inbound-scoped registry wire default would fire for a client that never asked for
   * it. Omitted means a genuine Responses inbound.
   */
  inboundWire?: InboundWire;
  /** Internal transport identity for route-scoped upstream compatibility policy. */
  inboundTransport?: "websocket";
  /** Internal recursion guard; callers outside this module must not set it. */
  comboAttempt?: boolean;
  /** Internal combo handoff: allow a later same-provider model after a reset-derived 429/402. */
  deferCodexResetDerivedCooldown?: boolean;
  /** 030-owned handoff when a child consumed the original failure under bounds. */
  onConsumedComboFailure?: (failure: ConsumedComboFailure) => void;
  /** Caller-owned for Chat/Claude replay; omitted only at genuine Responses ingress. */
  translatorBudget?: TranslatorBudget;
}



/**
 * Build the 499 JSON error the proxy returns when the client disconnects before the
 * response completes (`client_cancelled`).
 */
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

// Whole-body policy for non-streaming upstream JSON responses (see the application/json
// branch of the passthrough return path). 32 MiB matches the continuation snapshot read
// bound and is far above any legitimate non-streaming completion, including base64 image
// payloads. The stall deadlines only govern the body transfer — generation time before
// the response headers is untouched. Generation after early/chunked headers but before
// the first body byte previously used the 30-second inactivity deadline; this call site
// gives it the full body deadline instead.
const MAX_UPSTREAM_JSON_BODY_BYTES = 32 * 1024 * 1024;
const UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS = 180_000;
const UPSTREAM_JSON_BODY_INACTIVITY_TIMEOUT_MS = 30_000;
export const UPSTREAM_JSON_BODY_READ_OPTIONS = {
  maxBytes: MAX_UPSTREAM_JSON_BODY_BYTES,
  totalTimeoutMs: UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS,
  inactivityTimeoutMs: UPSTREAM_JSON_BODY_INACTIVITY_TIMEOUT_MS,
  firstByteTimeoutMs: UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS,
};

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
      authCtx = await resolveCodexAuthContext(req.headers, config, route.codexAccountMode, {
        accountId: route.codexAccountId,
        modelId: route.modelId,
        beginCodexAccountSelection: codexAccountSelectionForTurn(options.turnAdmissionLease),
      });
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
      return { ok: false, response: cooldownErrorResponse(err, Date.now(), route.codexAccountNamespace) };
    }
    if (err instanceof CodexMainProfileDrainingError) {
      return { ok: false, response: codexMainProfileDrainingResponse() };
    }
    if (err instanceof CodexThreadAffinityExpiredError) {
      return {
        ok: false,
        response: formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session"),
      };
    }
    if (err instanceof CodexAuthContextError) {
      const safeAccountLabel = route.codexAccountNamespace
        ? `${route.providerName}-${route.codexAccountNamespace}`
        : formatCodexProviderForLog(route.providerName, err.accountId, config);
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
  inboundWire: InboundWire;
  inboundTransport?: "websocket";
}): Promise<void> {
  const { parsed, route, config, req, logCtx, inboundWire, inboundTransport } = args;

  // Apply the routed model id upstream: routing may strip a "<provider>/" namespace.
  if (route.modelId !== parsed.modelId) {
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as { model?: string }).model = route.modelId;
    }
    parsed.modelId = route.modelId;
  }
  // Transport-neutral reliability policy (#875): applies to any Responses
  // upstream whose final adapter is openai-responses, not only WS turns.
  const responsesUpstreamStreaming = providerModelResponsesUpstreamStreaming(
    route.providerName,
    route.provider,
    route.modelId,
  );

  // Settle the wire once so logging, fast-mode, auth, and sidecars read the adapter
  // this request will actually use (#404).
  route.provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire);
  logCtx.model = route.modelId;
  logCtx.provider = route.providerName;
  logCtx.providerAdapter = route.provider.adapter;
  logCtx.routeDecision = route.routeDecision;

  if (responsesUpstreamStreaming === false && route.provider.adapter === "openai-responses") {
    parsed.stream = false;
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as Record<string, unknown>).stream = false;
    }
  }

  // Final selected model before virtual wire-model rewriting (Pro aliases).
  const finalSelectedModelId = route.modelId;

  // Virtual model rewriting: Pro aliases → base model + reasoning.mode="pro".
  applyOpenAiVirtualModel(parsed, route, logCtx);

  // Fast mode override for OpenAI-routed models, only where the provider's Responses
  // route documents `service_tier` support (capability gate below strips everywhere else).
  if (config.fastMode !== undefined && route.provider.adapter === "openai-responses" && route.provider.supportsServiceTier === true) {
    const tier = config.fastMode ? "priority" : undefined;
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      if (tier) (parsed._rawBody as Record<string, unknown>).service_tier = tier;
      else delete (parsed._rawBody as Record<string, unknown>).service_tier;
    }
    parsed.options.serviceTier = tier;
  }
  applyServiceTierGate(route.provider, parsed._rawBody, parsed.options);

  {
    const guidance = await multiAgentGuidanceText(parsed, {
      multiAgentGuidanceEnabled: config.multiAgentGuidanceEnabled,
      codexAccountNamespace: route.codexAccountNamespace,
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
      routeDecision: logCtx.routeDecision,
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
  // One immutable combo selection trace, before any child dispatch; child
  // adoption below must never replace it with a concrete child route trace.
  logCtx.routeDecision = comboRouteDecisionTrace(config, comboId, pick, requestedModel);

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
      const currentTargetProvider = pick.target.provider;
      const deferCodexResetDerivedCooldown = combo.strategy === "failover"
        && combo.targets.slice(pick.targetIndex + 1).some(target =>
          target.provider === currentTargetProvider
          && payloadEligible(target)
          && !isComboTargetInCooldown(comboId, target),
        );
      response = await handleResponses(childRequest, config, childLog, {
        ...options,
        comboAttempt: true,
        deferCodexResetDerivedCooldown,
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
      noteComboSuccess(comboId, combo, pick.target, pick.writerGeneration);
      Object.assign(logCtx, childLog, {
        requestedModel,
        model: requestedModel,
        provider: "combo",
        comboId,
        routeDecision: logCtx.routeDecision,
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



function finalizeOwnedTranslatorBudget(response: Response, budget: TranslatorBudget): Response {
  if (!response.body) {
    budget.dispose();
    return response;
  }
  const reader = response.body.getReader();
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    budget.dispose();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finalize();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        finalize();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { finalize(); }
    },
  });
  const finalizedResponse = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  if (isNativePassthroughSseResponse(response)) {
    markNativePassthroughSseResponse(finalizedResponse);
  }
  if (isEagerRelaySseResponse(response)) {
    markEagerRelaySseResponse(finalizedResponse);
  }
  return finalizedResponse;
}

/**
 * Service-tier capability gate, applied after the final route/wire is settled. A
 * provider explicitly documented as NOT supporting `service_tier` must never
 * receive it: strip the field and clear the logging value even when the caller
 * supplied one (fail closed). Tri-state contract: `true` supports (injection
 * allowed, caller values preserved), `false` strips, and an UNCLASSIFIED custom
 * provider (`undefined`) preserves caller-supplied values but never gets an
 * injection — deleting the caller's field there would silently change their
 * request against a gateway we know nothing about.
 */
export function applyServiceTierGate(
  provider: OcxProviderConfig,
  rawBody: unknown,
  options: { serviceTier?: string },
): void {
  if (provider.adapter !== "openai-responses" || provider.supportsServiceTier !== false) return;
  if (rawBody && typeof rawBody === "object") {
    delete (rawBody as Record<string, unknown>).service_tier;
  }
  options.serviceTier = undefined;
}

/**
 * Route one `/v1/responses` request through the adapter pipeline: recovery loop, passthrough
 * wire, image/web-search bridges, and the terminal-guard continuation.
 */
export async function handleResponses(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions = {},
): Promise<Response> {
  const ownsBudget = options.translatorBudget === undefined;
  const translatorBudget = options.translatorBudget ?? createTranslatorBudget();
  try {
    const response = await handleResponsesInner(req, config, logCtx, { ...options, translatorBudget });
    return ownsBudget ? finalizeOwnedTranslatorBudget(response, translatorBudget) : response;
  } catch (error) {
    if (ownsBudget) translatorBudget.dispose();
    throw error;
  }
}

/**
 * Inner implementation of `handleResponses`; owns the pre-stream recovery loop and the
 * per-request same-target 429 retry budgets.
 */
async function handleResponsesInner(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: HandleResponsesOptions & { translatorBudget: TranslatorBudget },
): Promise<Response> {
  // The Chat and Anthropic surfaces replay through here with a Responses-shaped body,
  // so an omitted value means a genuine Responses inbound.
  const inboundWire = options.inboundWire ?? "responses";
  const translatorBudget = options.translatorBudget;
  let body: unknown;
  try {
    body = await readJsonRequestBody(req, translatorBudget);
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
  if (previousResponseReplayFailure(body)) {
    return formatErrorResponse(
      400,
      "previous_response_not_found",
      "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
    );
  }
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
  let toolBridgeMaps: ReturnType<typeof buildToolBridgeMaps>;
  try {
    parsed = parseRequest(body);
    toolBridgeMaps = buildToolBridgeMaps(parsed, translatorBudget);
    if (previousResponseInputExpanded) parsed._previousResponseInputExpanded = true;
    parsed._providerContinuation = previousResponseProviderState(parsed.previousResponseId);
    parsed._cursorConversationId = parsed._providerContinuation?.cursor?.conversationId;
    const clientThreadId = req.headers.get("x-codex-parent-thread-id")?.trim();
    if (clientThreadId) parsed._clientThreadId = clientThreadId;
  } catch (err) {
    if (isTranslatorBudgetExceededError(err)) {
      return formatErrorResponse(413, "request_too_large", "request translation buffer exceeded the safe limit", {
        code: "translation_buffer_limit",
      });
    }
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

  // Shadow call intercept: rewrite Codex 0.145.0+ helper calls (gpt-5.6-luna).
  // Ancient clients using gpt-5.4-mini remain configurable via sourceModels.
  const _sci = config.shadowCallIntercept;
  if (_sci?.enabled && _sci.model && shouldInterceptShadowCall(
    parsed.modelId,
    _sci.sourceModels,
    req.headers,
  )) {
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

  let route: RouteResult;
  try {
    route = routeModel(config, parsed.modelId, evidenceFromBody(parsed._rawBody));
    logCtx.routeDecision = route.routeDecision;
  } catch (err) {
    if (err instanceof NoAvailableComboTargetsError) {
      return comboUnavailableResponse(err.message);
    }
    if (err instanceof NoEligiblePolicyCandidateError) {
      // Persist the evaluation trace (per-candidate exclusions + the
      // no-eligible reason) so failed policy requests stay auditable.
      logCtx.routeDecision = err.trace;
    }
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }

  const hasUnexpandedPreviousResponse = !!parsed.previousResponseId
    && parsed._previousResponseInputExpanded !== true;
  // Exact account selectors are isolated from Pool-wide quota work. A canonical replay miss must
  // also fail closed without polling quota upstream. Cached fallback state can still select a
  // provider with native continuation support below.
  const threadSpawn = isThreadSpawnRequest(req.headers);
  const previewSelectionAdmission = threadSpawn && route.codexAccountId === undefined
    ? codexAccountSelectionForTurn(options.turnAdmissionLease)?.()
    : undefined;
  const nativeMainRecoveryBlocked = isNativeMainTrafficBlocked();
  const nativeMainReadsForbidden = nativeMainRecoveryBlocked
    || previewSelectionAdmission?.mainProfileDraining === true;
  const previewSelectionOptions = {
    nativeMainSelectionOnly: !nativeMainRecoveryBlocked
      && previewSelectionAdmission?.mainProfileDraining === true,
  };
  let authCtx: CodexAuthContext = { kind: "main", accountId: null };
  let selectedForwardHeaders = req.headers;
  let subagentFallbackAccountId = config.activeCodexAccountId ?? null;
  let subagentQuotaFailureModel = parsed.modelId;

  try {
    if (
      threadSpawn
      && route.codexAccountId === undefined
      && !(hasUnexpandedPreviousResponse && isCanonicalOpenAiForwardProvider(route.provider))
    ) {
      await maybePrimeSubagentQuota(config, Date.now(), { nativeMainReadsForbidden });
    }

  // Subagent fallback must settle the final model/provider BEFORE route-dependent
  // normalization (virtual models, effort caps, service tier, wire protocol).
  // Preview the preferred Codex account without acquiring a probe lease or refreshing
  // tokens — auth is resolved only after the final route is selected.
  if (threadSpawn && !options.comboAttempt && route.codexAccountId === undefined) {
    const threadId = req.headers.get("x-codex-parent-thread-id");
    const previewAccountId = previewCodexAccountForRequest(
      threadId,
      config,
      Date.now(),
      undefined,
      previewSelectionOptions,
    );
    subagentFallbackAccountId = previewAccountId ?? config.activeCodexAccountId ?? null;
    const fallback = applySubagentModelFallback(
      parsed,
      req.headers,
      config,
      previewAccountId,
      Date.now(),
      unreadableEncryptedAgentTask,
      previewSelectionOptions,
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
        route = routeModel(config, fallback.to, evidenceFromBody(parsed._rawBody));
        logCtx.routeDecision = route.routeDecision;
      } catch (err) {
        if (err instanceof NoAvailableComboTargetsError) {
          return comboUnavailableResponse(err.message);
        }
        if (err instanceof NoEligiblePolicyCandidateError) {
          logCtx.routeDecision = err.trace;
        }
        return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
      }
    }
  }
  } finally {
    previewSelectionAdmission?.release();
  }

  // Encrypted child tasks may only reach the canonical native backend. This check
  // runs against the FINAL route so native-only fallback can rescue a routed primary.
  if (!isCanonicalOpenAiForwardProvider(route.provider) && unreadableEncryptedAgentTask) {
    return unreadableEncryptedAgentTaskResponse();
  }

  // The canonical ChatGPT backend rejects previous_response_id, so a local replay miss leaves no
  // safe way to recover the omitted history. Fail before auth, adapter construction, or upstream
  // I/O instead of stripping the id and silently forwarding a context-free delta (#702).
  if (
    hasUnexpandedPreviousResponse
    && isCanonicalOpenAiForwardProvider(route.provider)
  ) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "OpenAI forward continuation state is unavailable or expired; start a new session instead of reusing this previous_response_id.",
    );
  }

  // Captured before normalization: whether the CLIENT asked for SSE. The
  // transport-neutral upstream-streaming policy below may force a bounded JSON
  // upstream for reliability (#875); the answer must then be reframed to SSE
  // for streaming clients.
  const clientRequestedStream = parsed.stream;
  await applyFinalRouteRequestNormalization({
    parsed,
    route,
    config,
    req,
    logCtx,
    inboundWire,
    inboundTransport: options.inboundTransport,
  });
  // Attribute local auth/cooldown failures to the public selector too; exact auth may fail before
  // the normal post-resolution provider label is assigned.
  if (route.codexAccountNamespace) {
    logCtx.provider = `${route.providerName}-${route.codexAccountNamespace}`;
  }

  {
    const finalAuth = await resolveResponsesCodexAuth(req, config, route, options);
    if (!finalAuth.ok) return finalAuth.response;
    authCtx = finalAuth.authCtx;
    selectedForwardHeaders = finalAuth.headers;
  }

  route.provider = applyCodexAuthContextToProvider(route.provider, authCtx, route.codexAccountMode);
  logCtx.provider = route.codexAccountNamespace
    ? `${route.providerName}-${route.codexAccountNamespace}`
    : formatCodexProviderForLog(route.providerName, codexLogAccountId(authCtx), config);
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
  let anthropicPoolAccountId: string | null = null;
  let anthropicPoolFailovers = 0;
  const anthropicSessionKey = route.providerName === "anthropic" && route.provider.authMode === "oauth"
    ? anthropicSessionKeyFromParts({
      sessionIdHeader: sessionIdHeaderFromRequest(req.headers),
      threadIdHeader: req.headers.get("thread-id"),
      promptCacheKey: typeof parsed.options.promptCacheKey === "string" ? parsed.options.promptCacheKey : null,
      clientThreadId: typeof parsed._clientThreadId === "string" ? parsed._clientThreadId : null,
      promptCacheKeyIsSharedCohort: options.promptCacheKeyIsSharedCohort === true,
    })
    : null;
  if (route.provider.authMode === "oauth") {
    try {
      if (route.providerName === "anthropic" && isAnthropicAccountPoolEnabled(config)) {
        const selection = resolveAnthropicAccountForSession(anthropicSessionKey, config);
        if (!selection.accountId) {
          if (selection.reason === "all-cooled") {
            const retryAfterSec = getAnthropicPoolRetryAfterSeconds();
            return formatErrorResponse(
              429,
              "rate_limit_error",
              "All Anthropic OAuth accounts are temporarily rate-limited",
              retryAfterSec !== null ? { retryAfter: String(retryAfterSec) } : undefined,
            );
          }
          return formatErrorResponse(401, "authentication_error", "No eligible Anthropic OAuth account available");
        }
        const accessToken = await getAnthropicPoolAccessToken(selection.accountId);
        anthropicPoolAccountId = selection.accountId;
        bindAnthropicSessionAffinity(anthropicSessionKey, selection.accountId);
        promoteAnthropicActiveAccount(selection.accountId);
        route.provider = { ...route.provider, apiKey: accessToken };
        logCtx.provider = formatAnthropicProviderForLog("anthropic", selection.accountId, config);
      } else {
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
  const adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire);
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
        {
          // Account-qualified native routes are passthrough, so their in-turn helper is vision.
          // Scope its cooldown and outcome to the helper model, not the routed text model.
          ...(route.codexAccountId !== undefined
            ? { exactAccount: { accountId: route.codexAccountId, modelId: resolveOpenAiVisionModel(config) } }
            : {}),
          beginCodexAccountSelection: codexAccountSelectionForTurn(options.turnAdmissionLease),
        },
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
        && !(err instanceof CodexMainProfileDrainingError)
      ) throw err;
    }
  }

  // Vision sidecar: the routed model can't see images (provider.noVisionModels). Describe each
  // attached image through the selected sidecar backend and replace it with text BEFORE the main
  // call, so the text-only model can reason about it.
  const visionPlan = planVisionSidecar(config, route.provider, route.modelId, parsed, openAiSidecar);
  const recordSidecarOutcome = openAiSidecar?.recordOutcome;
  if (visionPlan) {
    await describeImagesInPlace(
      parsed,
      visionPlan,
      openAiSidecar?.headers ?? selectedForwardHeaders,
      options.abortSignal,
      recordSidecarOutcome,
      translatorBudget,
    );
  } else if (modelInList(route.provider.noVisionModels, route.modelId)) {
    // Sidecar-covered model but NO plan (no forward provider / missing forwarded auth / sidecar
    // disabled): fail closed — never forward raw images to a text-only upstream.
    stripImagesInPlace(parsed, translatorBudget);
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
    const imageGenCallAliases = route.provider.authMode === "forward"
      ? new Map<string, { namespace: string; name: string }>()
      : imageGenToolCallAliases(toolBridgeMaps.toolNsMap, parsed._rawBody, translatorBudget);
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
    let request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders, translatorBudget });
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
      const outcome = classifyTransportFailureKind(err);
      // Host-level evidence stands regardless of pool membership: a direct
      // forward send has no pool accounting, but the reachability failure is
      // still host-wide, not account evidence (#914 review).
      if (outcome === "connect_neutral") {
        recordUpstreamHostFailure(
          upstreamHostHealthKey(route.providerName, safeOriginLabel(request.url)),
          { code: transportErrorCode(err) },
        );
      }
      if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
        recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, {
          threadId: req.headers.get("x-codex-parent-thread-id"),
          fixedAccount: authCtx.fixedAccount,
          modelId: route.modelId,
          probeLeaseId: codexProbeLeaseId(authCtx),
          probeQuotaScope: codexProbeQuotaScope(authCtx),
          writerGeneration: authCtx.writerGeneration,
        });
      }
      const msg = outcome === "timeout"
        ? `Provider connect timeout after ${connectMs}ms`
        : describeUpstreamConnectFailure(err, connectMs);
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
          }, recovery), upstream.signal, connectMs, parsed.stream, providerFetch(route.provider),
            route.provider.authMode === "forward")
            // Every real attempt response — including an intermediate 5xx the
            // retry wrapper replaces — proves the host was reached (#914 review).
            .then(res => {
              resetUpstreamHostHealth(upstreamHostHealthKey(route.providerName, safeOriginLabel(request.url)));
              return res;
            });
        },
        { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
      );
    } catch (err) {
      return transportFailureResponse(err);
    } finally {
      request.releaseBodyObservation?.();
    }

    // Same-target 429 wait-and-retry (opt-in `retryOn429`) for key-auth providers on the
    // passthrough wire. This branch returns before the recovery loop below, so Responses-shaped
    // key-auth gateways (e.g. the built-in DeepSeek preset) would otherwise surface 429
    // immediately with no same-key replay. Pre-stream only — nothing has been relayed yet, so
    // the replay is lossless (same invariant as the recovery loop). Forward/OAuth providers
    // keep their pool logic below (rateLimitRetryPolicyFor returns null for them).
    const rateLimitPolicy = rateLimitRetryPolicyFor(route.provider);
    let rateLimitRetries = 0;
    while (
      upstreamResponse.status === 429
      && rateLimitPolicy !== null
      && rateLimitRetries < rateLimitPolicy.attempts
    ) {
      rateLimitRetries += 1;
      // Release unread body + deliberate wait via the shared same-target helper.
      const retryAfterHeader = upstreamResponse.headers.get("retry-after");
      try {
        for await (const _ of prepareSameTarget429Wait({
          body: upstreamResponse.body,
          signal: options.abortSignal,
          delayMs: rateLimitRetryDelayMs(rateLimitPolicy, retryAfterHeader, Date.now()),
        })) {
          // pre-stream: no stall watchdog to feed
        }
      } catch {
        upstream.abort();
        return clientCancelledResponse();
      }
      // Client cancellation wins over any stale timer edge: re-check before dispatching the
      // replay so the wire never starts work for a request the client already abandoned.
      if (options.abortSignal?.aborted || upstream.signal.aborted) {
        upstream.abort();
        return clientCancelledResponse();
      }
      try {
        upstreamResponse = await fetchWithTransientRetry(
          recovery => {
            // The first send of every replay is itself a rate-limit retry; inner transient-5xx
            // recoveries keep their own label (recovery is provided for those).
            noteAttemptSend(logCtx.activeAttempt, passthroughEstimate, recovery ?? "rate-limit-429");
            return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
              method: request.method,
              headers: request.headers,
              body: request.body,
            }, recovery), upstream.signal, connectMs, parsed.stream, providerFetch(route.provider),
              route.provider.authMode === "forward")
              .then(res => {
                resetUpstreamHostHealth(upstreamHostHealthKey(route.providerName, safeOriginLabel(request.url)));
                return res;
              });
          },
          { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
        );
      } catch (err) {
        return transportFailureResponse(err);
      }
    }

    if (usesCodexForwardPoolAuth(authCtx, route.provider) && !authCtx.fixedAccount) {
      let poolRetryOutcome: number | undefined;
      if (await shouldRetryCodexPoolAccountModel400(
        upstreamResponse,
        route.modelId,
        options.abortSignal,
      )) {
        poolRetryOutcome = 400;
      } else if (shouldRetryCodexPoolAccountQuota(upstreamResponse)) {
        // Pre-stream only: once SSE has begun, mid-stream quota stays terminal.
        poolRetryOutcome = upstreamResponse.status;
      }

      if (poolRetryOutcome !== undefined) {
        const retry = await retryCodexPoolOnAlternateAccount({
          req,
          config,
          route,
          parsed,
          logCtx,
          options,
          firstAuthCtx: authCtx,
          firstResponse: upstreamResponse,
          outcomeStatus: poolRetryOutcome,
          upstream,
          connectMs,
          passthroughEstimate,
          stream: parsed.stream,
        });
        if (retry.kind === "transport") {
          authCtx = retry.authCtx;
          return transportFailureResponse(retry.error);
        }
        if (retry.kind === "retried") {
          authCtx = retry.authCtx;
          request = retry.request;
          upstreamResponse = retry.upstreamResponse;
          selectedForwardHeaders = retry.selectedForwardHeaders;
          // Keep subagent quota-failure health keyed to the account that actually served.
          subagentFallbackAccountId = retry.authCtx.accountId;
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
      route.modelId,
      logCtx,
      req.headers.get("x-codex-parent-thread-id"),
    );
    const terminalBodyWillRecord = !!terminalRecorder && upstreamResponse.ok && isEventStream;
    // Capture quota from upstream response for multi-account tracking
   if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
      // primary was the 5h window; it now carries weekly data for GPT plans.
      // Prefer primary when present, fall back to secondary for compatibility.
      const quotaMeta = codexQuotaOutcomeMeta(upstreamResponse);
      const { applyAccountQuotaFromUpstreamHeaders } = await import("../../codex/auth-api");
      applyAccountQuotaFromUpstreamHeaders(
        authCtx.accountId,
        upstreamResponse.headers,
        authCtx.writerGeneration,
      );
      if (terminalBodyWillRecord) {
        options.setTerminalOutcomeRecorder?.((status, httpStatusOverride) => {
          terminalRecorder(status, httpStatusOverride);
          if (status === "failed") {
            const quotaFailureMessage = httpStatusOverride === 429 || httpStatusOverride === 402
              || logCtx.terminalHttpStatus === 429
              || logCtx.terminalHttpStatus === 402
              ? (httpStatusOverride ?? logCtx.terminalHttpStatus)
              : undefined;
            if (!isFixedCodexAccount(authCtx) && quotaFailureMessage !== undefined) {
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
      } else if (!shouldDeferCodexResetDerivedCooldown(
        upstreamResponse,
        options.deferCodexResetDerivedCooldown,
      )) {
        recordCodexUpstreamOutcome(config, authCtx.accountId, upstreamResponse.status, {
          ...quotaMeta,
          threadId: req.headers.get("x-codex-parent-thread-id"),
          fixedAccount: authCtx.fixedAccount,
          modelId: route.modelId,
          probeLeaseId: codexProbeLeaseId(authCtx),
          probeQuotaScope: codexProbeQuotaScope(authCtx),
          writerGeneration: authCtx.writerGeneration,
        });
      }
    }

    // Non-2xx passthrough failures must never reach Codex as an empty body —
    // Codex renders that as the opaque "Unknown error" (#452). Combo attempts
    // keep their typed failure envelope. Non-empty bodies are relayed verbatim
    // (headers included) so pool-retry Activation B/D and client diagnostics stay intact.
    // Manual-redirect policy (#914): a 3xx is relayed as-is (Location preserved
    // through sanitizePassthroughHeaders) so a redirect to a dead host can never
    // masquerade as a pre-connection failure after the credential was seen.
    // The numeric outcome above already classified it neutral — no streak.
    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: sanitizePassthroughHeaders(upstreamResponse.headers),
      });
    }
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
    // #314 alternative shape: win32 no-rewrite traffic follows the runtime/config
    // gate; darwin no-rewrite traffic joins it only for explicit
    // `streamMode: "eager-relay"` opt-in. Darwin `auto` always stays tee. The
    // eager shape skips tee and uses one bounded reader with inline inspection
    // (src/server/relay-eager.ts; policy:
    // devlog/_fin/260731_macos_rss_retention/100_darwin_eager_optin.md).
    // The bundled known-bad runtime remains on tee by default on both platforms.
    if (isEventStream && upstreamResponse.body) {
      const repairConfig = route.provider.responsesItemIdRepair;
      const snapshotRepairEnabled = hasResponsesSnapshotRepair(route.provider.responsesSnapshotRepair);
      const needsClientRewrite = imageGenCallAliases.size > 0 || hasResponsesItemIdRepair(repairConfig) || snapshotRepairEnabled;
      // Compose opt-in payload rewrites into one parse/stringify pass (image-gen restore first).
      const payloadRewrites = [
        createImageGenCallRestoreRewrite(imageGenCallAliases),
        hasResponsesItemIdRepair(repairConfig)
          ? createResponsesItemIdPayloadRewrite(repairConfig!, translatorBudget)
          : undefined,
      ].filter((rewrite): rewrite is NonNullable<typeof rewrite> => rewrite !== undefined);
      // #893: sparse-snapshot gateways get field backfills AND lifecycle event
      // injection at the block level, after payload rewrites. Defaults come
      // from the finalized OUTBOUND body — the normalized internal tool shapes
      // are not the Responses wire shapes the snapshot must mirror.
      const snapshotDefaultsRequest = (() => {
        try {
          return JSON.parse(request.body) as unknown;
        } catch {
          return undefined;
        }
      })();
      const clientBlockRewrite = snapshotRepairEnabled
        ? composeSseBlockRewrites(
          payloadRewriteAsBlockRewrite(composeSsePayloadRewrites(...payloadRewrites)),
          createResponsesSnapshotBlockRewrite(snapshotDefaultsRequest, translatorBudget),
        )
        : undefined;
      // #864: win32 rewrite traffic must never enter the tee()+JS-pull chain
      // (Bun#32111 JS-sink segfault — text frames pass, the terminal block is
      // lost). The eager single reader applies the same rewrites inline.
      const win32EagerRewrite = isWin32EagerRewrite(process.platform, needsClientRewrite);
      const eagerPath = selectEagerPath(
        process.platform,
        needsClientRewrite,
        config.streamMode ?? "auto",
      );
      if (eagerPath?.useEagerRelay || win32EagerRewrite) {
        const turnAc = new AbortController();
        linkAbortSignal(upstream, turnAc.signal);
        registerTurn(turnAc, options.turnAdmissionLease);
        const reportNativeTerminal = recordTerminalOutcomes
          ? (status: ResponsesTerminalStatus, httpStatusOverride?: number) => {
            terminalRecorder?.(status, httpStatusOverride);
            if (status === "failed") {
              const quotaFailureMessage = httpStatusOverride === 429 || httpStatusOverride === 402
                || logCtx.terminalHttpStatus === 429
                || logCtx.terminalHttpStatus === 402
                ? (httpStatusOverride ?? logCtx.terminalHttpStatus)
                : undefined;
              if (!isFixedCodexAccount(authCtx) && quotaFailureMessage !== undefined) {
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
          disposeInspection: () => inspector.dispose(),
          // Stream lifetime follows the protocol terminal even when this request
          // has no outcome callback configured (reported() would stay false).
          sawTerminal: () => inspector.terminalSeen(),
          ...(win32EagerRewrite
            ? { rewritePayload: composeSsePayloadRewrites(...payloadRewrites) }
            : {}),
          ...(clientBlockRewrite
            ? { rewriteBlocks: clientBlockRewrite }
            : {}),
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
        }, win32EagerRewrite ? { rewriteBudget: translatorBudget } : undefined);
        // When selected, this relay closes response.completed even if upstream
        // keeps the connection alive. Windows rewrite traffic applies its
        // payload transform inline — never via the Bun#32111-unsafe
        // tee()+JS-pull chain (#864).
        if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
        return markEagerRelaySseResponse(
          markNativePassthroughSseResponse(new Response(eagerBody, {
            status: upstreamResponse.status,
            headers,
          })),
        );
      }
      const [nativeBody, inspectBody] = upstreamResponse.body.tee();
      const turnAc = new AbortController();
      const clientGone = new AbortController();
      linkAbortSignal(upstream, turnAc.signal);
      registerTurn(turnAc, options.turnAdmissionLease);
      const inspectionConsumerOptions = {
        clientGoneSignal: clientGone.signal,
        drainBounds: { ms: 15_000, bytes: 32 * 1024 * 1024 },
        upstream,
      };
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
            if (!isFixedCodexAccount(authCtx) && quotaFailureMessage !== undefined) {
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
          inspectionConsumerOptions,
        );
      } else {
        consumeForResponseLogMetadata(
          inspectBody,
          logCtx,
          turnAc.signal,
          () => unregisterTurn(turnAc),
          rememberPassthroughResponse,
          options.onFirstOutput,
          inspectionConsumerOptions,
        );
      }
      if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
      // Windows was handled by the eager terminal-aware branch above. Remaining
      // tee traffic can use the JS relay to close on a protocol terminal and to
      // convert a mid-stream reset into a clean response.failed event.
      const rewrittenBody = clientBlockRewrite !== undefined || payloadRewrites.length > 0
        ? relaySseWithBlockRewrite(nativeBody, clientBlockRewrite ?? payloadRewriteAsBlockRewrite(composeSsePayloadRewrites(...payloadRewrites)), translatorBudget)
        : nativeBody;
      const clientBody = relaySseWithFailedTail(rewrittenBody, upstream, reason => clientGone.abort(reason));
      return markNativePassthroughSseResponse(new Response(clientBody, {
        status: upstreamResponse.status,
        headers,
      }));
    }
    if (headers.get("content-type")?.toLowerCase().includes("application/json")) {
      // Bounded whole-body read: a non-streaming upstream JSON body is fully materialized
      // here (and again by the request-log finalizer and the WebSocket bridge's reframing),
      // so an unbounded .text() would let a hostile or stuck upstream grow proxy memory
      // without limit. This path is no longer rare — WebSocket turns for models whose
      // streaming terminal event is unreliable are deliberately answered with bounded JSON.
      // Oversize and stall deadlines both fail closed; a partial body is never parsed.
      const bounded = await readBoundedResponseBody(upstreamResponse, UPSTREAM_JSON_BODY_READ_OPTIONS);
      if (bounded.oversized) {
        return formatErrorResponse(502, "upstream_error", "upstream JSON response exceeded the safe body limit");
      }
      if (bounded.truncated) {
        return formatErrorResponse(502, "upstream_error", "upstream JSON response stalled before completing");
      }
      const text = bounded.text;
      inspectResponseLogJson(logCtx, text);
      if (rememberPassthroughResponse) {
        try {
          rememberPassthroughResponse(JSON.parse(text) as { id?: unknown; output?: unknown; status?: unknown });
        } catch { /* non-JSON despite content-type; recording is best-effort */ }
      }
      const clientJson = (() => {
        const restored = restoreImageGenCallsInJson(text, imageGenCallAliases);
        if (!hasResponsesSnapshotRepair(route.provider.responsesSnapshotRepair)) return restored;
        let outbound: unknown;
        try {
          outbound = JSON.parse(request.body);
        } catch {
          outbound = undefined;
        }
        return repairResponsesSnapshotJson(restored, outbound);
      })();
      // #875: the transport-neutral reliability policy forced a bounded JSON
      // upstream for a client that asked for SSE. Reframe the completed JSON
      // as the canonical terminal SSE sequence (created → output_item.done →
      // terminal → [DONE]) so Codex commits the turn instead of hanging on a
      // stream that never closes. Non-streaming clients keep the plain JSON.
      if (clientRequestedStream === true
        && options.inboundTransport !== "websocket"
        && providerModelResponsesUpstreamStreaming(route.providerName, route.provider, route.modelId) === false
        && route.provider.adapter === "openai-responses") {
        try {
          let completed = JSON.parse(clientJson) as Record<string, unknown>;
          // The bounded-JSON answer bypasses the SSE relay, so it also bypasses
          // the SSE item-id rewrite. Apply the same client-facing normalization
          // here or this policy would silently disable id repair for the very
          // providers that need it (raw record already happened above).
          if (hasResponsesItemIdRepair(route.provider.responsesItemIdRepair)) {
            completed = repairResponsesJsonItemIds(completed, route.provider.responsesItemIdRepair!, translatorBudget);
          }
          const sseHeaders = sanitizePassthroughHeaders(headers);
          sseHeaders.set("content-type", "text/event-stream");
          sseHeaders.set("cache-control", "no-store");
          return new Response(responsesJsonToSseBody(completed), {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: sseHeaders,
          });
        } catch {
          // Non-JSON despite content-type: fall through to the plain relay.
        }
      }
      // WS turns reframe this JSON into events in the bridge, which is the
      // other relay-free path — normalize ids so both bounded-JSON paths agree.
      const outboundJson = options.inboundTransport === "websocket"
        && providerModelResponsesUpstreamStreaming(route.providerName, route.provider, route.modelId) === false
        && hasResponsesItemIdRepair(route.provider.responsesItemIdRepair)
        ? (() => {
          try {
            return JSON.stringify(repairResponsesJsonItemIds(
              JSON.parse(clientJson) as Record<string, unknown>,
              route.provider.responsesItemIdRepair!,
              translatorBudget,
            ));
          } catch {
            return clientJson;
          }
        })()
        : clientJson;
      return new Response(outboundJson, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    }
    const body = relayWithAbort(upstreamResponse.body, upstream);
    const turnAc = new AbortController();
    const tracked = body ? trackStreamLifetime(body, turnAc, undefined, options.turnAdmissionLease) : null;
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
  const vidPlan = !routedCompaction ? await planVideoBridge(config, parsed, route.provider) : undefined;
  const canRunWebSearch = !!wsPlan && !adapter.runTurn;
  if ((imgPlan || vidPlan) && canRunWebSearch) {
    // Web search takes priority when both are active — the media bridge cannot run
    // alongside runWithWebSearch. Surface a runtime signal so the user knows their
    // configured video/image bridge was skipped for this turn, rather than silently
    // dropping a paid capability.
    if (vidPlan) console.warn("[videos] video bridge skipped: web search is active for this turn");
    if (imgPlan) console.warn("[images] image bridge skipped: web search is active for this turn");
  }
  if ((imgPlan || vidPlan) && (!wsPlan || adapter.runTurn)) {
    // The image bridge detects a hosted image_generation tool and requires streaming.
    // The video bridge activates from config and injects a tool — it also needs streaming
    // (the loop returns SSE). For video-only (no imgPlan) on a non-streaming request, skip
    // the bridge entirely so enabling the feature doesn't break ordinary non-streaming traffic.
    if (!parsed.stream) {
      if (imgPlan) {
        return formatErrorResponse(400, "invalid_request_error", "image bridge requires stream=true");
      }
      // Video-only: skip bridge for non-streaming requests
    } else {
    // Replace any pre-existing image_gen/video_gen aliases instead of appending duplicate wire names.
    const priorTools = parsed.context.tools ?? [];
    const bridgeTools = [...priorTools.filter(t => {
      if (t.imageGeneration) return false;
      if (t.videoGeneration) return false;
      if (imgPlan && imgPlan.toolNames.has(t.name)) return false;
      if (imgPlan && t.namespace && imgPlan.toolNames.has(namespacedToolName(t.namespace, t.name))) return false;
      // Only strip unnamespaced video_gen aliases — a namespaced MCP video_gen is left alone.
      if (vidPlan && !t.namespace && vidPlan.toolNames.has(t.name)) return false;
      return true;
    })];
    const existingNames = new Set(bridgeTools.map(t => t.name));
    if (imgPlan && !existingNames.has(IMAGE_GEN_TOOL_NAME)) bridgeTools.push(buildImageTool());
    if (vidPlan && !existingNames.has(VIDEO_GEN_TOOL_NAME)) bridgeTools.push(buildVideoTool());
    parsed.context.tools = bridgeTools;
    // Hosted image_generation tool_choice / allowed_tools must target the synthetic function name.
    // Gate on imgPlan — in a video-only turn buildImageTool() was never injected, so rewriting
    // image_generation/image_gen aliases would add an undeclared tool that strict upstreams reject.
    const tc = parsed.options.toolChoice;
    if (imgPlan && tc && typeof tc === "object" && "allowedTools" in tc && Array.isArray(tc.allowedTools)) {
      const mapped = tc.allowedTools.map(name =>
        name === "image_generation" || name === "image_gen" || (imgPlan.toolNames.has(name) ?? false)
          ? IMAGE_GEN_TOOL_NAME
          : name,
      );
      parsed.options.toolChoice = { ...tc, allowedTools: [...new Set(mapped)] };
    } else if (imgPlan && tc && typeof tc === "object" && "name" in tc && typeof tc.name === "string"
      && (tc.name === "image_generation" || imgPlan.toolNames.has(tc.name))) {
      parsed.options.toolChoice = { ...tc, name: IMAGE_GEN_TOOL_NAME };
    }
    const imgResponse = await runWithImageBridge({
      parsed, adapter,
      incomingMeta: { headers: selectedForwardHeaders, abortSignal: options.abortSignal, translatorBudget },
      ...(imgPlan ? { plan: imgPlan } : {}),
      ...(vidPlan ? { videoPlan: vidPlan } : {}),
      forwardHeaders: selectedForwardHeaders,
      onAttemptSend: (recovery?: AttemptRecoveryKind) =>
        noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens, recovery),
      abortSignal: options.abortSignal,
      maxRounds: imgPlan && vidPlan
        ? clampImageMaxRounds(Math.min(config.images?.maxRounds ?? 3, config.images?.videoMaxRounds ?? 2))
        : imgPlan
          ? clampImageMaxRounds(config.images?.maxRounds)
          : clampImageMaxRounds(config.images?.videoMaxRounds ?? 2),
      connectTimeoutMs: config.connectTimeoutMs ?? 200_000,
      stallTimeoutSec: config.stallTimeoutSec,
      fetchImpl: providerFetch(route.provider),
      onRequestBuilt: request => recordAdapterReasoning(logCtx, request),
      ...(vidPlan?.timeoutMs ? { videoTimeoutMs: vidPlan.timeoutMs } : {}),
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
        const rotated = rotateProviderTransportOn429(config, route.providerName, route.provider, {
          retryAfter,
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: parsed.options.promptCacheKey,
        });
        if (!rotated) return null;
        route.provider = rotated;
        return resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
          config.cacheRetention,
        );
      },
      retryOn429Policy: rateLimitRetryPolicyFor(route.provider),
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
      return new Response(trackStreamLifetime(imgResponse.body, imgTurnAc, undefined, options.turnAdmissionLease), {
        status: imgResponse.status,
        headers: imgResponse.headers,
      });
    }
    return imgResponse;
    } // end else (streaming bridge)
  }

  // Web-search sidecar: Codex enabled web_search but this is a routed (non-OpenAI) model that can't
  // run it server-side. Expose web_search as a function tool and run searches via the gpt-mini sidecar
  // through the ChatGPT passthrough, looping until the model answers. Otherwise take the normal path.
  // Placed BEFORE the runTurn early-return for non-runTurn adapters so dual-tool turns dispatch
  // through web-search instead of being swallowed. runTurn adapters never enter this branch.
  if (canRunWebSearch && wsPlan) {
    parsed.context.tools = [...(parsed.context.tools ?? []), buildWebSearchTool()];
    const wsResponse = await runWithWebSearch({
      parsed, adapter,
      incomingMeta: { headers: selectedForwardHeaders, abortSignal: options.abortSignal, translatorBudget },
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
      onAttemptSend: (recovery?: AttemptRecoveryKind) =>
        noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens, recovery),
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
        const rotated = rotateProviderTransportOn429(config, route.providerName, route.provider, {
          retryAfter,
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: parsed.options.promptCacheKey,
        });
        if (!rotated) return null;
        route.provider = rotated;
        return resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
          config.cacheRetention,
        );
      },
      retryOn429Policy: rateLimitRetryPolicyFor(route.provider),
    });
    // Register the sidecar stream as an active turn so drainAndShutdown waits for (or aborts)
    // in-flight web-search turns instead of skipping them during graceful shutdown.
    if (wsResponse.body) {
      const wsTurnAc = new AbortController();
      return new Response(trackStreamLifetime(wsResponse.body, wsTurnAc, undefined, options.turnAdmissionLease), {
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
          { headers: selectedForwardHeaders, abortSignal: runTurnAbort.signal, translatorBudget },
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

    const { toolNsMap, freeformToolNames, toolSearchToolNames } = toolBridgeMaps;
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
          translatorBudget,
          replayCacheScope: parsed._clientThreadId ?? "global",
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
      const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc, undefined, options.turnAdmissionLease);
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
      translatorBudget,
      replayCacheScope: parsed._clientThreadId ?? "global",
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
  // Bridge stall budget (seconds of silence before upstream_stall_timeout); the retry backoff
  // heartbeat interval is derived from it so the watchdog is always fed during deliberate waits.
  const stallTimeoutMs = typeof config.stallTimeoutSec === "number" && Number.isFinite(config.stallTimeoutSec) && config.stallTimeoutSec > 0
    ? Math.floor(config.stallTimeoutSec * 1000)
    : 300_000;
  let activeAdapter = adapter;

  // One immutable, body-safe outbound request per same-target sequence (URL, serialized body,
  // auth headers, generated compat headers). Same-target 429 replays reuse it verbatim; the
  // builder runs again only after a key/account/adapter rotation, an oauth refresh, or an
  // image-tier bias change (transportToken bump). `body` is always a serialized string, so
  // reuse is safe, and releaseBodyObservation is idempotent per build.
  let initialRequest: AdapterRequest | undefined;
  let inputTokenEstimate: number | undefined;
  try {
    initialRequest = await activeAdapter.buildRequest(parsed, { headers: selectedForwardHeaders, translatorBudget });
    recordAdapterReasoning(logCtx, initialRequest);
    inputTokenEstimate = typeof initialRequest.usageLog?.inputTokens === "number"
      ? initialRequest.usageLog.inputTokens
      : undefined;
    if (inputTokenEstimate !== undefined) logCtx.usageLogInputTokens = inputTokenEstimate;
  } catch (err) {
    // A throwing buildRequest never returned a request; if a post-build step threw, release
    // the serialized-body observation (idempotent) so the translator budget is not leaked.
    // The build runs after linkAbortSignal, so a failure must also tear the link down and
    // abort the upstream controller instead of escaping handleResponses unmapped.
    initialRequest?.releaseBodyObservation?.();
    cleanupUpstreamAbort();
    upstream.abort();
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    const msg = err instanceof Error ? err.message : String(err);
    return formatErrorResponse(400, "invalid_request_error", redactSecretString(msg));
  }
  // The catch path above always returns, so the request is definitely assigned here.
  // Capture it in a const so the fetch callbacks read a narrowed, immutable value
  // (TypeScript drops narrowing for a `let` captured by a nested function).
  const builtInitialRequest = initialRequest;
  let sameTargetRequest: AdapterRequest | undefined = builtInitialRequest;
  let sameTargetParsed: OcxParsedRequest | undefined = parsed;
  let sameTargetToken = 0;
  let transportToken = 0;
  /**
   * Invalidate the same-target request cache. Every credential/adapter/parsed mutation MUST
   * go through here: the cache keys on `parsed` REFERENCE identity, so an in-place mutation
   * is invisible to it and a missed bump would replay a request built with a stale key.
   */
  const invalidateSameTargetRequest = (): void => { transportToken += 1; };
  let upstreamResponse: Response;
  try {
    if (activeAdapter.fetchResponse) {
      noteAttemptSend(logCtx.activeAttempt, inputTokenEstimate);
      upstreamResponse = await activeAdapter.fetchResponse(builtInitialRequest, {
        abortSignal: upstream.signal,
        timeoutMs: connectMs,
        stream: parsed.stream,
      });
    } else {
      upstreamResponse = await fetchWithResetRetry(
        recovery => {
          noteAttemptSend(logCtx.activeAttempt, inputTokenEstimate, recovery);
          return fetchWithHeaderTimeout(builtInitialRequest.url, applyUpstreamRecoveryInit({
            method: builtInitialRequest.method,
            headers: builtInitialRequest.headers,
            body: builtInitialRequest.body,
          }, recovery), upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
        },
        { abortSignal: upstream.signal, label: safeHostLabel(builtInitialRequest.url) },
      );
    }
  } catch (err) {
    cleanupUpstreamAbort();
    upstream.abort();
    if (options.abortSignal?.aborted) return clientCancelledResponse();
    const msg = describeUpstreamConnectFailure(err, connectMs);
    return formatErrorResponse(502, "upstream_error", msg);
  } finally {
    builtInitialRequest.releaseBodyObservation?.();
  }

  // Same-target 429 retry budget is per REQUEST: it lives OUTSIDE the recovery loop (so a 413/401
  // replay that comes back 429 cannot silently re-arm a fresh budget) and is SHARED with the
  // terminal-guard continuation below, so the main loop + one continuation can never exceed
  // `attempts` same-key replays in total (bounded per request).
  const rateLimitPolicy = rateLimitRetryPolicyFor(route.provider);
  let rateLimitRetries = 0;
  // Shared with the terminal-guard continuation below: an image-tier reduction that let the
  // main request clear a 413 must not be forgotten on the very next continuation build.
  let imageTierBias = 0;
  if (!upstreamResponse.ok) {
    // Recovery loop: multi-key 429 failover + at most ONE anthropic 413 tightened retry
    // (devlog/260714_image_normalization_pipeline/030). One mutable activeAdapter serves
    // both paths so a 429→413 sequence never rebuilds against a stale pre-rotation
    // adapter, and imageTierBias — once armed — rides EVERY subsequent rebuild so a
    // 413→429 rotation cannot silently undo the tightening.
    let imageRetryAttempted = false;
    let oauth401ReplayAttempted = false;
    /**
     * Rebuild the request from the current parsed input (and any image-tier bias) and refetch
     * it once, tagging the attempt with the given recovery kind. Rebuilds are deterministic
     * for the same parsed request, so same-target replays stay byte-identical.
     */
    const rebuildAndRefetch = async (
      recovery: AttemptRecoveryKind,
    ): Promise<Response | { failed: Response }> => {
      let retryRequest: AdapterRequest;
      if (sameTargetRequest !== undefined && sameTargetParsed === parsed && sameTargetToken === transportToken) {
        // Same target (key/adapter/parsed/tier unchanged): replay the exact cached request.
        retryRequest = sameTargetRequest;
      } else {
        try {
          retryRequest = await activeAdapter.buildRequest(parsed, {
            headers: selectedForwardHeaders,
            translatorBudget,
            ...(imageTierBias > 0 ? { imageTierBias } : {}),
          });
          recordAdapterReasoning(logCtx, retryRequest);
        } catch (err) {
          // A rotated/rebuilt adapter build failure is a request-shaping error, not an
          // upstream connect failure: tear the abort link down and map it as 400 (no 413
          // translator-budget mapping here — that stays with parseRequest/buildToolBridgeMaps).
          cleanupUpstreamAbort();
          upstream.abort();
          if (options.abortSignal?.aborted) return { failed: clientCancelledResponse() };
          const msg = err instanceof Error ? err.message : String(err);
          return { failed: formatErrorResponse(400, "invalid_request_error", redactSecretString(msg)) };
        }
        sameTargetRequest = retryRequest;
        sameTargetParsed = parsed;
        sameTargetToken = transportToken;
      }
      const retryEstimate = typeof retryRequest.usageLog?.inputTokens === "number"
        ? retryRequest.usageLog.inputTokens
        : undefined;
      if (retryEstimate !== undefined) logCtx.usageLogInputTokens = retryEstimate;
      logCtx.providerAdapter = activeAdapter.name;
      sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, activeAdapter.name);
      noteAttemptSend(logCtx.activeAttempt, retryEstimate, recovery);
      try {
        try {
          return activeAdapter.fetchResponse
            ? await activeAdapter.fetchResponse(retryRequest, { abortSignal: upstream.signal, timeoutMs: connectMs, stream: parsed.stream })
            : await fetchWithHeaderTimeout(retryRequest.url, {
              method: retryRequest.method, headers: retryRequest.headers, body: retryRequest.body,
            }, upstream.signal, connectMs, parsed.stream, providerFetch(route.provider));
        } finally {
          retryRequest.releaseBodyObservation?.();
        }
      } catch (err) {
        cleanupUpstreamAbort();
        upstream.abort();
        if (options.abortSignal?.aborted) {
          return { failed: clientCancelledResponse() };
        }
        const msg = describeUpstreamConnectFailure(err, connectMs);
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
        invalidateSameTargetRequest();
        activeAdapter = resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, refreshedProvider, inboundWire),
          config.cacheRetention,
        );
        const result = await rebuildAndRefetch("oauth-401");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
        continue recovery;
      }

      // Same-target 429 wait-and-retry (opt-in `retryOn429`, issue #487). Codex never retries
      // 429 itself (it retries 5xx only), and single-key pools cannot use the failover below,
      // so wait (Retry-After or the fixed interval) and replay the IDENTICAL request on the
      // same key first. Pre-stream only: a 429 arrives before any bytes are relayed, so the
      // replay is lossless. Runs before key failover so "primary-first" setups keep the same
      // key on rate-limit blips; only after the attempts are exhausted does failover run.
      while (
        upstreamResponse.status === 429
        && rateLimitPolicy !== null
        && rateLimitRetries < rateLimitPolicy.attempts
      ) {
        rateLimitRetries += 1;
        // Release unread body + deliberate wait via the shared same-target helper.
        const retryAfterHeader = upstreamResponse.headers.get("retry-after");
        try {
          for await (const _ of prepareSameTarget429Wait({
            body: upstreamResponse.body,
            signal: options.abortSignal,
            delayMs: rateLimitRetryDelayMs(rateLimitPolicy, retryAfterHeader, Date.now()),
          })) {
            // pre-stream: no stall watchdog to feed
          }
        } catch {
          cleanupUpstreamAbort();
          upstream.abort();
          return clientCancelledResponse();
        }
        // Client cancellation wins over any stale timer edge: re-check before dispatching the
        // replay so an adapter never starts work for a request the client already abandoned.
        if (options.abortSignal?.aborted || upstream.signal.aborted) {
          cleanupUpstreamAbort();
          upstream.abort();
          return clientCancelledResponse();
        }
        const result = await rebuildAndRefetch("rate-limit-429");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
      }

      // Multi-key 429 failover: rotate to the next pool key (cooldown-aware) and retry the
      // SAME request once per remaining key. OAuth/forward providers and single-key pools
      // return null immediately, so this stays a no-op for them (src/providers/key-failover.ts).
      while (upstreamResponse.status === 429 && hasKeyPoolFailover(route.provider)) {
        const rotated = rotateProviderTransportOn429(config, route.providerName, route.provider, {
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
        invalidateSameTargetRequest();
        activeAdapter = resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
          config.cacheRetention,
        );
        const result = await rebuildAndRefetch("key-429");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
      }

      // Opt-in Anthropic OAuth account pool (#294): cool the failed account and retry
      // with another eligible OAuth account (bounded per request). Disabled by default.
      while (
        upstreamResponse.status === 429
        && anthropicPoolAccountId
        && isAnthropicAccountPoolEnabled(config)
        && anthropicPoolFailovers < ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST
      ) {
        const nextAccountId = rotateAnthropicAccountOn429(
          config,
          anthropicPoolAccountId,
          upstreamResponse.headers.get("retry-after"),
          anthropicSessionKey,
        );
        if (!nextAccountId) break;
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        try {
          const accessToken = await getAnthropicPoolAccessToken(nextAccountId);
          anthropicPoolAccountId = nextAccountId;
          anthropicPoolFailovers += 1;
          route.provider = { ...route.provider, apiKey: accessToken };
          invalidateSameTargetRequest();
          promoteAnthropicActiveAccount(nextAccountId);
          logCtx.provider = formatAnthropicProviderForLog("anthropic", nextAccountId, config);
          activeAdapter = resolveAdapter(
            resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
            config.cacheRetention,
          );
          sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, activeAdapter.name);
          const result = await rebuildAndRefetch("anthropic-oauth-429");
          if ("failed" in result) return result.failed;
          upstreamResponse = result;
        } catch {
          break;
        }
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
        invalidateSameTargetRequest();
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
      if (!isFixedCodexAccount(authCtx)) {
        recordSubagentQuotaFailureForThreadSpawn(
          req.headers,
          subagentQuotaFailureModel,
          upstreamResponse.status === 429 || upstreamResponse.status === 402
            ? upstreamResponse.status
            : `Provider error ${upstreamResponse.status}: ${redactSecretString(errorText.slice(0, 500))}`,
          config,
          subagentFallbackAccountId,
        );
      }
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

  // Anthropic-only: one bounded internal continuation re-ask for clean end_turn turns that
  // announced an edit without emitting a tool call.
  const terminalGuardEnabled = activeAdapter.name === "anthropic" && !options.comboAttempt && !routedCompaction;
  /**
   * One bounded internal re-ask for Anthropic end_turn-without-tool-call turns. Replays the
   * continuation on a 429 with the same-key retry budget (hoisted per request), then falls
   * back to key/account failover; a failure becomes an in-stream adapter error so the client
   * never sees a second hidden HTTP response or an unbounded retry loop.
   */
  const fetchTerminalGuardContinuation = async function* (nextParsed: OcxParsedRequest): AsyncGenerator<AdapterEvent> {
    let response: Response | undefined;
    // One-shot recovery label for the next top-of-loop continuation send after a failover rotation.
    let nextContinuationRecoveryKind: AttemptRecoveryKind | undefined;
    /**
     * Build and fetch one terminal-guard continuation. `recoveryKind` tags same-target and
     * failover sends (`rate-limit-429`, `key-429`, `anthropic-oauth-429`, `image-413`); the
     * adapter rebuild is deterministic for the same parsed request (tests assert byte-identical
     * replays).
     */
    const fetchContinuation = async (recoveryKind?: AttemptRecoveryKind): Promise<Response> => {
      let continuationRequest: AdapterRequest | undefined;
      if (sameTargetRequest !== undefined && sameTargetParsed === nextParsed && sameTargetToken === transportToken) {
        // Same target (key/adapter/parsed/tier unchanged): replay the exact cached request.
        continuationRequest = sameTargetRequest;
      } else {
        try {
          continuationRequest = await activeAdapter.buildRequest(nextParsed, {
            headers: selectedForwardHeaders,
            translatorBudget,
            ...(imageTierBias > 0 ? { imageTierBias } : {}),
          });
          recordAdapterReasoning(logCtx, continuationRequest);
        } catch (err) {
          // The main body is already streaming, so there is no HTTP error surface: release
          // any partial body observation and surface the failure as an in-stream error via
          // the outer catch (no upstream.abort() — that would kill the live body stream).
          continuationRequest?.releaseBodyObservation?.();
          throw err;
        }
        sameTargetRequest = continuationRequest;
        sameTargetParsed = nextParsed;
        sameTargetToken = transportToken;
      }
      // Both branches assign the request (the build catch rethrows), so capture it in a
      // const for the fetch callback and finally below — a `let` read inside a nested
      // function keeps its undefined half, which would break the byte-identical replay.
      const builtContinuationRequest = continuationRequest;
      const continuationEstimate = typeof builtContinuationRequest.usageLog?.inputTokens === "number"
        ? builtContinuationRequest.usageLog.inputTokens
        : undefined;
      if (continuationEstimate !== undefined) logCtx.usageLogInputTokens = continuationEstimate;
      // Optional recovery label for same-target / failover continuation sends.
      const replayKind: AttemptRecoveryKind | undefined = recoveryKind;
      try {
        if (activeAdapter.fetchResponse) {
          noteAttemptSend(logCtx.activeAttempt, continuationEstimate, replayKind);
          return await activeAdapter.fetchResponse(builtContinuationRequest, {
            abortSignal: upstream.signal,
            timeoutMs: connectMs,
            stream: nextParsed.stream,
          });
        }
        return await fetchWithResetRetry(
          recovery => {
            noteAttemptSend(logCtx.activeAttempt, continuationEstimate, recovery ?? replayKind);
            return fetchWithHeaderTimeout(
              builtContinuationRequest.url,
              applyUpstreamRecoveryInit({
                method: builtContinuationRequest.method,
                headers: builtContinuationRequest.headers,
                body: builtContinuationRequest.body,
              }, recovery),
              upstream.signal,
              connectMs,
              nextParsed.stream,
              providerFetch(route.provider),
            );
          },
          { abortSignal: upstream.signal, label: safeHostLabel(builtContinuationRequest.url) },
          );
      } finally {
        builtContinuationRequest.releaseBodyObservation?.();
      }
    };
    while (true) {
      try {
        const recoveryKind = nextContinuationRecoveryKind;
        nextContinuationRecoveryKind = undefined;
        response = await fetchContinuation(recoveryKind);
      } catch (error) {
        if (options.abortSignal?.aborted || upstream.signal.aborted) {
          yield { type: "error", message: "client closed request during terminal continuation", status: 499 };
        } else {
          yield { type: "error", message: `Provider continuation failed: ${redactSecretString(error instanceof Error ? error.message : String(error))}` };
        }
        return;
      }

      // Same-target 429 wait-and-retry (opt-in `retryOn429`) before key/account failover:
      // a primary-key rate-limit blip replays on the SAME key, matching the main recovery
      // loop; only after the attempts are exhausted does the continuation fail over.
      while (
        response.status === 429
        && rateLimitPolicy !== null
        && rateLimitRetries < rateLimitPolicy.attempts
      ) {
        rateLimitRetries += 1;
        // Release unread body + heartbeat-fed wait via the shared same-target helper.
        const retryAfterHeader = response.headers.get("retry-after");
        try {
          yield* prepareSameTarget429Wait({
            body: response.body,
            // Listen on the upstream signal: once the SSE body is being streamed, a client
            // cancel aborts `upstream` through the bridge, and upstream is also linked from
            // options.abortSignal — so this covers both cancellation paths.
            signal: upstream.signal,
            delayMs: rateLimitRetryDelayMs(rateLimitPolicy, retryAfterHeader, Date.now()),
            heartbeatIntervalMs: Math.min(10_000, Math.max(250, stallTimeoutMs / 2)),
          });
        } catch {
          if (options.abortSignal?.aborted || upstream.signal.aborted) {
            yield { type: "error", message: "client closed request during terminal continuation", status: 499 };
          } else {
            yield { type: "error", message: "Provider continuation failed: retry wait interrupted" };
          }
          return;
        }
        // Client cancellation wins over any stale timer edge: re-check before dispatching the
        // replay so the continuation never starts work for a request the client abandoned.
        if (options.abortSignal?.aborted || upstream.signal.aborted) {
          yield { type: "error", message: "client closed request during terminal continuation", status: 499 };
          return;
        }
        try {
          response = await fetchContinuation("rate-limit-429");
        } catch (error) {
          if (options.abortSignal?.aborted || upstream.signal.aborted) {
            yield { type: "error", message: "client closed request during terminal continuation", status: 499 };
          } else {
            yield { type: "error", message: `Provider continuation failed: ${redactSecretString(error instanceof Error ? error.message : String(error))}` };
          }
          return;
        }
      }

      if (response.status === 429 && hasKeyPoolFailover(route.provider)) {
        const rotated = rotateProviderTransportOn429(config, route.providerName, route.provider, {
          retryAfter: response.headers.get("retry-after"),
          now: Date.now(),
          attemptedKey: route.provider.apiKey,
          promptCacheKey: nextParsed.options.promptCacheKey,
        });
        if (rotated) {
          try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
          route.provider = rotated;
          invalidateSameTargetRequest();
          activeAdapter = resolveAdapter(
            resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
            config.cacheRetention,
          );
          nextContinuationRecoveryKind = "key-429";
          continue;
        }
      }
      if (
        response.status === 429
        && anthropicPoolAccountId
        && isAnthropicAccountPoolEnabled(config)
        && anthropicPoolFailovers < ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST
      ) {
        const nextAccountId = rotateAnthropicAccountOn429(
          config,
          anthropicPoolAccountId,
          response.headers.get("retry-after"),
          anthropicSessionKey,
        );
        if (nextAccountId) {
          try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
          try {
            const accessToken = await getAnthropicPoolAccessToken(nextAccountId);
            anthropicPoolAccountId = nextAccountId;
            anthropicPoolFailovers += 1;
            route.provider = { ...route.provider, apiKey: accessToken };
            invalidateSameTargetRequest();
            promoteAnthropicActiveAccount(nextAccountId);
            logCtx.provider = formatAnthropicProviderForLog("anthropic", nextAccountId, config);
            activeAdapter = resolveAdapter(
              resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
              config.cacheRetention,
            );
            sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, activeAdapter.name);
            nextContinuationRecoveryKind = "anthropic-oauth-429";
            continue;
          } catch {
            // fall through to emit continuation error below
          }
        }
      }
      if (shouldAttemptImageTierRetry({
        status: response.status,
        adapterName: activeAdapter.name,
        parsed: nextParsed,
        alreadyAttempted: imageTierBias > 0,
      })) {
        imageTierBias = 1;
        invalidateSameTargetRequest();
        try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
        nextContinuationRecoveryKind = "image-413";
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
          yield* activeAdapter.parseStream(response, translatorBudget);
        } else if (activeAdapter.parseResponse) {
          yield* await activeAdapter.parseResponse(response, translatorBudget);
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
    const initialEventStream = activeAdapter.parseStream(upstreamResponse, translatorBudget);
    const eventStream = terminalGuardEnabled
      ? guardTerminalEventStream({
          parsed,
          firstEvents: initialEventStream,
          adapterName: activeAdapter.name,
          maxAutoContinuations: 1,
          continuation: fetchTerminalGuardContinuation,
        })
      : initialEventStream;
    const { toolNsMap, freeformToolNames, toolSearchToolNames } = toolBridgeMaps;
    const sseStream = bridgeToResponsesSSE(
      eventStream, parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
      () => upstream.abort(), 2_000,
      {
        translatorBudget,
        replayCacheScope: parsed._clientThreadId ?? "global",
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
    const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc, cleanupUpstreamAbort, options.turnAdmissionLease);
    return new Response(trackedSse, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
    });
  }

  if (activeAdapter.parseResponse) {
    let events: AdapterEvent[];
    try {
      const initialEvents = await activeAdapter.parseResponse(upstreamResponse, translatorBudget);
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
    const { toolNsMap, freeformToolNames, toolSearchToolNames } = toolBridgeMaps;
    let providerState: OcxProviderContinuationState | undefined;
    const json = buildResponseJSON(events, parsed.modelId, {
      translatorBudget,
      replayCacheScope: parsed._clientThreadId ?? "global",
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
