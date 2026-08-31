import type { Server } from "bun";
import { randomUUID } from "node:crypto";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse, type ResponsesTerminalStatus } from "../../bridge";
import { formatPassthroughUpstreamError } from "./passthrough-error";
import {
  createResponsesFieldBackfillBlockRewrite,
  backfillResponsesFieldsJson,
} from "./responses-field-backfill";
import { checkInputAdmission } from "./input-admission";
import { nativeContextLimits } from "../../codex/catalog";
import { describeUpstreamConnectFailure } from "./upstream-error";
import {
  multiAgentGuidanceEnabled,
  resolveEnvValue,
} from "../../config";
import { parseRequest } from "../../responses/parser";
import {
  bindReasoningReplayScope,
  commitReasoningReplayServingIdentity,
  reasoningReplayCodexCredentialIdentity,
  reasoningReplayDestinationIdentity,
  durableReplayDestinationIdentity,
  durableReplayCredentialIdentity,
  reasoningReplayKeyCredentialIdentity,
  reasoningReplayOpaqueBlobRejectionMemoized,
  reasoningReplayOAuthCredentialIdentity,
  reasoningReplayServingIdentityChanged,
  rememberReasoningReplayOpaqueBlobRejection,
} from "../../responses/reasoning-replay-cache";
import { awaitThoughtSignatureDurability, thoughtSignatureReplaySalt } from "../../responses/thought-signature-replay";
import { buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary, extractCompactUserMessages } from "../../responses/compaction";
import { FORWARD_HEADERS, sanitizeReasoningInputContent } from "../../adapters/openai-responses";
import { XaiToolSchemaCompatibilityError } from "../../adapters/xai-tool-schema";
import {
  copyPreviousResponseReplayProvenance,
  expandPreviousResponseInput,
  markBodyNonPersistable,
  previousResponseProviderState,
  previousResponseReplayFailure,
  previousResponseScopeMismatch,
  rememberResponseState,
} from "../../responses/state";
import {
  bindTurnTerminationScope,
  rememberDeliveredFinalAnswer,
} from "../../responses/turn-termination";
import {
  isValidProviderContinuationOwner,
  mergeProviderContinuationPayload,
  providerContinuationOwnerFromReplayIdentity,
  providerContinuationRouteScope,
  sameProviderContinuationOwner,
} from "../../responses/provider-continuation";
import {
  comboRouteDecisionTrace,
  NoEligiblePolicyCandidateError,
  routeConcreteModel,
  routeModel,
  type RouteResult,
} from "../../router";
import { evidenceFromBody } from "../../routing/request-evidence";
import { resolvePassiveRouteSubjectId } from "../passive-route-linker";
import {
  advanceComboAfterFailure,
  comboDefaultEffort,
  comboFailureDecision,
  comboIdFromRawBody,
  comboRequestHasImageInput,
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
import {
  CYBER_POLICY_ERROR_CODE,
  CYBER_POLICY_FALLBACK_MESSAGE,
  adapterFailureFromMessage,
  isCyberPolicyCode,
  isCyberPolicyMessage,
} from "../../lib/errors";
import { injectionDebugLog } from "../../lib/injection-debug-log";
import { resolveClientRetryAfter } from "../../lib/retry-after";
import { enrichOpenCodeZenRateLimitMessage } from "../../providers/opencode-zen-rate-limit";
import { CODE_MODE_EXEC_TOOL_NAME, modelInList, namespacedToolName } from "../../types";
import type {
  AdapterEvent,
  OcxConfig,
  OcxParsedRequest,
  OcxProviderConfig,
  OcxProviderContinuationOwner,
  OcxProviderContinuationState,
  OcxReasoningReplayIdentity,
  OcxUsage,
  TierDecision,
} from "../../types";
import {
  forceRefreshOAuthAccessSnapshot,
  getValidAccessTokenForAccount,
  getValidAccessSnapshotForAccount,
  getValidAccessTokenSnapshot,
  publicOAuthAuthenticationErrorMessage,
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
import { stampOAuthAccountLabel } from "../../providers/label";
import {
  failoverAccountSnapshot,
  forgetGenericFailoverRoster,
  GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST,
  isGenericFailoverProvider,
  isGenericOAuthFailoverEnabled,
  preferredInitialAccount,
  rotateGenericOAuthAccountOn429,
} from "../../oauth/generic-account-failover";
import { resolveCopilotApiBaseUrl } from "../../oauth/github-copilot";
import { buildWebSearchTool, planWebSearch, runWithWebSearch, shouldResolveOpenAiWebSearchSidecar } from "../../web-search";
import { buildImageTool, buildVideoTool, planImageBridge, planVideoBridge, runWithImageBridge, clampImageMaxRounds, IMAGE_GEN_TOOL_NAME, VIDEO_GEN_TOOL_NAME } from "../../images";
import { describeImagesInPlace, isModelTextOnly, planVisionSidecar, resolveOpenAiVisionModel, shouldResolveOpenAiVisionSidecar, stripImagesInPlace } from "../../vision";
import { createAdapterEventQueue, preflightAdapterEvents, type AdapterEventQueue } from "../../adapters/run-turn-queue";
import {
  applyCodexAuthContextToProvider,
  codexPoolAffinityKey,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexMainProfileDrainingError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  materializeCodexUpstreamAuthAsync,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  codexProbeLeaseId,
  codexProbeQuotaScope,
  releaseCodexAuthContextProbeLease,
  stripCodexRuntimeProviderFields,
  type CodexAuthContext,
} from "../../codex/auth-context";
import {
  entitledCodexAccountIdsForModel,
  invalidateCodexModelEntitlementsForAccount,
  resolveCodexModelEntitlements,
} from "../../codex/model-entitlements";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../../codex/catalog/native-models";
import {
  MAIN_CODEX_ACCOUNT_ID,
  forceRefreshMainAccountToken,
  type NativeMainRefreshDependencies,
} from "../../codex/main-account";
import { captureCodexAffinityDiagnostic } from "../../codex/affinity-debug";
import {
  computeQuotaCooldown,
  codexQuotaScopeForModel,
  formatCodexProviderForLog,
  handOffThreadAffinityGeneration,
  previewCodexAccountForRequest,
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "../../codex/routing";
import {
  TokenRefreshError,
  forceRefreshCodexPoolToken,
  readCodexAccountRecord,
} from "../../codex/account-store";
import { codexAuthContextLogLabel } from "../../codex/account-label";
import {
  applyUpstreamRecoveryInit,
  fetchWithResetRetry,
  fetchWithTransientRetry,
  prepareSameTarget429Wait,
} from "../../lib/upstream-retry";
import {
  ForwardAdmissionCredentialError,
  hasForwardableCodexBearer,
  validateForwardAdmissionCredential,
} from "../auth-cors";
import type { DataPlaneAdmission } from "../auth-cors";
import { createTranslatorBudget, isTranslatorBudgetExceededError, type TranslatorBudget } from "../../lib/translator-budget";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar, type ResolvedOpenAiForwardSidecar } from "../../providers/openai-sidecar";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { providerContextCap } from "../../providers/context-cap";
import {
  fastPolicyForModel,
  serviceTierSupportFromPolicy,
  SERVICE_TIER_ADAPTERS,
} from "../../providers/service-tier";
import {
  canonicalFastTierMarker,
  decideTier,
  tierObservationContext,
  tierValueAfterDecision,
  type ResolvedFastPolicy,
} from "../../providers/fastwire";
import {
  RequestPacingQueueOverloadError,
  waitForProviderRequestSlot,
} from "../../providers/request-pacing";
import { slugsEquivalent } from "../../providers/slug-codec";
import { applyOpenAiVirtualModel, resolveOpenAiCompactModel } from "../../providers/openai-virtual-models";
import { isUsageDebugEnabled } from "../../usage/debug";
import { readJsonRequestBody, DecompressedBodyTooLargeError, UnsupportedContentEncodingError } from "../request-decompress";
import { resolveAdapter, resolveWireProtocolOverride } from "../adapter-resolve";
import {
  providerModelResponsesTerminalRepair,
  providerModelResponsesUpstreamStreaming,
  type InboundWire,
} from "../../providers/registry";
import type { AdapterRequest, ProviderAdapter } from "../../adapters/base";
import {
  hasKeyPoolFailover,
  rateLimitRetryDelayMs,
  rateLimitRetryPolicyFor,
  rotateProviderTransportOn429,
  transientRetryPolicyFor,
} from "../../providers/key-failover";
import { shouldAttemptImageTierRetry } from "../image-retry";
import { isXaiResponsesDestination, resolveProviderTransport } from "../../providers/xai-transport";
import type { WsData } from "../ws-bridge";
import {
  codexAccountSelectionForTurn,
  registerTurn,
  trackStreamLifetime,
  tryClaimNativeMainProfileForTurn,
  unregisterTurn,
} from "../lifecycle";
import { redactSecretString, sanitizeLogMetadataString } from "../../lib/redact";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import type { AdmissionLease } from "../../lib/admission";
import { supportedLadderFor } from "../effort-policy";
import { isThreadSpawnRequest } from "../effort-policy";
import {
  applySubagentModelFallback,
  maybePrimeSubagentQuota,
  recordSubagentQuotaFailureForThreadSpawn,
  resolveSubagentFallbackChain,
  subagentFallbackNeedsModelEntitlements,
  type SubagentModelEligibleAccountIds,
  type SubagentPoolAccountPreview,
} from "../../codex/subagent-model-fallback";
import { isNativeMainTrafficBlocked } from "../../codex/native-profile-startup";
import {
  beginRequestAttempt,
  finishRequestAttempt,
  inspectResponseLogJson,
  noteAttemptSend,
  readConfiguredCodexServiceTier,
  recordAdapterReasoning,
  recordAdapterTier,
  recordAdapterTierMetadata,
  recordAttemptRequestedEffort,
  requestLogSpeedLabel,
  sealRequestAttemptIdentity,
  usageFromResponsesPayload,
  type RequestLogContext,
} from "../request-log";
import {
  conversationIdFromResponsesRequest,
  normalizeLogConversationId,
  reasoningReplayConversationIdFromResponsesRequest,
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
import {
  agentTaskRecoveryConfig,
  discardEncryptedAgentTaskRecovery,
  recoverEncryptedAgentTask,
} from "./agent-task-recovery";
import { relaySseEagerBounded } from "../relay-eager";
import {
  relayResponsesSseWithTerminalRepair,
  type ResponsesTerminalRepairScheduler,
} from "../responses-terminal-repair";
import { isWin32EagerRewrite, selectEagerPath } from "../../lib/bun-stream-caps";
import { cancelBodyOnAbort } from "../../lib/abort";
import { isCodexWsUpstreamResponse, type BunRuntimeGateInput } from "./ws-upstream";
import {
  createResponsesItemIdPayloadRewrite,
  hasResponsesItemIdRepair,
  repairResponsesJsonItemIds,
} from "../responses-item-id-repair";
import {
  createReasoningSummaryChannelPayloadRewrite,
  rewriteReasoningSummaryInJsonString,
  routeUsesContentChannelReasoning,
} from "../responses-reasoning-summary-rewrite";
import {
  createImageGenCallRestoreRewrite,
  imageGenToolCallAliases,
  restoreImageGenCallsInJson,
} from "../responses-image-gen-repair";
import { createResponsesModelPayloadRewrite, rewriteResponsesModelJson } from "../responses-model-rewrite";
import type { EffectiveSubagentRoster, SpawnAgentSurface } from "../../codex/catalog";

import { buildToolBridgeMaps, collabSurface, injectDeveloperMessage, multiAgentGuidanceText } from "./collaboration";
import { mapCodexAuthContextErrorToResponse, nativeMainRefreshFailureResponse } from "./codex-auth-error";
import { hasUnreadableEncryptedAgentTask, looksLikeBackendCiphertext, sanitizeEncryptedContentInPlace } from "./encrypted-payload";
import { fetchWithHeaderTimeout, providerFetch, safeHostLabel, safeOriginLabel, storedPoolReplayDispatchNotifier } from "./fetch-helpers";
import { classifyTransportFailureKind, transportErrorCode } from "../../lib/upstream-reachability";
import {
  acquireUpstreamHostAdmission,
  disableUpstreamHostCircuitForKey,
  normalizeUpstreamHostCircuitThreshold,
  recordUpstreamHostFailure,
  releaseUpstreamHostAdmission,
  resetUpstreamHostHealth,
  upstreamHostHealthKey,
  type UpstreamHostAdmissionLease,
} from "../../codex/upstream-host-health";
import {
  createResponsesSnapshotBlockRewrite,
  hasResponsesSnapshotRepair,
  repairResponsesSnapshotJson,
} from "../responses-snapshot-repair";
import {
  composeSseBlockRewrites,
  composeSsePayloadRewrites,
  payloadRewriteAsBlockRewrite,
  relaySseWithBlockRewrite,
} from "../sse-payload-rewrite";
import { restoreRoutedCustomCalls, restoreRoutedCustomCallsInJson } from "../../responses/custom-tool-compat";
import { createRoutedCustomToolRestoreBlockRewrite } from "../responses-custom-tool-repair";
import { restoreRoutedToolSearchCallsInJson } from "../../responses/tool-search-compat";
import { createRoutedToolSearchRestoreBlockRewrite } from "../responses-tool-search-repair";
import {
  createRoutedNamespaceCallRestoreRewrite,
  NamespaceToolCollisionError,
  restoreRoutedNamespaceCalls,
  restoreRoutedNamespaceCallsInJson,
  type RoutedNamespaceToolAliases,
} from "../../responses/namespace-tool-compat";
import {
  collectDeclaredNamelessClientCallTypes,
  collectDeclaredWireToolNames,
  collectProviderExecutedCallTypes,
  createUndeclaredToolCallGuardBlockRewrite,
  currentTurnWireToolCatalogBody,
  hasExplicitWireToolCatalog,
  undeclaredToolCallMessage,
  undeclaredToolCallName,
  undeclaredToolCallNameInResponse,
  type ProviderExecutedCallType,
} from "../responses-undeclared-tool-guard";
import { createGithubCopilotResponsesBlockRewrite } from "../github-copilot-responses-repair";
import { responsesJsonToSseStream } from "../responses-json-events";
import { guardTerminalEventStream } from "./terminal-guard";
import {
  emptyCompletionRetryEnabled,
  emptyCompletionNotice,
  observeEmptyCompletion,
  guardEmptyCompletionEventStream,
} from "./empty-completion-guard";
import { preflightComboStreamResponse } from "./combo-stream-preflight";

// runTurn adapters own an event queue and perform their combo preflight before
// bridging. A second byte-stream reader would reinterpret that transport's
// already-committed event boundary and can replay custom adapter work.
const runTurnAdapterSseResponses = new WeakSet<Response>();

/**
 * Adapters whose continuation state must survive Codex's store:false requests.
 */
export function adapterNeedsForcedContinuation(name: string): boolean {
  return name === "kiro" || name === "cursor";
}

export function sidecarOutcomeRecorder(
  config: OcxConfig,
  authCtx: CodexAuthContext,
): ((outcome: CodexUpstreamOutcome) => void) | undefined {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool"
    ? outcome => recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, {
      threadId: authCtx.affinityKey,
      fixedAccount: authCtx.fixedAccount,
      probeLeaseId: authCtx.probeLeaseId,
      probeQuotaScope: authCtx.probeQuotaScope,
      writerGeneration: authCtx.writerGeneration,
      // A vision or web-search sidecar can return 401/403, and that is evidence about the exact
      // stored credential it used. Without the generation it becomes an account-wide quarantine
      // that a replacement inherits (#2892 gap 4). `main-pool` has no stored-record generation, so
      // it keeps the unfenced account-wide semantics.
      ...(authCtx.kind === "pool" ? { credentialGeneration: authCtx.generation } : {}),
    })
    : undefined;
}



import { isShadowSourceModel, shadowSourceModelPrefix, shouldInterceptShadowCall } from "../../lib/shadow-call";

export { DEFAULT_SHADOW_SOURCE_MODELS, isShadowSourceModel, shadowSourceModels } from "../../lib/shadow-call";



export function codexLogAccountId(authCtx: CodexAuthContext): string | null {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool" ? authCtx.accountId : null;
}

type ContinuationOwnerRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; owner: OcxProviderContinuationOwner };

function readProviderContinuationOwner(
  state: OcxProviderContinuationState | undefined,
): ContinuationOwnerRead {
  if (!state || state.__ocxOwner === undefined) return { kind: "missing" };
  const owner = state.__ocxOwner;
  if (!isValidProviderContinuationOwner(owner)) return { kind: "invalid" };
  return { kind: "valid", owner: { ...owner } };
}

function providerContinuationPayload(
  state: OcxProviderContinuationState | undefined,
): OcxProviderContinuationState | undefined {
  if (!state) return undefined;
  const cloned = structuredClone(state);
  delete cloned.__ocxOwner;
  return Object.keys(cloned).length > 0 ? cloned : undefined;
}

function bindProviderContinuationForRoute(
  parsed: OcxParsedRequest,
  currentOwner: OcxProviderContinuationOwner | undefined,
): void {
  const candidate = parsed._providerContinuationCandidate;
  const storedOwner = readProviderContinuationOwner(candidate);
  const mayRestore = storedOwner.kind === "valid"
    && !!currentOwner
    && sameProviderContinuationOwner(storedOwner.owner, currentOwner);
  const restored = mayRestore ? providerContinuationPayload(candidate) : undefined;
  if (restored) parsed._providerContinuation = restored;
  else delete parsed._providerContinuation;
  const cursorConversationId = restored?.cursor?.conversationId;
  if (cursorConversationId) parsed._cursorConversationId = cursorConversationId;
  else delete parsed._cursorConversationId;
  if (currentOwner) parsed._providerContinuationOwner = { ...currentOwner };
  else delete parsed._providerContinuationOwner;
}

function providerContinuationDestinationIdentity(
  parsed: OcxParsedRequest,
  provider: OcxProviderConfig,
): string | undefined {
  const kiroContext = parsed._kiroAuthContext;
  return reasoningReplayDestinationIdentity(JSON.stringify([
    provider.baseUrl.trim().replace(/\/+$/, ""),
    provider.responsesPath ?? "",
    kiroContext?.profileArn ?? "",
    kiroContext?.apiRegion ?? "",
    kiroContext?.ssoRegion ?? "",
  ]));
}

function bindRouteReasoningReplayScope(args: {
  parsed: OcxParsedRequest;
  providerName: string;
  provider: OcxProviderConfig;
  adapterName: string;
  oauthCredentialSnapshot?: Pick<OAuthAccessSnapshot, "accountId" | "generation">;
  codexAuthContext?: CodexAuthContext;
  forwardHeaders?: Headers;
}): void {
  const { parsed, providerName, provider, adapterName } = args;
  let credentialIdentity: string | undefined;
  let credentialDurableIdentity: string | undefined;
  const durableSalt = thoughtSignatureReplaySalt();
  if (provider.authMode === "oauth") {
    credentialIdentity = reasoningReplayOAuthCredentialIdentity(
      args.oauthCredentialSnapshot,
      provider.headers,
    );
    // The persisted account-slot id survives token refresh and restarts; the rotating
    // generation deliberately does NOT participate (#1926 design: rotation-safe).
    credentialDurableIdentity = durableReplayCredentialIdentity(
      "oauth",
      args.oauthCredentialSnapshot?.accountId,
      provider.headers,
      durableSalt,
    );
  } else if (provider.authMode === "forward") {
    const poolContext = args.codexAuthContext?.kind === "pool"
      || args.codexAuthContext?.kind === "main-pool"
      ? args.codexAuthContext
      : undefined;
    credentialIdentity = reasoningReplayCodexCredentialIdentity({
      authorization: poolContext
        ? `Bearer ${poolContext.accessToken}`
        : args.forwardHeaders?.get("authorization"),
      chatgptAccountId: poolContext?.chatgptAccountId
        ?? args.forwardHeaders?.get("chatgpt-account-id"),
      accountId: poolContext?.accountId,
      credentialGeneration: poolContext?.kind === "pool"
        ? poolContext.generation
        : undefined,
      writerGeneration: poolContext?.writerGeneration,
      headers: provider.headers,
    });
    // Durable identity requires a STABLE, TRUSTED account handle. Pool context comes from
    // our own account store; a client-supplied chatgpt-account-id header is attacker
    // -influenceable bucket selection and a bearer alone is rotating material — both are
    // refused, so direct-forward turns get no durable scope (fail closed; the in-process
    // cache still covers same-process replay).
    const codexDurableHandle = poolContext?.accountId
      ?? poolContext?.chatgptAccountId
      ?? undefined;
    credentialDurableIdentity = durableReplayCredentialIdentity(
      "codex",
      codexDurableHandle ?? undefined,
      provider.headers,
      durableSalt,
    );
  } else if (provider.authMode !== "local") {
    credentialIdentity = reasoningReplayKeyCredentialIdentity(provider);
    credentialDurableIdentity = durableReplayCredentialIdentity(
      "key",
      nonEmptyProviderApiKey(provider),
      provider.headers,
      durableSalt,
    );
  }
  const providerDestinationIdentity = reasoningReplayDestinationIdentity(provider.baseUrl);
  const replayIdentity: OcxReasoningReplayIdentity | undefined = credentialIdentity && providerDestinationIdentity
    ? {
        providerName,
        providerDestinationIdentity,
        providerDestinationDurableIdentity: durableReplayDestinationIdentity(provider.baseUrl),
        adapterName,
        modelId: parsed.modelId,
        credentialIdentity,
        ...(credentialDurableIdentity ? { credentialDurableIdentity } : {}),
      }
    : undefined;
  const continuationDestinationIdentity = providerContinuationDestinationIdentity(parsed, provider);
  const continuationOwner = providerContinuationOwnerFromReplayIdentity(
    replayIdentity && continuationDestinationIdentity
      ? { ...replayIdentity, providerDestinationIdentity: continuationDestinationIdentity }
      : undefined,
  );
  if (adapterName === "cursor") {
    // The final route owner is authoritative for Cursor and supersedes the account-derived
    // seed assigned before route binding. A Cursor conversation must be scoped to the exact
    // provider/destination/adapter/model/credential that serves it.
    if (continuationOwner) parsed._cursorIdentityScope = providerContinuationRouteScope(continuationOwner);
    else if (!parsed._cursorIdentityScope?.startsWith("cursor-unowned:")) {
      // Prevent the adapter's token-only fallback from recreating a provider-private id after the
      // route owner failed closed. The sentinel is per parsed request and contains no credential.
      parsed._cursorIdentityScope = `cursor-unowned:${randomUUID()}`;
    }
  }
  bindReasoningReplayScope(
    parsed._reasoningReplayScope,
    replayIdentity,
  );
  // Keep this sticky for the whole outbound request: a later auth/key rebind may compare equal
  // after the first mismatch, but it cannot make history minted by the prior route decodable.
  if (reasoningReplayServingIdentityChanged(parsed._reasoningReplayScope)) {
    parsed._stripReasoningEncryptedContent = true;
  }
  if (reasoningReplayOpaqueBlobRejectionMemoized(parsed._reasoningReplayScope)) {
    parsed._stripReasoningEncryptedContent = true;
  }
  bindProviderContinuationForRoute(parsed, continuationOwner);
}

function adapterResponseReachedServingTerminal(
  events: readonly AdapterEvent[],
  response: Readonly<Record<string, unknown>>,
): boolean {
  return (response.status === "completed" || response.status === "incomplete")
    && events.some(event => event.type === "done" || event.type === "incomplete");
}

const OPAQUE_RESPONSES_INPUT_TYPES = new Set([
  "reasoning",
  "compaction",
  "compaction_summary",
  "context_compaction",
]);

function outboundResponsesBodyCarriesOpaqueBlob(bodyText: string | undefined): boolean {
  if (!bodyText) return false;
  try {
    const body = JSON.parse(bodyText) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const input = (body as { input?: unknown }).input;
    if (!Array.isArray(input)) return false;
    return input.some(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const candidate = item as { type?: unknown; encrypted_content?: unknown };
      return typeof candidate.type === "string"
        && OPAQUE_RESPONSES_INPUT_TYPES.has(candidate.type)
        && typeof candidate.encrypted_content === "string"
        && candidate.encrypted_content.length > 0;
    });
  } catch {
    return false;
  }
}

