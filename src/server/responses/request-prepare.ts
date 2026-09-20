import type { ResponsesRequestContext, ResponsesAdmissionState, ResponsesDispatchers } from "./core-options";
import {
  agentTaskRecoveryConfig,
  restoreCachedEncryptedAgentTasks,
  recoverEncryptedAgentTaskWithResult,
} from "./agent-task-recovery";
import { readJsonRequestBody, resolveInboundBodyLimitBytes } from "../request-decompress";
import {
  clientCancelledResponse,
  decodeRequestErrorResponse,
  comboUnavailable,
  unreadableEncryptedAgentTaskResponse,
} from "./core-errors";
import { parseSyntheticRowId } from "../fast-row";
import { resolveComboId, comboIdFromRawBody, NoAvailableComboTargetsError } from "../../combos";
import { recallComboForLane } from "./combo-session-recall";
import {
  sessionLaneIdFromRequest,
  conversationIdFromResponsesRequest,
  sessionIdHeaderFromRequest,
  reasoningReplayConversationIdFromResponsesRequest,
} from "../request-log-conversation";
import {
  isShadowSourceModel,
  shadowSourceModelPrefix,
  shouldInterceptShadowCall,
} from "../../lib/shadow-call";
import { sanitizeLogMetadataString } from "../../lib/redact";
import {
  hasUnreadableEncryptedAgentTask,
  sanitizeEncryptedContentInPlace,
  stripAgentMessageCiphertextInPlace,
} from "./encrypted-payload";
import {
  codexPoolAffinityKey,
  previewCodexPoolLineage,
  applyCodexAuthContextToProvider,
  hasCallerCodexBearer,
  requestOwnedMainPinState,
} from "../../codex/auth-context";
import {
  copyPreviousResponseReplayProvenance,
  expandPreviousResponseInput,
  previousResponseReplayFailure,
  markBodyNonPersistable,
  previousResponseProviderState,
} from "../../responses/state";
import { formatErrorResponse } from "../../bridge";
import type { OcxParsedRequest } from "../../types";
import { buildToolBridgeMaps } from "./collaboration";
import { parseRequest } from "../../responses/parser";
import { anthropicSessionKeyFromParts } from "../../oauth/anthropic-routing";
import { isTranslatorBudgetExceededError } from "../../lib/translator-budget";
import { bindTurnTerminationScope, rememberDeliveredFinalAnswer } from "../../responses/turn-termination";
import { requestLogSpeedLabel, readConfiguredCodexServiceTier } from "../request-log";
import type { RouteResult } from "../../router";
import {
  captureRouteStaticPolicy,
  routeConcreteModel,
  routeCompactionModel,
  routeModel,
  NoEligiblePolicyCandidateError,
} from "../../router";
import { evidenceFromBody } from "../../routing/request-evidence";
import { OPENAI_CODEX_PROVIDER_ID, isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { isThreadSpawnRequest } from "../effort-policy";
import {
  resolveSubagentFallbackChain,
  maybePrimeSubagentQuota,
  applySubagentModelFallback,
} from "../../codex/subagent-model-fallback";
import { codexAccountSelectionForTurn } from "../lifecycle";
import { isNativeMainTrafficBlocked } from "../../codex/native-profile-startup";
import type {
  SubagentPoolAccountPreview,
  SubagentModelEligibleAccountIds,
} from "../../codex/subagent-model-fallback";
import {
  codexRouteCredentialDomainHeaders,
  codexRouteCredentialOwnership,
  resolveResponsesCodexAuth,
  withClaudeNativeSession,
} from "./core-auth";
import {
  resolveSubagentFallbackModelEligibility,
  canPassThroughEncryptedV2AgentTask,
  applyFinalRouteRequestNormalization,
} from "./core-normalize";
import {
  cachedDeniedCodexAccountIdsForModel,
  resolveCodexModelEntitlements,
} from "../../codex/model-entitlements";
import { MAIN_CODEX_ACCOUNT_ID } from "../../codex/main-account";
import {
  previewCodexAccountForRequest,
  codexQuotaScopeForModel,
  formatCodexProviderForLog,
} from "../../codex/routing";
import { isInjectionDebugEnabled } from "../../lib/debug-settings";
import { injectionDebugLog } from "../../lib/injection-debug-log";
import { slugsEquivalent } from "../../providers/slug-codec";
import type { AgentTaskRecoveryFailureReason } from "./agent-task-recovery";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { hasUnmappedRoutedCustomToolOutput } from "../../responses/custom-tool-compat";
import { PROVIDER_OWNED_CONTINUATION_WIRES, resolvedAdapterWire } from "../../responses/continuation-ownership";
import {
  isCodexReserveHelperUnsupported,
  isCodexReserveOptInMissing,
  CODEX_RESERVE_HELPER_UNSUPPORTED_MESSAGE,
  CODEX_RESERVE_OPT_IN_REQUIRED_MESSAGE,
} from "../../codex/loopback-target";
import { checkComboTargetInputAdmission, checkInputAdmission } from "./input-admission";
import { nativeContextLimits } from "../../codex/catalog";
import { streamingContextOverflowResponse } from "./context-overflow";
import {
  preAuthUpstreamHostCircuitKey,
  upstreamHostCircuitOpenResponse,
  applyCodexAccountGatedWireNormalization,
  codexLogAccountId,
} from "./core-codex-account";
import { acquireUpstreamHostAdmission } from "../../codex/upstream-host-health";
import { applyCompactionRoutingOverride, compactionRoutingKeepsProviderIdentity } from "./compaction-routing";
import { codexAuthContextLogLabel } from "../../codex/account-label";
import {
  conversationStateBindingFromAuth,
  applyAccountChangeConversationStateScrub,
  accountChangeFileReferenceRefusal,
  conversationCarriesUploadedFiles,
} from "./account-change-state";

/** Parses, selects, and admits one request without changing the dispatch policy. */
export async function prepareResponsesRequest(
  requestContext: Pick<ResponsesRequestContext, "options" | "config" | "req" | "logCtx">,
  admissionState: ResponsesAdmissionState,
  requestDispatchers: ResponsesDispatchers,
) {
  const { options, config, req, logCtx } = requestContext;

  // The Chat and Anthropic surfaces replay through here with a Responses-shaped body,
  // so an omitted value means a genuine Responses inbound.
  const inboundWire = options.inboundWire ?? "responses";
  const translatorBudget = options.translatorBudget;
  const agentTaskRecovery = agentTaskRecoveryConfig(config);
  let body: unknown;
  try {
    body = await readJsonRequestBody(req, translatorBudget, resolveInboundBodyLimitBytes(config.maxInboundBodyBytes));
  } catch (err) {
    if (options.abortSignal?.aborted || req.signal.aborted) {
      return clientCancelledResponse();
    }
    return decodeRequestErrorResponse(err, "responses");
  }
  if (!options.comboAttempt && !options.compactionRoutingOverride && inboundWire === "responses") {
    options.compactionRoutingOverride = applyCompactionRoutingOverride(body, req.headers, config, {
      endpoint: "responses",
      transport: options.inboundTransport,
    });
  }
  options.onRequestBodyParsed?.(body);
  // An effort row naming a table-less combo (`combo/x--high`) must reach the combo dispatcher
  // as its base id, so the selector is normalized here, before comboIdFromRawBody reads model.
  const comboRows = !options.comboAttempt && body && typeof body === "object" && !Array.isArray(body)
    && typeof (body as { model?: unknown }).model === "string"
    // One parse for both grammars, from the selector as the client sent it. Parsing them
    // separately made the outcome depend on which ran first.
    ? parseSyntheticRowId((body as { model: string }).model, config)
    : { fastRow: null, effortRow: null };
  const comboEffortRow = comboRows.effortRow;
  if (comboRows.fastRow) {
    // Same reason as the effort row above: the combo dispatcher reads `model` next, so the
    // selector has to be normalized before it, or a combo child is built from a synthetic id.
    const raw = body as Record<string, unknown>;
    raw.model = comboRows.fastRow.baseId;
    // A caller INTENT, not a decision. decideTier still rules on eligibility downstream, so
    // fastMode:false and an ineligible route both still suppress it.
    raw.service_tier = "priority";
  }
  if (comboEffortRow) {
    const raw = body as Record<string, unknown>;
    raw.model = comboEffortRow.baseId;
    const rawReasoning = raw.reasoning;
    raw.reasoning = {
      ...(rawReasoning && typeof rawReasoning === "object" && !Array.isArray(rawReasoning)
        ? rawReasoning as Record<string, unknown>
        : {}),
      effort: comboEffortRow.effort,
    };
  }
  // Compaction may send the last client-visible bare model after a combo switch.
  // Configured selectors take precedence; otherwise recall before combo dispatch (#3891).
  if (!options.comboAttempt && !options.compactionRoutingOverride && body && typeof body === "object" && !Array.isArray(body)) {
    const rawModel = (body as { model?: unknown }).model;
    const rawInput = (body as { input?: unknown }).input;
    const isCompactionTrigger = Array.isArray(rawInput)
      && rawInput.some((item: unknown) =>
        typeof item === "object" && item !== null && (item as { type?: string }).type === "compaction_trigger");
    if (typeof rawModel === "string" && !rawModel.includes("/") && isCompactionTrigger
      && !comboRows.fastRow && !comboEffortRow
      && !resolveComboId(config, rawModel)) {
      const recalledComboId = recallComboForLane(config, sessionLaneIdFromRequest(req.headers), rawModel);
      if (recalledComboId) {
        (body as Record<string, unknown>).model = `combo/${recalledComboId}`;
      }
    }
  }
  // A shadow-call replacement that names a COMBO is routing policy, not the identity of any
  // one pick. The late intercept site below resolves it through routeModel/tryPickComboModel,
  // which collapses the table to a single target while still tagging `routeKind: "combo"`, so
  // the combo gate on the next line never fires, handleComboResponses never runs, and 429/5xx
  // hops — which only exist inside that loop — are unreachable (#4129). Rewrite the selector
  // here instead, before comboIdFromRawBody reads `model`, and identify the combo by CONFIG
  // LOOKUP so the check can never observe a one-candidate collapse.
  if (!options.comboAttempt && !options.compactionRoutingOverride && body && typeof body === "object" && !Array.isArray(body)) {
    const shadowIntercept = config.shadowCallIntercept;
    const rawShadowModel = (body as { model?: unknown }).model;
    if (shadowIntercept?.enabled && shadowIntercept.model && typeof rawShadowModel === "string"
      && isShadowSourceModel(rawShadowModel, shadowIntercept.sourceModels)) {
      const shadowComboId = resolveComboId(config, shadowIntercept.model);
      if (shadowComboId && Object.hasOwn(config.combos ?? {}, shadowComboId)) {
        (body as Record<string, unknown>).model = shadowIntercept.model;
        // Same rule as the late intercept site: record the operator-configured prefix that
        // matched, never the caller's raw model string. Matching is by prefix, so the raw
        // value is caller-controlled and reaches usage.jsonl and /api/logs.
        logCtx.shadowCallRewrittenFrom = sanitizeLogMetadataString(
          shadowSourceModelPrefix(rawShadowModel, shadowIntercept.sourceModels),
        );
      }
    }
  }
  const comboId = !options.comboAttempt ? comboIdFromRawBody(body, config) : null;
  if (comboId && Object.hasOwn(config.combos ?? {}, comboId)) {
    options.onRequestBodyRead?.();
    return requestDispatchers.handleComboResponses(req, body, comboId, config, logCtx, {
      ...options,
      // The original request body was accepted above. Combo children are synthetic
      // replays and must not repeat the caller-owned timeout transition.
      onRequestBodyRead: undefined,
    });
  }
  let unreadableEncryptedAgentTask = hasUnreadableEncryptedAgentTask(
    (body as { input?: unknown } | undefined)?.input,
  );
  const inboundClientThreadId = req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  // The request's OWN thread, which `x-codex-parent-thread-id` is not: parallel children of one
  // parent all present the same parent id. `codexConversationIdentity` already reads this header
  // for the same reason, and a surface that must tell siblings apart needs it too (#5033).
  const inboundOwnThreadId = req.headers.get("thread-id")?.trim() || undefined;
  const cursorClientThreadId = codexPoolAffinityKey(req.headers);
  const originalBody = body;
  if (options.comboReplaySnapshot) {
    copyPreviousResponseReplayProvenance(options.comboReplaySnapshot.sourceBody, body);
  } else {
    body = expandPreviousResponseInput(body, inboundClientThreadId);
    const replayFailure = previousResponseReplayFailure(body);
    if (replayFailure?.reason === "scope_mismatch") {
      // Bounded and content-free: no task scope and nothing about the retained entry.
      console.warn("[opencodex] refusing continuation because the client task scope does not match replay state");
    }
    // Local replay failures require full client replay.
    if (replayFailure) {
      return formatErrorResponse(
        400,
        "previous_response_not_found",
        "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
      );
    }
  }
  const previousResponseInputExpanded = options.comboReplaySnapshot?.previousResponseInputExpanded
    ?? (body !== originalBody
      && typeof (body as { previous_response_id?: unknown }).previous_response_id === "string");

  // Spawn-message compatibility (both directions): agent_message task payloads ride in
  // encrypted_content slots as plaintext. Rewrite them to input_text on the RAW body BEFORE
  // parsing so every consumer sees the payload: parseRequest (routed/translated providers read
  // the parsed messages) and the native passthrough (_rawBody is this same object, serialized
  // verbatim). Structurally valid backend ciphertext stays byte-identical; encoded-looking unknown
  // slots remain opaque only until final-route handling can preserve or strip them safely.
  {
    const rewritten = sanitizeEncryptedContentInPlace(
      (body as { input?: unknown } | undefined)?.input,
      // The final destination is not known yet. Keep ambiguous encoded slots opaque until route
      // selection can either strip them for a third party or apply strict native classification.
      { preserveUnknownOpaqueSlots: true },
    );
    if (rewritten > 0)
      console.warn(
        `[opencodex] rewrote ${rewritten} plaintext encrypted_content part(s) to input_text (spawn-message compatibility)`,
      );
  }

  let parsed: OcxParsedRequest;
  let toolBridgeMaps: ReturnType<typeof buildToolBridgeMaps>;
  try {
    parsed = parseRequest(body);
    parsed._promptCacheKeyIsSharedCohort = options.promptCacheKeyIsSharedCohort;
    // Captured before any parser mutates it, so both grammars see the client's id.
    const { fastRow, effortRow } = parseSyntheticRowId(parsed.modelId, config);
    if (fastRow) {
      parsed.modelId = fastRow.baseId;
      parsed.options.serviceTier = "priority";
      const raw = parsed._rawBody as Record<string, unknown>;
      raw.model = fastRow.baseId;
      raw.service_tier = "priority";
    }
    if (effortRow) {
      parsed.modelId = effortRow.baseId;
      parsed.options.reasoning = effortRow.effort;
      const raw = parsed._rawBody as Record<string, unknown>;
      const rawReasoning = raw.reasoning;
      raw.model = effortRow.baseId;
      raw.reasoning = {
        ...(rawReasoning && typeof rawReasoning === "object" && !Array.isArray(rawReasoning)
          ? rawReasoning as Record<string, unknown>
          : {}),
        effort: effortRow.effort,
      };
    }
    if (options.comboReplaySnapshot?.recoveredPlaintext) {
      markBodyNonPersistable(parsed._rawBody);
    }
    toolBridgeMaps = buildToolBridgeMaps(parsed, translatorBudget);
    if (previousResponseInputExpanded) parsed._previousResponseInputExpanded = true;
    const providerContinuationCandidate = options.comboReplaySnapshot
      ? options.comboReplaySnapshot.providerContinuation
      : previousResponseProviderState(parsed.previousResponseId);
    if (providerContinuationCandidate) parsed._providerContinuationCandidate = providerContinuationCandidate;
    if (inboundOwnThreadId) parsed._codexOwnThreadId = inboundOwnThreadId;
    if (inboundClientThreadId) {
      parsed._clientThreadId = inboundClientThreadId;
    } else if (
      options.inboundWire === "anthropic"
      && options.promptCacheKeyIsSharedCohort !== true
      && typeof parsed.options.promptCacheKey === "string"
      && parsed.options.promptCacheKey.trim().length > 0
    ) {
      // Claude Code has no Codex parent-thread header, but its metadata.user_id is
      // translated into a stable per-session prompt_cache_key. Use it as the replay
      // thread identity so Gemini thought signatures are remembered by call_id for
      // Anthropic Messages clients too (#1735/#1926). Keep `_clientThreadId` unset so
      // existing provider session-id derivation (first-user-text fallback) is unchanged.
      // Normalize through anthropicSessionKeyFromParts so overlong keys are hashed and
      // trimming matches the affinity/session-key path exactly (no raw >128-char ids).
      const normalizedCacheKey = anthropicSessionKeyFromParts({
        promptCacheKey: parsed.options.promptCacheKey,
        // The enclosing branch already proves this is not the shared cohort.
        promptCacheKeyIsSharedCohort: false,
      });
      if (normalizedCacheKey) {
        parsed._reasoningReplayScope = { clientThreadId: normalizedCacheKey };
      }
    }
    if (cursorClientThreadId) parsed._cursorClientThreadId = cursorClientThreadId;
  } catch (err) {
    if (isTranslatorBudgetExceededError(err)) {
      return formatErrorResponse(413, "request_too_large", "request translation buffer exceeded the safe limit", {
        code: "translation_buffer_limit",
      });
    }
    return formatErrorResponse(400, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  options.onRequestBodyRead?.();
  const responseStateOptions = (force = false): { force?: boolean; clientThreadId?: string } => ({
    ...(force ? { force: true } : {}),
    ...(parsed._clientThreadId ? { clientThreadId: parsed._clientThreadId } : {}),
  });
  const resolvedConversationId = conversationIdFromResponsesRequest({
    clientThreadId: parsed._clientThreadId,
    sessionIdHeader: sessionIdHeaderFromRequest(req.headers),
    threadIdHeader: req.headers.get("thread-id"),
    cursorConversationId: parsed._cursorConversationId,
  });
  bindTurnTerminationScope(parsed, resolvedConversationId);
  const rememberKiroDeliveredFinalAnswer = (adapterName: string, response: unknown): void => {
    if (adapterName === "kiro") rememberDeliveredFinalAnswer(parsed, response);
  };
  // _clientThreadId remains the routing/continuation identity supplied by Codex. Replay state uses
  // a dedicated raw conversation namespace so mixed headers that carry the same identity still
  // match, and a shared/synthetic session_id cannot coalesce distinct thread/Cursor conversations.
  // Keep an Anthropic prompt_cache_key scope already bound above (#1735/#1926).
  if (!parsed._reasoningReplayScope) {
    const reasoningReplayConversationId = reasoningReplayConversationIdFromResponsesRequest({
      clientThreadId: parsed._clientThreadId,
      threadIdHeader: req.headers.get("thread-id"),
      cursorConversationId: parsed._cursorConversationId,
      sessionIdHeader: sessionIdHeaderFromRequest(req.headers),
    });
    if (reasoningReplayConversationId) {
      parsed._reasoningReplayScope = { clientThreadId: reasoningReplayConversationId };
    }
  }
  // Prefer a pre-populated id (routed Claude) over Responses headers that may be
  // absent or synthetically injected (session_id from prompt_cache_key).
  if (!logCtx.conversationId) {
    logCtx.conversationId = resolvedConversationId;
  }
  logCtx.requestedModel = options.compactionRoutingOverride?.sourceModel ?? parsed.modelId;
  logCtx.requestedEffort = parsed.options.reasoning;
  // What this request may spend beyond its input, for the durable spend reservation (#4707).
  // Read from the caller rather than from the adapter's serialized body, because the
  // reservation has to exist before the body does. A caller that omits it leaves the
  // provider/model default in charge and reserves only the input estimate; settlement then
  // books the real figure, so the gap is a looser bound up front, never a wrong one after.
  if (typeof parsed.options.maxOutputTokens === "number" && parsed.options.maxOutputTokens > 0) {
    logCtx.spendOutputCeilingTokens = Math.trunc(parsed.options.maxOutputTokens);
  }
  logCtx.callerServiceTier = sanitizeLogMetadataString(parsed.options.serviceTier);
  logCtx.requestedServiceTier = parsed.options.serviceTier;
  logCtx.requestedSpeedLabel = requestLogSpeedLabel(parsed.options.serviceTier);
  logCtx.configuredServiceTier = readConfiguredCodexServiceTier();
  logCtx.configuredSpeedLabel = requestLogSpeedLabel(logCtx.configuredServiceTier);

  let route: RouteResult;
  let credentialDomainWasRewritten = false;
  const captureInboundRoutePolicy = (candidate: RouteResult): RouteResult => {
    candidate.staticPolicy = captureRouteStaticPolicy(
      candidate.providerName,
      candidate.modelId,
      candidate.provider,
      candidate.staticPolicy.effectiveAlias,
      inboundWire,
    );
    return candidate;
  };
  try {
    // A `compaction_trigger` turn may name a bare native model the operator has
    // no canonical OpenAI route for (#2901). Only the initial compaction route
    // may fall back to the configured default provider; combo attempts and the
    // later fallback/recovery re-routes keep the ordinary reservation.
    const resolveRoute = (modelId: string) => captureInboundRoutePolicy(options.comboAttempt
      ? routeConcreteModel(config, modelId)
      : parsed._compactionRequest === true
        ? routeCompactionModel(config, modelId, evidenceFromBody(parsed._rawBody))
        : routeModel(config, modelId, evidenceFromBody(parsed._rawBody)));
    const _sci = config.shadowCallIntercept;
    let shadowRoute: RouteResult | undefined;
    if (!options.compactionRoutingOverride && _sci?.enabled && _sci.model && isShadowSourceModel(parsed.modelId, _sci.sourceModels)) {
      const sourcePrefix = shadowSourceModelPrefix(parsed.modelId, _sci.sourceModels)!;
      let sourceIdentity = { providerName: OPENAI_CODEX_PROVIDER_ID, modelId: sourcePrefix };
      try {
        const resolvedSource = routeConcreteModel(config, parsed.modelId);
        sourceIdentity = { providerName: resolvedSource.providerName, modelId: sourcePrefix };
      } catch { /* Native Codex helper calls remain OpenAI-owned without an enabled OpenAI route. */ }
      const targetRoute = resolveRoute(_sci.model);
      if (shouldInterceptShadowCall(parsed.modelId, _sci.sourceModels, sourceIdentity, targetRoute)) {
        credentialDomainWasRewritten = true;
        const _sciOriginal = parsed.modelId;
        parsed.modelId = _sci.model;
        if (parsed._rawBody && typeof parsed._rawBody === "object") {
          (parsed._rawBody as { model?: string }).model = _sci.model;
        }
        // Record the operator-configured prefix that matched, NOT the caller's raw model string.
        // Matching is by prefix, so a caller can append arbitrary text and still intercept; that
        // raw value would then land in usage.jsonl and /api/logs behind a pattern-based redactor
        // that does not recognize every credential family. The prefix is a value the operator
        // configured, so no caller-controlled string is persisted.
        logCtx.shadowCallRewrittenFrom = sanitizeLogMetadataString(
          shadowSourceModelPrefix(_sciOriginal, _sci.sourceModels),
        );
        // Helpers must not resume/append into the parent thread's Cursor conversation.
        parsed._cursorIsolateConversation = true;
        shadowRoute = targetRoute;
      }
    }
    if (parsed._compactionRequest === true || options.compactionRoutingOverride) parsed._cursorIsolateConversation = true;
    route = shadowRoute ?? resolveRoute(parsed.modelId);
    if (options.compactionRoutingOverride && !compactionRoutingKeepsProviderIdentity(config, options.compactionRoutingOverride, route)) {
      credentialDomainWasRewritten = true;
      // The destination does not share the conversation's credential domain, so it can neither
      // verify the source backend's reasoning ciphertext nor decode its native compaction blob.
      // This is the same condition an account change already reports (account-change-state.ts),
      // and the serializer turns a stored summary into readable text instead of dropping it.
      parsed._stripReasoningEncryptedContent = true;
      if (parsed._compactionRequest === true) parsed._portableCompaction = true;
    }
    logCtx.routeDecision = route.routeDecision;
  } catch (err) {
    if (err instanceof NoAvailableComboTargetsError) {
      return comboUnavailable(err.comboId);
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
  const initialSubagentFallbackChain = threadSpawn && !options.comboAttempt
    ? resolveSubagentFallbackChain(parsed, config)
    : null;
  const previewSelectionAdmission = threadSpawn
    && !options.comboAttempt
    && (route.codexAccountId === undefined || initialSubagentFallbackChain !== null)
    ? codexAccountSelectionForTurn(options.turnAdmissionLease)?.()
    : undefined;
  // The credential headers final authentication will be given, resolved once and reused by
  // everything below that has to predict what final auth decides.
  const previewAuthHeaders = codexRouteCredentialDomainHeaders(
    req,
    route,
    options,
    credentialDomainWasRewritten,
  );
  // Does the CALLER own the credential this request will authenticate with? Validated exactly
  // the way final auth validates it: the route ownership predicate AND the caller-bearer check
  // `resolveCodexAuthContext` re-applies to these same headers.
  const previewRequestScopedMainCredential = codexRouteCredentialOwnership(
    previewAuthHeaders,
    config,
    route,
    options,
  ).requestScopedMainCredential && hasCallerCodexBearer(previewAuthHeaders);
  const nativeMainRecoveryBlocked = isNativeMainTrafficBlocked();
  // The same three inputs final auth ORs together (src/codex/auth-context.ts). Request-owned
  // ownership is first there and has to be first here: computing the preview fence from
  // recovery and drain state alone let a `thread_spawn` carrying a forwardable caller bearer
  // read the physical main token it is forbidden to touch, and score main differently than the
  // resolution this preview exists to predict.
  const nativeMainReadsForbidden = previewRequestScopedMainCredential
    || nativeMainRecoveryBlocked
    || previewSelectionAdmission?.mainProfileDraining === true;
  // The liveness answer final authentication gives its own selection options, computed from the
  // same shared predicate so the two cannot drift apart again (#4850). `fixedAccountId` is
  // mirrored through `route.codexAccountId` because that is literally what core-auth.ts passes
  // as `accountId`. A reserve-authorized request is the one input where the two can differ, and
  // it differs harmlessly: reserve plus a caller bearer is served as main either way, which is
  // the answer this produces.
  const previewRequestOwnedMainPin = requestOwnedMainPinState(
    previewAuthHeaders,
    config,
    options.codexAuthPolicy ?? config,
    previewRequestScopedMainCredential,
    route.codexAccountId,
  ).preserve;
  // Deliberately NOT fenced on ownership: final auth derives `nativeMainSelectionOnly` from the
  // drain alone, and adding a term here would diverge from it in the other direction.
  const previewSelectionOptions = {
    nativeMainSelectionOnly: !nativeMainRecoveryBlocked
      && previewSelectionAdmission?.mainProfileDraining === true,
    // Pool eligibility was the last part of preview still outside the fence (#4850). Without
    // this seam `codexAccountUnusableReason` takes its default branch into
    // `isMainAccountCredentialUsable()`, which opens the physical `auth.json` -- twice per
    // spawn, because subagent fallback re-enters the preview through the callback below.
    //
    // Scoped to ownership, and carrying final auth's value rather than a constant, because
    // preview exists to predict final auth. Under an effective main pin the request really is
    // served by its own main credential, so main must stay eligible; without the pin final auth
    // scores main `main_credential_unavailable` and drops it, so preview has to drop it too. A
    // hardcoded `true` would be wrong in the second case and `false` in the first.
    isMainAccountTokenLive: previewRequestScopedMainCredential
      ? () => previewRequestOwnedMainPin
      : undefined,
    // Preview must reach the same answer as the final resolution, including the uploaded-file
    // retention (#4778): a preview that reported a quota move the request will not make would
    // hand subagent fallback a different account than the one that actually serves.
    retainAccountForUploadedFiles: conversationCarriesUploadedFiles(parsed._rawBody),
  };
  let selectedForwardHeaders = req.headers;
  let subagentFallbackAccountId = config.activeCodexAccountId ?? null;
  let subagentFallbackAccountPreview: SubagentPoolAccountPreview | undefined;
  let subagentFallbackModelEligibleAccountIdsForModel: SubagentModelEligibleAccountIds | undefined;
  let subagentQuotaFailureModel = parsed.modelId;
  const parentThreadId = req.headers.get("x-codex-parent-thread-id")?.trim() ?? null;
  const poolAffinityKey = codexPoolAffinityKey(req.headers) ?? null;
  // Preview has to see the same lineage resolve does. Without it, a child's first turn is
  // previewed as a cold pick and resolved onto the family account, and the subagent fallback
  // then decides model eligibility against an account the request will never use.
  //
  // "The same" means both halves of the question the final resolution asks. The Authorization
  // it will be given, because the lineage scope is an HMAC of exactly that header; and its own
  // Pool-state predicate, because a fixed account selector and a request-owned credential
  // deliberately create no affinity at all -- previewing a family binding for one of those would
  // hand model fallback an account this request can never authenticate as. Read-only: the record
  // is written by the resolution that binds, never by a preview that may own no Pool state.
  const poolLineage = previewCodexPoolLineage(previewAuthHeaders, options.codexAuthPolicy ?? config, {
    accountId: route.codexAccountId,
    modelId: route.modelId,
    admission: options.admission,
    requestScopedMainCredential: previewRequestScopedMainCredential,
  });

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
  if (
    threadSpawn
    && !options.comboAttempt
    && (route.codexAccountId === undefined || initialSubagentFallbackChain !== null)
  ) {
    // The final resolveCodexAuthContext binds under codexQuotaScopeForModel(route.modelId),
    // so the preview must read the same scope slot — an undefined scope would map to the
    // "legacy" affinity bucket and never find a binding made under "shared" or a native
    // model scope, making the preview diverge from the account that actually authenticates.
    const fallbackChain = initialSubagentFallbackChain;
    subagentFallbackModelEligibleAccountIdsForModel = await resolveSubagentFallbackModelEligibility({
      config,
      fallbackChain,
      nativeMainReadsForbidden,
      resolver: options.resolveCodexModelEntitlements ?? resolveCodexModelEntitlements,
    });
    const fallbackNow = Date.now();
    subagentFallbackAccountPreview = (modelId, previewNow, modelEligibleAccountIds) => previewCodexAccountForRequest(
      poolAffinityKey,
      config,
      previewNow,
      codexQuotaScopeForModel(modelId),
      {
        ...previewSelectionOptions,
        modelEligibleAccountIds,
        // Per CANDIDATE model, like the scope and the eligible set above: the preference is
        // model-specific, so hoisting it out of the closure would score every fallback
        // candidate against the requested model's evidence and diverge from final auth (#4768).
        // Under the same native-main read fence final auth applies: the reader validates each
        // cached roster against the account's current credential, and for main that is a
        // synchronous read of the stored token. A preview that read it would both cross the
        // fence and score main differently than the resolution it is supposed to predict.
        deniedModelAccountIds: cachedDeniedCodexAccountIdsForModel(modelId, previewNow, {
          excludeAccountIds: nativeMainReadsForbidden ? new Set([MAIN_CODEX_ACCOUNT_ID]) : undefined,
        }),
      },
      modelId,
      poolLineage,
    );
    const previewAccountId = route.codexAccountId ?? subagentFallbackAccountPreview(
      route.modelId,
      fallbackNow,
      subagentFallbackModelEligibleAccountIdsForModel?.(route.modelId),
    );
    subagentFallbackAccountId = previewAccountId ?? config.activeCodexAccountId ?? null;
    const fallback = applySubagentModelFallback(
      parsed,
      req.headers,
      config,
      previewAccountId,
      fallbackNow,
      unreadableEncryptedAgentTask,
      previewSelectionOptions,
      subagentFallbackAccountPreview,
      subagentFallbackModelEligibleAccountIdsForModel,
      fallbackChain,
      candidateRoute => canPassThroughEncryptedV2AgentTask(candidateRoute, inboundWire),
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
        route = captureInboundRoutePolicy(
          routeModel(config, fallback.to, evidenceFromBody(parsed._rawBody)),
        );
        credentialDomainWasRewritten = true;
        logCtx.routeDecision = route.routeDecision;
      } catch (err) {
        if (err instanceof NoAvailableComboTargetsError) {
          return comboUnavailable(err.comboId);
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

  let recoveryFailureReason: AgentTaskRecoveryFailureReason | undefined;
  // Native fallback and explicitly trusted direct Responses routes can consume ciphertext,
  // so recover only after final route selection.
  //
  // Deliberately NOT gated on `threadSpawn` (#4089). Switching a live thread from a native
  // ChatGPT model to a routed provider replays a backend-minted encrypted agent message on every
  // later turn, and a model switch is not a spawn, so the spawn requirement failed the thread
  // closed permanently without ever attempting recovery. The trust boundary is
  // `recoveryAdmission()` in ./agent-task-recovery -- Codex originator, live native ChatGPT
  // bearer, matching chatgpt-account-id, no inbound API key, no proxy-admission secret -- which
  // admits only the owner of the session that would be spent. `threadSpawn` narrowed which of
  // that owner's own requests could use their own session; it kept nobody else out. The combo
  // gate above keeps its spawn requirement: that path has its own native-target filtering and
  // per-attempt failover, and the reported defect is on this path.
  if (
    inboundWire === "responses"
    && agentTaskRecovery
    && !isCanonicalOpenAiForwardProvider(route.provider)
    && !options.comboAttempt
    && !canPassThroughEncryptedV2AgentTask(route, inboundWire)
  ) {
    let recovered = restoreCachedEncryptedAgentTasks(
      req, (body as { input?: unknown } | undefined)?.input, config, { parentThreadId },
    ) > 0;
    unreadableEncryptedAgentTask = hasUnreadableEncryptedAgentTask(
      (body as { input?: unknown } | undefined)?.input,
    );
    if (unreadableEncryptedAgentTask) try {
      const result = await recoverEncryptedAgentTaskWithResult(
        req,
        (body as { input?: unknown } | undefined)?.input,
        agentTaskRecovery,
        config,
        { parentThreadId, abortSignal: options.abortSignal },
      );
      recovered = result.recovered;
      recoveryFailureReason = result.recovered ? undefined : result.reason;
    } catch {
      recovered = false;
      recoveryFailureReason = undefined;
    }
    if (recovered) {
      unreadableEncryptedAgentTask = hasUnreadableEncryptedAgentTask(
        (body as { input?: unknown } | undefined)?.input,
      );
      if (!unreadableEncryptedAgentTask) {
        try {
          const reparsed = parseRequest(body);
          const kept: Array<keyof OcxParsedRequest> = [
            "_previousResponseInputExpanded",
            "_providerContinuation",
            "_providerContinuationCandidate",
            "_providerContinuationOwner",
            "_cursorConversationId",
            "_clientThreadId",
            "_codexOwnThreadId",
            "_promptCacheKeyIsSharedCohort",
            "_cursorClientThreadId",
            "_reasoningReplayScope",
            "_cursorIsolateConversation",
          ];
          for (const key of kept) {
            if (parsed[key] !== undefined) {
              (reparsed as unknown as Record<string, unknown>)[key] = parsed[key];
            }
          }
          bindTurnTerminationScope(reparsed, resolvedConversationId);
          parsed = reparsed;
          // The recovery mutated `body.input` in place, so `_rawBody` now carries decrypted task
          // text. Bar it from the continuation cache before any recording path can reach it —
          // that cache is persisted to disk, which would defeat the recovery cache's TTL.
          markBodyNonPersistable(parsed._rawBody);

          // The ciphertext-only pass intentionally excludes routed candidates. Once recovery
          // makes the assignment readable, run selection again with the full configured chain
          // and keep the route in sync with any newly selected fallback.
          const recoverySelectionAdmission = codexAccountSelectionForTurn(options.turnAdmissionLease)?.();
          const fallback = (() => {
            try {
              const recoveryNativeMainBlocked = isNativeMainTrafficBlocked();
              // Recompute ownership here rather than reusing the pre-decryption value: a
              // subagent fallback above may have re-routed, and `requestScopedMainCredential`
              // is a function of the route as well as the headers.
              const recoveryAuthHeaders = codexRouteCredentialDomainHeaders(
                req,
                route,
                options,
                credentialDomainWasRewritten,
              );
              const recoveryRequestScopedMainCredential = codexRouteCredentialOwnership(
                recoveryAuthHeaders,
                config,
                route,
                options,
              ).requestScopedMainCredential && hasCallerCodexBearer(recoveryAuthHeaders);
              // Recovery's own answer to the same question, against the route it may have moved
              // to. Reconstructing the options without it is what left pool eligibility outside
              // the fence on the first preview (#4850); recovery re-previews, so it would leave
              // the same two reads on the one path that runs after decryption.
              const recoveryRequestOwnedMainPin = requestOwnedMainPinState(
                recoveryAuthHeaders,
                config,
                options.codexAuthPolicy ?? config,
                recoveryRequestScopedMainCredential,
                route.codexAccountId,
              ).preserve;
              const recoverySelectionOptions = {
                nativeMainSelectionOnly: !recoveryNativeMainBlocked
                  && recoverySelectionAdmission?.mainProfileDraining === true,
                isMainAccountTokenLive: recoveryRequestScopedMainCredential
                  ? () => recoveryRequestOwnedMainPin
                  : undefined,
                // #4778, same reason as `previewSelectionOptions` above: this preview decides
                // which account subagent fallback scores against, and final auth passes the
                // retention. Recovery is exactly where the two could diverge -- it re-previews
                // against the DECRYPTED body, which is the first point at which a file reference
                // that was ciphertext-only becomes readable, so reconstructing the options
                // without the bit lets preview report a quota move the request will not make.
                retainAccountForUploadedFiles: conversationCarriesUploadedFiles(parsed._rawBody),
              };
              const recoveryNow = Date.now();
              // Carry the entitlement filter through recovery too (#2509/#2623). The scope was
              // already re-previewed per candidate here; the ELIGIBLE-ACCOUNT set was not, so a
              // recovered assignment could select an account that is not entitled to the model
              // and then fail closed at final auth — the same class of stale-selection bug as
              // the quota scope, one layer over.
              subagentFallbackAccountPreview = (modelId, previewNow, modelEligibleAccountIds) => previewCodexAccountForRequest(
                poolAffinityKey,
                config,
                previewNow,
                codexQuotaScopeForModel(modelId),
                {
                  ...recoverySelectionOptions,
                  modelEligibleAccountIds,
                  // Same read fence as the first preview, evaluated against recovery's own view
                  // of the drain AND of credential ownership, rather than the one captured before
                  // decryption. Omitting ownership here would reopen the fence the first preview
                  // closes, on the one path that re-previews after the route may have moved.
                  deniedModelAccountIds: cachedDeniedCodexAccountIdsForModel(modelId, previewNow, {
                    excludeAccountIds: recoveryRequestScopedMainCredential
                      || recoveryNativeMainBlocked
                      || recoverySelectionAdmission?.mainProfileDraining === true
                      ? new Set([MAIN_CODEX_ACCOUNT_ID])
                      : undefined,
                  }),
                },
                modelId,
                poolLineage,
              );
              const recoveryPreviewAccountId = subagentFallbackAccountPreview(
                parsed.modelId,
                recoveryNow,
                subagentFallbackModelEligibleAccountIdsForModel?.(parsed.modelId),
              );
              return applySubagentModelFallback(
                parsed,
                req.headers,
                config,
                recoveryPreviewAccountId,
                recoveryNow,
                false,
                recoverySelectionOptions,
                subagentFallbackAccountPreview,
                subagentFallbackModelEligibleAccountIdsForModel,
              );
            } finally {
              recoverySelectionAdmission?.release();
            }
          })();
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
              route = captureInboundRoutePolicy(
                routeModel(config, fallback.to, evidenceFromBody(parsed._rawBody)),
              );
              credentialDomainWasRewritten = true;
              logCtx.routeDecision = route.routeDecision;
            } catch (err) {
              if (err instanceof NoAvailableComboTargetsError) {
                return comboUnavailable(err.comboId);
              }
              if (err instanceof NoEligiblePolicyCandidateError) {
                logCtx.routeDecision = err.trace;
              }
              return formatErrorResponse(
                404,
                "invalid_request_error",
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        } catch {
          unreadableEncryptedAgentTask = true;
        }
      }
    }
  }

  if (options.abortSignal?.aborted) return clientCancelledResponse();

  if (inboundWire === "responses" && isCanonicalOpenAiForwardProvider(route.provider)) {
    const rewritten = sanitizeEncryptedContentInPlace(
      (body as { input?: unknown } | undefined)?.input,
    );
    if (rewritten > 0) {
      console.warn(
        `[opencodex] rewrote ${rewritten} non-Fernet encrypted_content part(s) before canonical native replay`,
      );
    }
  }

  // Encrypted child tasks may reach the canonical native backend or an explicitly trusted
  // direct Responses route. This runs against the FINAL route so native-only fallback can
  // rescue an incompatible primary without weakening combo behavior.
  const finalRouteCanPassThroughEncryptedTask = !options.comboAttempt
    && canPassThroughEncryptedV2AgentTask(route, inboundWire);
  if (
    (route.combo !== undefined || !isCanonicalOpenAiForwardProvider(route.provider))
    && !finalRouteCanPassThroughEncryptedTask
    && unreadableEncryptedAgentTask
  ) {
    return unreadableEncryptedAgentTaskResponse(recoveryFailureReason);
  }

  // The guard above asks whether the CURRENT worker task is readable, and it only inspects the
  // tail item. An `agent_message` that mixes readable text with backend ciphertext answers
  // "readable" to that question at every position, so it passed -- and then
  // `normalizeRoutedAgentMessages` refused to lower it, because lowering requires every part to
  // be representable. The raw Responses passthrough serialized the private item as it stood, so
  // backend ciphertext and an item type only the Codex backend declares reached a third-party
  // provider, which answered `422 unknown item type "agent_message"` (#4454).
  //
  // The opaque-blob path already knows the repair: replace the undecryptable part with an
  // omission marker, which leaves the item lowerable. It applied that repair only AFTER an
  // upstream rejection. For a destination that cannot accept the private item under any
  // circumstances, that round trip was never going to succeed and sent the ciphertext to find
  // out, so do the repair here instead. Recovery above has already had its chance to turn the
  // same bytes into real plaintext; only what it could not rescue reaches this.
  if (inboundWire === "responses" && !finalRouteCanPassThroughEncryptedTask) {
    // Only the raw Responses passthrough puts input items on the wire verbatim, so that is the
    // only wire this has to repair: translated wires rebuild the body from parsed messages, where
    // `inputContentParts` drops an encrypted part instead of forwarding it. The exemption is the
    // canonical Codex backend alone, because it is the one destination that minted these bytes and
    // can read them. `authMode: "forward"` is NOT that test -- a noncanonical forward gateway is
    // somebody else's server that happens to be configured for passthrough, and it receives the
    // ciphertext like any other third party.
    //
    // Combo children run this too. Each child carries its own `structuredClone` of the body
    // (`concreteComboRequestBody`) and its own concrete route, so a sibling's repair is invisible
    // here and a target that resolves to a routed Responses wire would otherwise send the
    // ciphertext that the parent's own dispatch no longer does.
    const wireProvider = resolveWireProtocolOverride(
      route.providerName,
      route.modelId,
      route.provider,
      inboundWire,
      route.staticPolicy,
    );
    if (wireProvider.adapter === "openai-responses" && !isCanonicalOpenAiForwardProvider(wireProvider)) {
      const repaired = stripAgentMessageCiphertextInPlace((body as { input?: unknown } | undefined)?.input);
      if (repaired > 0) {
        console.warn(
          `[opencodex] replaced ciphertext in ${repaired} replayed agent message(s) with an omission marker; the selected provider cannot read native ChatGPT ciphertext`,
        );
      }
    }
  }

  // The canonical ChatGPT backend rejects previous_response_id, so a local replay miss leaves no
  // safe way to recover the omitted history. Fail before auth, adapter construction, or upstream
  // I/O instead of stripping the id and silently forwarding a context-free delta (#702).
  // Codex recognizes previous_response_not_found on WebSocket errors and reconnects with its
  // full input. A generic invalid_request_error instead terminates the task after cache expiry.
  if (
    hasUnexpandedPreviousResponse
    && isCanonicalOpenAiForwardProvider(route.provider)
  ) {
    return formatErrorResponse(
      400,
      "previous_response_not_found",
      "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
    );
  }

  if (hasUnexpandedPreviousResponse) {
    const continuationProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy);
    // Can the DESTINATION see the history this process failed to restore? Only the native
    // Responses passthrough can: it forwards previous_response_id to a backend that stored the
    // chain. Every translated wire rebuilds the conversation from this request's input alone —
    // including the three that look stateful, for the reasons recorded in
    // responses/continuation-ownership.ts — so a replay miss there is not a degraded turn. It is
    // the entire conversation deleted, with one user line left in its place and nothing in the
    // response saying so. Refuse before auth or upstream I/O and let the client resend.
    const continuationWire = resolvedAdapterWire(continuationProvider.adapter);
    const upstreamOwnsOmittedHistory = continuationWire === "openai-responses"
      // Stateless destinations cannot resolve the omitted prefix. Stateful destinations may,
      // but a lowered custom result still needs its call to recover the original wire type.
      // Native function/custom continuations without lowering keep their upstream-owned state.
      ? !(continuationProvider.statelessResponses === true
        || hasUnmappedRoutedCustomToolOutput(parsed._rawBody, continuationProvider.supportsResponsesCustomTools))
      // An unknown adapter is left to the resolution error it already raises below.
      : continuationWire === undefined || PROVIDER_OWNED_CONTINUATION_WIRES.has(continuationWire);
    if (!upstreamOwnsOmittedHistory) {
      return formatErrorResponse(
        400,
        "previous_response_not_found",
        "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
      );
    }
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
    claudeGoAffinity: options.claudeGoAffinity,
  });
  // Attribute local auth/cooldown failures to the public selector too; exact auth may fail before
  // the normal post-resolution provider label is assigned.
  if (route.codexAccountNamespace) {
    logCtx.provider = `${route.providerName}-${route.codexAccountNamespace}`;
  }

  if (options.abortSignal?.aborted) return clientCancelledResponse();
  // Resolve aliases/combo children before refusing helpers; do not spend main auth or host budget.
  if (isCanonicalOpenAiForwardProvider(route.provider)
    && isCodexReserveHelperUnsupported(options.codexAuthPolicy ?? config, route.modelId,
      options.admission, options.visionDescribeTerminal === true)) {
    return formatErrorResponse(400, "invalid_request_error", CODEX_RESERVE_HELPER_UNSUPPORTED_MESSAGE);
  }
  // #4940: the opt-in is off, so every Reserve affordance in this process is inert -- no catalog
  // row, no main-credential substitution, no authorization handshake, and no `luna-reserve` header
  // on the send. Forwarding `gpt-reserve` as an ordinary native model therefore buys nothing but a
  // 429 "The usage limit has been reached", which names neither the real cause nor the setting the
  // operator would have to change. Refuse here instead, on the same terms and in the same place as
  // the helper refusal above: after alias/combo resolution, before auth, host-circuit budget or any
  // upstream byte.
  //
  // Two narrowings beyond the predicate, both about not answering a question this refusal cannot
  // answer correctly. A terminal vision/search helper is excluded because enabling the opt-in would
  // not make it work -- it would produce the helper refusal above instead, so telling that caller to
  // enable the flag is advice that does not hold. Non-native inbound wires are excluded because a
  // `gpt-reserve` selector reaching us over Chat or Anthropic Messages is an operator-authored
  // route (a `claudeCode.modelMap` entry, say), not a Codex client that was forced onto Reserve by
  // its own usage snapshot, and that route keeps whatever behavior it has today.
  if (inboundWire === "responses"
    && options.visionDescribeTerminal !== true
    && isCanonicalOpenAiForwardProvider(route.provider)
    && isCodexReserveOptInMissing(options.codexAuthPolicy ?? config, route.modelId, options.admission)) {
    return formatErrorResponse(400, "invalid_request_error", CODEX_RESERVE_OPT_IN_REQUIRED_MESSAGE);
  }
  // Refuse an input that cannot plausibly fit the model context window before spending auth,
  // circuit budget, or upstream bandwidth on a turn the provider will reject anyway (#1412).
  //
  // Compaction turns are exempt: Codex sends compaction_trigger BECAUSE context is full, so
  // refusing the turn that shrinks the context would deadlock the client against the very
  // limit this gate reports — it would be told to compact and then denied the compaction.
  if (parsed._compactionRequest !== true) {
    // A combo child is the one caller that can afford a strict gate: skipping a target it
    // cannot fit is safe before any upstream bytes are sent, and the ladder continues. A
    // direct request has nowhere to go, so it keeps the loose pathological-input gate.
    const inputAdmission = options.comboAttempt
      ? checkComboTargetInputAdmission(parsed, route.provider, route.providerName, parsed.modelId, nativeContextLimits(config))
      : checkInputAdmission(parsed, route.provider, route.providerName, parsed.modelId, nativeContextLimits(config));
    if (!inputAdmission.admitted) {
      // #1524: this is a LOCAL preflight refusal, not an upstream verdict. A policy or combo
      // fallback must be able to skip this candidate and try one whose context window fits,
      // instead of treating the first incompatible candidate as the end of the chain. The
      // distinct code is what lets the fallback layer tell the two apart -- an upstream
      // `context_length_exceeded` still stops, because retrying it elsewhere is guesswork.
      if (clientRequestedStream && !options.comboAttempt) {
        return streamingContextOverflowResponse(
          parsed._responseModelId ?? parsed.modelId,
          translatorBudget,
        );
      }
      return formatErrorResponse(
        413,
        "input_admission_refused",
        inputAdmission.requiredOutputHeadroom !== undefined
          ? `Estimated input (~${inputAdmission.estimatedTokens} tokens) plus ${inputAdmission.requiredOutputHeadroom} `
            + `tokens of requested output headroom cannot fit the context window of ${parsed.modelId} `
            + `(${inputAdmission.ceiling} tokens).`
          : `Estimated input (~${inputAdmission.estimatedTokens} tokens) is far past the context window `
            + `of ${parsed.modelId} (${inputAdmission.ceiling} tokens). Start a new session or choose a `
            + `model with a larger context window.`,
      );
    }
  }
  const preAuthHostKey = preAuthUpstreamHostCircuitKey(route, config);
  if (preAuthHostKey) {
    const admission = acquireUpstreamHostAdmission(
      preAuthHostKey,
      config.upstreamHostCircuitThreshold,
    );
    if (admission.kind === "blocked") {
      return upstreamHostCircuitOpenResponse(admission.retryAfterSeconds);
    }
    admissionState.pendingHostAdmissionLease = admission.lease;
  }

  let substituteMainCredential = false;
  let callerAuthHeaders: Headers;
  {
    // #4778: uploaded files are scoped to the account that issued them, so a conversation
    // carrying live references must retain its binding across a voluntary quota move. Answered
    // from the body alone, by the same predicate the refusal guard uses, so the two can never
    // disagree about which conversations are in scope.
    const finalAuth = await resolveResponsesCodexAuth(
      req,
      config,
      route,
      options,
      credentialDomainWasRewritten,
      conversationCarriesUploadedFiles(parsed._rawBody),
    );
    if (!finalAuth.ok) return finalAuth.response;
    admissionState.authCtx = finalAuth.authCtx;
    selectedForwardHeaders = withClaudeNativeSession(finalAuth.headers, route.provider, options.claudeNativeSessionId);
    callerAuthHeaders = withClaudeNativeSession(finalAuth.callerAuthHeaders, route.provider, options.claudeNativeSessionId);
    substituteMainCredential = finalAuth.substituteMainCredential;
  }

  route.provider = applyCodexAuthContextToProvider(route.provider, admissionState.authCtx, route.codexAccountMode);
  applyCodexAccountGatedWireNormalization(parsed, route, logCtx);
  logCtx.provider = route.codexAccountNamespace
    ? `${route.providerName}-${route.codexAccountNamespace}`
    : formatCodexProviderForLog(route.providerName, codexLogAccountId(admissionState.authCtx), config);
  logCtx.accountLogLabel = codexAuthContextLogLabel(admissionState.authCtx, config);
  // A move is the expensive event: it discards the prefix warmed on the previous account. Record
  // it as an event with its cause, so the operator reads it off one line instead of inferring it
  // from account labels across many (#4546).
  if (admissionState.authCtx.kind === "pool" && admissionState.authCtx.affinityDecision) {
    logCtx.affinity = admissionState.authCtx.affinityDecision.move;
    logCtx.affinityReason = admissionState.authCtx.affinityDecision.reason;
  }
  {
    const binding = conversationStateBindingFromAuth(admissionState.authCtx, poolAffinityKey);
    if (binding) {
      // Before the scrub, because a file reference is refused rather than removed and the
      // refusal has to happen while there is still no dispatch to undo.
      const refusal = accountChangeFileReferenceRefusal({
        body: parsed._rawBody,
        bindingKey: binding.bindingKey,
        servingAccountId: binding.accountId,
      });
      if (refusal) return refusal;
      applyAccountChangeConversationStateScrub({
        body: parsed._rawBody,
        parsed,
        bindingKey: binding.bindingKey,
        servingAccountId: binding.accountId,
        logCtx,
      });
    }
  }
  // Seed an account-derived scope before final adapter binding. Cursor never treats it as
  // authoritative: bindRouteReasoningReplayScope replaces it with the exact route owner or a
  // per-request fail-closed sentinel after the final provider and credential are known.
  const identityScope = codexLogAccountId(admissionState.authCtx);
  if (identityScope) parsed._cursorIdentityScope = identityScope;
  subagentFallbackAccountId = admissionState.authCtx.kind === "pool" || admissionState.authCtx.kind === "main-pool"
    ? admissionState.authCtx.accountId
    : config.activeCodexAccountId ?? null;

  return {
    inboundWire,
    translatorBudget,
    parsed,
    toolBridgeMaps,
    responseStateOptions,
    rememberKiroDeliveredFinalAnswer,
    route,
    get selectedForwardHeaders(): typeof selectedForwardHeaders {
      return selectedForwardHeaders;
    },
    set selectedForwardHeaders(value: typeof selectedForwardHeaders) {
      selectedForwardHeaders = value;
    },
    get subagentFallbackAccountId(): typeof subagentFallbackAccountId {
      return subagentFallbackAccountId;
    },
    set subagentFallbackAccountId(value: typeof subagentFallbackAccountId) {
      subagentFallbackAccountId = value;
    },
    subagentQuotaFailureModel,
    poolAffinityKey,
    clientRequestedStream,
    substituteMainCredential,
    callerAuthHeaders,
  };
}

export type PreparedResponsesRequest = Exclude<Awaited<ReturnType<typeof prepareResponsesRequest>>, Response>;