function isSelfIdentifiedOpaqueBlobRejection(bodyText: string): boolean {
  try {
    const payload = JSON.parse(bodyText) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const record = payload as { code?: unknown; error?: unknown };

    if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
      const error = record.error as { type?: unknown; code?: unknown; message?: unknown };
      if (error.type === "invalid_request_error") {
        if (error.code === "invalid_encrypted_content") return true;
        if (
          (error.code === null || error.code === undefined)
          && typeof error.message === "string"
          && error.message.startsWith("The encrypted content ")
          && error.message.endsWith(
            " could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
          )
        ) return true;
      }
    }

    if (record.code !== "invalid-argument" || typeof record.error !== "string") return false;
    return record.error.startsWith("Could not decode the compaction blob")
      || record.error.startsWith("Could not decrypt the provided encrypted_content");
  } catch {
    return false;
  }
}

/**
 * Whether an upstream Responses 4xx authoritatively rejected opaque replay state.
 *
 * The outbound-body check is intentional: the inbound transcript may contain a proxy envelope or
 * compaction blob that the adapter already lowered, in which case a replay would be byte-identical.
 * OpenAI usually exposes a dedicated nested code; ChatGPT also emits one exact code-less
 * unverifiable-ciphertext message. xAI's code is generic, so its two concrete decoder error
 * identities are also required. Unrelated error prose must never gain a hidden resend.
 */
export function shouldAttemptOpaqueBlobRecovery(args: {
  status: number;
  adapterName: string;
  outboundBody?: string;
  errorBody: string;
  alreadyAttempted: boolean;
}): boolean {
  return args.status >= 400
    && args.status < 500
    && args.adapterName === "openai-responses"
    && !args.alreadyAttempted
    && outboundResponsesBodyCarriesOpaqueBlob(args.outboundBody)
    && isSelfIdentifiedOpaqueBlobRejection(args.errorBody);
}

async function opaqueBlobRejectionBodyForRecovery(
  response: Response,
  outboundBody: string | undefined,
  adapterName: string,
  alreadyAttempted: boolean,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (
    response.status < 400
    || response.status >= 500
    || adapterName !== "openai-responses"
    || alreadyAttempted
    || !outboundResponsesBodyCarriesOpaqueBlob(outboundBody)
  ) return undefined;
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    return body.displaySafe && !body.truncated ? body.text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Materialize an upstream error body only when the bounded reader observed a complete,
 * display-safe payload. Partial timeout and over-limit prefixes are attacker-controlled,
 * so callers keep their existing status-only fallback instead.
 */
export async function readDisplaySafeErrorText(
  response: Response,
  signal: AbortSignal,
  fallback: string,
): Promise<string> {
  try {
    const body = await readBoundedResponseBody(response, { signal });
    return body.displaySafe ? body.text : fallback;
  } catch {
    // Preserve the former Response.text().catch(fallback) contract. Request-abort
    // classification remains owned by the surrounding response pipeline.
    return fallback;
  }
}

interface NormalizedUpstreamErrorText {
  safeText: string;
  message?: string;
  type?: string;
  code?: string;
  cyberPolicy: boolean;
}

/**
 * Extract the structured provider error envelope without making `error.type` authoritative.
 * Policy identity comes from the dedicated code (or the legacy message fallback); a credible
 * upstream type is only carried through so callers do not erase provider diagnostics.
 */
function normalizeUpstreamErrorText(text: string, fallback: string): NormalizedUpstreamErrorText {
  const safeText = redactSecretString(text).slice(0, 500).trim() || fallback;
  let message: string | undefined;
  let type: string | undefined;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const response = parsed.response && typeof parsed.response === "object" && !Array.isArray(parsed.response)
      ? parsed.response as Record<string, unknown>
      : undefined;
    const candidates = [parsed.error, response?.error, response?.last_error, parsed.last_error, parsed];
    const source = candidates.find((candidate): candidate is Record<string, unknown> => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const record = candidate as Record<string, unknown>;
      return [record.message, record.type, record.code].some(value => typeof value === "string");
    });
    if (!source) return { safeText, cyberPolicy: isCyberPolicyMessage(safeText) };
    if (typeof source.message === "string" && source.message.trim()) {
      message = redactSecretString(source.message.trim()).slice(0, 500);
    }
    if (typeof source.type === "string" && source.type.trim()) type = source.type.trim();
    if (typeof source.code === "string" && source.code.trim()) code = source.code.trim();
  } catch {
    /* non-JSON upstream body — retain the bounded display-safe text */
  }
  const cyberPolicy = isCyberPolicyCode(code) || isCyberPolicyMessage(message ?? safeText);
  return { safeText, message, type, code, cyberPolicy };
}

function prepareOpaqueBlobRecovery(parsed: OcxParsedRequest): void {
  parsed._stripReasoningEncryptedContent = true;
}

type OpaqueBlobRecoveryGuard = { attempted: boolean };

type OpaqueBlobRecoveryResult =
  | { kind: "skipped" }
  | { kind: "recovered"; response: Response }
  | { kind: "failed"; response: Response };

async function attemptOpaqueBlobRecovery(
  args: {
    response: Response;
    outboundBody?: string;
    adapterName: string;
    parsed: OcxParsedRequest;
    guard: OpaqueBlobRecoveryGuard;
    signal: AbortSignal;
  },
  rebuild: (kind: AttemptRecoveryKind) => Promise<Response | { failed: Response }>,
): Promise<OpaqueBlobRecoveryResult> {
  const errorBody = await opaqueBlobRejectionBodyForRecovery(
    args.response,
    args.outboundBody,
    args.adapterName,
    args.guard.attempted,
    args.signal,
  );
  if (errorBody === undefined || !shouldAttemptOpaqueBlobRecovery({
    status: args.response.status,
    adapterName: args.adapterName,
    outboundBody: args.outboundBody,
    errorBody,
    alreadyAttempted: args.guard.attempted,
  })) {
    return { kind: "skipped" };
  }

  args.guard.attempted = true;
  const rejectedScope = args.parsed._reasoningReplayScope
    ? {
        clientThreadId: args.parsed._reasoningReplayScope.clientThreadId,
        ...(args.parsed._reasoningReplayScope.current
          ? { current: { ...args.parsed._reasoningReplayScope.current } }
          : {}),
      }
    : undefined;
  prepareOpaqueBlobRecovery(args.parsed);
  try { void args.response.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
  const result = await rebuild("opaque-blob-rejection");
  if (!("failed" in result) && result.ok) {
    rememberReasoningReplayOpaqueBlobRejection(rejectedScope);
  }
  return "failed" in result
    ? { kind: "failed", response: result.failed }
    : { kind: "recovered", response: result };
}

function nonEmptyProviderApiKey(provider: OcxProviderConfig): string | undefined {
  return typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0
    ? provider.apiKey
    : undefined;
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

export function preAuthUpstreamHostCircuitKey(
  route: Pick<RouteResult, "provider" | "providerName" | "codexAccountMode" | "codexAccountId">,
  config: OcxConfig,
  options: { requireResponsesAdapter?: boolean } = {},
): string | null {
  if (
    normalizeUpstreamHostCircuitThreshold(config.upstreamHostCircuitThreshold) === 0
    || route.codexAccountMode !== "pool"
    || route.codexAccountId !== undefined
    || route.provider.authMode !== "forward"
    || (options.requireResponsesAdapter !== false && route.provider.adapter !== "openai-responses")
  ) return null;
  return upstreamHostHealthKey(route.providerName, safeOriginLabel(route.provider.baseUrl ?? ""));
}

export function upstreamHostCircuitOpenResponse(retryAfterSeconds: number): Response {
  return formatErrorResponse(
    503,
    "upstream_host_circuit_open",
    "Provider host is temporarily unavailable",
    { retryAfter: String(retryAfterSeconds) },
  );
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
    codexWsRuntimeIdentity?: BunRuntimeGateInput;
    translatorBudget: TranslatorBudget;
    turnAdmissionLease?: AdmissionLease;
    resolveCodexModelEntitlements?: typeof resolveCodexModelEntitlements;
  };
  firstAuthCtx: Extract<CodexAuthContext, { kind: "pool" | "main-pool" }>;
  firstResponse: Response;
  outcomeStatus: number;
  /**
   * Forbid resolving a DIFFERENT account for this retry.
   *
   * Set when a stored Pool 401 already spent this logical request's account budget on its own
   * refresh and replay. The same-account gated-model retry above stays available, because it
   * sends to the account that was already paying; only the alternate-account resolution below is
   * out of budget.
   */
  sameAccountOnly?: boolean;
  upstream: AbortController;
  connectMs: number;
  passthroughEstimate?: number;
  stream: boolean;
  onResponse?: (
    response: Response,
    authCtx: Extract<CodexAuthContext, { kind: "pool" | "main-pool" }>,
    request: Awaited<ReturnType<ReturnType<typeof resolveAdapter>["buildRequest"]>>,
  ) => void;
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

/** Keep retry-stage entitlement snapshots inside the native-main selection fence. */
async function resolveCodexRetryModelEntitlements(
  config: OcxConfig,
  resolver: typeof resolveCodexModelEntitlements,
  turnAdmissionLease?: AdmissionLease,
): Promise<Awaited<ReturnType<typeof resolveCodexModelEntitlements>>> {
  // The initial auth selection has already released its admission before the first
  // response arrives. Re-enter for every refresh so profile switching cannot overlap
  // credential discovery, and omit main entirely when a drain or recovery owns it.
  const selectionAdmission = codexAccountSelectionForTurn(turnAdmissionLease)?.();
  const nativeMainReadsForbidden = isNativeMainTrafficBlocked()
    || selectionAdmission?.mainProfileDraining === true;
  try {
    return await resolver(config, {
      excludeAccountIds: nativeMainReadsForbidden
        ? new Set([MAIN_CODEX_ACCOUNT_ID])
        : undefined,
    });
  } finally {
    selectionAdmission?.release();
  }
}

const CODEX_ACCOUNT_GATED_CANONICAL_WIRE_MODELS: ReadonlyMap<string, string> = new Map([
  // The authenticated catalog currently advertises Daybreak Blue, while successful responses
  // identify the serving model as gpt-5.6-sol. Sending the selector itself is shard-dependent:
  // live traffic can receive the exact unsupported-model 400 repeatedly from the same entitled
  // account. Keep Daybreak as the admission/catalog identity, but use the stable serving id on
  // the credential-bearing wire after entitlement selection has completed.
  ["gpt-daybreak-blue-latest", "gpt-5.6-sol"],
]);

export function codexAccountGatedCanonicalWireModel(modelId: string): string | undefined {
  const exact = CODEX_ACCOUNT_GATED_CANONICAL_WIRE_MODELS.get(modelId);
  if (exact) return exact;
  for (const [selector, wireModel] of CODEX_ACCOUNT_GATED_CANONICAL_WIRE_MODELS) {
    if (slugsEquivalent(modelId, selector)) return wireModel;
  }
  return undefined;
}

function applyCodexAccountGatedWireNormalization(parsed: OcxParsedRequest, route: RouteResult, logCtx?: RequestLogContext): void {
  if (!isCanonicalOpenAiForwardProvider(route.provider)) return;
  const wireModel = codexAccountGatedCanonicalWireModel(route.modelId);
  if (!wireModel) return;

  if (logCtx) {
    logCtx.preserveResolvedModelFromRoute = true;
    delete logCtx.resolvedModel;
  }
  parsed.modelId = wireModel;
  if (!parsed._rawBody || typeof parsed._rawBody !== "object") return;
  const raw = parsed._rawBody as Record<string, unknown>;
  raw.model = wireModel;
  // Daybreak's authenticated catalog does not advertise retention support, and the upstream
  // rejects this optional Codex hint before model execution. Removing it preserves request
  // semantics while avoiding an otherwise terminal pre-stream 400.
  delete raw.prompt_cache_retention;
}

/**
 * Workspace-denial evidence for a 403, read from the upstream body.
 *
 * #1789: a valid K12 credential gets 403 `codex_workspace_access_denied` on a routed prompt.
 * Without this the account is quarantined for reauthentication, which cannot fix a workspace
 * grant and loops forever. Fails closed: an unreadable body keeps the historical handling.
 */
async function codexDenialOutcomeMeta(response: Response): Promise<{ denial?: "workspace" | "entitlement" }> {
  if (response.status !== 403) return {};
  const { classifyCodexPreStreamRejection } = await import("../../codex/quota-rejection");
  const rejection = await classifyCodexPreStreamRejection(response);
  return rejection.denial ? { denial: rejection.denial } : {};
}

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
  const inboundWire = options.inboundWire ?? "responses";
  const entitlementResolver = options.resolveCodexModelEntitlements ?? resolveCodexModelEntitlements;
  let retryAuthCtx: CodexAuthContext | undefined;
  if (outcomeStatus === 400 && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(route.modelId)) {
    invalidateCodexModelEntitlementsForAccount(firstAuthCtx.accountId);
    let refreshed;
    try {
      refreshed = await resolveCodexRetryModelEntitlements(
        config,
        entitlementResolver,
        options.turnAdmissionLease,
      );
    } catch (error) {
      await firstResponse.body?.cancel().catch(() => undefined);
      releaseCodexAuthContextProbeLease(firstAuthCtx);
      throw error;
    }
    if (entitledCodexAccountIdsForModel(refreshed, route.modelId)?.has(firstAuthCtx.accountId)) {
      // The authenticated roster still grants this exact model. Retry on the same account:
      // upstream shards can briefly disagree during a gated-model rollout, but a pre-stream 400
      // proves no output was committed and keeps this replay bounded.
      retryAuthCtx = firstAuthCtx;
    }
  }
  // Exact account selectors may retry the same confirmed account above, but must never resolve
  // an alternate. Quota failures and a refreshed entitlement miss remain terminal.
  if (!retryAuthCtx && (firstAuthCtx.fixedAccount || args.sameAccountOnly === true)) {
    return { kind: "no-alternate" };
  }
  try {
    retryAuthCtx ??= await resolveCodexAuthContext(
        req.headers,
        config,
        "pool",
        {
          excludeAccountId: firstAuthCtx.accountId,
          modelId: route.modelId,
          requestScopedMainCredential: hasForwardableCodexBearer(req.headers, config),
          beginCodexAccountSelection: codexAccountSelectionForTurn(options.turnAdmissionLease),
          resolveCodexModelEntitlements: entitlementResolver,
        },
      );
  } catch (error) {
    const unexpectedRetryError =
      !(error instanceof CodexPoolAuthenticationError)
      && !(error instanceof CodexAuthContextError)
      && !(error instanceof CodexAccountCooldownError)
      && !(error instanceof CodexMainProfileDrainingError);
    if (unexpectedRetryError) {
      await firstResponse.body?.cancel().catch(() => undefined);
      releaseCodexAuthContextProbeLease(firstAuthCtx);
      throw error;
    }
  }
  if (retryAuthCtx?.kind !== "pool" && retryAuthCtx?.kind !== "main-pool") {
    return { kind: "no-alternate" };
  }

  const quotaMeta = { ...codexQuotaOutcomeMeta(firstResponse), ...(await codexDenialOutcomeMeta(firstResponse)) };
  if (outcomeStatus === 429 || outcomeStatus === 402) {
    const { applyAccountQuotaFromUpstreamHeaders } = await import("../../codex/auth-api");
    applyAccountQuotaFromUpstreamHeaders(
      firstAuthCtx.accountId,
      firstResponse.headers,
      firstAuthCtx.writerGeneration,
    );
  }
  const deferFirstOutcome = shouldDeferCodexResetDerivedCooldown(
    firstResponse,
    options.deferCodexResetDerivedCooldown,
  );
  const recordFirstOutcome = (): void => {
    recordCodexUpstreamOutcome(config, firstAuthCtx.accountId, outcomeStatus, {
      ...quotaMeta,
      threadId: firstAuthCtx.affinityKey,
      modelId: route.modelId,
      probeLeaseId: codexProbeLeaseId(firstAuthCtx),
      probeQuotaScope: codexProbeQuotaScope(firstAuthCtx),
      writerGeneration: firstAuthCtx.writerGeneration,
      // Retry already advanced the RR ring via excludeAccountId — reuse for promotion.
      ...(retryAuthCtx.accountId ? { promoteAccountId: retryAuthCtx.accountId } : {}),
    });
  };
  // Only a combo reset-derived outcome is deferred. Retry-After, defaults, and
  // ordinary requests must block the first account before the alternate send.
  if (!deferFirstOutcome) recordFirstOutcome();
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
  bindRouteReasoningReplayScope({
    parsed,
    providerName: route.providerName,
    provider: retryProvider,
    adapterName: retryAdapter.name,
    codexAuthContext: retryAuthCtx,
    forwardHeaders: retryHeaders,
  });
  const request = await retryAdapter.buildRequest(parsed, {
    headers: retryHeaders,
    translatorBudget: options.translatorBudget,
  });
  recordAdapterReasoning(logCtx, request);
  recordAdapterTier(logCtx, request);

  await firstResponse.body?.cancel().catch(() => undefined);
  options.onCodexAuthContextResolved?.(retryAuthCtx);
  route.provider = retryProvider;
  logCtx.provider = formatCodexProviderForLog(
    route.providerName,
    retryAuthCtx.accountId,
    config,
  );
  logCtx.accountLogLabel = codexAuthContextLogLabel(retryAuthCtx, config);
  sealRequestAttemptIdentity(
    logCtx.activeAttempt,
    logCtx.provider,
    retryAdapter.name,
    logCtx.accountLogLabel,
  );

  const retrySameConfirmedAccount = outcomeStatus === 400
    && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(route.modelId)
    && retryAuthCtx.accountId === firstAuthCtx.accountId;
  // Live Daybreak traffic has produced long runs of unsupported-model 400s from different
  // upstream shards even while the authenticated roster continues to grant the model. Permit
  // seven additional same-account sends (eight total including the original), re-checking the
  // exact allow-listed body and fresh entitlement before every later send. Alternate-account and
  // quota recovery retain their historical one-send bound.
  const maxRetrySends = retrySameConfirmedAccount ? 7 : 1;
  let retrySendCount = 0;
  let upstreamResponse: Response;
  try {
    while (true) {
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
          stream,
          providerFetch(route.provider, options.codexWsRuntimeIdentity, {
            providerName: route.providerName,
            modelId: route.modelId,
          }),
          // Credential-bearing forward send: never follow a redirect into a
          // dead-host rejection after the credential was seen (#914).
          route.provider.authMode === "forward",
        );
      } catch (error) {
        // Only the forward send is a transport boundary. Entitlement resolver throws below are
        // deliberately outside this catch so programming errors retain their original path.
        return { kind: "transport", error, authCtx: retryAuthCtx };
      }
      retrySendCount += 1;
      args.onResponse?.(upstreamResponse, retryAuthCtx, request);
      if (!retrySameConfirmedAccount || retrySendCount >= maxRetrySends) break;
      if (!await shouldRetryCodexPoolAccountModel400(
        upstreamResponse,
        route.modelId,
        options.abortSignal,
      )) break;
      invalidateCodexModelEntitlementsForAccount(retryAuthCtx.accountId);
      let refreshed: Awaited<ReturnType<typeof resolveCodexModelEntitlements>>;
      try {
        refreshed = await resolveCodexRetryModelEntitlements(
          config,
          entitlementResolver,
          options.turnAdmissionLease,
        );
      } catch (error) {
        await upstreamResponse.body?.cancel().catch(() => undefined);
        await firstResponse.body?.cancel().catch(() => undefined);
        releaseCodexAuthContextProbeLease(firstAuthCtx);
        releaseCodexAuthContextProbeLease(retryAuthCtx);
        throw error;
      }
      if (!entitledCodexAccountIdsForModel(refreshed, route.modelId)?.has(retryAuthCtx.accountId)) break;
      await upstreamResponse.body?.cancel().catch(() => undefined);
    }
  } finally {
    request.releaseBodyObservation?.();
  }
  // A real HTTP response proves the host was reached (#914).
  const retryHostKey = upstreamHostHealthKey(route.providerName, safeOriginLabel(request.url));
  if (normalizeUpstreamHostCircuitThreshold(config.upstreamHostCircuitThreshold) > 0) {
    resetUpstreamHostHealth(retryHostKey, null);
  } else {
    resetUpstreamHostHealth(retryHostKey);
  }
  if (deferFirstOutcome && upstreamResponse.ok) {
    // Deferral keeps the first account eligible for a later combo model while an
    // alternate attempt is still fallible. Commit its quota outcome only once the
    // alternate account returns a successful HTTP response; otherwise the combo may
    // still need the first account for its next target.
    recordFirstOutcome();
  }
  return {
    kind: "retried",
    authCtx: retryAuthCtx,
    request,
    upstreamResponse,
    selectedForwardHeaders: retryHeaders,
  };
}



export function codexForwardTerminalOutcomeRecorder(
  config: OcxConfig,
  authCtx: CodexAuthContext,
  provider: OcxProviderConfig,
  modelId?: string,
  logCtx?: RequestLogContext,
): ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined {
  if (!usesCodexForwardPoolAuth(authCtx, provider)) return undefined;
  return (status, httpStatusOverride) => {
    if (status === "incomplete") {
      // Normal limit/content-filter/stall terminal — the account served the
      // request. Don't penalize account health; record success to clear any
      // prior soft-avoid so a healthy account isn't stuck avoided.
      recordCodexUpstreamOutcome(config, authCtx.accountId, 200, {
        threadId: authCtx.affinityKey,
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
      threadId: authCtx.affinityKey,
      fixedAccount: authCtx.fixedAccount,
      modelId,
      probeLeaseId: codexProbeLeaseId(authCtx),
      probeQuotaScope: codexProbeQuotaScope(authCtx),
      writerGeneration: authCtx.writerGeneration,
      // A mid-stream terminal can carry a semantic 401 long after the credential was
      // replaced. It is never replayed — the client already saw output — but it must
      // not retire the replacement either (#2887).
      ...(authCtx.kind === "pool" ? { credentialGeneration: authCtx.generation } : {}),
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
  /**
   * How the caller proved data-plane admission (#1686).
   *
   * A bearer-presented admission secret is one of OUR OWN secrets, so a Direct turn must
   * SUBSTITUTE the stored main credential rather than forward it. Without this fact at the
   * decision point, Direct cannot tell an admission bearer from the user own ChatGPT bearer,
   * which is why it refused the whole env_key flow instead of serving it.
   */
  admission?: DataPlaneAdmission;
  /** Called at most once after the complete client body is read and accepted for dispatch. */
  onRequestBodyRead?: () => void;
  forceEmptyResponseId?: boolean;
  abortSignal?: AbortSignal;
  /** One-shot TTFT callback: first non-empty model output observed (WP4). */
  onFirstOutput?: () => void;
  onCodexAuthContextResolved?: (context: CodexAuthContext | undefined) => void;
  /** Internal deterministic seam for account-gated native fallback tests. */
  resolveCodexModelEntitlements?: typeof resolveCodexModelEntitlements;
  recordTerminalOutcomes?: boolean;
  setTerminalOutcomeRecorder?: (recorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined) => void;
  onNativePassthroughTerminal?: (status: ResponsesTerminalStatus) => void;
  onNativePassthroughCancel?: () => void;
  /** Internal deterministic clock/timer seam for provider terminal repair. */
  responsesTerminalRepairScheduler?: ResponsesTerminalRepairScheduler;
  /** Internal deterministic runtime-identity seam for Codex upstream WS selection tests. */
  codexWsRuntimeIdentity?: BunRuntimeGateInput;
  /** Test seam for native main refresh without live OAuth traffic. */
  nativeMainRefreshDependencies?: NativeMainRefreshDependencies;
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
  /**
   * Claude replay may add native-main auth so OpenAI sidecars remain available.
   * Strip only that internal credential when the final route is a noncanonical
   * forward destination; final routing can differ from Claude's preflight route.
   */
  stripClaudeMainAuthForNoncanonicalForward?: boolean;
  /** Internal recursion guard; callers outside this module must not set it. */
  comboAttempt?: boolean;
  /** Internal combo handoff for one parent-validated continuation snapshot. */
  comboReplaySnapshot?: {
    sourceBody: unknown;
    previousResponseInputExpanded: boolean;
    providerContinuation: OcxProviderContinuationState | undefined;
    recoveredPlaintext: boolean;
  };
  /** Internal combo handoff: allow a later same-provider model after a reset-derived 429/402. */
  deferCodexResetDerivedCooldown?: boolean;
  /** 030-owned handoff when a child consumed the original failure under bounds. */
  onConsumedComboFailure?: (failure: ConsumedComboFailure) => void;
  /** A stored Pool credential was refreshed and its one allowed same-account replay was sent. */
  onStoredPool401ReplayDispatched?: () => void;
  /** Caller-owned for Chat/Claude replay; omitted only at genuine Responses ingress. */
  translatorBudget?: TranslatorBudget;
  /**
   * Terminal vision-describe marker (roadmap 180): true when the inbound
   * request IS the vision sidecar's own loopback describe call. The plan site
   * then STRIPS images instead of planning another describe — a depth cap of 1
   * that holds under predicate drift and combo re-resolution. The Chat surface
   * detects the raw `x-opencodex-vision-describe` header before its bridge
   * rebuilds headers and carries the fact through this flag.
   */
  visionDescribeTerminal?: boolean;
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
  let upstreamMessage: string | undefined;
  let upstreamType: string | undefined;
  try {
    const body = await readBoundedResponseBody(response, { signal });
    usage = usageFromComboFailureText(body.text);
    if (body.displaySafe) {
      const normalized = normalizeUpstreamErrorText(body.text, fallback);
      classificationText = normalized.safeText;
      upstreamCode = normalized.code;
      upstreamMessage = normalized.message;
      upstreamType = normalized.type;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    classificationText = fallback;
  }
  const cyberFailure = isCyberPolicyCode(upstreamCode) || isCyberPolicyMessage(classificationText);
  const normalizedUpstreamCode = cyberFailure ? CYBER_POLICY_ERROR_CODE : upstreamCode;
  const message = cyberFailure
    ? upstreamMessage
      ?? (isCyberPolicyCode(upstreamCode) ? CYBER_POLICY_FALLBACK_MESSAGE : classificationText)
    : classificationText === fallback
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
    response: formatErrorResponse(
      response.status,
      cyberFailure ? (upstreamType ?? CYBER_POLICY_ERROR_CODE) : "upstream_error",
      message,
      {
        ...(normalizedUpstreamCode !== undefined ? { code: normalizedUpstreamCode } : {}),
        ...(clientRetryAfter !== undefined ? { retryAfter: clientRetryAfter } : {}),
      },
    ),
    classificationText,
    ...(normalizedUpstreamCode !== undefined ? { upstreamCode: normalizedUpstreamCode } : {}),
    ...(!cyberFailure && cooldownRetryAfter !== undefined ? { retryAfter: cooldownRetryAfter } : {}),
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
const MAX_FAST_WIRE_CAPABILITY_WARNINGS = 256;
const warnedFastWireCapabilityGaps = new Set<string>();

function warnFastWireCapabilityGap(providerName: string, modelId: string): void {
  const safeProvider = sanitizeLogMetadataString(providerName) ?? "unknown";
  const safeModel = sanitizeLogMetadataString(modelId) ?? "unknown";
  const key = `${safeProvider}\0${safeModel}`;
  if (warnedFastWireCapabilityGaps.has(key)) return;
  if (warnedFastWireCapabilityGaps.size >= MAX_FAST_WIRE_CAPABILITY_WARNINGS) {
    const oldest = warnedFastWireCapabilityGaps.values().next().value;
    if (oldest !== undefined) warnedFastWireCapabilityGaps.delete(oldest);
  }
  warnedFastWireCapabilityGaps.add(key);
  console.warn(
    `[opencodex] Fast policy for ${safeProvider}/${safeModel} has service-tier capability but no Fast wire; preserving only caller-permitted tier behavior`,
  );
}
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
  | { ok: true; authCtx: CodexAuthContext; headers: Headers; substituteMainCredential: boolean }
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
    // #1686: a caller that proved admission with a BEARER presented one of our own secrets.
    // Refusing it here is what made the codex-cli `env_key` contract unusable against Direct.
    // Admitting it is only safe because the stored main credential is substituted below, so
    // the admission secret still never leaves this process.
    //
    // #2132: substitution answers "does THIS ROUTE need our stored ChatGPT credential", not
    // "how did the caller authenticate". Only a native Codex route reaches the ChatGPT backend
    // and can consume that credential; a key-authenticated routed provider carries its own and
    // never touches it. Keying on the caller alone made an install that deliberately never
    // logged into ChatGPT fail every routed request with "No usable Codex main credential".
    //
    // But ask that question the way the ADAPTER asks it. `codexAccountMode` is derived from the
    // provider NAME (`providerCodexAccountMode`), while the passthrough adapter decides whether
    // to forward caller credentials from the TRANSPORT — adapter, auth mode, and base URL
    // (`isCanonicalOpenAiForwardProvider`). A row the operator named anything other than
    // `openai`, pointed at the canonical ChatGPT backend with `authMode: "forward"`, satisfies
    // the adapter's test and fails this one, so substitution was skipped and the adapter then
    // forwarded our own admission secret upstream. Two predicates answering one question is the
    // bug; the transport is the authority, because the transport is what actually carries the
    // header. A key-authenticated routed provider is still not canonical-forward, so #2132's
    // no-ChatGPT-login install keeps working.
    const substituteMainCredential = options.admission?.source === "bearer"
      && (route.codexAccountMode !== undefined || isCanonicalOpenAiForwardProvider(route.provider));
    const requestScopedMainCredential = route.codexAccountMode !== undefined
      && !substituteMainCredential
      && hasForwardableCodexBearer(req.headers, config);
    if (route.codexAccountMode === "direct" && !substituteMainCredential) {
      validateForwardAdmissionCredential(req.headers, config);
    }
    let authCtx: CodexAuthContext;
    if (route.codexAccountMode) {
      authCtx = await resolveCodexAuthContext(req.headers, config, route.codexAccountMode, {
        accountId: route.codexAccountId,
        modelId: route.modelId,
        substituteMainCredentialForDirect: substituteMainCredential,
        requestScopedMainCredential,
        beginCodexAccountSelection: codexAccountSelectionForTurn(options.turnAdmissionLease),
        resolveCodexModelEntitlements: options.resolveCodexModelEntitlements,
        signal: options.abortSignal,
        nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
      });
      options.onCodexAuthContextResolved?.(authCtx);
    } else {
      // A custom-named canonical-forward provider has no Codex account mode, but an
      // admission bearer still substitutes the stored main credential below. Claim the
      // same physical profile before synthesizing the main context so transport-based
      // substitution cannot bypass a switch drain.
      if (
        substituteMainCredential
        && (
          isNativeMainTrafficBlocked()
          || !tryClaimNativeMainProfileForTurn(options.turnAdmissionLease)
          || isNativeMainTrafficBlocked()
        )
      ) {
        throw new CodexMainProfileDrainingError();
      }
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
      headers: await materializeCodexUpstreamAuthAsync(req.headers, authCtx, {
        substituteMainCredential,
        signal: options.abortSignal,
        nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
      }),
      substituteMainCredential,
    };
  } catch (err) {
    if (err instanceof CodexAuthContextError) {
      const safeAccountLabel = route.codexAccountNamespace
        ? `${route.providerName}-${route.codexAccountNamespace}`
        : formatCodexProviderForLog(route.providerName, err.accountId, config);
      console.error(`[codex-auth] Pool account ${safeAccountLabel} token failed; reauthentication required`);
    }
    if (err instanceof ForwardAdmissionCredentialError) {
      return { ok: false, response: formatErrorResponse(401, "authentication_error", err.message) };
    }
    const response = mapCodexAuthContextErrorToResponse(err, {
      accountSelector: route.codexAccountNamespace,
      now: Date.now(),
    });
    if (response) return { ok: false, response };
    throw err;
  }
}

/**
 * Terminal means the grant itself is dead and no retry can help. Everything else —
 * an untyped network failure, a token-endpoint 5xx surfacing as `unknown`, an abort,
 * refresh capacity, lock contention, a superseded flight — is transient, and treating
 * it as terminal would quarantine a healthy account on an upstream blip, which is the
 * defect this path exists to fix (#2887).
 */
function isTerminalPoolRefreshFailure(error: unknown): boolean {
  return error instanceof TokenRefreshError && (error.reason === "revoked" || error.reason === "expired");
}

/**
 * One forced refresh and one same-account rebuild for a stored pool credential that
 * upstream rejected with a pre-stream 401. `quarantine` distinguishes a dead grant,
 * which must retire the account, from a transient failure, which must not.
 */
async function refreshPoolForwardAuth(args: {
  req: Request;
  route: RouteResult;
  authCtx: CodexAuthContext & { kind: "pool" };
  substituteMainCredential: boolean;
  options: HandleResponsesOptions;
}): Promise<
  | { ok: true; authCtx: CodexAuthContext; provider: OcxProviderConfig; headers: Headers }
  | { ok: false; response: Response; quarantine: boolean; quarantineGeneration?: number }
> {
  const { req, route, authCtx, substituteMainCredential, options } = args;
  try {
    const refreshed = await forceRefreshCodexPoolToken(authCtx.accountId, {
      rejectedGeneration: authCtx.generation,
      rejectedAccessToken: authCtx.accessToken,
      signal: options.abortSignal,
    });
    if (!refreshed.rotated) {
      // The store resolved to the same bearer upstream just rejected. Replaying it
      // would spend another upstream call to earn the identical 401. Upstream can do
      // this on a SUCCESSFUL response by rotating only the refresh grant, so the
      // credential generation may already have moved — quarantine has to be fenced on
      // where the credential actually is, not on the generation we started from.
      return {
        ok: false,
        quarantine: true,
        quarantineGeneration: refreshed.generation,
        response: formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication"),
      };
    }
    // Only a CAS this request performed itself proves the new credential descends from
    // the rejected one. Somebody else's replacement may be a different identity, and
    // its affinity must be retired rather than inherited.
    if (refreshed.selfRefreshed) {
      handOffThreadAffinityGeneration(authCtx.accountId, authCtx.generation, refreshed.generation);
    }
    const refreshedAuthCtx: CodexAuthContext = {
      ...authCtx,
      accessToken: refreshed.accessToken,
      chatgptAccountId: refreshed.chatgptAccountId,
      generation: refreshed.generation,
    };
    const provider = applyCodexAuthContextToProvider(
      stripCodexRuntimeProviderFields(route.provider),
      refreshedAuthCtx,
      route.codexAccountMode,
    );
    const headers = await materializeCodexUpstreamAuthAsync(req.headers, refreshedAuthCtx, {
      substituteMainCredential,
      signal: options.abortSignal,
      nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
    });
    return { ok: true, authCtx: refreshedAuthCtx, provider, headers };
  } catch (error) {
    if (isTerminalPoolRefreshFailure(error)) {
      return {
        ok: false,
        quarantine: true,
        response: formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication"),
      };
    }
    const response = formatErrorResponse(
      503,
      "server_busy",
      "Codex credential refresh did not complete; retry this request",
    );
    const headers = new Headers(response.headers);
    headers.set("Retry-After", "1");
    return { ok: false, quarantine: false, response: new Response(response.body, { status: response.status, headers }) };
  }
}

async function refreshNativeMainForwardAuth(args: {
  req: Request;
  route: RouteResult;
  authCtx: CodexAuthContext;
  substituteMainCredential: boolean;
  options: HandleResponsesOptions;
}): Promise<
  | { ok: true; authCtx: CodexAuthContext; provider: OcxProviderConfig; headers: Headers }
  | { ok: false; response: Response }
> {
  const { req, route, authCtx, substituteMainCredential, options } = args;
  if (authCtx.kind !== "main-pool") {
    return { ok: false, response: formatErrorResponse(401, "authentication_error", "No native main credential to refresh") };
  }
  try {
    const refreshed = await forceRefreshMainAccountToken(authCtx.accessToken, {
      signal: options.abortSignal,
      ...(options.nativeMainRefreshDependencies ?? {}),
    });
    if (!refreshed) {
      return { ok: false, response: formatErrorResponse(401, "authentication_error", "Codex main account needs reauthentication") };
    }
    const refreshedAuthCtx: CodexAuthContext = {
      ...authCtx,
      accessToken: refreshed.accessToken,
      chatgptAccountId: refreshed.chatgptAccountId,
    };
    const provider = applyCodexAuthContextToProvider(
      stripCodexRuntimeProviderFields(route.provider),
      refreshedAuthCtx,
      route.codexAccountMode,
    );
    const headers = await materializeCodexUpstreamAuthAsync(req.headers, refreshedAuthCtx, {
      substituteMainCredential,
      signal: options.abortSignal,
      nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
    });
    return { ok: true, authCtx: refreshedAuthCtx, provider, headers };
  } catch (error) {
    return { ok: false, response: nativeMainRefreshFailureResponse(error) };
  }
}

async function resolveSubagentFallbackModelEligibility(args: {
  config: OcxConfig;
  fallbackChain: readonly string[] | null;
  nativeMainReadsForbidden: boolean;
  resolver: typeof resolveCodexModelEntitlements;
}): Promise<SubagentModelEligibleAccountIds | undefined> {
  if (!subagentFallbackNeedsModelEntitlements(args.fallbackChain, args.config)) return undefined;
  const excludeAccountIds = args.nativeMainReadsForbidden
    ? new Set([MAIN_CODEX_ACCOUNT_ID])
    : undefined;
  const snapshot = await args.resolver(args.config, { excludeAccountIds });
  return (modelId) => {
    const entitledAccountIds = entitledCodexAccountIdsForModel(snapshot, modelId);
    return entitledAccountIds
      ? new Set([...entitledAccountIds].filter(accountId => !excludeAccountIds?.has(accountId)))
      : undefined;
  };
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

  // Only Anthropic message routes retain the Codex-facing selector. Other providers must keep
  // their existing response.model contract even when their public and wire model ids differ.
  const responseModelId = parsed.modelId;
  const preserveAnthropicResponseModel = route.providerName === "anthropic"
    || route.provider.adapter === "anthropic";

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
  if (preserveAnthropicResponseModel) parsed._responseModelId = responseModelId;
  logCtx.model = route.modelId;
  logCtx.provider = route.providerName;
  logCtx.providerAdapter = route.provider.adapter;
  logCtx.routeDecision = route.routeDecision;
  if (route.routeReason === "model-alias" || route.modelId !== responseModelId && responseModelId.includes("/")) logCtx.requestedAlias = responseModelId;

  if (responsesUpstreamStreaming === false && route.provider.adapter === "openai-responses") {
    parsed.stream = false;
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      (parsed._rawBody as Record<string, unknown>).stream = false;
    }
  }

  // Generic Responses clients (e.g. AI-SDK apps) omit `store`, but the canonical
  // forward Codex backend rejects a native request without an explicit store:false.
  // Default it only there — every other Responses upstream (key-auth providers and
  // custom forward gateways) intentionally keeps the omitted-store server-side
  // default for previous_response_id reuse — and never override an explicit value.
  if (
    isCanonicalOpenAiForwardProvider(route.provider)
    && parsed._rawBody && typeof parsed._rawBody === "object"
    && (parsed._rawBody as Record<string, unknown>).store === undefined
  ) {
    (parsed._rawBody as Record<string, unknown>).store = false;
  }

  // Final selected model before virtual wire-model rewriting (Pro aliases).
  const finalSelectedModelId = route.modelId;

  // Virtual model rewriting: Pro aliases → base model + reasoning.mode="pro".
  applyOpenAiVirtualModel(parsed, route, logCtx);
  if (parsed._responseModelId !== undefined && parsed._responseModelId !== parsed.modelId) {
    logCtx.resolvedModel = route.modelId;
    logCtx.preserveResolvedModelFromRoute = true;
  }

  // Resolve Fast policy after the final route/wire settles. A1 records the decision on parsed
  // options; the Responses adapter owns the final outbound body write.
  const fastPolicy = fastPolicyForModel(
    route.provider,
    route.modelId,
    route.providerName,
    inboundWire,
    config.providers[route.providerName],
  );
  const modelServiceTierSupport = serviceTierSupportFromPolicy(fastPolicy);
  const callerTier = parsed.options.serviceTier;
  // The ChatGPT-internal Codex backend echoes `service_tier: "default"` even on turns it
  // scheduled as priority, so its echo cannot confirm OR deny Fast. Believing it reported every
  // Fast request as `response-declined` (#2558). The public API's echo stays authoritative.
  parsed.options.tierObservation = tierObservationContext(
    fastPolicy,
    config.fastMode,
    callerTier,
    isCanonicalOpenAiForwardProvider(route.provider) ? false : undefined,
  );
  parsed.options.tierDecision = decideTier(fastPolicy, config.fastMode, callerTier);
  parsed.options.serviceTier = tierValueAfterDecision(parsed.options.tierDecision, callerTier);
  if (fastPolicy.capability === true && fastPolicy.fastWire === null) {
    warnFastWireCapabilityGap(route.providerName, route.modelId);
  }
  applyServiceTierGate(
    route.provider,
    parsed._rawBody,
    parsed.options,
    route.modelId,
    route.providerName,
    inboundWire,
    fastPolicy,
  );
  if (modelServiceTierSupport === false) {
    logCtx.requestedServiceTier = undefined;
    logCtx.requestedSpeedLabel = undefined;
  }

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
  logCtx.modelSupportsServiceTier = SERVICE_TIER_ADAPTERS.has(route.provider.adapter)
    ? modelServiceTierSupport
    : undefined;
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
  // Expand previous_response_id before image policy and child dispatch so a
  // continuation that only references prior images still fails closed when
  // imageInput is disabled (and so targets see the full replayed input).
  const inboundClientThreadId = req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  const body = expandPreviousResponseInput(rawBody, inboundClientThreadId);
  const scopeMismatch = previousResponseScopeMismatch(body);
  if (scopeMismatch) {
    console.warn("[opencodex] dropped a previous_response_id with a mismatched client task scope; continuing fresh");
  }
  if (previousResponseReplayFailure(body)) {
    return formatErrorResponse(
      400,
      "previous_response_not_found",
      "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
    );
  }
  // Missing state returns the original body without a failure marker. Reject
  // that unresolved continuation for image-disabled combos so a target cannot
  // resolve prior images out of band. A successful expansion yields a new
  // object (still carrying previous_response_id) and must not be treated as
  // unresolved — text-only stored continuations remain allowed.
  const requestedPreviousId = typeof (rawBody as { previous_response_id?: unknown } | null)?.previous_response_id === "string"
    ? (rawBody as { previous_response_id: string }).previous_response_id.trim()
    : "";
  const unresolvedPrevious = requestedPreviousId.length > 0 && body === rawBody;
  if (combo.imageInput === "disabled" && unresolvedPrevious) {
    return formatErrorResponse(
      400,
      "previous_response_not_found",
      "Continuation state is unavailable or corrupt; resend the full conversation without previous_response_id.",
    );
  }
  if (combo.imageInput === "disabled" && comboRequestHasImageInput(body)) {
    return formatErrorResponse(400, "invalid_request_error", `Combo "${comboId}" does not accept image input`);
  }
  const comboReplaySnapshot = {
    sourceBody: body,
    previousResponseInputExpanded: body !== rawBody
      && typeof (body as { previous_response_id?: unknown }).previous_response_id === "string",
    providerContinuation: !scopeMismatch && body !== rawBody && requestedPreviousId
      ? previousResponseProviderState(requestedPreviousId)
      : undefined,
    recoveredPlaintext: false,
  };
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
    (body as { input?: unknown } | undefined)?.input,
  );
  const canDecryptUnreadableAgentTask = (target: (typeof combo.targets)[number]): boolean => {
    const provider = config.providers[target.provider];
    if (!provider || provider.disabled === true) return false;
    try {
      const route = routeConcreteModel(config, `${target.provider}/${target.model}`);
      return isCanonicalOpenAiForwardProvider(route.provider);
    } catch {
      return false;
    }
  };
  let comboPayloadReadable = false;
  const payloadEligible = (target: (typeof combo.targets)[number]): boolean =>
    comboPayloadReadable || !unreadableEncryptedAgentTask || canDecryptUnreadableAgentTask(target);
  const initialNow = Date.now();
  let pick: ReturnType<typeof pickComboTarget> = null;

  if (unreadableEncryptedAgentTask && !combo.targets.some(canDecryptUnreadableAgentTask)) {
    const recovery = agentTaskRecoveryConfig(config);
    if (
      (options.inboundWire ?? "responses") !== "responses"
      || !isThreadSpawnRequest(req.headers)
      || !recovery
      || options.comboAttempt
    ) {
      discardEncryptedAgentTaskRecovery(
        req,
        (body as { input?: unknown } | undefined)?.input,
        config,
        { parentThreadId: inboundClientThreadId },
      );
      return unreadableEncryptedAgentTaskResponse();
    }
    pick = pickComboTarget(config, comboId, {
      eligible: target => !isComboTargetInCooldown(comboId, target, initialNow),
    });
    if (!pick) {
      discardEncryptedAgentTaskRecovery(
        req,
        (body as { input?: unknown } | undefined)?.input,
        config,
        { parentThreadId: inboundClientThreadId },
      );
      return comboUnavailableResponse(`No available targets for combo: ${comboId}`);
    }
    let recovered = false;
    try {
      recovered = await recoverEncryptedAgentTask(
        req,
        (body as { input?: unknown } | undefined)?.input,
        recovery,
        config,
        { parentThreadId: inboundClientThreadId, abortSignal: options.abortSignal },
      );
    } catch {
      recovered = false;
    }
    // Recovery has the same in-place input mutation contract as the direct routed path.
    if (
      !recovered
      || hasUnreadableEncryptedAgentTask((body as { input?: unknown } | undefined)?.input)
    ) {
      discardEncryptedAgentTaskRecovery(
        req,
        (body as { input?: unknown } | undefined)?.input,
        config,
        { parentThreadId: inboundClientThreadId },
      );
      return unreadableEncryptedAgentTaskResponse();
    }
    comboPayloadReadable = true;
    comboReplaySnapshot.recoveredPlaintext = true;
  } else {
    pick = pickComboTarget(config, comboId, {
      eligible: target => payloadEligible(target)
        && !isComboTargetInCooldown(comboId, target, initialNow),
    });
  }

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
    const targetRoute = routeConcreteModel(config, `${pick.target.provider}/${pick.target.model}`);
    const childBody = concreteComboRequestBody(
      body,
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
        childLog.accountLogLabel,
      );
      finishRequestAttempt(attempt, 499, Date.now() - started, childLog.usage);
      (logCtx.attempts ??= []).push(attempt);
      attemptRetained = true;
    };
    let consumedChildFailure: ConsumedComboFailure | undefined;
    let storedPool401ReplayDispatched = false;
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
        comboReplaySnapshot,
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
        onStoredPool401ReplayDispatched: () => { storedPool401ReplayDispatched = true; },
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

    if (response.ok && !runTurnAdapterSseResponses.has(response)) {
      const nativePassthrough = isNativePassthroughSseResponse(response);
      const eagerRelay = isEagerRelaySseResponse(response);
      let preflight;
      try {
        preflight = await preflightComboStreamResponse(response, childLog);
      } catch (error) {
        callbackGate.discard();
        if (options.abortSignal?.aborted) {
          retainCancelledAttempt();
          return clientCancelledResponse();
        }
        throw error;
      }
      if (preflight.kind === "failed") {
        callbackGate.discard();
        terminalRecorder?.("failed", preflight.response.status);
        response = preflight.response;
      } else {
        response = preflight.response;
        if (nativePassthrough) markNativePassthroughSseResponse(response);
        if (eagerRelay) markEagerRelaySseResponse(response);
      }
    }

    if (response.ok) {
      sealRequestAttemptIdentity(
        attempt,
        childLog.provider,
        childLog.providerAdapter ?? attempt.adapter,
        childLog.accountLogLabel,
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
      childLog.accountLogLabel,
    );
    finishRequestAttempt(
      attempt,
      failure.response.status,
      Date.now() - started,
      failure.usage,
    );
    (logCtx.attempts ??= []).push(attempt);
    attemptRetained = true;
    lastFailure = failure.response;
    if (storedPool401ReplayDispatched) {
      adoptFailedChildLog(childLog);
      return lastFailure;
    }
    if (comboFailureDecision(failure.response.status, failure.classificationText, {
      code: failure.upstreamCode,
    }) === "stop") {
      adoptFailedChildLog(childLog);
      return lastFailure;
    }
    console.warn(
      `[combo] ${comboId}: ${targetKey(pick.target)} failed with ${failure.response.status} after ${Date.now() - started}ms`,
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
 * supplied one (fail closed). A policy-produced canonical Fast decision has
 * already passed capability validation and cannot be vetoed by Chat's caller
 * forwarding permission. On unclassified routes every caller tier remains subject
 * to `forwardCallerTier`.
 */
export function applyServiceTierGate(
  provider: OcxProviderConfig,
  rawBody: unknown,
  options: { serviceTier?: string; tierDecision?: TierDecision },
  modelId?: string,
  providerName?: string,
  inbound: InboundWire = "responses",
  resolvedPolicy?: ResolvedFastPolicy,
): void {
  // A direct unit caller without a model id retains the historical tri-state behavior for
  // adapters outside the OpenAI service-tier family. Once a model is known, resolve the final
  // model adapter as well: an explicit override to Anthropic (or another non-OpenAI wire) must
  // not carry a caller-supplied `service_tier` through a route that cannot forward it.
  if (modelId === undefined && !SERVICE_TIER_ADAPTERS.has(provider.adapter)) return;
  const policy = modelId === undefined
    ? undefined
    : resolvedPolicy ?? fastPolicyForModel(provider, modelId, providerName, inbound);
  const forwardCallerTier = modelId === undefined
    ? provider.supportsServiceTier !== false
    : policy!.forwardCallerTier;
  const rawTier = rawBody && typeof rawBody === "object"
    ? (rawBody as Record<string, unknown>).service_tier
    : undefined;
  const canonicalDecision = options.tierDecision?.kind === "set";
  const callerTierIsForeign = rawTier !== undefined
    && (typeof rawTier !== "string" || canonicalFastTierMarker(rawTier) === undefined);
  const dropForeignCallerTier = policy?.capability === true
    && policy.fastWire?.kind === "service-tier"
    && policy.fastWire?.foreignCallerTiers === "drop"
    && callerTierIsForeign;
  if (policy && policy.capability !== false && canonicalDecision) return;
  if (forwardCallerTier && !dropForeignCallerTier) return;
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
  let pendingHostAdmissionLease: UpstreamHostAdmissionLease | null = null;
  let authCtx: CodexAuthContext = { kind: "main", accountId: null };
  try {
  // The Chat and Anthropic surfaces replay through here with a Responses-shaped body,
  // so an omitted value means a genuine Responses inbound.
  const inboundWire = options.inboundWire ?? "responses";
  const translatorBudget = options.translatorBudget;
  const agentTaskRecovery = agentTaskRecoveryConfig(config);
  let body: unknown;
  try {
    body = await readJsonRequestBody(req, translatorBudget);
  } catch (err) {
    if (options.abortSignal?.aborted || req.signal.aborted) {
      return clientCancelledResponse();
    }
    return decodeRequestErrorResponse(err, "responses");
  }
  const comboId = !options.comboAttempt ? comboIdFromRawBody(body, config) : null;
  if (comboId && Object.hasOwn(config.combos ?? {}, comboId)) {
    options.onRequestBodyRead?.();
    return handleComboResponses(req, body, comboId, config, logCtx, {
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
  const cursorClientThreadId = codexPoolAffinityKey(req.headers);
  const originalBody = body;
  if (options.comboReplaySnapshot) {
    copyPreviousResponseReplayProvenance(options.comboReplaySnapshot.sourceBody, body);
  } else {
    body = expandPreviousResponseInput(body, inboundClientThreadId);
    if (previousResponseScopeMismatch(body)) {
      console.warn("[opencodex] dropped a previous_response_id with a mismatched client task scope; continuing fresh");
    }
    if (previousResponseReplayFailure(body)) {
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

  let parsed: OcxParsedRequest;
  let toolBridgeMaps: ReturnType<typeof buildToolBridgeMaps>;
  try {
    parsed = parseRequest(body);
    if (options.comboReplaySnapshot?.recoveredPlaintext) {
      markBodyNonPersistable(parsed._rawBody);
    }
    toolBridgeMaps = buildToolBridgeMaps(parsed, translatorBudget);
    if (previousResponseInputExpanded) parsed._previousResponseInputExpanded = true;
    const providerContinuationCandidate = options.comboReplaySnapshot
      ? options.comboReplaySnapshot.providerContinuation
      : previousResponseProviderState(parsed.previousResponseId);
    if (providerContinuationCandidate) parsed._providerContinuationCandidate = providerContinuationCandidate;
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
  logCtx.requestedModel = parsed.modelId;
  logCtx.requestedEffort = parsed.options.reasoning;
  logCtx.callerServiceTier = sanitizeLogMetadataString(parsed.options.serviceTier);
  logCtx.requestedServiceTier = parsed.options.serviceTier;
  logCtx.requestedSpeedLabel = requestLogSpeedLabel(parsed.options.serviceTier);
  logCtx.configuredServiceTier = readConfiguredCodexServiceTier();
  logCtx.configuredSpeedLabel = requestLogSpeedLabel(logCtx.configuredServiceTier);

  let route: RouteResult;
  try {
    const resolveRoute = (modelId: string) => options.comboAttempt
      ? routeConcreteModel(config, modelId)
      : routeModel(config, modelId, evidenceFromBody(parsed._rawBody));
    const _sci = config.shadowCallIntercept;
    let shadowRoute: RouteResult | undefined;
    if (_sci?.enabled && _sci.model && isShadowSourceModel(parsed.modelId, _sci.sourceModels)) {
      const sourcePrefix = shadowSourceModelPrefix(parsed.modelId, _sci.sourceModels)!;
      let sourceIdentity = { providerName: OPENAI_CODEX_PROVIDER_ID, modelId: sourcePrefix };
      try {
        const resolvedSource = routeConcreteModel(config, parsed.modelId);
        sourceIdentity = { providerName: resolvedSource.providerName, modelId: sourcePrefix };
      } catch { /* Native Codex helper calls remain OpenAI-owned without an enabled OpenAI route. */ }
      const targetRoute = resolveRoute(_sci.model);
      if (shouldInterceptShadowCall(parsed.modelId, _sci.sourceModels, sourceIdentity, targetRoute)) {
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
    if (parsed._compactionRequest === true) parsed._cursorIsolateConversation = true;
    route = shadowRoute ?? resolveRoute(parsed.modelId);
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
  const initialSubagentFallbackChain = threadSpawn && !options.comboAttempt
    ? resolveSubagentFallbackChain(parsed, config)
    : null;
  const previewSelectionAdmission = threadSpawn
    && !options.comboAttempt
    && (route.codexAccountId === undefined || initialSubagentFallbackChain !== null)
    ? codexAccountSelectionForTurn(options.turnAdmissionLease)?.()
    : undefined;
  const nativeMainRecoveryBlocked = isNativeMainTrafficBlocked();
  const nativeMainReadsForbidden = nativeMainRecoveryBlocked
    || previewSelectionAdmission?.mainProfileDraining === true;
  const previewSelectionOptions = {
    nativeMainSelectionOnly: !nativeMainRecoveryBlocked
      && previewSelectionAdmission?.mainProfileDraining === true,
  };
  let selectedForwardHeaders = req.headers;
  let subagentFallbackAccountId = config.activeCodexAccountId ?? null;
  let subagentFallbackAccountPreview: SubagentPoolAccountPreview | undefined;
  let subagentFallbackModelEligibleAccountIdsForModel: SubagentModelEligibleAccountIds | undefined;
  let subagentQuotaFailureModel = parsed.modelId;
  const parentThreadId = req.headers.get("x-codex-parent-thread-id")?.trim() ?? null;
  const poolAffinityKey = codexPoolAffinityKey(req.headers) ?? null;

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
      { ...previewSelectionOptions, modelEligibleAccountIds },
      modelId,
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

  // Native fallback can consume ciphertext, so recover only after final route selection.
  if (
    inboundWire === "responses"
    &&
    threadSpawn
    && unreadableEncryptedAgentTask
    && agentTaskRecovery
    && !isCanonicalOpenAiForwardProvider(route.provider)
    && !options.comboAttempt
  ) {
    let recovered = false;
    try {
      recovered = await recoverEncryptedAgentTask(
        req,
        (body as { input?: unknown } | undefined)?.input,
        agentTaskRecovery,
        config,
        { parentThreadId, abortSignal: options.abortSignal },
      );
    } catch {
      recovered = false;
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
            "_cursorClientThreadId",
            "_reasoningReplayScope",
            "_cursorIsolateConversation",
          ];
          for (const key of kept) {
            if (parsed[key] !== undefined) {
              (reparsed as unknown as Record<string, unknown>)[key] = parsed[key];
            }
          }
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
              const recoverySelectionOptions = {
                nativeMainSelectionOnly: !recoveryNativeMainBlocked
                  && recoverySelectionAdmission?.mainProfileDraining === true,
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
                { ...recoverySelectionOptions, modelEligibleAccountIds },
                modelId,
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
              route = routeModel(config, fallback.to, evidenceFromBody(parsed._rawBody));
              logCtx.routeDecision = route.routeDecision;
            } catch (err) {
              if (err instanceof NoAvailableComboTargetsError) {
                return comboUnavailableResponse(err.message);
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

  if (options.abortSignal?.aborted) return clientCancelledResponse();
  // Refuse an input that cannot plausibly fit the model context window before spending auth,
  // circuit budget, or upstream bandwidth on a turn the provider will reject anyway (#1412).
  //
  // Compaction turns are exempt: Codex sends compaction_trigger BECAUSE context is full, so
  // refusing the turn that shrinks the context would deadlock the client against the very
  // limit this gate reports — it would be told to compact and then denied the compaction.
  if (parsed._compactionRequest !== true) {
    const inputAdmission = checkInputAdmission(parsed, route.provider, route.providerName, parsed.modelId, nativeContextLimits(config));
    if (!inputAdmission.admitted) {
      // #1524: this is a LOCAL preflight refusal, not an upstream verdict. A policy or combo
      // fallback must be able to skip this candidate and try one whose context window fits,
      // instead of treating the first incompatible candidate as the end of the chain. The
      // distinct code is what lets the fallback layer tell the two apart -- an upstream
      // `context_length_exceeded` still stops, because retrying it elsewhere is guesswork.
      return formatErrorResponse(
        413,
        "input_admission_refused",
        `Estimated input (~${inputAdmission.estimatedTokens} tokens) is far past the context window `
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
    pendingHostAdmissionLease = admission.lease;
  }

  let substituteMainCredential = false;
  {
    const finalAuth = await resolveResponsesCodexAuth(req, config, route, options);
    if (!finalAuth.ok) return finalAuth.response;
    authCtx = finalAuth.authCtx;
    selectedForwardHeaders = finalAuth.headers;
    substituteMainCredential = finalAuth.substituteMainCredential;
  }

  route.provider = applyCodexAuthContextToProvider(route.provider, authCtx, route.codexAccountMode);
  applyCodexAccountGatedWireNormalization(parsed, route, logCtx);
  logCtx.provider = route.codexAccountNamespace
    ? `${route.providerName}-${route.codexAccountNamespace}`
    : formatCodexProviderForLog(route.providerName, codexLogAccountId(authCtx), config);
  logCtx.accountLogLabel = codexAuthContextLogLabel(authCtx, config);
  // Seed an account-derived scope before final adapter binding. Cursor never treats it as
  // authoritative: bindRouteReasoningReplayScope replaces it with the exact route owner or a
  // per-request fail-closed sentinel after the final provider and credential are known.
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
  let replayOAuthCredentialSnapshot: Pick<OAuthAccessSnapshot, "accountId" | "generation"> | undefined;
  let anthropicPoolAccountId: string | null = null;
  let anthropicPoolFailovers = 0;
  // Generic OAuth rotation (#2568) for providers with no pool of their own. Bound to the account
  // the request actually used, so a concurrent rotation cannot cool an innocent replacement.
  let genericFailoverAccountId: string | null = null;
  let genericFailovers = 0;
  /**
   * Apply a rotated account's FULL credential snapshot to the live route (#2568d).
   *
   * One helper for all three rotation sites on purpose. Each site used to inline the same four
   * lines, and the divergence that produced was the bug: `apiKey` was swapped while the routing
   * metadata paired with it stayed behind.
   *
   * Returns false when the snapshot cannot be used safely, and the caller must then abandon the
   * rotation rather than send a half-applied identity:
   *
   * - Copilot pins its bearer to an account-scoped regional origin, so transport is re-resolved
   *   with the new account's `apiBaseUrl` instead of inheriting the previous account's host. The
   *   snapshot value is RESOLVED first: `rotatedProvider` is a clone of the FAILED account's
   *   provider, so passing a bare `undefined` origin let the transport resolver fall through its
   *   own `?? validateCopilotApiBaseUrl(provider.baseUrl)` step to the previous account's host —
   *   pairing B's bearer with A's accepted origin. Login and refresh always persist a resolved
   *   origin, so this fallback protects malformed or manually seeded credentials.
   * - A Cloud Code Assist provider needs an account-matched project. Antigravity's refresh path
   *   tolerates project discovery failing, so a stored account can legitimately have no project;
   *   sending that account's bearer with the FAILED account's project is worse than not rotating.
   */
  const applyFailoverSnapshot = (snapshot: OAuthAccessSnapshot): boolean => {
    if (route.provider.googleMode === "cloud-code-assist" && !snapshot.projectId) return false;
    let rotatedProvider: OcxProviderConfig = { ...route.provider, apiKey: snapshot.accessToken };
    if (route.providerName === "github-copilot") {
      rotatedProvider = resolveProviderTransport(
        route.providerName,
        rotatedProvider,
        parsed.options.promptCacheKey,
        resolveCopilotApiBaseUrl(snapshot.apiBaseUrl),
      ) as OcxProviderConfig;
    }
    if (snapshot.projectId) rotatedProvider = { ...rotatedProvider, project: snapshot.projectId };
    route.provider = rotatedProvider;
    if (route.providerName === "kiro") parsed._kiroAuthContext = { ...(snapshot.kiro ?? {}) };
    // Re-stamp: a request that rotated accounts must be attributed to the account that actually
    // served it. All three rotation sites funnel through here, so this is the only re-stamp
    // needed -- and putting it anywhere else would let one of the three drift.
    stampOAuthAccountLabel(logCtx, route.providerName, route.provider, snapshot.accountId);
    return true;
  };
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
        // Prefer the account with known headroom BEFORE the first attempt. Rotation alone
        // only reacts to a 429, so a turn could open on an account a previous probe already
        // measured as spent. A null answer means "use the active account", so every provider
        // without quota evidence keeps the resolution it has today.
        const preferredAccountId = isGenericFailoverProvider(route.providerName, route.provider)
          ? preferredInitialAccount(config, route.providerName)
          : null;
        // Resolved account-scoped, NOT through failoverAccountSnapshot: that helper marks a
        // rotation site, and rotation sites must apply their credential through
        // applyFailoverSnapshot's pairing rules. This is initial resolution — the code below
        // already pairs the snapshot's Kiro metadata, Copilot origin and Antigravity project
        // with this same bearer, exactly as it does for the active account.
        let usedPreferredAccount = preferredAccountId !== null;
        let resolved: OAuthAccessSnapshot;
        if (preferredAccountId) {
          try {
            // `requireUsableAccount` makes a removed OR reauth-flagged account throw from
            // inside the resolver's own store read. Without it a revoked account resolves
            // successfully — its credential is still readable — and the request would
            // dispatch on an account already known to need a fresh login.
            resolved = await getValidAccessSnapshotForAccount(
              route.providerName,
              preferredAccountId,
              { requireUsableAccount: true },
            );
          } catch {
            // The roster is read behind a short TTL, so a preferred account can be removed
            // or flagged for reauth in the window after it was cached. Resolving it then
            // throws, and a PREFERENCE that turns a healthy request into a 401 is worse
            // than no preference at all — the active account is still perfectly usable.
            // Drop the stale roster so the next request re-reads it, and carry on.
            forgetGenericFailoverRoster(route.providerName);
            usedPreferredAccount = false;
            resolved = await getValidAccessTokenSnapshot(route.providerName);
          }
        } else {
          resolved = await getValidAccessTokenSnapshot(route.providerName);
        }
        // A Cloud Code Assist account needs its own project. Antigravity's refresh path
        // tolerates project discovery failing, so a stored account can legitimately have
        // none — and a PREFERENCE must never turn a working request into an error. Fall
        // back to the ordinary active-account resolution instead, which is exactly what
        // would have happened had the preference never existed.
        if (usedPreferredAccount && route.provider.googleMode === "cloud-code-assist" && !resolved.projectId) {
          resolved = await getValidAccessTokenSnapshot(route.providerName);
          usedPreferredAccount = false;
        }
        replayOAuthCredentialSnapshot = {
          accountId: resolved.accountId,
          generation: resolved.generation,
        };
        if (isOAuth401ReplayProvider) sentOAuthSnapshot = resolved;
        route.provider = { ...route.provider, apiKey: resolved.accessToken };
        // Attribution is independent of failover (#2699): stamped from the resolved snapshot
        // itself, not from inside the `isGenericFailoverProvider` branch below, so a future
        // narrowing of that predicate cannot silently switch attribution off.
        stampOAuthAccountLabel(logCtx, route.providerName, route.provider, resolved.accountId);
        // Remember which account actually served this request so a 429 cools THAT one, not
        // whichever account is active by the time the response comes back (#2568).
        if (isGenericFailoverProvider(route.providerName, route.provider)) {
          genericFailoverAccountId = resolved.accountId;
        }
        if (route.providerName === "kiro") {
          // `{}` is intentional: this is an account-scoped request with no stored routing metadata.
          // Only genuinely accountless adapter calls leave the context undefined and use local/env fallback.
          parsed._kiroAuthContext = { ...(resolved.kiro ?? {}) };
        }
        // Antigravity (cloud-code-assist) needs the discovered Cloud Code Assist project id in the
        // CCA envelope. Keep it paired with the token snapshot so an account rotation cannot mix
        // a fresh token with project metadata re-read from a different credential generation.
        if (route.provider.googleMode === "cloud-code-assist") {
          // When pre-dispatch chose a DIFFERENT account, the configured project belongs to
          // the account we did not use, and `!route.provider.project` would skip right past
          // it — installing B's bearer alongside A's project. That is the #2841 pairing bug
          // in its original shape, so the preferred-account path replaces the project
          // unconditionally and refuses to dispatch at all if the chosen account has none.
          // A project-less preferred account already fell back above, so by here the
          // preferred path always has one.
          if (usedPreferredAccount && resolved.projectId) {
            route.provider = { ...route.provider, project: resolved.projectId };
          } else if (!route.provider.project && resolved.projectId) {
            route.provider = { ...route.provider, project: resolved.projectId };
          }
        }
      }
    } catch (err) {
      if (err instanceof UnsupportedOAuthProviderError) {
        const safeProviderName = redactSecretString(route.providerName);
        return formatErrorResponse(
          400,
          "invalid_request_error",
          `${redactSecretString(err.message)}. Remove or reconfigure provider '${safeProviderName}' in the OpenCodex configuration.`,
        );
      }
      return formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(err));
    }
  }
  route.provider = resolveProviderTransport(
    route.providerName,
    route.provider,
    parsed.options.promptCacheKey,
    route.providerName === "github-copilot" && route.provider.authMode === "oauth"
      ? resolveCopilotApiBaseUrl(sentOAuthSnapshot?.apiBaseUrl)
      : undefined,
  );
  let adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire);
  const stripClaudeMainAuth = options.stripClaudeMainAuthForNoncanonicalForward === true
    && adapterProvider.adapter === "openai-responses"
    && adapterProvider.authMode === "forward"
    && !isCanonicalOpenAiForwardProvider(adapterProvider);
  if (stripClaudeMainAuth) {
    releaseCodexAuthContextProbeLease(authCtx);
    authCtx = { kind: "main", accountId: null };
    route.provider = stripCodexRuntimeProviderFields(route.provider);
    adapterProvider = stripCodexRuntimeProviderFields(adapterProvider);
    selectedForwardHeaders = new Headers(selectedForwardHeaders);
    selectedForwardHeaders.delete("authorization");
    selectedForwardHeaders.delete("chatgpt-account-id");
    delete route.codexAccountMode;
    delete route.codexAccountId;
    delete route.codexAccountNamespace;
    logCtx.provider = route.providerName;
    delete logCtx.accountLogLabel;
  }
  const adapter = resolveAdapter(adapterProvider, config.cacheRetention);
  bindRouteReasoningReplayScope({
    parsed,
    providerName: route.providerName,
    provider: adapterProvider,
    adapterName: adapter.name,
    oauthCredentialSnapshot: replayOAuthCredentialSnapshot,
    codexAuthContext: authCtx,
    forwardHeaders: selectedForwardHeaders,
  });
  if (!logCtx.conversationId && parsed._cursorConversationId) {
    logCtx.conversationId = normalizeLogConversationId(parsed._cursorConversationId);
  }
  logCtx.providerAdapter = adapter.name;
  // Ordinary requests receive one durable attempt only after their final initial
  // adapter is resolved. Combo children own their attempt and retries keep it.
  if (!options.comboAttempt && !logCtx.activeAttempt) {
    const attempt = beginRequestAttempt(
      (logCtx.attempts?.length ?? 0) + 1,
      logCtx.provider,
      route.modelId,
      adapter.name,
    );
    logCtx.activeAttempt = attempt;
    logCtx.activeAttemptStartedAt = Date.now();
    (logCtx.attempts ??= []).push(attempt);
  }
  sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, adapter.name, logCtx.accountLogLabel);
  let runTurnAdapter = adapter;
  if (adapter.runTurn) {
    recordAdapterTierMetadata(logCtx, adapter.tierLogForRunTurn?.(parsed));
  }
  // Optional route-identity linkage for attempt correlation (CL-09 consumes it). The slot
  // resolves to null unless an opt-in subsystem registered a linker, so an install without
  // routing profiles does no work here and loads no additional module. The non-throwing
  // guarantee lives in the slot helper.
  if (logCtx.activeAttempt && !logCtx.activeAttempt.labRouteSubjectId) {
    const passiveSubjectId = resolvePassiveRouteSubjectId(
      config,
      route.providerName,
      route.modelId,
      route.provider,
      inboundWire,
    );
    if (passiveSubjectId) logCtx.activeAttempt.labRouteSubjectId = passiveSubjectId;
  }
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
  // Terminal describe fence (roadmap 180): the sidecar's OWN loopback describe
  // call must never plan another describe. The flag arrives from the Chat
  // surface (whose bridge rebuilds headers) or as the raw header for native
  // Responses callers. Marked + text-only routed model → strip, depth cap 1.
  const visionDescribeTerminal = options.visionDescribeTerminal === true
    || req.headers.get("x-opencodex-vision-describe") === "1";
  const visionPlan = visionDescribeTerminal
    ? undefined
    : planVisionSidecar(config, route.provider, route.modelId, parsed, openAiSidecar);
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
  } else if (isModelTextOnly(route.provider, route.modelId)) {
    // Sidecar-covered model but NO plan (no forward provider / missing forwarded auth / sidecar
    // disabled): fail closed — never forward raw images to a text-only upstream.
    stripImagesInPlace(parsed, translatorBudget);
  }

  const recordTerminalOutcomes = options.recordTerminalOutcomes !== false;

  const continuationStateForResponse = (
    emitted?: OcxProviderContinuationState,
  ): OcxProviderContinuationState | undefined => {
    const cursorConversationId = parsed._cursorConversationId;
    const inherited = providerContinuationPayload(parsed._providerContinuation);
    const emittedPayload = providerContinuationPayload(emitted);
    if (!emittedPayload && !inherited && !cursorConversationId) return undefined;
    const merged = mergeProviderContinuationPayload(
      inherited ?? {},
      emittedPayload ?? {},
    ) as OcxProviderContinuationState;
    if (cursorConversationId) {
      merged.cursor = { ...(merged.cursor ?? {}), conversationId: cursorConversationId };
    }
    return parsed._providerContinuationOwner
      ? { ...merged, __ocxOwner: { ...parsed._providerContinuationOwner } }
      : merged;
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
  const commitReasoningReplayServingRoute = (): void => {
    commitReasoningReplayServingIdentity(parsed._reasoningReplayScope);
  };
  if (routedCompaction) {
    delete parsed.context.tools;
    delete parsed._webSearch;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    // The compaction turn is a plain prose summary; a surviving structured-output format
    // would force schema-constrained JSON into the synthetic compaction item. The flag and
    // the raw `text` control go too: the key-mode openai-responses adapter builds from
    // _rawBody, so a surviving format there would still reach the upstream. (The Kiro
    // guard no longer reads _rawBody.text; it refuses structured output only.)
    delete parsed.options.textFormat;
    delete parsed._structuredOutput;
    if (parsed._rawBody && typeof parsed._rawBody === "object") {
      delete (parsed._rawBody as Record<string, unknown>).text;
    }
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  let routedNamespaceToolAliases: RoutedNamespaceToolAliases = new Map();
  const refreshRoutedNamespaceToolAliases = (builtRequest: AdapterRequest): void => {
    routedNamespaceToolAliases = builtRequest.convertedRoutedNamespaceToolAliases ?? new Map();
  };

  if ("passthrough" in adapter && adapter.passthrough && !routedCompaction) {
    let hostAdmissionLease = pendingHostAdmissionLease;
    pendingHostAdmissionLease = null;
    try {
    const imageGenCallAliases = route.provider.authMode === "forward"
      ? new Map<string, { namespace: string; name: string }>()
      : imageGenToolCallAliases(toolBridgeMaps.toolNsMap, parsed._rawBody, translatorBudget);
    const routedCustomToolNames = new Set<string>();
    const routedCustomToolRepairNames = new Set<string>();
    const routedToolSearchNames = new Set<string>();
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
        rememberResponseState(parsed._rawBody, response, undefined, responseStateOptions(true))
      : undefined;
    if (parsed.previousResponseId && !parsed._previousResponseInputExpanded) {
      console.warn(
        `[responses] previous_response_id ${parsed.previousResponseId} not found in local replay state `
        + `(model ${parsed.modelId}); forwarding without it — earlier turns may be missing from this request`,
      );
    }
    // Preserve the caller's readable catalog boundary before provider-specific normalization can
    // remove an unsupported final entry (for example xAI cached-only web search).
    const replayedInputPrefixLength = parsed._replayPrefixLen ?? 0;
    const clientToolAuthorizationBody = currentTurnWireToolCatalogBody(
      parsed._rawBody,
      replayedInputPrefixLength,
    );
    const clientExplicitWireToolCatalog = hasExplicitWireToolCatalog(clientToolAuthorizationBody);
    const clientDeclaredWireToolNames = collectDeclaredWireToolNames(clientToolAuthorizationBody);
    const clientDeclaredNamelessCallTypes = collectDeclaredNamelessClientCallTypes(
      clientToolAuthorizationBody,
    );
    // Hosted calls the PROVIDER runs itself. Gated on the destination actually being xAI, so a
    // declaration alone cannot buy the exemption on some other upstream that never serves it.
    // Provider-executed declarations are authorized from the actual outbound body, after the
    // adapter has applied destination-specific injection and normalization. Client-executed tool
    // authority remains bounded to the caller-owned catalog above.
    const providerExecutedCallTypes = new Set<ProviderExecutedCallType>();
    let request: Awaited<ReturnType<typeof adapter.buildRequest>>;
    try {
      request = await adapter.buildRequest(parsed, { headers: selectedForwardHeaders, translatorBudget });
    } catch (error) {
      releaseCodexAuthContextProbeLease(authCtx);
      // A tool catalog this proxy cannot lower onto one wire namespace is a client input error, and
      // the rotation-rebuild and bridged paths already answer 400 for the identical throw. Rethrowing
      // it here escaped every catch up to the Bun handler, so the same request produced an
      // unstructured 500 — and no request log — depending only on whether a rotation ran first.
      // Same shape for a tool_choice this proxy cannot honor: the destination rejects a schema the
      // catalog had to drop, so the selector naming it is a client input error, not a 500.
      if (error instanceof NamespaceToolCollisionError || error instanceof XaiToolSchemaCompatibilityError) {
        return formatErrorResponse(400, "invalid_request_error", redactSecretString(error.message));
      }
      throw error;
    }
    if (!isCanonicalOpenAiForwardProvider(route.provider)) {
      for (const name of request.convertedRoutedCustomToolNames ?? []) {
        if (
          toolBridgeMaps.freeformToolNames.has(name)
          || toolBridgeMaps.toolNsMap.get(name)?.freeform === true
        ) routedCustomToolNames.add(name);
      }
      for (const name of request.routedCustomToolRepairNames ?? []) {
        if (
          toolBridgeMaps.freeformToolNames.has(name)
          || toolBridgeMaps.toolNsMap.get(name)?.freeform === true
        ) routedCustomToolRepairNames.add(name);
      }
    }
    for (const name of request.convertedRoutedToolSearchNames ?? []) {
      // The adapter already keeps this set empty when tool_choice forbids the private search.
      // Its wire name may be collision-aliased, so comparing it to the caller-facing name here
      // would incorrectly disable restoration for the exact ambiguous-name case the alias fixes.
      routedToolSearchNames.add(name);
    }
    refreshRoutedNamespaceToolAliases(request);
    // #1700: the bridged paths refuse a call to a tool the request never declared
    // (`declaredToolNames`, src/bridge.ts). The passthrough had no equivalent, so a routed
    // provider's top-level `apply_patch` — which under Codex code mode exists only as a nested
    // `tools.apply_patch(...)` helper inside `exec`, never as a wire tool — reached Codex as a
    // call it cannot execute, and the turn showed a bare `aborted` with the file untouched.
    // Forward auth is the canonical ChatGPT backend speaking Codex's own protocol rather than a
    // routed provider, so it keeps passing through unguarded, as it does for the rewrites above.
    // The guard needs a catalog to compare against, so it stands down when the request omits one.
    // An explicit empty catalog is still authoritative: it declares that no client tools may be
    // called. A passthrough request can legitimately omit `tools` entirely and still receive a call
    // the client understands — `tests/github-copilot-stream-contract.test.ts` sends
    // `{model, input, stream}` with no tools and Copilot answers with a `custom_tool_call` for
    // `apply_patch`. Policing an absent catalog truncates that turn. An unreadable body lands there
    // too because the proxy cannot establish the caller's declared authorization boundary.
    const parseOutboundRequestBody = (bodyText: string): Record<string, unknown> | undefined => {
      try {
        const body = JSON.parse(bodyText) as unknown;
        return body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : undefined;
      } catch {
        return undefined;
      }
    };
    let outboundRequestBody: Record<string, unknown> | undefined;
    const declaredWireToolNames = new Set<string>();
    const declaredNamelessClientCallTypes = new Set<string>();
    // `buildToolBridgeMaps` creates a bare alias only when the caller selected exactly one
    // namespaced tool through a bare tool_choice. Restore that request-bounded identity before
    // authorization checks instead of admitting the bare name into the declared set: for `exec`,
    // the latter would also authorize the unrelated code-mode helper names.
    const authorizedBareNamespaceToolAliases: RoutedNamespaceToolAliases = new Map(
      [...toolBridgeMaps.toolNsMap].flatMap(([alias, identity]) =>
        alias === identity.name
          ? [[alias, {
              namespace: identity.namespace,
              name: identity.name,
              kind: identity.freeform ? "custom" as const : "function" as const,
            }] as const]
          : []
      ),
    );
    const restoreAuthorizedBareNamespaceToolCalls = (value: unknown): unknown =>
      restoreRoutedNamespaceCalls(value, authorizedBareNamespaceToolAliases).value;
    let undeclaredToolGuardActive = false;
    const refreshUndeclaredToolGuard = (builtRequest: AdapterRequest): void => {
      outboundRequestBody = parseOutboundRequestBody(builtRequest.body);
      providerExecutedCallTypes.clear();
      if (isXaiResponsesDestination(route.provider)) {
        // Preserve the caller-declared authorization recognized by the original classifier, then
        // add adapter-injected declarations from the actual current-turn outbound catalog.
        for (const callType of collectProviderExecutedCallTypes(clientToolAuthorizationBody)) {
          providerExecutedCallTypes.add(callType);
        }
        const currentOutboundCatalog = currentTurnWireToolCatalogBody(
          outboundRequestBody,
          replayedInputPrefixLength,
        );
        for (const callType of collectProviderExecutedCallTypes(currentOutboundCatalog)) {
          providerExecutedCallTypes.add(callType);
        }
      }
      declaredWireToolNames.clear();
      // With no replay prefix the full outbound body belongs to this turn and its normalized
      // aliases are authoritative. A continuation's outbound body still contains historical
      // catalogs (and may promote historical tool-search definitions), so it can never widen the
      // current caller snapshot captured above.
      if (replayedInputPrefixLength === 0) {
        for (const name of collectDeclaredWireToolNames(outboundRequestBody)) {
          declaredWireToolNames.add(name);
        }
      }
      for (const name of clientDeclaredWireToolNames) declaredWireToolNames.add(name);
      declaredNamelessClientCallTypes.clear();
      if (replayedInputPrefixLength === 0) {
        for (const callType of collectDeclaredNamelessClientCallTypes(outboundRequestBody)) {
          declaredNamelessClientCallTypes.add(callType);
        }
      }
      for (const callType of clientDeclaredNamelessCallTypes) {
        declaredNamelessClientCallTypes.add(callType);
      }
      // On an ordinary request these maps capture caller-catalog identities that normalization may
      // replace on the outbound wire (for example a client image tool becoming hosted). On replay,
      // however, the parsed maps also contain historical catalog entries, so only the bounded
      // current-turn wire snapshot above may authorize a call.
      if (replayedInputPrefixLength === 0) {
        for (const name of toolBridgeMaps.declaredToolNames) {
          // `buildToolBridgeMaps` also aliases a namespaced tool under its bare name when the
          // caller's `tool_choice` selected it unambiguously, which the bridge needs to route the
          // call back. For `exec` alone that alias would also switch on nested-helper
          // normalization and re-authorize `exec_command`/`shell_command`/`apply_patch`, so it is
          // admitted here only when the caller's own catalog declared a bare `exec`. Selecting an
          // MCP `exec` is not a declaration of the code-mode shell tool.
          if (
            name === CODE_MODE_EXEC_TOOL_NAME
            && !clientDeclaredWireToolNames.has(CODE_MODE_EXEC_TOOL_NAME)
          ) continue;
          declaredWireToolNames.add(name);
        }
      }
      undeclaredToolGuardActive = (
        declaredWireToolNames.size > 0
        || clientDeclaredNamelessCallTypes.size > 0
        || clientExplicitWireToolCatalog
      ) && route.provider.authMode !== "forward";
    };
    refreshUndeclaredToolGuard(request);
    // A refused turn must not seed `previous_response_id` replay. The inspection branch reads the
    // untouched upstream stream, so it can still observe a `response.completed` the client never
    // received; checking the payload itself rather than a flag shared with the client relay keeps
    // this free of tee ordering races.
    //
    // Checking only the terminal snapshot is not enough. An upstream can announce the undeclared
    // call in `response.output_item.added`, which trips the client guard, and then close with a
    // `response.completed` whose `output` is empty. The client gets `response.failed`, the terminal
    // check sees nothing undeclared, and the refused turn enters continuation state anyway. So the
    // rejection is sticky for the whole turn, set from every parsed payload on the inspection side.
    let inspectionSawUndeclaredTool = false;
    const noteInspectedPayload = (payload: unknown) => {
      // Gated on the same flag as the guard itself: with no readable catalog (or a forward-auth
      // provider) every name looks undeclared, and flipping this would stop recording continuation
      // state for exactly the passthrough traffic the guard deliberately stands down for.
      if (!undeclaredToolGuardActive || inspectionSawUndeclaredTool) return;
      if (undeclaredToolCallName(
        restoreAuthorizedBareNamespaceToolCalls(payload),
        declaredWireToolNames,
        declaredNamelessClientCallTypes,
        providerExecutedCallTypes,
      ) !== undefined) {
        inspectionSawUndeclaredTool = true;
      }
    };
    const rememberPassthroughResponseChecked = rememberPassthroughResponse
      ? (response: { id?: unknown; output?: unknown; status?: unknown }) => {
        if (inspectionSawUndeclaredTool) return;
        const restoredResponse = restoreRoutedCustomCalls(
          restoreAuthorizedBareNamespaceToolCalls(response),
          routedCustomToolNames,
          routedCustomToolRepairNames,
          declaredWireToolNames,
        ).value as { id?: unknown; output?: unknown; status?: unknown };
        if (
          undeclaredToolGuardActive
          && undeclaredToolCallNameInResponse(
            restoredResponse,
            declaredWireToolNames,
            declaredNamelessClientCallTypes,
            providerExecutedCallTypes,
          ) !== undefined
        ) {
          return;
        }
        rememberPassthroughResponse(restoredResponse);
      }
      : undefined;
    recordAdapterReasoning(logCtx, request);
    recordAdapterTier(logCtx, request);
    const actualHostKey = upstreamHostHealthKey(
      route.providerName,
      safeOriginLabel(request.url),
    );
    const hostKey = route.provider.authMode === "forward"
      ? actualHostKey
      : null;
    const hostCircuitEnabled = hostKey !== null
      && normalizeUpstreamHostCircuitThreshold(config.upstreamHostCircuitThreshold) > 0;
    if (hostKey !== null && !hostCircuitEnabled) {
      disableUpstreamHostCircuitForKey(actualHostKey);
    }
    if (hostAdmissionLease && hostAdmissionLease.key !== hostKey) {
      return formatErrorResponse(502, "upstream_error", "Provider host changed after circuit admission");
    }
    if (options.abortSignal?.aborted) {
      releaseCodexAuthContextProbeLease(authCtx);
      return clientCancelledResponse();
    }
    if (!hostAdmissionLease && hostCircuitEnabled) {
      const admission = acquireUpstreamHostAdmission(
        hostKey!,
        config.upstreamHostCircuitThreshold,
      );
      if (admission.kind === "blocked") {
        releaseCodexAuthContextProbeLease(authCtx);
        return upstreamHostCircuitOpenResponse(admission.retryAfterSeconds);
      }
      hostAdmissionLease = admission.lease;
    }
    const settleObservedHostResponse = (): void => {
      if (hostCircuitEnabled) {
        resetUpstreamHostHealth(actualHostKey, hostAdmissionLease);
      } else {
        resetUpstreamHostHealth(actualHostKey);
      }
      hostAdmissionLease = null;
    };
    let passthroughEstimate = typeof request.usageLog?.inputTokens === "number"
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
      if (options.abortSignal?.aborted) {
        releaseUpstreamHostAdmission(hostAdmissionLease);
        hostAdmissionLease = null;
        releaseCodexAuthContextProbeLease(authCtx);
        return clientCancelledResponse();
      }
      const outcome = classifyTransportFailureKind(err);
      // Host-level evidence stands regardless of pool membership: a direct
      // forward send has no pool accounting, but the reachability failure is
      // still host-wide, not account evidence (#914 review).
      if (outcome === "connect_neutral") {
        if (hostCircuitEnabled) {
          recordUpstreamHostFailure(actualHostKey, {
            code: transportErrorCode(err),
            threshold: config.upstreamHostCircuitThreshold,
            lease: hostAdmissionLease,
          });
        } else {
          recordUpstreamHostFailure(actualHostKey, { code: transportErrorCode(err) });
        }
        hostAdmissionLease = null;
      } else {
        releaseUpstreamHostAdmission(hostAdmissionLease);
        hostAdmissionLease = null;
      }
      if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
        recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, {
          threadId: authCtx.affinityKey,
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
          }, recovery), upstream.signal, connectMs, parsed.stream,
            providerFetch(route.provider, options.codexWsRuntimeIdentity, {
              providerName: route.providerName,
              modelId: route.modelId,
            }),
            route.provider.authMode === "forward")
            // Every real attempt response — including an intermediate 5xx the
            // retry wrapper replaces — proves the host was reached (#914 review).
            .then(res => {
              settleObservedHostResponse();
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

    const opaqueBlobRecoveryGuard: OpaqueBlobRecoveryGuard = { attempted: false };
    let oauth401ReplayAttempted = false;
    let codex401ReplayKind: "main" | "stored" | null = null;
    const rateLimitPolicy = rateLimitRetryPolicyFor(route.provider);
    let rateLimitRetries = 0;
    const rebuildAndRefetch = async (
      recovery: AttemptRecoveryKind,
    ): Promise<Response | { failed: Response }> => {
      const retryAdapter = resolveAdapter(
        resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
        config.cacheRetention,
      );
      if (!("passthrough" in retryAdapter) || !retryAdapter.passthrough) {
        upstream.abort();
        return { failed: formatErrorResponse(502, "upstream_error", "Recovery changed the provider wire unexpectedly") };
      }
      try {
        request = await retryAdapter.buildRequest(parsed, {
          headers: selectedForwardHeaders,
          translatorBudget,
        });
        refreshRoutedNamespaceToolAliases(request);
        recordAdapterReasoning(logCtx, request);
        recordAdapterTier(logCtx, request);
      } catch (err) {
        upstream.abort();
        if (options.abortSignal?.aborted) return { failed: clientCancelledResponse() };
        const msg = err instanceof Error ? err.message : String(err);
        return { failed: formatErrorResponse(400, "invalid_request_error", redactSecretString(msg)) };
      }
      passthroughEstimate = typeof request.usageLog?.inputTokens === "number"
        ? request.usageLog.inputTokens
        : undefined;
      if (passthroughEstimate !== undefined) logCtx.usageLogInputTokens = passthroughEstimate;
      refreshUndeclaredToolGuard(request);
      logCtx.providerAdapter = retryAdapter.name;
      sealRequestAttemptIdentity(
        logCtx.activeAttempt,
        logCtx.provider,
        retryAdapter.name,
        logCtx.accountLogLabel,
      );
      try {
        return await fetchWithTransientRetry(
          innerRecovery => {
            noteAttemptSend(logCtx.activeAttempt, passthroughEstimate, innerRecovery ?? recovery);
            return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
              method: request.method,
              headers: request.headers,
              body: request.body,
            }, innerRecovery), upstream.signal, connectMs, parsed.stream,
              providerFetch(route.provider, options.codexWsRuntimeIdentity, {
                providerName: route.providerName,
                modelId: route.modelId,
              }),
              route.provider.authMode === "forward")
              .then(response => {
                settleObservedHostResponse();
                return response;
              });
          },
          { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
        );
      } catch (err) {
        return { failed: transportFailureResponse(err) };
      } finally {
        request.releaseBodyObservation?.();
      }
    };

    // Keep recovery kinds in sync with the generic `recovery:` loop below.
    passthroughRecovery: for (;;) {

    if (
      upstreamResponse.status === 401
      && (authCtx.kind === "main-pool" || authCtx.kind === "pool")
      && usesCodexForwardPoolAuth(authCtx, route.provider)
      && codex401ReplayKind === null
    ) {
      codex401ReplayKind = authCtx.kind === "pool" ? "stored" : "main";
      try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed */ }
      const poolAuthCtx = authCtx.kind === "pool" ? authCtx : undefined;
      const poolReplay = poolAuthCtx
        ? await refreshPoolForwardAuth({ req, route, authCtx: poolAuthCtx, substituteMainCredential, options })
        : undefined;
      const replay = poolReplay
        ?? await refreshNativeMainForwardAuth({ req, route, authCtx, substituteMainCredential, options });
      if (!replay.ok) {
        // Compact already records this; core historically returned without recording,
        // so a dead grant stayed selectable and every request repeated the same doomed
        // refresh. Fenced by the generation the 401 belongs to (#2887).
        if (poolAuthCtx && poolReplay && !poolReplay.ok && poolReplay.quarantine) {
          recordCodexUpstreamOutcome(config, poolAuthCtx.accountId, 401, {
            threadId: poolAuthCtx.affinityKey,
            fixedAccount: poolAuthCtx.fixedAccount,
            modelId: route.modelId,
            writerGeneration: poolAuthCtx.writerGeneration,
            credentialGeneration: poolReplay.quarantineGeneration ?? poolAuthCtx.generation,
          });
        }
        upstream.abort();
        releaseCodexAuthContextProbeLease(authCtx);
        return replay.response;
      }
      authCtx = replay.authCtx;
      route.provider = replay.provider;
      selectedForwardHeaders = replay.headers;
      const replayAdapter = resolveAdapter(
        resolveWireProtocolOverride(route.providerName, route.modelId, replay.provider, inboundWire),
        config.cacheRetention,
      );
      if (!("passthrough" in replayAdapter) || !replayAdapter.passthrough) {
        upstream.abort();
        return formatErrorResponse(502, "upstream_error", "Native main refresh changed the provider wire unexpectedly");
      }
      bindRouteReasoningReplayScope({
        parsed,
        providerName: route.providerName,
        provider: replay.provider,
        adapterName: replayAdapter.name,
        codexAuthContext: authCtx,
        forwardHeaders: selectedForwardHeaders,
      });
      logCtx.providerAdapter = replayAdapter.name;
      sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, replayAdapter.name, logCtx.accountLogLabel);
      try {
        request = await replayAdapter.buildRequest(parsed, {
          headers: selectedForwardHeaders,
          translatorBudget,
        });
        refreshRoutedNamespaceToolAliases(request);
        recordAdapterReasoning(logCtx, request);
        recordAdapterTier(logCtx, request);
        refreshUndeclaredToolGuard(request);
        noteAttemptSend(logCtx.activeAttempt, passthroughEstimate, "oauth-401");
        upstreamResponse = await fetchWithHeaderTimeout(
          request.url,
          { method: request.method, headers: request.headers, body: request.body },
          upstream.signal,
          connectMs,
          parsed.stream,
          // The replay-dispatched signal is what bounds the rest of this logical request, so it
          // has to describe a send that actually happened. fetchWithHeaderTimeout awaits pacing
          // admission BEFORE calling the executor, so signalling at the call site would spend the
          // budget even when a rejected pacing wait means nothing reaches the network. Wrapping
          // the executor moves the signal to the last moment before the send, where a throw from
          // here on is a genuine transport attempt.
          storedPoolReplayDispatchNotifier(
            providerFetch(route.provider, options.codexWsRuntimeIdentity, {
              providerName: route.providerName,
              modelId: route.modelId,
            }),
            codex401ReplayKind === "stored" ? options.onStoredPool401ReplayDispatched : undefined,
          ),
          route.provider.authMode === "forward",
        ).then(response => {
          settleObservedHostResponse();
          return response;
        });
      } catch (err) {
        return transportFailureResponse(err);
      } finally {
        request.releaseBodyObservation?.();
      }
      continue passthroughRecovery;
    }

    if (codex401ReplayKind !== null && upstreamResponse.status === 401) break;

    // Native Responses providers return before the generic adapter recovery loop below. Keep
    // their OAuth contract identical: one pre-stream 401 forces a credential refresh and one
    // rebuilt replay. xAI's current subscription models use this branch now that their official
    // Grok CLI catalog declares the Responses backend.
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
        upstream.abort();
        releaseCodexAuthContextProbeLease(authCtx);
        return formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(err));
      }
      sentOAuthSnapshot = refreshed;
      replayOAuthCredentialSnapshot = {
        accountId: refreshed.accountId,
        generation: refreshed.generation,
      };
      if (route.providerName === "kiro") {
        parsed._kiroAuthContext = { ...(refreshed.kiro ?? {}) };
      }
      const refreshedProvider = resolveProviderTransport(
        route.providerName,
        { ...route.provider, apiKey: refreshed.accessToken },
        parsed.options.promptCacheKey,
        route.providerName === "github-copilot"
          ? resolveCopilotApiBaseUrl(refreshed.apiBaseUrl)
          : undefined,
      );
      route.provider = refreshedProvider;
      const refreshedAdapter = resolveAdapter(
        resolveWireProtocolOverride(route.providerName, route.modelId, refreshedProvider, inboundWire),
        config.cacheRetention,
      );
      if (!("passthrough" in refreshedAdapter) || !refreshedAdapter.passthrough) {
        upstream.abort();
        return formatErrorResponse(502, "upstream_error", "OAuth refresh changed the provider wire unexpectedly");
      }
      bindRouteReasoningReplayScope({
        parsed,
        providerName: route.providerName,
        provider: refreshedProvider,
        adapterName: refreshedAdapter.name,
        oauthCredentialSnapshot: replayOAuthCredentialSnapshot,
      });
      logCtx.providerAdapter = refreshedAdapter.name;
      sealRequestAttemptIdentity(
        logCtx.activeAttempt,
        logCtx.provider,
        refreshedAdapter.name,
        logCtx.accountLogLabel,
      );
      try {
        request = await refreshedAdapter.buildRequest(parsed, {
          headers: selectedForwardHeaders,
          translatorBudget,
        });
        refreshRoutedNamespaceToolAliases(request);
        recordAdapterReasoning(logCtx, request);
        recordAdapterTier(logCtx, request);
      } catch (err) {
        upstream.abort();
        if (options.abortSignal?.aborted) return clientCancelledResponse();
        const msg = err instanceof Error ? err.message : String(err);
        return formatErrorResponse(400, "invalid_request_error", redactSecretString(msg));
      }
      refreshUndeclaredToolGuard(request);
      try {
        upstreamResponse = await fetchWithTransientRetry(
          recovery => {
            noteAttemptSend(logCtx.activeAttempt, passthroughEstimate, recovery ?? "oauth-401");
            return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
              method: request.method,
              headers: request.headers,
              body: request.body,
            }, recovery), upstream.signal, connectMs, parsed.stream,
              providerFetch(route.provider, options.codexWsRuntimeIdentity, {
                providerName: route.providerName,
                modelId: route.modelId,
              }),
              route.provider.authMode === "forward")
              .then(res => {
                settleObservedHostResponse();
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
    }

    // Same-target 429 wait-and-retry (opt-in `retryOn429`) for key-auth providers on the
    // passthrough wire. This branch returns before the recovery loop below, so Responses-shaped
    // key-auth gateways (e.g. the built-in DeepSeek preset) would otherwise surface 429
    // immediately with no same-key replay. Pre-stream only — nothing has been relayed yet, so
    // the replay is lossless (same invariant as the recovery loop). Forward/OAuth providers
    // keep their pool logic below (rateLimitRetryPolicyFor returns null for them).
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
            }, recovery), upstream.signal, connectMs, parsed.stream,
              providerFetch(route.provider, options.codexWsRuntimeIdentity, {
                providerName: route.providerName,
                modelId: route.modelId,
              }),
              route.provider.authMode === "forward")
              .then(res => {
                settleObservedHostResponse();
                return res;
              });
          },
          { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
        );
      } catch (err) {
        return transportFailureResponse(err);
      }
    }

    const captureAffinityResponse = (
      response: Response,
      captureAuthCtx: CodexAuthContext = authCtx,
      captureRequest: Awaited<ReturnType<typeof adapter.buildRequest>> = request,
      credentialSubstituted = substituteMainCredential
        || captureAuthCtx.kind === "pool"
        || captureAuthCtx.kind === "main-pool",
    ): void => {
      if (!isCanonicalOpenAiForwardProvider(route.provider)) return;
      captureCodexAffinityDiagnostic({
        inboundHeaders: req.headers,
        outboundHeaders: captureRequest.headers,
        authKind: captureAuthCtx.kind,
        accountMode: route.codexAccountMode,
        fixedAccount: isFixedCodexAccount(captureAuthCtx),
        credentialSubstituted,
        accountGatedModel: ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(route.modelId),
        wireModelNormalized: parsed.modelId !== route.modelId,
        status: response.status,
      });
    };
    captureAffinityResponse(upstreamResponse);

    if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
      let poolRetryOutcome: number | undefined;
      if (await shouldRetryCodexPoolAccountModel400(
        upstreamResponse,
        route.modelId,
        options.abortSignal,
      )) {
        poolRetryOutcome = 400;
      } else if (!authCtx.fixedAccount && shouldRetryCodexPoolAccountQuota(upstreamResponse)) {
        // Pre-stream only: once SSE has begun, mid-stream quota stays terminal.
        poolRetryOutcome = upstreamResponse.status;
      }

      if (poolRetryOutcome !== undefined) {
        // A stored Pool 401 spent this request's account budget on its own refresh and replay, so
        // nothing afterwards may be paid for out of a DIFFERENT account. One flag carries that,
        // rather than a status check here as well: a quota failure has no same-account move, so
        // `sameAccountOnly` makes it terminal by refusing the alternate; the gated-model 400
        // ladder does have one — retrying the account the refreshed roster still grants — and
        // keeps it. An earlier revision also broke here on a non-400 outcome, which no test could
        // justify because this flag already produced the identical result.
        const storedReplaySpent = codex401ReplayKind === "stored";
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
          sameAccountOnly: storedReplaySpent,
          upstream,
          connectMs,
          passthroughEstimate,
          stream: parsed.stream,
          onResponse: (response, retryAuthCtx, retryRequest) => {
            captureAffinityResponse(response, retryAuthCtx, retryRequest, true);
          },
        });
        if (retry.kind === "transport") {
          authCtx = retry.authCtx;
          return transportFailureResponse(retry.error);
        }
        if (retry.kind === "retried") {
          authCtx = retry.authCtx;
          request = retry.request;
          refreshRoutedNamespaceToolAliases(request);
          refreshUndeclaredToolGuard(request);
          upstreamResponse = retry.upstreamResponse;
          selectedForwardHeaders = retry.selectedForwardHeaders;
          // Keep subagent quota-failure health keyed to the account that actually served.
          subagentFallbackAccountId = retry.authCtx.accountId;
        }
      }
    }
    // The deterministic route record cannot classify history it never observed (restart, expiry,
    // eviction, or an older transcript). Inspect only a bounded clone of a 4xx whose exact outbound
    // Responses body still carries opaque state, then rebuild once through the ordinary adapter
    // sanitation path. A second rejection falls through unchanged because the guard stays armed.
    const opaqueBlobRecovery = await attemptOpaqueBlobRecovery({
      response: upstreamResponse,
      outboundBody: request.body,
      adapterName: adapter.name,
      parsed,
      guard: opaqueBlobRecoveryGuard,
      signal: upstream.signal,
    }, rebuildAndRefetch);
    if (opaqueBlobRecovery.kind === "failed") return opaqueBlobRecovery.response;
    if (opaqueBlobRecovery.kind === "recovered") {
      upstreamResponse = opaqueBlobRecovery.response;
      continue passthroughRecovery;
    }
    break;
    }
    const headers = sanitizePassthroughHeaders(upstreamResponse.headers);
    const resolvedModel = headers.get("openai-model")?.trim();
    if (resolvedModel && !logCtx.preserveResolvedModelFromRoute) logCtx.resolvedModel = resolvedModel;
    if (isUsageDebugEnabled()) {
      const upstreamContentType = upstreamResponse.headers.get("content-type");
      if (upstreamContentType) logCtx.usageDebugContentType = upstreamContentType;
    }
    // The chatgpt backend may omit Content-Type on SSE responses. Fall back to
    // treating a successful body as SSE when the caller requested streaming.
    const passthroughCt = headers.get("content-type")?.toLowerCase();
    const isEventStream = passthroughCt?.includes("text/event-stream")
      || (upstreamResponse.ok && !!upstreamResponse.body && !passthroughCt && parsed.stream);
    const recordTerminalOutcome = codexForwardTerminalOutcomeRecorder(
      config,
      authCtx,
      route.provider,
      route.modelId,
      logCtx,
    );
    let terminalOutcomeRecorded = false;
    const terminalRecorder = recordTerminalOutcome
      ? (status: ResponsesTerminalStatus, httpStatusOverride?: number): void => {
        if (terminalOutcomeRecorded) return;
        terminalOutcomeRecorded = true;
        recordTerminalOutcome(status, httpStatusOverride);
      }
      : undefined;
    const terminalBodyWillRecord = !!terminalRecorder && upstreamResponse.ok && isEventStream;
    // Capture quota from upstream response for multi-account tracking
   if (usesCodexForwardPoolAuth(authCtx, route.provider)) {
      // primary was the 5h window; it now carries weekly data for GPT plans.
      // Prefer primary when present, fall back to secondary for compatibility.
      const quotaMeta = { ...codexQuotaOutcomeMeta(upstreamResponse), ...(await codexDenialOutcomeMeta(upstreamResponse)) };
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
          threadId: authCtx.affinityKey,
          fixedAccount: authCtx.fixedAccount,
          modelId: route.modelId,
          probeLeaseId: codexProbeLeaseId(authCtx),
          probeQuotaScope: codexProbeQuotaScope(authCtx),
          writerGeneration: authCtx.writerGeneration,
          // Includes a replay's second 401, which is the case that actually retires the
          // account — fence it on the credential the request was holding.
          ...(authCtx.kind === "pool" ? { credentialGeneration: authCtx.generation } : {}),
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
        // No pre-read guard here: `consumeComboFailure` -> `readBoundedResponseBody` reads
        // `response.body` itself and already threads the abort signal through its own read,
        // and the combo contract is that this body's getter is touched exactly once (pinned by
        // "captures passthrough failed usage from its original bounded body exactly once").
        // Attaching a guard would be a second `.body` access and break that contract for no
        // gain, since the bounded reader owns settlement on this path.
        const failure = await consumeComboFailure(upstreamResponse, options.abortSignal);
        options.onConsumedComboFailure?.(failure);
        return failure.response;
      }
      // The bounded reader owns the original body, deadline, abort settlement, and lock.
      // Unsafe partial data falls back to #452's non-empty status-only JSON.
      const errorText = await readDisplaySafeErrorText(upstreamResponse, upstream.signal, "");
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
      // For streamed passthrough, a successful terminal response means non-error upstream status
      // before relay starts. Waiting for SSE completion would retain request state across the whole
      // stream; a later body failure does not undo that this destination accepted and served the turn.
      commitReasoningReplayServingRoute();
      const terminalRepairPolicy = providerModelResponsesTerminalRepair(
        route.providerName,
        route.provider,
        route.modelId,
      );
      const passthroughSseBody = terminalRepairPolicy
        ? relayResponsesSseWithTerminalRepair(
          upstreamResponse.body,
          upstream,
          terminalRepairPolicy,
          translatorBudget,
          options.responsesTerminalRepairScheduler,
        )
        : upstreamResponse.body;
      const repairConfig = route.provider.responsesItemIdRepair;
      const snapshotRepairEnabled = hasResponsesSnapshotRepair(route.provider.responsesSnapshotRepair);
      const githubCopilotRepairEnabled = route.providerName === "github-copilot";
      const responseModelRewrite = parsed._responseModelId !== undefined
        && parsed._responseModelId !== parsed.modelId
        ? createResponsesModelPayloadRewrite(parsed._responseModelId)
        : undefined;
      // Compose opt-in payload rewrites into one parse/stringify pass (image-gen restore first).
      const payloadRewrites = [
        createImageGenCallRestoreRewrite(imageGenCallAliases),
        routedNamespaceToolAliases.size > 0
          ? createRoutedNamespaceCallRestoreRewrite(routedNamespaceToolAliases)
          : undefined,
        authorizedBareNamespaceToolAliases.size > 0
          ? createRoutedNamespaceCallRestoreRewrite(authorizedBareNamespaceToolAliases)
          : undefined,
        hasResponsesItemIdRepair(repairConfig)
          ? createResponsesItemIdPayloadRewrite(repairConfig!, translatorBudget)
          : undefined,
        responseModelRewrite,
        parsed.options.hideThinkingSummary !== true
          && routeUsesContentChannelReasoning(route.provider, route.modelId)
          ? createReasoningSummaryChannelPayloadRewrite()
          : undefined,
      ].filter((rewrite): rewrite is NonNullable<typeof rewrite> => rewrite !== undefined);
      // #893: sparse-snapshot gateways get field backfills AND lifecycle event
      // injection at the block level, after payload rewrites. Defaults come
      // from the finalized OUTBOUND body — the normalized internal tool shapes
      // are not the Responses wire shapes the snapshot must mirror.
      const blockRewrites = [
        payloadRewrites.length > 0
          ? payloadRewriteAsBlockRewrite(composeSsePayloadRewrites(...payloadRewrites))
          : undefined,
        routedCustomToolNames.size > 0 || routedCustomToolRepairNames.size > 0
          ? createRoutedCustomToolRestoreBlockRewrite(
            routedCustomToolNames,
            translatorBudget,
            routedCustomToolRepairNames,
            declaredWireToolNames,
          )
          : undefined,
        routedToolSearchNames.size > 0
          ? createRoutedToolSearchRestoreBlockRewrite(routedToolSearchNames, translatorBudget)
          : undefined,
        githubCopilotRepairEnabled
          ? createGithubCopilotResponsesBlockRewrite(translatorBudget)
          : undefined,
        snapshotRepairEnabled
          ? createResponsesSnapshotBlockRewrite(outboundRequestBody, translatorBudget)
          : undefined,
        createResponsesFieldBackfillBlockRewrite(),
        // Last: every rewrite above can still rename or reshape a call item, so the guard must
        // compare the names the client will actually receive against the declared catalog.
        undeclaredToolGuardActive
          ? createUndeclaredToolCallGuardBlockRewrite(
            declaredWireToolNames,
            declaredNamelessClientCallTypes,
            providerExecutedCallTypes,
          )
          : undefined,
      ].filter((rewrite): rewrite is NonNullable<typeof rewrite> => rewrite !== undefined);
      const clientBlockRewrite = blockRewrites.length > 0
        ? composeSseBlockRewrites(...blockRewrites)
        : undefined;
      const needsClientRewrite = clientBlockRewrite !== undefined;
      // #864: win32 rewrite traffic must never enter the tee()+JS-pull chain
      // (Bun#32111 JS-sink segfault — text frames pass, the terminal block is
      // lost). The eager single reader applies the same rewrites inline.
      const win32EagerRewrite = isWin32EagerRewrite(process.platform, needsClientRewrite);
      const eagerPath = selectEagerPath(
        process.platform,
        needsClientRewrite,
        config.streamMode ?? "auto",
      );
      // A successful Codex WS upgrade is a push source. If it entered tee(),
      // the inspection branch could drain continuously while the slow client
      // branch retained bytes without a bound. Force the existing bounded,
      // single-reader relay before tee; HTTP fallback responses stay unmarked.
      const forceCodexWsEagerRelay = isCodexWsUpstreamResponse(upstreamResponse);
      const inlineEagerRewrite = needsClientRewrite
        && (forceCodexWsEagerRelay || win32EagerRewrite || eagerPath?.useEagerRelay === true);
      if (forceCodexWsEagerRelay || eagerPath?.useEagerRelay || win32EagerRewrite) {
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
          onCompletedResponse: rememberPassthroughResponseChecked,
          onParsedPayload: noteInspectedPayload,
          onFirstOutput: options.onFirstOutput,
          pinCompletedResponseIdToFirstSeen: githubCopilotRepairEnabled,
        });
        const eagerBody = relaySseEagerBounded(passthroughSseBody, turnAc, {
          inspectChunk: chunk => inspector.feed(chunk),
          finishInspection: () => inspector.finish(),
          disposeInspection: () => inspector.dispose(),
          // Stream lifetime follows the protocol terminal even when this request
          // has no outcome callback configured (reported() would stay false).
          sawTerminal: () => inspector.terminalSeen(),
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
              if (logCtx.activeAttempt) logCtx.activeAttempt.streamAborted = true;
              reportNativeTerminal("failed", 502);
            }
          },
          onClientCancel: () => options.onNativePassthroughCancel?.(),
          onDone: () => unregisterTurn(turnAc),
        }, inlineEagerRewrite ? { rewriteBudget: translatorBudget } : undefined);
        // When selected, this relay closes response.completed even if upstream
        // keeps the connection alive. Marked Codex WS traffic, Windows
        // forced-rewrite traffic, and Darwin explicit eager traffic apply
        // client rewrites inline rather than via the tee()+JS-pull chain.
        if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
        return markEagerRelaySseResponse(
          markNativePassthroughSseResponse(new Response(eagerBody, {
            status: upstreamResponse.status,
            headers,
          })),
        );
      }
      const [nativeBody, inspectBody] = passthroughSseBody.tee();
      const turnAc = new AbortController();
      const clientGone = new AbortController();
      linkAbortSignal(upstream, turnAc.signal);
      registerTurn(turnAc, options.turnAdmissionLease);
      const inspectionConsumerOptions = {
        clientGoneSignal: clientGone.signal,
        drainBounds: { ms: 15_000, bytes: 32 * 1024 * 1024 },
        upstream,
        pinCompletedResponseIdToFirstSeen: githubCopilotRepairEnabled,
        onParsedPayload: noteInspectedPayload,
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
          rememberPassthroughResponseChecked,
          options.onFirstOutput,
          inspectionConsumerOptions,
        );
      } else {
        consumeForResponseLogMetadata(
          inspectBody,
          logCtx,
          turnAc.signal,
          () => unregisterTurn(turnAc),
          rememberPassthroughResponseChecked,
          options.onFirstOutput,
          inspectionConsumerOptions,
        );
      }
      if (!headers.has("content-type")) headers.set("content-type", "text/event-stream");
      // Windows was handled by the eager terminal-aware branch above. Remaining
      // tee traffic can use the JS relay to close on a protocol terminal and to
      // convert a mid-stream reset into a clean response.failed event.
      const rewrittenBody = clientBlockRewrite !== undefined
        ? relaySseWithBlockRewrite(nativeBody, clientBlockRewrite, translatorBudget)
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
      const clientJson = (() => {
        const restoredNamespace = restoreRoutedNamespaceCallsInJson(
          restoreImageGenCallsInJson(text, imageGenCallAliases),
          routedNamespaceToolAliases,
        );
        const restoredAuthorizedBareNamespace = restoreRoutedNamespaceCallsInJson(
          restoredNamespace,
          authorizedBareNamespaceToolAliases,
        );
        const restored = restoreRoutedCustomCallsInJson(
          restoredAuthorizedBareNamespace,
          routedCustomToolNames,
          routedCustomToolRepairNames,
          declaredWireToolNames,
        );
        const restoredToolSearch = restoreRoutedToolSearchCallsInJson(
          restored,
          routedToolSearchNames,
        );
        const repaired = hasResponsesSnapshotRepair(route.provider.responsesSnapshotRepair)
          ? repairResponsesSnapshotJson(restoredToolSearch, outboundRequestBody)
          : restoredToolSearch;
        const modelRewritten = parsed._responseModelId !== undefined && parsed._responseModelId !== parsed.modelId
          ? rewriteResponsesModelJson(backfillResponsesFieldsJson(repaired), parsed._responseModelId)
          : backfillResponsesFieldsJson(repaired);
        // The bounded-JSON answer bypasses the SSE payload rewrite, so content-
        // channel reasoning needs the same normalization here for the plain
        // JSON answer and every reframed-SSE variant built from clientJson.
        return parsed.options.hideThinkingSummary !== true
          && routeUsesContentChannelReasoning(route.provider, route.modelId)
          ? rewriteReasoningSummaryInJsonString(modelRewritten)
          : modelRewritten;
      })();
      // #1700: same fail-closed policy as the SSE relay above. Both the plain JSON answer and
      // the reframed-SSE branch below are built from this body, so one check covers them. This
      // runs BEFORE the continuation cache write below: a refused turn must not become state a
      // later `previous_response_id` replay can expand from.
      if (undeclaredToolGuardActive) {
        const undeclared = (() => {
          try {
            return undeclaredToolCallNameInResponse(
              JSON.parse(clientJson),
              declaredWireToolNames,
              declaredNamelessClientCallTypes,
              providerExecutedCallTypes,
            );
          } catch {
            return undefined;
          }
        })();
        if (undeclared !== undefined) {
          return formatErrorResponse(502, "upstream_error", undeclaredToolCallMessage(undeclared));
        }
      }
      commitReasoningReplayServingRoute();
      if (rememberPassthroughResponseChecked) {
        try {
          rememberPassthroughResponseChecked(
            JSON.parse(text) as { id?: unknown; output?: unknown; status?: unknown },
          );
        } catch { /* non-JSON despite content-type; recording is best-effort */ }
      }
      // #875: the transport-neutral reliability policy forced a bounded JSON
      // upstream for a client that asked for SSE. Reframe the completed JSON
      // as the canonical terminal SSE sequence (created → output_item.done →
      // terminal → [DONE]) so Codex commits the turn instead of hanging on a
      // stream that never closes. Non-streaming clients keep the plain JSON.
      if (clientRequestedStream === true
        && options.inboundTransport !== "websocket"
        && providerModelResponsesUpstreamStreaming(route.providerName, route.provider, route.modelId) === false
        && route.provider.adapter === "openai-responses") {
        let completed: Record<string, unknown> | undefined;
        try {
          const parsedCompleted = JSON.parse(clientJson) as unknown;
          if (!parsedCompleted || typeof parsedCompleted !== "object" || Array.isArray(parsedCompleted)) {
            throw new TypeError("bounded Responses JSON is not an object");
          }
          let candidate = parsedCompleted as Record<string, unknown>;
          // The bounded-JSON answer bypasses the SSE relay, so it also bypasses
          // the SSE item-id rewrite. Apply the same client-facing normalization
          // here or this policy would silently disable id repair for the very
          // providers that need it (raw record already happened above).
          if (hasResponsesItemIdRepair(route.provider.responsesItemIdRepair)) {
            candidate = repairResponsesJsonItemIds(candidate, route.provider.responsesItemIdRepair!, translatorBudget);
          }
          completed = candidate;
        } catch {
          // Non-JSON despite content-type: fall through to the plain relay.
        }
        if (completed) {
          let stream: ReadableStream<Uint8Array>;
          try {
            stream = responsesJsonToSseStream(completed);
          } catch (error) {
            if (error instanceof RangeError) {
              return formatErrorResponse(
                502,
                "upstream_error",
                "upstream JSON response exceeded the synthesized SSE item limit",
              );
            }
            throw error;
          }
          const sseHeaders = sanitizePassthroughHeaders(headers);
          sseHeaders.set("content-type", "text/event-stream");
          sseHeaders.set("cache-control", "no-store");
          return new Response(stream, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: sseHeaders,
          });
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
    // An unclassified passthrough body is relayed directly and has no bounded completion observer;
    // use the same non-error-status success boundary as SSE instead of retaining per-stream state.
    commitReasoningReplayServingRoute();
    const body = relayWithAbort(upstreamResponse.body, upstream);
    const turnAc = new AbortController();
    const tracked = body ? trackStreamLifetime(body, turnAc, undefined, options.turnAdmissionLease) : null;
    return new Response(tracked, {
      status: upstreamResponse.status,
      headers,
    });
    } finally {
      if (hostAdmissionLease) {
        releaseUpstreamHostAdmission(hostAdmissionLease);
        releaseCodexAuthContextProbeLease(authCtx);
      }
    }
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
  const rotateSidecarProviderOn429 = async (retryAfter: string | null): Promise<ProviderAdapter | null> => {
    const rotated = rotateProviderTransportOn429(config, route.providerName, route.provider, {
      retryAfter,
      now: Date.now(),
      attemptedKey: route.provider.apiKey,
      promptCacheKey: parsed.options.promptCacheKey,
    });
    if (rotated) {
      route.provider = rotated;
    } else {
      if (
        !genericFailoverAccountId
        || genericFailovers >= GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST
        || !isGenericOAuthFailoverEnabled(config, route.providerName)
      ) return null;
      const nextAccountId = rotateGenericOAuthAccountOn429(
        config,
        route.providerName,
        genericFailoverAccountId,
        retryAfter,
      );
      if (!nextAccountId) return null;
      try {
        const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
        genericFailoverAccountId = nextAccountId;
        genericFailovers += 1;
        if (!applyFailoverSnapshot(snapshot)) return null;
      } catch {
        return null;
      }
    }
    const rotatedAdapter = resolveAdapter(
      resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
      config.cacheRetention,
    );
    bindRouteReasoningReplayScope({
      parsed,
      providerName: route.providerName,
      provider: route.provider,
      adapterName: rotatedAdapter.name,
    });
    return rotatedAdapter;
  };
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
    const imageProviderFetch = providerFetch(
      route.provider,
      options.codexWsRuntimeIdentity,
      { providerName: route.providerName, modelId: route.modelId },
    );
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
      waitForRequestSlot: imageProviderFetch.waitForPacing,
      fetchImpl: imageProviderFetch.unpacedFetch ?? imageProviderFetch,
      onRequestBuilt: request => {
        recordAdapterReasoning(logCtx, request);
        recordAdapterTier(logCtx, request);
      },
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
      on429: rotateSidecarProviderOn429,
      retryOn429Policy: rateLimitRetryPolicyFor(route.provider),
      ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
      ...(options.forceEmptyResponseId ? { forceEmptyResponseId: true } : {}),
      onCompletedResponse: (response, providerState) => {
        commitReasoningReplayServingRoute();
        rememberKiroDeliveredFinalAnswer(adapter.name, response);
        rememberResponseState(
          parsed._rawBody,
          response,
          continuationStateForResponse(providerState),
          responseStateOptions(adapterNeedsForcedContinuation(adapter.name)),
        );
      },
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
    // Resolve the mutable route at send time: a 429 rotation replaces route.provider, so retaining
    // one pre-rotation providerFetch would keep the old credential and transport pin.
    const routedProviderFetch = ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
      providerFetch(route.provider, options.codexWsRuntimeIdentity, {
        providerName: route.providerName,
        modelId: route.modelId,
      })(input, init)) as typeof globalThis.fetch;
    const wsResponse = await runWithWebSearch({
      parsed, adapter,
      incomingMeta: {
        headers: selectedForwardHeaders,
        abortSignal: options.abortSignal,
        translatorBudget,
        providerFetch: routedProviderFetch,
      },
      backend: wsPlan.backend,
      forwardProvider: wsPlan.forwardSidecar?.provider,
      anthropicSidecar: wsPlan.anthropicSidecar,
      xaiSidecar: wsPlan.xaiSidecar,
      geminiSidecar: wsPlan.geminiSidecar,
      xaiSearchOptions: wsPlan.xaiSearchOptions,
      // The exa key never rides the plan: read it from config at unpack time (L9).
      ...(wsPlan.exaConfigured ? { exaApiKey: config.webSearchSidecar?.exaApiKey } : {}),
      hostedTool: wsPlan.hostedTool,
      selectedForwardHeaders: wsPlan.forwardSidecar?.headers ?? selectedForwardHeaders,
      settings: wsPlan.settings,
      maxSearches: wsPlan.maxSearches,
      forceEmptyResponseId: true,
      abortSignal: options.abortSignal,
      ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
      onRequestBuilt: request => {
        recordAdapterReasoning(logCtx, request);
        recordAdapterTier(logCtx, request);
      },
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
      streamRoutedModelOutput: wsPlan.streamRoutedModelOutput,
      on429: rotateSidecarProviderOn429,
      retryOn429Policy: rateLimitRetryPolicyFor(route.provider),
      onCompletedResponse: commitReasoningReplayServingRoute,
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

  // Empty-completion guard (codex-router PR #145 port): a 200 that completes with no output
  // text and no tool call is a failure the client cannot see — it silently records the turn as
  // done. The guard holds pre-content adapter events, suppresses the terminal of an empty
  // turn, retries the IDENTICAL request once, and surfaces a stated error when the retry is
  // empty or fails. This is a top-level config opt-in; OCX_EMPTY_COMPLETION_RETRY=0 is a
  // disable-only emergency override. Compaction turns and combo attempts keep their own
  // machinery (the combo preflight already handles empty streams). Native Chat-to-Chat
  // requests return from handleChatCompletions before entering Responses core, so they are
  // intentionally outside this guard and retain their existing one-send wire behavior.
  const emptyCompletionGuardEnabled =
    emptyCompletionRetryEnabled(config)
    && !options.comboAttempt
    && !routedCompaction;

  if (adapter.runTurn) {
    const runTurnAbort = new AbortController();
    const cleanupRunTurnAbort = linkAbortSignal(runTurnAbort, options.abortSignal);
    const queue = createAdapterEventQueue({
      onBacklogExceeded: () => runTurnAbort.abort(),
    });
    // Initial admission must settle before the streaming Response commits HTTP 200.
    // Let the outer Responses facade preserve the local retryable-429 contract.
    try {
      await waitForProviderRequestSlot(route.providerName, route.provider, route.modelId, runTurnAbort.signal);
    } catch (error) {
      cleanupRunTurnAbort();
      queue.close();
      throw error;
    }
    // One attempt of the runTurn transport, against an explicit queue. The
    // empty-completion guard re-invokes the IDENTICAL turn (same parsed request,
    // same forwarded headers, same abort signal) through a fresh queue, so the
    // attempt body must not capture the first queue. Each attempt consumes its
    // own provider pacing slot (#1584): retries are paced like first attempts.
    const runTurnAttempt = async (
      targetQueue: AdapterEventQueue,
      recovery?: AttemptRecoveryKind,
      pacingSlotAcquired = false,
    ): Promise<void> => {
      try {
        if (!pacingSlotAcquired) {
          await waitForProviderRequestSlot(route.providerName, route.provider, route.modelId, runTurnAbort.signal);
        }
        noteAttemptSend(logCtx.activeAttempt, logCtx.usageLogInputTokens, recovery);
        const runTurnProviderFetch = providerFetch(
          route.provider,
          options.codexWsRuntimeIdentity,
          {
            providerName: route.providerName,
            modelId: route.modelId,
            // runTurnAttempt acquired this logical turn's first physical-request slot above.
            // Cursor HTTP/1.1 consumes it for RunSSE; every BidiAppend and redial then waits on
            // the same provider queue through this stateful wrapper.
            pacingSlotAcquired: true,
          },
        );
        await runTurnAdapter.runTurn?.(
          parsed,
          {
            headers: selectedForwardHeaders,
            abortSignal: runTurnAbort.signal,
            translatorBudget,
            providerFetch: runTurnProviderFetch,
          },
          targetQueue.push,
        );
      } catch (err) {
        targetQueue.push(err instanceof RequestPacingQueueOverloadError
          ? {
              type: "error",
              status: 429,
              errorType: "rate_limit_error",
              retryable: true,
              message: err.message,
            }
          : {
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            });
      } finally {
        // Cursor assigns a stable conversation id inside runTurn on the first headerless
        // turn; backfill so Logs can filter/total that opening request (#330 / #522).
        if (!logCtx.conversationId && parsed._cursorConversationId) {
          logCtx.conversationId = normalizeLogConversationId(parsed._cursorConversationId);
        }
        targetQueue.close();
      }
    };
    const runTurn = async (): Promise<void> => runTurnAttempt(queue, undefined, true);
    const rotateRunTurnAdapterOnPreflight429 = async (
      error: Extract<AdapterEvent, { type: "error" }>,
    ): Promise<boolean> => {
      const status = error.status ?? adapterFailureFromMessage(error.message).httpStatus;
      if (
        status !== 429
        || !genericFailoverAccountId
        || genericFailovers >= GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST
        || !isGenericOAuthFailoverEnabled(config, route.providerName)
      ) return false;
      const nextAccountId = rotateGenericOAuthAccountOn429(
        config,
        route.providerName,
        genericFailoverAccountId,
        null,
      );
      if (!nextAccountId) return false;
      try {
        const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
        genericFailoverAccountId = nextAccountId;
        genericFailovers += 1;
        if (!applyFailoverSnapshot(snapshot)) return false;
        // A Cursor conversation/checkpoint is credential-scoped. The failed attempt emitted no
        // client-visible bytes, so replay is safe, but carrying its account identity into the next
        // account would not be. Let the rotated adapter derive a fresh identity and conversation.
        parsed._cursorIdentityScope = undefined;
        parsed._cursorConversationId = undefined;
        if (parsed._providerContinuation?.cursor) {
          const { cursor: _discardedCursor, ...otherProviderState } = parsed._providerContinuation;
          parsed._providerContinuation = otherProviderState;
        }
        const rotatedProvider = resolveWireProtocolOverride(
          route.providerName,
          route.modelId,
          route.provider,
          inboundWire,
        );
        const rotatedAdapter = resolveAdapter(rotatedProvider, config.cacheRetention);
        if (!rotatedAdapter.runTurn) return false;
        runTurnAdapter = rotatedAdapter;
        bindRouteReasoningReplayScope({
          parsed,
          providerName: route.providerName,
          provider: rotatedProvider,
          adapterName: rotatedAdapter.name,
          oauthCredentialSnapshot: { accountId: snapshot.accountId, generation: snapshot.generation },
          codexAuthContext: authCtx,
          forwardHeaders: selectedForwardHeaders,
        });
        sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, rotatedAdapter.name, logCtx.accountLogLabel);
        return true;
      } catch {
        return false;
      }
    };
    const preflightRunTurnFailover = async (
      firstSource: AsyncIterable<AdapterEvent>,
    ): Promise<AsyncIterable<AdapterEvent>> => {
      let source = firstSource;
      while (true) {
        const preflight = await preflightAdapterEvents(source);
        if (!preflight.error || !(await rotateRunTurnAdapterOnPreflight429(preflight.error))) {
          return preflight.stream;
        }
        const retryQueue = createAdapterEventQueue({
          onBacklogExceeded: () => runTurnAbort.abort(),
        });
        void runTurnAttempt(retryQueue, "oauth-account-429");
        source = retryQueue.stream();
      }
    };
    // The empty-completion retry re-runs the turn against a fresh queue: the
    // first queue is closed once its attempt settles, and pushing into it after
    // close is a silent no-op.
    const runTurnRetrySource = (): AsyncIterable<AdapterEvent> => {
      const retryQueue = createAdapterEventQueue({
        onBacklogExceeded: () => runTurnAbort.abort(),
      });
      void runTurnAttempt(retryQueue, "empty-completion");
      return retryQueue.stream();
    };

    const { toolNsMap, declaredToolNames, toolParameterSchemas, freeformToolNames, toolSearchToolNames } = toolBridgeMaps;
    if (parsed.stream) {
      void runTurn();
      let eventSource: AsyncIterable<AdapterEvent> = queue.stream();
      if (genericFailoverAccountId && isGenericOAuthFailoverEnabled(config, route.providerName)) {
        // Preflight holds only heartbeats and the first meaningful event. A first-event 429 can be
        // replayed transparently; after any output reaches the bridge, a later error stays terminal.
        eventSource = await preflightRunTurnFailover(eventSource);
      }
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
      const guardedSource = emptyCompletionGuardEnabled
        ? guardEmptyCompletionEventStream({
            firstEvents: eventSource,
            // Identical-turn retry: same parsed request, same headers, same
            // signal — run the adapter transport again against a fresh queue.
            continuation: runTurnRetrySource,
          })
        // Guard off (the default): leave the stream alone, but record that the turn ended
        // empty so the user has something to correlate instead of an unexplained blank
        // result (#2472). Retrying by default would re-send a turn that may already have had
        // billable side effects, so the honest default is observability, not recovery.
        : observeEmptyCompletion(eventSource, () => {
          console.warn(emptyCompletionNotice(route.providerName, route.modelId));
        });
      const sseStream = bridgeToResponsesSSE(
        guardedSource, parsed._responseModelId ?? parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
        () => {
          runTurnAbort.abort();
          queue.close();
        }, 2_000,
        {
          translatorBudget,
          replayCacheScope: parsed._reasoningReplayScope,
          ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
          stallTimeoutSec: config.stallTimeoutSec,
          hideThinkingSummary: parsed.options.hideThinkingSummary,
          declaredToolNames,
          toolParameterSchemas,
          ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
          ...(routedCompaction ? { compaction: true } : {}),
          // grok-build's strict decoder dies on the typed response.heartbeat frame; its
          // eventsource layer tolerates comment keep-alives. Codex needs the opposite.
          ...(logCtx.surface === "grok" ? { heartbeatStyle: "comment" as const } : {}),
          onUsage: usage => {
            // Raw adapter usage, pre wire-normalization: the bridged SSE now always carries
            // zero-default detail objects, so provenance must come from here (cache_detail_missing).
            logCtx.usageFromBridge = true;
            if (usage) {
              logCtx.usage = usage;
              if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
            }
          },
          onCompletedResponse: (response: Record<string, unknown>, providerState?: OcxProviderContinuationState) => {
            commitReasoningReplayServingRoute();
            rememberKiroDeliveredFinalAnswer(adapter.name, response);
            if (!routedCompaction) {
              rememberResponseState(
                parsed._rawBody,
                response,
                continuationStateForResponse(providerState),
                responseStateOptions(adapterNeedsForcedContinuation(adapter.name)),
              );
            }
          },
        },
      );
      const bridgeTurnAc = new AbortController();
      const trackedSse = trackStreamLifetime(sseStream, bridgeTurnAc, undefined, options.turnAdmissionLease);
      const response = new Response(trackedSse, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" },
      });
      runTurnAdapterSseResponses.add(response);
      return response;
    }

    await runTurn();
    const firstAttemptEvents = await queue.collect();
    let runTurnEvents: AdapterEvent[] = firstAttemptEvents;
    if (genericFailoverAccountId && isGenericOAuthFailoverEnabled(config, route.providerName)) {
      runTurnEvents = [];
      for await (const event of await preflightRunTurnFailover(
        (async function* () { yield* firstAttemptEvents; })(),
      )) runTurnEvents.push(event);
    }
    let events: AdapterEvent[];
    if (emptyCompletionGuardEnabled) {
      events = [];
      for await (const event of guardEmptyCompletionEventStream({
        firstEvents: (async function* () { yield* runTurnEvents; })(),
        continuation: runTurnRetrySource,
      })) events.push(event);
    } else {
      events = runTurnEvents;
    }
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
    const json = buildResponseJSON(events, parsed._responseModelId ?? parsed.modelId, {
      translatorBudget,
      replayCacheScope: parsed._reasoningReplayScope,
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      declaredToolNames,
      toolParameterSchemas,
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
      rememberKiroDeliveredFinalAnswer(adapter.name, json);
      rememberResponseState(
        parsed._rawBody,
        json,
        continuationStateForResponse(providerState),
        responseStateOptions(adapterNeedsForcedContinuation(adapter.name)),
      );
    }
    // #1926 gap 2: the buffered path queued its signature persists inside
    // buildResponseJSON; bound the durability window before the JSON becomes
    // externally visible.
    await awaitThoughtSignatureDurability();
    if (adapterResponseReachedServingTerminal(events, json)) {
      commitReasoningReplayServingRoute();
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
  // An adapter may know the turn needs no inference at all — Kiro's replayed history ending in a
  // delivered final answer. Answer it locally: no build (so no token estimate), no send (so
  // sendCount stays 0), and crucially no empty-completion guard, which treats an outputless
  // terminal as a failed turn and re-invokes the identical request. Routing this through the
  // ordinary event path would therefore reinstate the loop it exists to end.
  const localTerminal = activeAdapter.localTerminal?.(parsed);
  if (localTerminal) {
    logCtx.localTerminalReason = localTerminal.reason;
    // Mark the physical attempt too, not just the parent row. `finishRequestAttempt` finalizes the
    // attempt through the same estimated-provider path, so without this the row reads exact while
    // its own attempt still claims an estimate — the detailed accounting a maintainer actually
    // reads for a zero-send turn.
    if (logCtx.activeAttempt) logCtx.activeAttempt.locallyAnswered = true;
    cleanupUpstreamAbort();
    upstream.abort();
    const terminalEvents: AdapterEvent[] = [{
      type: "done",
      endTurn: true,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }];
    if (parsed.stream) {
      const localSse = bridgeToResponsesSSE(
        (async function* () { yield* terminalEvents; })(),
        parsed._responseModelId ?? parsed.modelId,
        toolBridgeMaps.toolNsMap,
        toolBridgeMaps.freeformToolNames,
        toolBridgeMaps.toolSearchToolNames,
        undefined,
        2_000,
        {
          translatorBudget,
          ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
          ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
        },
      );
      // Same lifetime tracking as every other streaming return in this function: the turn
      // admission lease is released when the body finishes or the client disconnects. Returning
      // the raw stream would hold a lease for a turn that already has all of its output.
      const localTurnAc = new AbortController();
      return new Response(
        trackStreamLifetime(localSse, localTurnAc, undefined, options.turnAdmissionLease),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
          },
        },
      );
    }
    return new Response(
      JSON.stringify(buildResponseJSON(terminalEvents, parsed._responseModelId ?? parsed.modelId, {
        translatorBudget,
      })),
      { headers: { "Content-Type": "application/json" } },
    );
  }
  // One request-scoped transient-retry budget owner, declared here so BOTH the initial send
  // and the later recovery refetches (429, key/account rotation, OAuth replay) share it. A
  // per-leg budget would let a request that recovers several times multiply upstream load.
  let transientSendsUsed = 0;
  const noteTransientSends = (used: number): void => { transientSendsUsed += Math.max(0, used); };
  const remainingTransientSendBudget = (budget: number): number =>
    Math.max(1, budget - transientSendsUsed);
  try {
    initialRequest = await activeAdapter.buildRequest(parsed, { headers: selectedForwardHeaders, translatorBudget });
    refreshRoutedNamespaceToolAliases(initialRequest);
    recordAdapterReasoning(logCtx, initialRequest);
    recordAdapterTier(logCtx, initialRequest);
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
      await waitForProviderRequestSlot(route.providerName, route.provider, route.modelId, upstream.signal);
      upstreamResponse = await activeAdapter.fetchResponse(builtInitialRequest, {
        abortSignal: upstream.signal,
        timeoutMs: connectMs,
        stream: parsed.stream,
        executor: providerFetch(route.provider, options.codexWsRuntimeIdentity, {
          providerName: route.providerName,
          modelId: route.modelId,
        }),
      });
    } else {
      // #1851 scope guard: transient-5xx retry on this generic adapter path is opt-in for
      // direct Google AI Studio only (Vertex/Antigravity use fetchResponse above). Other
      // adapters keep reset-only retry so combo failover still hops on the first 5xx
      // instead of burning ~1.2s of same-target retries per hop.
      // #2643: an opted-in key-auth openai-chat provider also gets transient-5xx retry. The
      // legacy direct-Google exception is preserved exactly; every other adapter still keeps
      // reset-only semantics so combo failover hops on the first 5xx.
      const transientPolicy = transientRetryPolicyFor(route.provider);
      const fetchWithRetryPolicy = (route.provider.adapter === "google" || transientPolicy)
        ? fetchWithTransientRetry
        : fetchWithResetRetry;
      upstreamResponse = await fetchWithRetryPolicy(
        recovery => {
          noteAttemptSend(logCtx.activeAttempt, inputTokenEstimate, recovery);
          return fetchWithHeaderTimeout(builtInitialRequest.url, applyUpstreamRecoveryInit({
            method: builtInitialRequest.method,
            headers: builtInitialRequest.headers,
            body: builtInitialRequest.body,
          }, recovery), upstream.signal, connectMs, parsed.stream,
            providerFetch(route.provider, options.codexWsRuntimeIdentity, {
              providerName: route.providerName,
              modelId: route.modelId,
            }));
        },
        {
          abortSignal: upstream.signal,
          label: safeHostLabel(builtInitialRequest.url),
          ...(transientPolicy
            ? { attempts: transientPolicy.attempts, onSendsConsumed: noteTransientSends }
            : {}),
        },
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
    // Recovery loop: multi-key 429 failover + at most ONE opaque-state rebuild and ONE
    // anthropic 413 tightened retry
    // (devlog/260714_image_normalization_pipeline/030). One mutable activeAdapter serves
    // both paths so a 429→413 sequence never rebuilds against a stale pre-rotation
    // adapter, and imageTierBias — once armed — rides EVERY subsequent rebuild so a
    // 413→429 rotation cannot silently undo the tightening.
    let imageRetryAttempted = false;
    const opaqueBlobRecoveryGuard: OpaqueBlobRecoveryGuard = { attempted: false };
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
          recordAdapterTier(logCtx, retryRequest);
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
      refreshRoutedNamespaceToolAliases(retryRequest);
      const retryEstimate = typeof retryRequest.usageLog?.inputTokens === "number"
        ? retryRequest.usageLog.inputTokens
        : undefined;
      if (retryEstimate !== undefined) logCtx.usageLogInputTokens = retryEstimate;
      logCtx.providerAdapter = activeAdapter.name;
      sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, activeAdapter.name, logCtx.accountLogLabel);
      noteAttemptSend(logCtx.activeAttempt, retryEstimate, recovery);
      try {
        try {
          if (activeAdapter.fetchResponse) {
            await waitForProviderRequestSlot(route.providerName, route.provider, route.modelId, upstream.signal);
            return await activeAdapter.fetchResponse(retryRequest, {
              abortSignal: upstream.signal,
              timeoutMs: connectMs,
              stream: parsed.stream,
              executor: providerFetch(route.provider, options.codexWsRuntimeIdentity, {
                providerName: route.providerName,
                modelId: route.modelId,
              }),
            });
          }
          // #2643 review: this leg used to call fetchWithHeaderTimeout directly, so an
          // opted-in provider's transient-5xx policy applied to the initial send and to
          // native chat but was silently bypassed here — a 429 that recovered into a
          // retryable 503 got no retry on the Responses path. Route it through the same
          // selection, and pass what is LEFT of the request-scoped budget rather than a
          // fresh one, so a recovery loop cannot multiply total upstream sends.
          const refetchTransientPolicy = transientRetryPolicyFor(route.provider);
          const refetchWithPolicy = (route.provider.adapter === "google" || refetchTransientPolicy)
            ? fetchWithTransientRetry
            : fetchWithResetRetry;
          return await refetchWithPolicy(
            recoveryKind => fetchWithHeaderTimeout(retryRequest.url,
              applyUpstreamRecoveryInit({
                method: retryRequest.method, headers: retryRequest.headers, body: retryRequest.body,
              }, recoveryKind), upstream.signal, connectMs, parsed.stream,
              providerFetch(route.provider, options.codexWsRuntimeIdentity, {
                providerName: route.providerName,
                modelId: route.modelId,
              })),
            {
              abortSignal: upstream.signal,
              label: safeHostLabel(retryRequest.url),
              ...(refetchTransientPolicy
                ? {
                  attempts: remainingTransientSendBudget(refetchTransientPolicy.attempts),
                  onSendsConsumed: noteTransientSends,
                }
                : {}),
            },
          );
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
    // Keep recovery kinds in sync with the native Responses `passthroughRecovery:` loop above.
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
          return formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(err));
        }
        sentOAuthSnapshot = refreshed;
        replayOAuthCredentialSnapshot = {
          accountId: refreshed.accountId,
          generation: refreshed.generation,
        };
        if (route.providerName === "kiro") {
          parsed._kiroAuthContext = { ...(refreshed.kiro ?? {}) };
        }
        const refreshedProvider = resolveProviderTransport(
          route.providerName,
          { ...route.provider, apiKey: refreshed.accessToken },
          parsed.options.promptCacheKey,
          route.providerName === "github-copilot"
            ? resolveCopilotApiBaseUrl(refreshed.apiBaseUrl)
            : undefined,
        );
        route.provider = refreshedProvider;
        invalidateSameTargetRequest();
        activeAdapter = resolveAdapter(
          resolveWireProtocolOverride(route.providerName, route.modelId, refreshedProvider, inboundWire),
          config.cacheRetention,
        );
        bindRouteReasoningReplayScope({
          parsed,
          providerName: route.providerName,
          provider: refreshedProvider,
          adapterName: activeAdapter.name,
          oauthCredentialSnapshot: replayOAuthCredentialSnapshot,
        });
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
        bindRouteReasoningReplayScope({
          parsed,
          providerName: route.providerName,
          provider: route.provider,
          adapterName: activeAdapter.name,
        });
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
          sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, activeAdapter.name, logCtx.accountLogLabel);
          const result = await rebuildAndRefetch("anthropic-oauth-429");
          if ("failed" in result) return result.failed;
          upstreamResponse = result;
        } catch {
          break;
        }
      }
      // Generic OAuth account failover (#2568) for providers with no pool of their own.
      // Presence is consent since #2568d: rotation is ON by default once two or more eligible
      // accounts are stored for the provider, because a second deliberate login is read as the
      // operator asking for it. A single-account install is still a strict no-op, and an
      // explicit `oauthAccountFailover.enabled: false` (global or per provider) still wins --
      // see isGenericOAuthFailoverEnabled in src/oauth/generic-account-failover.ts. Codex and
      // Anthropic are excluded by isGenericFailoverProvider: their pools own quota scopes,
      // probe leases and affinity that this must not reimplement.
      while (
        upstreamResponse.status === 429
        && genericFailoverAccountId
        && genericFailovers < GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST
        && isGenericOAuthFailoverEnabled(config, route.providerName)
      ) {
        const nextAccountId = rotateGenericOAuthAccountOn429(
          config,
          route.providerName,
          genericFailoverAccountId,
          upstreamResponse.headers.get("retry-after"),
        );
        if (!nextAccountId) break;
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        try {
          // The FULL snapshot, not just the bearer: Antigravity pairs an account-matched
          // projectId with its token and Kiro carries routing metadata, so a token-only swap
          // would mix one account's credential with another's routing data.
          const snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId);
          genericFailoverAccountId = nextAccountId;
          genericFailovers += 1;
          if (!applyFailoverSnapshot(snapshot)) break;
          invalidateSameTargetRequest();
          activeAdapter = resolveAdapter(
            resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
            config.cacheRetention,
          );
          sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, activeAdapter.name, logCtx.accountLogLabel);
          const result = await rebuildAndRefetch("oauth-account-429");
          if ("failed" in result) return result.failed;
          upstreamResponse = result;
        } catch {
          break;
        }
      }
      // Unknown provenance is deliberately fail-soft in pre-flight: after a restart, TTL expiry,
      // or LRU eviction, a valid same-backend blob must survive. A decoder's own 4xx identity is
      // the missing authoritative signal. Rebuild once through the same sanitation path used by a
      // known route switch; invalidating is mandatory because `parsed` mutates in place and the
      // same-target cache would otherwise replay the rejected bytes verbatim.
      const opaqueBlobRecovery = await attemptOpaqueBlobRecovery({
        response: upstreamResponse,
        outboundBody: sameTargetRequest?.body,
        adapterName: activeAdapter.name,
        parsed,
        guard: opaqueBlobRecoveryGuard,
        signal: upstream.signal,
      }, recovery => {
        invalidateSameTargetRequest();
        return rebuildAndRefetch(recovery);
      });
      if (opaqueBlobRecovery.kind === "failed") return opaqueBlobRecovery.response;
      if (opaqueBlobRecovery.kind === "recovered") {
        upstreamResponse = opaqueBlobRecovery.response;
        continue recovery;
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
        // No pre-read guard: `consumeComboFailure` -> `readBoundedResponseBody` reads
        // `response.body` itself with the abort signal threaded through, and the combo
        // contract is that this body's getter is touched exactly once. A guard here would be
        // a second `.body` access for no gain, since the bounded reader owns settlement.
        const failure = await consumeComboFailure(upstreamResponse, options.abortSignal)
          .finally(cleanupUpstreamAbort);
        options.onConsumedComboFailure?.(failure);
        return failure.response;
      }
      let errorText: string;
      try {
        errorText = await readDisplaySafeErrorText(
          upstreamResponse,
          upstream.signal,
          "unknown error",
        );
      } finally {
        cleanupUpstreamAbort();
      }
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
      const upstreamRetryAfter = upstreamResponse.headers.get("retry-after");
      const normalized = normalizeUpstreamErrorText(errorText, "unknown error");
      const message = normalized.cyberPolicy
        ? normalized.message
          ?? (isCyberPolicyCode(normalized.code) ? CYBER_POLICY_FALLBACK_MESSAGE : normalized.safeText)
        : enrichOpenCodeZenRateLimitMessage(
          `Provider error ${upstreamResponse.status}: ${normalized.safeText}`,
          {
            status: upstreamResponse.status,
            providerName: route.providerName,
            baseUrl: route.provider.baseUrl,
            adapter: route.provider.adapter,
            authMode: route.provider.authMode,
            hasApiKey: Boolean(route.provider.apiKey?.trim()),
            upstreamRetryAfter,
            // This recovery path is the HTTP Responses wire; custom runTurn transports
            // never reach enrichOpenCodeZenRateLimitMessage here.
            supportsHttpSameKeyRetry: true,
          },
        );
      const retryAfter = normalized.cyberPolicy
        ? undefined
        : resolveClientRetryAfter({
          status: upstreamResponse.status,
          message,
          upstreamRetryAfter,
        });
      return formatErrorResponse(
        upstreamResponse.status,
        normalized.cyberPolicy ? (normalized.type ?? CYBER_POLICY_ERROR_CODE) : "upstream_error",
        message,
        {
          ...(normalized.cyberPolicy ? { code: CYBER_POLICY_ERROR_CODE } : {}),
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        },
      );
    }
  }

  cancelBodyOnAbort(upstreamResponse.body, upstream.signal);

  // One bounded internal continuation re-ask for clean end_turn turns that announced an edit
  // without emitting a tool call. Anthropic gets this by default; openai-chat providers opt in
  // per-provider via `terminalContinuationGuard` (the heuristic was tuned on Anthropic turns,
  // so it stays off for the shared openai-chat adapter unless a provider enables it).
  const terminalGuardEnabled = (activeAdapter.name === "anthropic"
      || (activeAdapter.name === "openai-chat" && route.provider.terminalContinuationGuard === true))
    && !options.comboAttempt && !routedCompaction;
  /**
   * One bounded internal re-ask for Anthropic end_turn-without-tool-call turns. Replays the
   * continuation on a 429 with the same-key retry budget (hoisted per request), then falls
   * back to key/account failover; a failure becomes an in-stream adapter error so the client
   * never sees a second hidden HTTP response or an unbounded retry loop.
   */
  const fetchTerminalGuardContinuation = async function* (
    nextParsed: OcxParsedRequest,
    initialRecoveryKind?: AttemptRecoveryKind,
  ): AsyncGenerator<AdapterEvent> {
    let response: Response | undefined;
    // One-shot recovery label for the next top-of-loop continuation send after a failover rotation.
    let nextContinuationRecoveryKind: AttemptRecoveryKind | undefined = initialRecoveryKind;
    /**
     * Build and fetch one terminal-guard continuation. `recoveryKind` tags same-target and
     * failover sends (`empty-completion`, `rate-limit-429`, `key-429`,
     * `anthropic-oauth-429`, `image-413`); the
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
          recordAdapterTier(logCtx, continuationRequest);
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
          await waitForProviderRequestSlot(route.providerName, route.provider, nextParsed.modelId, upstream.signal);
          return await activeAdapter.fetchResponse(builtContinuationRequest, {
            abortSignal: upstream.signal,
            timeoutMs: connectMs,
            stream: nextParsed.stream,
            executor: providerFetch(route.provider, options.codexWsRuntimeIdentity, {
              providerName: route.providerName,
              modelId: nextParsed.modelId,
            }),
          });
        }
        // Same #1851 scope guard as the initial send: transient-5xx retry only for direct
        // Google AI Studio; every other adapter keeps reset-only semantics here.
        const continuationTransientPolicy = transientRetryPolicyFor(route.provider);
        const fetchContinuationWithRetryPolicy = (route.provider.adapter === "google" || continuationTransientPolicy)
          ? fetchWithTransientRetry
          : fetchWithResetRetry;
        return await fetchContinuationWithRetryPolicy(
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
              providerFetch(route.provider, options.codexWsRuntimeIdentity, {
                providerName: route.providerName,
                modelId: nextParsed.modelId,
              }),
            );
          },
          {
            abortSignal: upstream.signal,
            label: safeHostLabel(builtContinuationRequest.url),
            // Same request-scoped budget as the initial send and the 429/rotation refetches:
            // a terminal-guard continuation is another leg of ONE request, so handing it a
            // fresh `attempts` would let one request exceed the configured total-send ceiling.
            ...(continuationTransientPolicy
              ? {
                attempts: remainingTransientSendBudget(continuationTransientPolicy.attempts),
                onSendsConsumed: noteTransientSends,
              }
              : {}),
          },
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
          bindRouteReasoningReplayScope({
            parsed: nextParsed,
            providerName: route.providerName,
            provider: route.provider,
            adapterName: activeAdapter.name,
          });
          // Response persistence closes over the outer parsed request; keep its owner binding in
          // sync with the terminal-guard clone that builds the rotated continuation request.
          bindRouteReasoningReplayScope({
            parsed,
            providerName: route.providerName,
            provider: route.provider,
            adapterName: activeAdapter.name,
          });
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
            sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, activeAdapter.name, logCtx.accountLogLabel);
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
      const errorText = await readDisplaySafeErrorText(response, upstream.signal, "unknown error");
      const normalized = normalizeUpstreamErrorText(errorText, "unknown error");
      yield {
        type: "error",
        status: normalized.cyberPolicy ? 400 : response.status,
        message: normalized.cyberPolicy
          ? normalized.message
            ?? (isCyberPolicyCode(normalized.code) ? CYBER_POLICY_FALLBACK_MESSAGE : normalized.safeText)
          : `Provider continuation error ${response.status}: ${normalized.safeText}`,
        ...(normalized.cyberPolicy
          ? {
            errorType: normalized.type ?? CYBER_POLICY_ERROR_CODE,
            code: CYBER_POLICY_ERROR_CODE,
            retryable: false,
          }
          : {}),
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
          yield* activeAdapter.parseStream(response, translatorBudget, logCtx.activeTierMetadata);
        } else if (activeAdapter.parseResponse) {
          yield* await activeAdapter.parseResponse(response, translatorBudget, logCtx.activeTierMetadata);
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

  const fetchGuardedEmptyCompletionRetry = (): AsyncIterable<AdapterEvent> => {
    const retryEvents = fetchTerminalGuardContinuation(parsed, "empty-completion");
    return terminalGuardEnabled
      ? guardTerminalEventStream({
          parsed,
          firstEvents: retryEvents,
          adapterName: activeAdapter.name,
          maxAutoContinuations: 1,
          continuation: fetchTerminalGuardContinuation,
        })
      : retryEvents;
  };

  if (parsed.stream) {
    const initialEventStream = activeAdapter.parseStream(
      upstreamResponse,
      translatorBudget,
      logCtx.activeTierMetadata,
    );
    const eventStream = terminalGuardEnabled
      ? guardTerminalEventStream({
          parsed,
          firstEvents: initialEventStream,
          adapterName: activeAdapter.name,
          maxAutoContinuations: 1,
          continuation: fetchTerminalGuardContinuation,
        })
      : initialEventStream;
    // The empty-completion guard sits OUTSIDE the terminal guard: a completed
    // turn with no text and no tool call is retried with the IDENTICAL request
    // (fetchTerminalGuardContinuation(parsed) replays the cached byte-identical
    // request — same body, same headers, same signal).
    const guardedEventStream = emptyCompletionGuardEnabled
      ? guardEmptyCompletionEventStream({
          firstEvents: eventStream,
          continuation: fetchGuardedEmptyCompletionRetry,
        })
      : eventStream;
    const { toolNsMap, declaredToolNames, toolParameterSchemas, freeformToolNames, toolSearchToolNames } = toolBridgeMaps;
    const sseStream = bridgeToResponsesSSE(
      guardedEventStream, parsed._responseModelId ?? parsed.modelId, toolNsMap, freeformToolNames, toolSearchToolNames,
      () => upstream.abort(), 2_000,
      {
        translatorBudget,
        replayCacheScope: parsed._reasoningReplayScope,
        ...(options.forceEmptyResponseId ? { responseId: "" } : {}),
        stallTimeoutSec: config.stallTimeoutSec,
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        declaredToolNames,
      toolParameterSchemas,
        ...(options.onFirstOutput ? { onFirstOutput: options.onFirstOutput } : {}),
        ...(routedCompaction ? { compaction: true } : {}),
        // Same grok-surface split as the runTurn branch above.
        ...(logCtx.surface === "grok" ? { heartbeatStyle: "comment" as const } : {}),
        onUsage: usage => {
          // Raw adapter usage, pre wire-normalization (see the runTurn branch above).
          logCtx.usageFromBridge = true;
          if (usage) {
            logCtx.usage = usage;
            if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
          }
        },
        onCompletedResponse: (response: Record<string, unknown>, providerState?: OcxProviderContinuationState) => {
          commitReasoningReplayServingRoute();
          rememberKiroDeliveredFinalAnswer(activeAdapter.name, response);
          // Compaction turns must NOT enter the continuation cache: _rawBody still holds the full
          // PRE-compaction history, and a later previous_response_id expansion would rehydrate the
          // giant stale chain Codex just replaced.
          if (!routedCompaction) {
            rememberResponseState(
              parsed._rawBody,
              response,
              continuationStateForResponse(providerState),
              responseStateOptions(activeAdapter.name === "kiro"),
            );
          }
        },
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
      const initialEvents = await activeAdapter.parseResponse(
        upstreamResponse,
        translatorBudget,
        logCtx.activeTierMetadata,
      );
      let guardedEvents: AdapterEvent[];
      if (terminalGuardEnabled) {
        guardedEvents = [];
        for await (const event of guardTerminalEventStream({
          parsed,
          firstEvents: (async function* () { yield* initialEvents; })(),
          adapterName: activeAdapter.name,
          maxAutoContinuations: 1,
          continuation: fetchTerminalGuardContinuation,
        })) guardedEvents.push(event);
      } else {
        guardedEvents = initialEvents;
      }
      if (emptyCompletionGuardEnabled) {
        events = [];
        for await (const event of guardEmptyCompletionEventStream({
          firstEvents: (async function* () { yield* guardedEvents; })(),
          continuation: fetchGuardedEmptyCompletionRetry,
        })) events.push(event);
      } else {
        events = guardedEvents;
      }
    } finally {
      cleanupUpstreamAbort();
    }
    const { toolNsMap, declaredToolNames, toolParameterSchemas, freeformToolNames, toolSearchToolNames } = toolBridgeMaps;
    let providerState: OcxProviderContinuationState | undefined;
    const json = buildResponseJSON(events, parsed._responseModelId ?? parsed.modelId, {
      translatorBudget,
      replayCacheScope: parsed._reasoningReplayScope,
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      toolNsMap,
      declaredToolNames,
      toolParameterSchemas,
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
      rememberKiroDeliveredFinalAnswer(activeAdapter.name, json);
      rememberResponseState(
        parsed._rawBody,
        json,
        continuationStateForResponse(providerState),
        responseStateOptions(activeAdapter.name === "kiro"),
      );
    }
    // #1926 gap 2: same buffered-path durability bound as the primary branch.
    await awaitThoughtSignatureDurability();
    if (adapterResponseReachedServingTerminal(events, json)) {
      commitReasoningReplayServingRoute();
    }
    return new Response(JSON.stringify(json), { headers: { "Content-Type": "application/json" } });
  }

  return formatErrorResponse(400, "invalid_request_error", "Non-streaming not supported by this adapter");
  } finally {
    if (pendingHostAdmissionLease) {
      releaseUpstreamHostAdmission(pendingHostAdmissionLease);
      releaseCodexAuthContextProbeLease(authCtx);
    }
  }
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
