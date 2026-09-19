import { createSteeringSettingsNormalizer } from "./native-steering-policy";
import { nativeResponseControlEligible } from "./native-response-control";
import { NativeInjectionReplay } from "./native-injection-replay";
import { NativeSteeringReplay } from "./native-steering-replay";
import type {
  ResponsesRequestContext,
  ResponsesAdmissionState,
  PassthroughAdmissionState,
} from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { ResponsesTransport } from "./request-transport";
import type { ResponsesEffects } from "./response-effects";
import type { ResponsesSendBudget } from "./request-send-budget";
import { transientSendCapFor } from "./request-send-budget";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { codexSafetyBufferingFilterOptions, terminalStatusFromParsed } from "../relay";
import { imageGenToolCallAliases } from "../responses-image-gen-repair";
import { rememberResponseState, isBodyNonPersistable } from "../../responses/state";
import {
  currentTurnWireToolCatalogBody,
  hasExplicitWireToolCatalog,
  collectDeclaredWireToolNames,
  collectDeclaredBareWireToolNames,
  collectDeclaredNamelessClientCallTypes,
  collectProviderExecutedCallTypes,
  undeclaredToolCallName,
  undeclaredToolCallNameInResponse,
  normalizeDefaultNamespaceInResponse,
} from "../responses-undeclared-tool-guard";
import { collectSelfNamedNamespaceScrubAuthorization } from "../responses-self-named-namespace-scrub";
import type { ProviderExecutedCallType } from "../responses-undeclared-tool-guard";
import {
  releaseCodexAuthContextProbeLease,
  unwrapUpstreamRetryEvidenceError,
  codexProbeLeaseId,
  codexProbeQuotaScope,
  codexTransientProbeGrant,
  createCodexReserveDispatchGuard,
} from "../../codex/auth-context";
import {
  NamespaceToolCollisionError,
  restoreRoutedNamespaceCalls,
} from "../../responses/namespace-tool-compat";
import { XaiToolSchemaCompatibilityError } from "../../adapters/xai-tool-schema";
import { formatErrorResponse } from "../../bridge";
import { redactSecretString } from "../../lib/redact";
import {
  collectFunctionCallRepairSchemas,
  repairFunctionCallsInJson,
} from "../../responses/function-call-compat";
import type { RoutedNamespaceToolAliases } from "../../responses/namespace-tool-compat";
import { hasResponsesSnapshotRepair, repairResponsesSnapshotJson } from "../responses-snapshot-repair";
import { backfillResponsesFieldsJson } from "./responses-field-backfill";
import type { AdapterRequest } from "../../adapters/base";
import { isXaiResponsesDestination, resolveProviderTransport } from "../../providers/xai-transport";
import { CODE_MODE_EXEC_TOOL_NAME } from "../../types";
import type { ResponsesTerminalStatus } from "../../bridge";
import { hasPassiveAccountQuota, recordPassiveAccountQuota } from "../../providers/quota";
import {
  isMuseSubscriptionUsagePayload,
  parseMuseSubscriptionUsage,
} from "../../providers/muse-subscription-usage";
import { restoreMuseToolNames } from "../../responses/muse-tool-name-alias";
import { restoreRoutedCustomCalls } from "../../responses/custom-tool-compat";
import { restorePlaintextV2AgentMessageCalls } from "../../responses/plaintext-v2-agent-messages";
import {
  recordAdapterReasoning,
  recordAdapterTier,
  sealRequestAttemptIdentity,
  recordAttemptCredentialSource,
} from "../request-log";
import { noteAttemptRecoveryWithheld } from "../request-log";
import {
  upstreamHostHealthKey,
  normalizeUpstreamHostCircuitThreshold,
  disableUpstreamHostCircuitForKey,
  acquireUpstreamHostAdmission,
  resetUpstreamHostHealth,
  releaseUpstreamHostAdmission,
  recordUpstreamHostFailure,
} from "../../codex/upstream-host-health";
import {
  safeOriginLabel,
  fetchWithHeaderTimeout,
  providerFetch,
  safeHostLabel,
  storedPoolReplayDispatchNotifier,
} from "./fetch-helpers";
import { classifyPoolRecoveryDispatch } from "../../routing/probe-lease";
import { clientCancelledResponse } from "./core-errors";
import {
  upstreamHostCircuitOpenResponse,
  usesCodexForwardPoolAuth,
  codexWsQuotaObserver,
  isFixedCodexAccount,
  codexPoolAccountModel400Denial,
  shouldRetryCodexPoolAccountQuota,
  shouldRetryCodexPoolAccountTransient,
  retryCodexPoolOnAlternateAccount,
} from "./core-codex-account";
import {
  clearCodexModelDenialEvidence,
  recordCodexModelDenialEvidence,
} from "../../codex/model-entitlements";
import { readCodexWsStage } from "./codex-ws-wire";
import { linkAbortSignal } from "./core-lifetime";
import type { CodexAuthContext } from "../../codex/auth-context";
import { checkOutboundBodySize, describeOutboundBodyRefusal } from "./outbound-body-guard";
import { streamingContextOverflowResponse } from "./context-overflow";
import {
  SendBudgetExhaustedError,
  fetchWithTransientRetry,
  applyUpstreamRecoveryInit,
  isNonReplayableResponse,
  refetchAfterProtocolSafeReset,
  TRANSIENT_RETRY_MAX_ATTEMPTS,
  prepareSameTarget429Wait,
  sleepWithAbort,
} from "../../lib/upstream-retry";
import { mapCodexAuthContextErrorToResponse } from "./codex-auth-error";
import { classifyTransportFailureKind, transportErrorCode } from "../../lib/upstream-reachability";
import { recordCodexUpstreamOutcome } from "../../codex/routing";
import { describeUpstreamConnectFailure } from "./upstream-error";
import type { OpaqueBlobRecoveryGuard } from "./core-opaque-recovery";
import {
  rateLimitRetryPolicyFor,
  rateLimitRetryDelayMs,
  transientRetryPolicyFor,
} from "../../providers/key-failover";
import type { AttemptRecoveryKind } from "../../usage/log";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { refreshPoolForwardAuth, refreshNativeMainForwardAuth, withClaudeNativeSession } from "./core-auth";
import { bindRouteReasoningReplayScope } from "./core-replay";
import type { OAuthAccessSnapshot } from "../../oauth";
import { publicOAuthAuthenticationErrorMessage } from "../../oauth";
import { resolveCopilotApiBaseUrl } from "../../oauth/github-copilot";
import {
  GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST,
  isGenericOAuthFailoverEnabled,
  rotateGenericOAuthAccountOn429,
  failoverAccountSnapshot,
} from "../../oauth/generic-account-failover";
import { captureCodexAffinityDiagnostic } from "../../codex/affinity-debug";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../../codex/catalog/native-models";
import {
  attemptOpaqueBlobRecovery,
  outboundResponsesBodyCarriesEncryptedFunctionOutput,
  resetStreamedOpaqueBlobLogContext,
  consoleGoUploadRejectionBody,
  CONSOLE_GO_UPLOAD_RETRY_DELAY_MS,
  reasoningEffortRejectionText,
} from "./core-opaque-recovery";
import type { RequestLogContext } from "../request-log";
import { deferProtocolSafeResetRecovery, preflightComboStreamResponse } from "./combo-stream-preflight";
import { isCodexWsUpstreamResponse } from "./ws-upstream";
import { upstreamErrorMessageFromPayload, ENCRYPTED_FUNCTION_OUTPUT_REJECTION } from "../../lib/errors";
import { isTransientConsoleGoUploadRejection } from "../../providers/opencode-zen-rate-limit";
import { planReasoningEffortDowngrade } from "../../providers/reasoning-metadata";

/** Prepares and recovers one native Responses exchange before client commitment. */
export async function preparePassthroughExchange(
  requestContext: Pick<ResponsesRequestContext, "config" | "logCtx" | "options" | "req">,
  admissionState: ResponsesAdmissionState,
  nativeHostState: PassthroughAdmissionState,
  requestState: Pick<
    PreparedResponsesRequest,
    | "route"
    | "toolBridgeMaps"
    | "parsed"
    | "translatorBudget"
    | "responseStateOptions"
    | "selectedForwardHeaders"
    | "clientRequestedStream"
    | "inboundWire"
    | "substituteMainCredential"
    | "callerAuthHeaders"
    | "subagentFallbackAccountId"
  >,
  transportState: Pick<
    ResponsesTransport,
    | "adapter"
    | "genericFailoverAccountId"
    | "passiveQuotaWriterGeneration"
    | "oauthDispatch"
    | "selectionIsCurrent"
    | "requestBindings"
    | "resolveSelectionAdapter"
    | "isOAuth401ReplayProvider"
    | "sentOAuthSnapshot"
    | "refreshResolvedOAuthSelection"
    | "replayOAuthCredentialSnapshot"
    | "genericFailovers"
    | "applyFailoverSnapshot"
    | "noteRoutedAttemptSend"
  >,
  responseEffects: Pick<
    ResponsesEffects,
    | "refreshRequestToolAliases"
    | "routedMuseToolNameAliases"
    | "plaintextV2AgentMessageToolNames"
    | "routedNamespaceToolAliases"
    | "plaintextV2AgentMessageAliasedToolNames"
    | "notifyResponseComplete"
  >,
  sendBudgetState: Pick<
    ResponsesSendBudget,
    | "remainingTransientSendBudget"
    | "noteTransientSends"
    | "recoverySendAllowance"
    | "recoveryClassFor"
    | "sendBudgetExhausted"
    | "reserveCredentialHop"
    | "pendingHopPermit"
    | "workflowRootId"
    | "sendsUsed"
  >,
) {
  const { config, logCtx, options, req } = requestContext;
  const {
    route,
    toolBridgeMaps,
    parsed,
    translatorBudget,
    responseStateOptions,
    clientRequestedStream,
    inboundWire,
    substituteMainCredential,
    callerAuthHeaders,
  } = requestState;
  const {
    passiveQuotaWriterGeneration,
    oauthDispatch,
    resolveSelectionAdapter,
    isOAuth401ReplayProvider,
    refreshResolvedOAuthSelection,
    applyFailoverSnapshot,
  } = transportState;
  const { refreshRequestToolAliases, notifyResponseComplete } = responseEffects;
  const {
    remainingTransientSendBudget,
    noteTransientSends,
    recoverySendAllowance,
    recoveryClassFor,
    sendBudgetExhausted,
    reserveCredentialHop,
    workflowRootId,
  } = sendBudgetState;

    const codexSafetyBufferingOptions = isCanonicalOpenAiForwardProvider(route.provider)
      ? codexSafetyBufferingFilterOptions(config)
      : undefined;
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
    if (options.nativeControl && nativeResponseControlEligible(route.provider, options.nativeControl)
      && options.inboundTransport === "websocket" && !options.comboAttempt) {
      const body = parsed._rawBody as Record<string, unknown>;
      if (options.nativeControl.kind === "steering") {
        options.nativeControl.normalizeContinuation = createSteeringSettingsNormalizer(parsed, route, config, req.headers);
      }
      const Replay = options.nativeControl.kind === "injection" ? NativeInjectionReplay : NativeSteeringReplay;
      options.nativeControl.replayFactory = () => new Replay(body.input, (input, response) => {
        if (passthroughRecordEligible && !isBodyNonPersistable(body)) {
          rememberResponseState({ ...body, input }, response, undefined, responseStateOptions(true));
        }
      });
    }
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
    const selfNamedNamespaceScrubAuthorization = collectSelfNamedNamespaceScrubAuthorization(
      clientToolAuthorizationBody,
      toolBridgeMaps.bareCustomToolNames,
      toolBridgeMaps.bareFunctionToolNames,
    );
    const clientExplicitWireToolCatalog = hasExplicitWireToolCatalog(clientToolAuthorizationBody);
    const clientDeclaredWireToolNames = collectDeclaredWireToolNames(clientToolAuthorizationBody);
    const clientDeclaredBareWireToolNames = collectDeclaredBareWireToolNames(clientToolAuthorizationBody);
    const clientDeclaredNamelessCallTypes = collectDeclaredNamelessClientCallTypes(
      clientToolAuthorizationBody,
    );
    // Hosted calls the PROVIDER runs itself. Gated on the destination actually being xAI, so a
    // declaration alone cannot buy the exemption on some other upstream that never serves it.
    // Provider-executed declarations are authorized from the actual outbound body, after the
    // adapter has applied destination-specific injection and normalization. Client-executed tool
    // authority remains bounded to the caller-owned catalog above.
    const providerExecutedCallTypes = new Set<ProviderExecutedCallType>();
    let request: Awaited<ReturnType<typeof transportState.adapter.buildRequest>>;
    try {
      request = await transportState.adapter.buildRequest(parsed, { headers: requestState.selectedForwardHeaders, translatorBudget });
    } catch (error) {
      releaseCodexAuthContextProbeLease(admissionState.authCtx);
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
    const functionRepairSchemas = isCanonicalOpenAiForwardProvider(route.provider)
      ? new Map()
      : collectFunctionCallRepairSchemas(clientToolAuthorizationBody);
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
    refreshRequestToolAliases(request);
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
    // the client understands — `tests/providers/github-copilot/github-copilot-stream-contract.test.ts` sends
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
    const declaredBareWireToolNames = new Set<string>();
    const declaredNamelessClientCallTypes = new Set<string>();
    // `buildToolBridgeMaps` adds each eligible bare alias to `declaredToolNames` and `toolNsMap`
    // (one authorized identity claims the bare name). `refreshUndeclaredToolGuard` normally copies
    // those entries into `declaredWireToolNames`, but passthrough restoration runs before the
    // undeclared-tool guard, so restore that request-bounded identity here, before authorization
    // checks. `exec` uses separate handling: its bridge alias is copied into the declared set only
    // when the client itself declared bare `exec`, because otherwise code-mode normalization could
    // authorize the unrelated code-mode helper names.
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
    const normalizeFunctionCompletionJson = (text: string): string => {
      const snapshot = hasResponsesSnapshotRepair(route.provider.responsesSnapshotRepair)
        ? repairResponsesSnapshotJson(text, outboundRequestBody)
        : text;
      // Sparse gateways need completion status inferred before schema repair can
      // distinguish completed arguments from in-progress placeholders.
      return repairFunctionCallsInJson(backfillResponsesFieldsJson(snapshot), functionRepairSchemas);
    };
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
      declaredBareWireToolNames.clear();
      if (replayedInputPrefixLength === 0) {
        for (const name of collectDeclaredWireToolNames(outboundRequestBody)) {
          declaredWireToolNames.add(name);
        }
        for (const name of collectDeclaredBareWireToolNames(outboundRequestBody)) {
          declaredBareWireToolNames.add(name);
        }
      }
      for (const name of clientDeclaredWireToolNames) declaredWireToolNames.add(name);
      for (const name of clientDeclaredBareWireToolNames) declaredBareWireToolNames.add(name);
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
          // normalization and re-authorize `exec_command`/`shell_command`/`apply_patch`/`view_image`, so it is
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
    let inspectedTerminal: ResponsesTerminalStatus | null = null;
    let inspectedCompletionSeen = false;
    let firstTerminalAllowsRecall = false;
    const passiveQuotaObserved = hasPassiveAccountQuota(route.providerName)
      && route.provider.authMode === "oauth";
    const noteInspectedPayload = (payload: unknown) => {
      // First terminal stays authoritative even in metadata-only inspection, which
      // intentionally continues parsing after a failed/incomplete terminal.
      const terminal = terminalStatusFromParsed(payload);
      if (inspectedTerminal === null && terminal !== null) {
        inspectedTerminal = terminal;
        // The client boundary accepts a terminal by event type, even without a
        // response object. Such a terminal must permanently decline recall.
        if (terminal === "completed" && payload && typeof payload === "object"
          && "response" in payload && payload.response && typeof payload.response === "object"
          && !Array.isArray(payload.response) && "model" in payload.response) {
          firstTerminalAllowsRecall = typeof payload.response.model === "string"
            && payload.response.model.trim().length > 0;
        }
      }
      // Meta reports subscription usage ONLY as an in-stream event; there is no endpoint
      // to poll (003 §E probed 17 paths, all 404). Observed here rather than behind a
      // dedicated inspector handler because onParsedPayload already reaches every
      // passthrough shape -- eager relay and both tee consumers -- through this one
      // function.
      //
      // Placed BEFORE the undeclared-tool early return below, which is load-bearing: that
      // guard latches for the rest of the turn once it fires, and a turn that tripped it
      // still legitimately reports usage.
      if (passiveQuotaObserved && isMuseSubscriptionUsagePayload(payload)) {
        const quota = parseMuseSubscriptionUsage(payload);
        // Read at EVENT time, not at handler construction: failover rebinds this, and the
        // quota belongs to the account that actually served the turn.
        const servingAccountId = transportState.genericFailoverAccountId;
        if (quota && servingAccountId) {
          recordPassiveAccountQuota(route.providerName, servingAccountId, quota, passiveQuotaWriterGeneration);
        }
      }
      // Gated on the same flag as the guard itself: with no readable catalog (or a forward-auth
      // provider) every name looks undeclared, and flipping this would stop recording continuation
      // state for exactly the passthrough traffic the guard deliberately stands down for.
      if (undeclaredToolGuardActive && !inspectionSawUndeclaredTool && undeclaredToolCallName(
        restoreAuthorizedBareNamespaceToolCalls(
          restoreMuseToolNames(payload, responseEffects.routedMuseToolNameAliases).value,
        ),
        declaredWireToolNames,
        declaredNamelessClientCallTypes,
        providerExecutedCallTypes,
        declaredBareWireToolNames,
      ) !== undefined) {
        inspectionSawUndeclaredTool = true;
      }
      // The snapshot callback opts the inspector into output reconstruction. Compaction
      // has no continuation cache, so use the parsed terminal here without adding retention.
      if (responseEffects.plaintextV2AgentMessageToolNames.size === 0 && !rememberPassthroughResponse && payload && typeof payload === "object"
        && "type" in payload && payload.type === "response.completed"
        && "response" in payload && payload.response && typeof payload.response === "object"
        && !Array.isArray(payload.response)) {
        rememberPassthroughResponseChecked(payload.response as Record<string, unknown>);
      }
    };
    const rememberPassthroughResponseChecked = (
      response: { id?: unknown; output?: unknown; status?: unknown; model?: unknown },
    ) => {
      if (inspectionSawUndeclaredTool) return;
      const restored = restoreRoutedCustomCalls(
        restoreAuthorizedBareNamespaceToolCalls(
          restoreRoutedNamespaceCalls(
            restoreMuseToolNames(response, responseEffects.routedMuseToolNameAliases).value,
            responseEffects.routedNamespaceToolAliases,
          ).value,
        ),
        routedCustomToolNames,
        routedCustomToolRepairNames,
        declaredWireToolNames,
      ).value;
      const normalizedResponse = (functionRepairSchemas.size > 0
        ? JSON.parse(normalizeFunctionCompletionJson(JSON.stringify(restored)))
        : restored) as { id?: unknown; output?: unknown; status?: unknown };
      const plaintextRestore = restorePlaintextV2AgentMessageCalls(
        normalizedResponse, responseEffects.plaintextV2AgentMessageToolNames, responseEffects.plaintextV2AgentMessageAliasedToolNames,
      );
      if (plaintextRestore.overflowed) return;
      const restoredResponse = plaintextRestore.value as typeof normalizedResponse;
      // Replay overlap compares the items the client echoes, including visible reasoning shape.
      const replayResponse = restoredResponse;
      if (
        undeclaredToolGuardActive
        && undeclaredToolCallNameInResponse(
          restoredResponse,
          declaredWireToolNames,
          declaredNamelessClientCallTypes,
          providerExecutedCallTypes,
          declaredBareWireToolNames,
        ) !== undefined
      ) {
        return;
      }
      const normalizedReplayResponse = (undeclaredToolGuardActive
        ? normalizeDefaultNamespaceInResponse(
            replayResponse,
            declaredWireToolNames,
            declaredBareWireToolNames,
          ).value
        : replayResponse) as typeof replayResponse;
      rememberPassthroughResponse?.(normalizedReplayResponse);
      const firstCompletion = !inspectedCompletionSeen;
      inspectedCompletionSeen = true;
      if (firstCompletion && (inspectedTerminal === null || firstTerminalAllowsRecall)) {
        // A model-less first completion permanently declines recall; later terminal
        // frames are hidden by the client boundary and cannot supply its identity.
        // Native inspection sees the pre-rewrite model. Only an actual terminal
        // model can seed recall; an absent model never falls back to the pick.
        if (typeof response.model === "string" && response.model.trim()) {
          notifyResponseComplete({
            status: response.status,
            model: parsed._responseModelId !== undefined && parsed._responseModelId !== parsed.modelId
              ? parsed._responseModelId : response.model,
          });
        }
      }
    };
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
    if (nativeHostState.lease && nativeHostState.lease.key !== hostKey) {
      return formatErrorResponse(502, "upstream_error", "Provider host changed after circuit admission");
    }
    if (options.abortSignal?.aborted) {
      releaseCodexAuthContextProbeLease(admissionState.authCtx);
      return clientCancelledResponse();
    }
    if (!nativeHostState.lease && hostCircuitEnabled) {
      const admission = acquireUpstreamHostAdmission(
        hostKey!,
        config.upstreamHostCircuitThreshold,
      );
      if (admission.kind === "blocked") {
        releaseCodexAuthContextProbeLease(admissionState.authCtx);
        return upstreamHostCircuitOpenResponse(admission.retryAfterSeconds);
      }
      nativeHostState.lease = admission.lease;
    }
    const settleObservedHostResponse = (): void => {
      if (hostCircuitEnabled) {
        resetUpstreamHostHealth(actualHostKey, nativeHostState.lease);
      } else {
        resetUpstreamHostHealth(actualHostKey);
      }
      nativeHostState.lease = null;
    };
    /**
     * #4191: a Codex WS exchange pins its content-free stage record on the
     * Response it resolves (markCodexWsStage). Adopting the record here, at
     * the single funnel every physical upstream response passes through,
     * binds it to the attempt that actually served it — including the 502/504
     * pre-response JSON settles that never reach the SSE relay.
     */
    const adoptCodexWsStage = (response: Response): void => {
      const stage = readCodexWsStage(response);
      if (stage && logCtx.activeAttempt) logCtx.activeAttempt.codexWsStage = stage;
    };
    const adoptObservedResponse = <T extends Response>(response: T): T => {
      settleObservedHostResponse();
      adoptCodexWsStage(response);
      return response;
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
    /**
     * This leg's transient-5xx ladder cap, from the provider's own `transientRetryOn5xx`.
     *
     * The lane used to pass `TRANSIENT_RETRY_MAX_ATTEMPTS` at every call site, so an operator who
     * configured the option on a key-auth `openai-responses` provider changed nothing in either
     * direction, while the same provider on `openai-chat` was tuned normally. That asymmetry is
     * #4893. The gate in `transientRetryPolicyFor` returns null for OAuth and forward providers,
     * so the ChatGPT pool keeps exactly the ladder it has always had.
     *
     * Read per call rather than captured once, for two reasons. `route.provider` is reassigned
     * inside the recovery loop by credential rotation and transport resolution, so a hoisted
     * policy could outlive the provider row it came from. And the configured value is a total for
     * the whole request, so it has to be measured against what the request has already sent at
     * the moment each leg asks.
     *
     * Still bounded by the request: every site feeds this to `remainingTransientSendBudget` or
     * `recoverySendAllowance`, which intersect it with the request-wide base allowance. So a
     * provider can narrow this request's sends exactly and cannot widen the bound that exists to
     * stop per-request amplification (#4546).
     */
    const transientSendPolicy = () => transientRetryPolicyFor(route.provider);
    const transientSendAttempts = (): number => transientSendCapFor(
      transientSendPolicy()?.attempts,
      sendBudgetState.sendsUsed,
    );
    const configuredTransientSendBudgetExhausted = (): boolean =>
      transientSendPolicy() !== null && transientSendAttempts() === 0;
    /**
     * Refuse a built body that exceeds the operator's configured ceiling, before it is sent.
     *
     * Unconfigured this measures nothing and returns undefined, so an unset proxy behaves
     * exactly as it does today. Runs at every point a body is built or rebuilt, because a
     * rebuild can produce a payload the initial check never saw.
     */
    const refuseOversizedOutboundBody = (
      builtRequest: AdapterRequest,
      refusalAuthCtx: CodexAuthContext = admissionState.authCtx,
    ): Response | undefined => {
      const result = checkOutboundBodySize(builtRequest.body, config.maxUpstreamBodyBytes);
      if (result.admitted) return undefined;

      // This returns before the surrounding fetch/finally owns the observation, so release
      // it here or one refused body holds translator budget for the process lifetime.
      builtRequest.releaseBodyObservation?.();
      upstream.abort();
      releaseUpstreamHostAdmission(nativeHostState.lease);
      nativeHostState.lease = null;
      releaseCodexAuthContextProbeLease(refusalAuthCtx);
      logCtx.errorCode = "outbound_body_too_large";
      console.warn(
        `[responses] refused an oversized outbound body: bytes=${result.bytes} limit=${result.limit} `
        + `input_images=${result.imageCount} image_bytes=${result.imageBytes} `
        + `model=${JSON.stringify(parsed.modelId)}`,
      );
      // A streaming client treats HTTP 413 as a retryable transport error and resends the same
      // oversized body — the reconnect loop #3177 exists to stop. Terminal overflow is the
      // honest shape, and it is what the upstream-413 path already returns.
      if (clientRequestedStream) {
        return streamingContextOverflowResponse(
          parsed._responseModelId ?? parsed.modelId,
          translatorBudget,
        );
      }
      return formatErrorResponse(
        413,
        "outbound_body_too_large",
        describeOutboundBodyRefusal(result),
      );
    };
    const transportFailureResponse = (err: unknown): Response => {
      upstream.abort();
      if (options.abortSignal?.aborted) {
        releaseUpstreamHostAdmission(nativeHostState.lease);
        nativeHostState.lease = null;
        releaseCodexAuthContextProbeLease(admissionState.authCtx);
        return clientCancelledResponse();
      }
      // A budget refusal is a proxy decision, not an upstream fault. Reporting it as
      // 502 upstream_error would blame the provider for a limit this process applied, and
      // would record a fake reachability failure against the account's health.
      if (err instanceof SendBudgetExhaustedError) {
        releaseUpstreamHostAdmission(nativeHostState.lease);
        nativeHostState.lease = null;
        releaseCodexAuthContextProbeLease(admissionState.authCtx);
        return formatErrorResponse(429, "request_send_budget_exhausted", err.message);
      }
      const localRefusal = mapCodexAuthContextErrorToResponse(unwrapUpstreamRetryEvidenceError(err), {
        now: Date.now(), accountSelector: route.codexAccountNamespace,
      });
      if (localRefusal) {
        releaseUpstreamHostAdmission(nativeHostState.lease);
        nativeHostState.lease = null;
        releaseCodexAuthContextProbeLease(admissionState.authCtx);
        return localRefusal;
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
            lease: nativeHostState.lease,
          });
        } else {
          recordUpstreamHostFailure(actualHostKey, { code: transportErrorCode(err) });
        }
        nativeHostState.lease = null;
      } else {
        releaseUpstreamHostAdmission(nativeHostState.lease);
        nativeHostState.lease = null;
      }
      if (usesCodexForwardPoolAuth(admissionState.authCtx, route.provider)) {
        recordCodexUpstreamOutcome(config, admissionState.authCtx.accountId, outcome, {
          threadId: admissionState.authCtx.affinityKey,
          fixedAccount: admissionState.authCtx.fixedAccount,
          modelId: route.modelId,
          probeLeaseId: codexProbeLeaseId(admissionState.authCtx),
          probeQuotaScope: codexProbeQuotaScope(admissionState.authCtx),
          transientProbe: codexTransientProbeGrant(admissionState.authCtx),
          writerGeneration: admissionState.authCtx.writerGeneration,
        });
      }
      const msg = outcome === "timeout"
        ? `Provider connect timeout after ${connectMs}ms`
        : describeUpstreamConnectFailure(err, connectMs);
      return formatErrorResponse(502, "upstream_error", msg);
    };
    const initialBodyRefusal = refuseOversizedOutboundBody(request);
    if (initialBodyRefusal) return initialBodyRefusal;
    try {
      // Transient-5xx pre-stream retry (devlog/_plan/260716_claudecode_hardening/010):
      // the ChatGPT backend emits transient 502/520s that an immediate retry absorbs.
      // Body is a replayable string; nothing has streamed to the client yet.
      upstreamResponse = await fetchWithTransientRetry(
        recovery => {
          // The pool-wide recovery window measures recovery traffic against observed demand,
          // and this is where demand is observed: `recovery === undefined` is a new request's
          // first send, everything after it is the same request trying again. Without this the
          // ratio has no denominator and the window collapses to its quiet-pool floor, which
          // would throttle recovery on a busy proxy exactly as hard as on an idle one (#4701).
          if (recovery === undefined) classifyPoolRecoveryDispatch("initial");
          transportState.noteRoutedAttemptSend(passthroughEstimate, recovery);
          return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
            method: request.method,
            headers: request.headers,
            body: request.body,
          }, recovery), upstream.signal, connectMs, parsed.stream,
            providerFetch(route.provider, options.codexWsRuntimeIdentity, {
              nativeControl: nativeResponseControlEligible(route.provider, options.nativeControl) && options.inboundTransport === "websocket" && !options.comboAttempt
                && responseEffects.plaintextV2AgentMessageToolNames.size === 0
                ? options.nativeControl : undefined,
              dispatchOverride: oauthDispatch(request),
              providerName: route.providerName,
              modelId: route.modelId,
              onCodexWsQuota: codexWsQuotaObserver(admissionState.authCtx, route.provider, route.modelId),
              beforeDispatch: isCanonicalOpenAiForwardProvider(route.provider)
                ? createCodexReserveDispatchGuard(admissionState.authCtx, options.codexAuthPolicy ?? config, route.modelId, options.admission, options.visionDescribeTerminal === true) : undefined,
            }),
            route.provider.authMode === "forward")
            // Every real attempt response — including an intermediate 5xx the
            // retry wrapper replaces — proves the host was reached (#914 review).
            .then(adoptObservedResponse);
        },
        { abortSignal: upstream.signal, label: safeHostLabel(request.url), attempts: remainingTransientSendBudget(transientSendAttempts()), onSendsConsumed: noteTransientSends },
      );
    } catch (err) {
      return transportFailureResponse(err);
    } finally {
      request.releaseBodyObservation?.();
    }

    const opaqueBlobRecoveryGuard: OpaqueBlobRecoveryGuard = { attempted: false };
    // At most one reasoning-effort downgrade per request.
    const reasoningEffortDowngradeGuard: { attempted: boolean } = { attempted: false };
    let oauth401ReplayAttempted = false;
    let codex401ReplayKind: "main" | "stored" | null = null;
    // Console Go answers a transient 400 "Invalid upload request." for bodies it accepts
    // moments later; at most one byte-identical replay is allowed per request.
    const consoleGoUploadRetryGuard: { attempted: boolean } = { attempted: false };
    const rateLimitPolicy = rateLimitRetryPolicyFor(route.provider);
    let rateLimitRetries = 0;
    const rebuildAndRefetch = async (
      recovery: AttemptRecoveryKind,
    ): Promise<Response | { failed: Response }> => {
      const retryAdapter = resolveSelectionAdapter(
        resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire),
        config.cacheRetention,
      );
      if (!("passthrough" in retryAdapter) || !retryAdapter.passthrough) {
        upstream.abort();
        return { failed: formatErrorResponse(502, "upstream_error", "Recovery changed the provider wire unexpectedly") };
      }
      try {
        if (recovery !== "console-go-upload-retry") {
          request = await retryAdapter.buildRequest(parsed, {
            headers: requestState.selectedForwardHeaders,
            translatorBudget,
          });
        }
        refreshRequestToolAliases(request);
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
      recordAttemptCredentialSource(logCtx.activeAttempt, route.providerName, route.provider, retryAdapter.name);
      const rebuiltBodyRefusal = refuseOversizedOutboundBody(request);
      if (rebuiltBodyRefusal) return { failed: rebuiltBodyRefusal };
      // The base allowance is spent first. An unconfigured provider may then draw the one shared
      // final-recovery reserve, which keeps a validated sanitized rebuild after a 5xx streak alive
      // at four total sends instead of dying at three. An explicit provider total cannot widen.
      // Reserve outside the try so the finally can hand it back if the leg never reaches its send.
      const allowance = recoverySendAllowance(
        transientSendAttempts(),
        recoveryClassFor(recovery),
        `${route.providerName}|${route.modelId}|${recovery}`,
        { allowFinalRecoveryReserve: transientSendPolicy() === null },
      );
      try {
        return await fetchWithTransientRetry(
          innerRecovery => {
            // Gated on the return, not fire-and-forget: a consumed permit means this leg
            // already sent once, and letting the second call through would be a free send.
            if (allowance.permit && !allowance.permit.use()) {
              throw new SendBudgetExhaustedError(safeHostLabel(request.url));
            }
            transportState.noteRoutedAttemptSend(passthroughEstimate, innerRecovery ?? recovery);
            return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
              method: request.method,
              headers: request.headers,
              body: request.body,
            }, innerRecovery), upstream.signal, connectMs, parsed.stream,
              providerFetch(route.provider, options.codexWsRuntimeIdentity, {
              nativeControl: nativeResponseControlEligible(route.provider, options.nativeControl) && options.inboundTransport === "websocket" && !options.comboAttempt
                && responseEffects.plaintextV2AgentMessageToolNames.size === 0
                ? options.nativeControl : undefined,
              dispatchOverride: oauthDispatch(request),
                providerName: route.providerName,
                modelId: route.modelId,
                onCodexWsQuota: codexWsQuotaObserver(admissionState.authCtx, route.provider, route.modelId),
                beforeDispatch: isCanonicalOpenAiForwardProvider(route.provider)
                  ? createCodexReserveDispatchGuard(admissionState.authCtx, options.codexAuthPolicy ?? config, route.modelId, options.admission, options.visionDescribeTerminal === true) : undefined,
              }),
              route.provider.authMode === "forward")
              .then(adoptObservedResponse);
          },
          { abortSignal: upstream.signal, label: safeHostLabel(request.url), attempts: allowance.attempts, onSendsConsumed: noteTransientSends },
        );
      } catch (err) {
        return { failed: transportFailureResponse(err) };
      } finally {
        // A no-op once the permit was used or once onSendsConsumed settled it; it only refunds
        // a reservation whose send never happened.
        allowance.permit?.release();
        request.releaseBodyObservation?.();
      }
    };

    // Keep recovery kinds in sync with the generic `recovery:` loop below.
    passthroughRecovery: for (;;) {

    if (
      upstreamResponse.status === 401
      && (admissionState.authCtx.kind === "main-pool" || admissionState.authCtx.kind === "pool")
      && usesCodexForwardPoolAuth(admissionState.authCtx, route.provider)
      && codex401ReplayKind === null
    ) {
      codex401ReplayKind = admissionState.authCtx.kind === "pool" ? "stored" : "main";
      try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed */ }
      const poolAuthCtx = admissionState.authCtx.kind === "pool" ? admissionState.authCtx : undefined;
      const poolReplay = poolAuthCtx
        ? await refreshPoolForwardAuth({ req, config, route, authCtx: poolAuthCtx, substituteMainCredential, options, logCtx })
        : undefined;
      const replay = poolReplay
        ?? await refreshNativeMainForwardAuth({ req, config, route, authCtx: admissionState.authCtx, substituteMainCredential, options });
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
        releaseCodexAuthContextProbeLease(admissionState.authCtx);
        return replay.response;
      }
      admissionState.authCtx = replay.authCtx;
      route.provider = replay.provider;
      requestState.selectedForwardHeaders = withClaudeNativeSession(replay.headers, replay.provider, options.claudeNativeSessionId);
      const replayAdapter = resolveSelectionAdapter(
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
        codexAuthContext: admissionState.authCtx,
        forwardHeaders: requestState.selectedForwardHeaders,
      });
      logCtx.providerAdapter = replayAdapter.name;
      sealRequestAttemptIdentity(logCtx.activeAttempt, logCtx.provider, replayAdapter.name, logCtx.accountLogLabel);
      recordAttemptCredentialSource(logCtx.activeAttempt, route.providerName, route.provider, replayAdapter.name);
      try {
        request = await replayAdapter.buildRequest(parsed, {
          headers: requestState.selectedForwardHeaders,
          translatorBudget,
        });
        refreshRequestToolAliases(request);
        recordAdapterReasoning(logCtx, request);
        recordAdapterTier(logCtx, request);
        refreshUndeclaredToolGuard(request);
        // The 401 replay rebuilds the body before sending, so it needs the same ceiling as
        // every other build site; a replay is exactly when a grown payload reappears.
        const replayBodyRefusal = refuseOversizedOutboundBody(request);
        if (replayBodyRefusal) return replayBodyRefusal;
        transportState.noteRoutedAttemptSend(passthroughEstimate, "oauth-401");
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
              nativeControl: nativeResponseControlEligible(route.provider, options.nativeControl) && options.inboundTransport === "websocket" && !options.comboAttempt
                && responseEffects.plaintextV2AgentMessageToolNames.size === 0
                ? options.nativeControl : undefined,
              dispatchOverride: oauthDispatch(request),
              providerName: route.providerName,
              modelId: route.modelId,
              onCodexWsQuota: codexWsQuotaObserver(admissionState.authCtx, route.provider, route.modelId),
              beforeDispatch: isCanonicalOpenAiForwardProvider(route.provider)
                ? createCodexReserveDispatchGuard(admissionState.authCtx, options.codexAuthPolicy ?? config, route.modelId, options.admission, options.visionDescribeTerminal === true) : undefined,
            }),
            codex401ReplayKind === "stored" ? options.onStoredPool401ReplayDispatched : undefined,
          ),
          route.provider.authMode === "forward",
        ).then(adoptObservedResponse);
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
      && transportState.sentOAuthSnapshot
      && !oauth401ReplayAttempted
      // Refused here, before the 401 body is cancelled: once it is gone the request can only
      // answer with a synthetic 502, which would report a proxy budget decision as an upstream
      // fault and throw away the credential evidence the client needs.
      && !sendBudgetExhausted(transientSendAttempts())
    ) {
      oauth401ReplayAttempted = true;
      try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
      let refreshed: OAuthAccessSnapshot;
      try {
        refreshed = await refreshResolvedOAuthSelection(transportState.sentOAuthSnapshot);
      } catch (err) {
        upstream.abort();
        releaseCodexAuthContextProbeLease(admissionState.authCtx);
        return formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(err));
      }
      if (route.provider.googleMode === "cloud-code-assist" && !refreshed.projectId) {
        upstream.abort();
        releaseCodexAuthContextProbeLease(admissionState.authCtx);
        return formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(new Error("Cloud Code Assist project is required")));
      }
      transportState.sentOAuthSnapshot = refreshed;
      transportState.replayOAuthCredentialSnapshot = {
        accountId: refreshed.accountId,
        generation: refreshed.generation,
      };
      if (route.providerName === "kiro") {
        parsed._kiroAuthContext = { ...(refreshed.kiro ?? {}) };
      }
      const refreshedProvider = resolveProviderTransport(
        route.providerName,
        {
          ...route.provider,
          apiKey: refreshed.accessToken,
          ...(refreshed.projectId ? { project: refreshed.projectId } : {}),
        },
        parsed.options.promptCacheKey,
        route.providerName === "github-copilot"
          ? resolveCopilotApiBaseUrl(refreshed.apiBaseUrl)
          : undefined,
      );
      route.provider = refreshedProvider;
      const refreshedAdapter = resolveSelectionAdapter(
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
        oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot,
      });
      logCtx.providerAdapter = refreshedAdapter.name;
      sealRequestAttemptIdentity(
        logCtx.activeAttempt,
        logCtx.provider,
        refreshedAdapter.name,
        logCtx.accountLogLabel,
      );
      recordAttemptCredentialSource(logCtx.activeAttempt, route.providerName, route.provider, refreshedAdapter.name);
      try {
        request = await refreshedAdapter.buildRequest(parsed, {
          headers: requestState.selectedForwardHeaders,
          translatorBudget,
        });
        refreshRequestToolAliases(request);
        recordAdapterReasoning(logCtx, request);
        recordAdapterTier(logCtx, request);
      } catch (err) {
        upstream.abort();
        if (options.abortSignal?.aborted) return clientCancelledResponse();
        const msg = err instanceof Error ? err.message : String(err);
        return formatErrorResponse(400, "invalid_request_error", redactSecretString(msg));
      }
      refreshUndeclaredToolGuard(request);
      const refreshedBodyRefusal = refuseOversizedOutboundBody(request);
      if (refreshedBodyRefusal) return refreshedBodyRefusal;
      try {
        upstreamResponse = await fetchWithTransientRetry(
          recovery => {
            transportState.noteRoutedAttemptSend(passthroughEstimate, recovery ?? "oauth-401");
            return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
              method: request.method,
              headers: request.headers,
              body: request.body,
            }, recovery), upstream.signal, connectMs, parsed.stream,
              providerFetch(route.provider, options.codexWsRuntimeIdentity, {
              nativeControl: nativeResponseControlEligible(route.provider, options.nativeControl) && options.inboundTransport === "websocket" && !options.comboAttempt
                && responseEffects.plaintextV2AgentMessageToolNames.size === 0
                ? options.nativeControl : undefined,
              dispatchOverride: oauthDispatch(request),
                providerName: route.providerName,
                modelId: route.modelId,
                onCodexWsQuota: codexWsQuotaObserver(admissionState.authCtx, route.provider, route.modelId),
                beforeDispatch: isCanonicalOpenAiForwardProvider(route.provider)
                  ? createCodexReserveDispatchGuard(admissionState.authCtx, options.codexAuthPolicy ?? config, route.modelId, options.admission, options.visionDescribeTerminal === true) : undefined,
              }),
              route.provider.authMode === "forward")
              .then(adoptObservedResponse);
          },
          { abortSignal: upstream.signal, label: safeHostLabel(request.url), attempts: remainingTransientSendBudget(transientSendAttempts()), onSendsConsumed: noteTransientSends },
        );
      } catch (err) {
        return transportFailureResponse(err);
      } finally {
        request.releaseBodyObservation?.();
      }
    }

    // Native Responses returns before the generic adapter's OAuth rotation loop. Keep
    // the same quorum, cooldown and request budget here, before any client bytes flow.
   if (
     upstreamResponse.status === 429
      // Not a provider rate limit when this proxy synthesized it for a refused reset
      // replay; rotating accounts on it would re-send an inference that may already
      // have run and would cool down an account that refused nothing.
      && !isNonReplayableResponse(upstreamResponse)
     && transportState.genericFailoverAccountId
      && transportState.genericFailovers < GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST
      && isGenericOAuthFailoverEnabled(config, route.providerName)
    ) {
      // The roster cap above is one half of the bound; the request's shared budget is the
      // other. A refused hop leaves the real 429 -- body, Retry-After and any quota evidence
      // -- exactly as upstream sent it.
      const hop = reserveCredentialHop(
        "auth-recovery",
        `${route.providerName}|${route.modelId}|oauth-account-429`,
        true,
      );
      if (hop.allowed) {
        const nextAccountId = rotateGenericOAuthAccountOn429(
          config, route.providerName, transportState.genericFailoverAccountId,
          upstreamResponse.headers.get("retry-after"),
          Date.now(),
          route.modelId,
        );
        let snapshot: OAuthAccessSnapshot | undefined;
        if (nextAccountId) {
          try { snapshot = await failoverAccountSnapshot(route.providerName, nextAccountId); }
          catch { /* Keep the original 429 body readable when the next credential is unavailable. */ }
        }
        if (snapshot && await applyFailoverSnapshot(snapshot)) {
          transportState.genericFailovers += 1;
          route.provider = resolveProviderTransport(
            route.providerName, route.provider, parsed.options.promptCacheKey, transportState.sentOAuthSnapshot?.apiBaseUrl,
          );
          bindRouteReasoningReplayScope({
            parsed, providerName: route.providerName, provider: route.provider,
            adapterName: "openai-responses", oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot,
          });
          try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already closed */ }
          // The replay IS this hop's send, so the rebuild spends the reservation instead of
          // asking for one of its own.
          sendBudgetState.pendingHopPermit = hop.permit;
          const result = await rebuildAndRefetch("oauth-account-429");
          sendBudgetState.pendingHopPermit = undefined;
          if ("failed" in result) return result.failed;
          upstreamResponse = result;
          continue passthroughRecovery;
        }
        // No credential moved, so the reservation costs nothing.
        hop.permit?.release();
      } else {
        // Rotation was available -- the roster cap above admitted it -- and the shared request
        // budget refused. Recorded so a one-send log is not read as "nothing was eligible",
        // which is the ambiguity this attribution exists to remove (#5044).
        noteAttemptRecoveryWithheld(logCtx.activeAttempt, "rotation-send-budget");
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
      && !isNonReplayableResponse(upstreamResponse)
     && rateLimitPolicy !== null
      && rateLimitRetries < rateLimitPolicy.attempts
      // Checked here rather than inside the helper: prepareSameTarget429Wait releases the 429
      // body, so a refusal discovered after the wait can no longer return the real rate-limit
      // answer and would surface a synthetic 502 instead.
      && !sendBudgetExhausted(transientSendAttempts())
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
            transportState.noteRoutedAttemptSend(passthroughEstimate, recovery ?? "rate-limit-429");
            return fetchWithHeaderTimeout(request.url, applyUpstreamRecoveryInit({
              method: request.method,
              headers: request.headers,
              body: request.body,
            }, recovery), upstream.signal, connectMs, parsed.stream,
              providerFetch(route.provider, options.codexWsRuntimeIdentity, {
              nativeControl: nativeResponseControlEligible(route.provider, options.nativeControl) && options.inboundTransport === "websocket" && !options.comboAttempt
                && responseEffects.plaintextV2AgentMessageToolNames.size === 0
                ? options.nativeControl : undefined,
              dispatchOverride: oauthDispatch(request),
                providerName: route.providerName,
                modelId: route.modelId,
                onCodexWsQuota: codexWsQuotaObserver(admissionState.authCtx, route.provider, route.modelId),
                beforeDispatch: isCanonicalOpenAiForwardProvider(route.provider)
                  ? createCodexReserveDispatchGuard(admissionState.authCtx, options.codexAuthPolicy ?? config, route.modelId, options.admission, options.visionDescribeTerminal === true) : undefined,
              }),
              route.provider.authMode === "forward")
              .then(adoptObservedResponse);
          },
          { abortSignal: upstream.signal, label: safeHostLabel(request.url), attempts: remainingTransientSendBudget(transientSendAttempts()), onSendsConsumed: noteTransientSends },
        );
      } catch (err) {
        return transportFailureResponse(err);
      }
    }

    const captureAffinityResponse = (
      response: Response,
      captureAuthCtx: CodexAuthContext = admissionState.authCtx,
      captureRequest: Awaited<ReturnType<typeof transportState.adapter.buildRequest>> = request,
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

    if (usesCodexForwardPoolAuth(admissionState.authCtx, route.provider)) {
      let poolRetryOutcome: number | undefined;
      // A success is the freshest evidence there is about this pair, and it outranks any earlier
      // refusal: whatever the entitlement was when upstream declined, it is not that now. Both
      // ids are cleared because the wire model can differ from the routed one.
      if (upstreamResponse.ok) {
        clearCodexModelDenialEvidence(admissionState.authCtx.accountId, route.modelId);
        clearCodexModelDenialEvidence(admissionState.authCtx.accountId, parsed.modelId);
      }
      const model400Denial = await codexPoolAccountModel400Denial(
        upstreamResponse,
        route.modelId,
        options.abortSignal,
        parsed.modelId,
      );
      if (model400Denial !== undefined) {
        // Spend this refusal on more than one retry. It is the account's own authenticated
        // answer about this model, and the roster cache that selection otherwise reads expires
        // five minutes after a catalog sync fills it -- so without remembering this, the next
        // request selects the same account on quota alone and takes the same 400 (#4906).
        recordCodexModelDenialEvidence(admissionState.authCtx.accountId, model400Denial);
        poolRetryOutcome = 400;
      } else if (!admissionState.authCtx.fixedAccount && await shouldRetryCodexPoolAccountQuota(
        upstreamResponse,
        options.abortSignal,
      )) {
        // Pre-stream only: once SSE has begun, mid-stream quota stays terminal.
        // ChatGPT sometimes wraps quota exhaustion in a generic 5xx. Normalize only
        // body-confirmed cases to quota evidence so cooldown and rotation both apply.
        poolRetryOutcome = upstreamResponse.status >= 500 ? 429 : upstreamResponse.status;
      } else if (!admissionState.authCtx.fixedAccount && shouldRetryCodexPoolAccountTransient(upstreamResponse)) {
        // A plain transient 5xx the same-account retry layer could not absorb. Keep the real
        // status so it records as transient rather than quota.
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
          callerAuthHeaders,
          config,
          route,
          parsed,
          logCtx,
          options: { ...options, workflowRootId },
          firstAuthCtx: admissionState.authCtx,
          firstResponse: upstreamResponse,
          outcomeStatus: poolRetryOutcome,
          sameAccountOnly: storedReplaySpent,
          upstream,
          connectMs,
          passthroughEstimate,
          stream: parsed.stream,
          onResponse: (response, retryAuthCtx, retryRequest) => {
            adoptCodexWsStage(response);
            captureAffinityResponse(
              response,
              retryAuthCtx,
              retryRequest,
              retryAuthCtx.kind !== "main",
            );
          },
        });
        if (retry.kind === "transport") {
          admissionState.authCtx = retry.authCtx;
          return transportFailureResponse(retry.error);
        }
        if (retry.kind === "retried") {
          admissionState.authCtx = retry.authCtx;
          request = retry.request;
          refreshRequestToolAliases(request);
          refreshUndeclaredToolGuard(request);
          upstreamResponse = retry.upstreamResponse;
          requestState.selectedForwardHeaders = retry.selectedForwardHeaders;
          // Keep subagent quota-failure health keyed to the account that actually served.
          requestState.subagentFallbackAccountId = retry.authCtx.accountId;
        }
      }
    }
    // The deterministic route record cannot classify history it never observed (restart, expiry,
    // eviction, or an older transcript). Inspect only a bounded clone of a 4xx whose exact outbound
    // Responses body still carries opaque state, then rebuild once through the ordinary adapter
    // sanitation path. A second rejection falls through unchanged because the guard stays armed.
    if (!configuredTransientSendBudgetExhausted()) {
      const opaqueBlobRecovery = await attemptOpaqueBlobRecovery({
        response: upstreamResponse,
        outboundBody: request.body,
        adapterName: transportState.adapter.name,
        parsed,
        guard: opaqueBlobRecoveryGuard,
        signal: upstream.signal,
      }, rebuildAndRefetch);
      if (opaqueBlobRecovery.kind === "failed") return opaqueBlobRecovery.response;
      if (opaqueBlobRecovery.kind === "recovered") {
        upstreamResponse = opaqueBlobRecovery.response;
        continue passthroughRecovery;
      }
    }

    const recoveryContentType = upstreamResponse.headers.get("content-type")?.toLowerCase() ?? "";
    const streamedFunctionOutputCandidate = upstreamResponse.ok
      && !!upstreamResponse.body
      && (recoveryContentType.includes("text/event-stream") || (!recoveryContentType && parsed.stream))
      && !opaqueBlobRecoveryGuard.attempted
      && !configuredTransientSendBudgetExhausted()
      && outboundResponsesBodyCarriesEncryptedFunctionOutput(request.body);
    if (streamedFunctionOutputCandidate) {
      const preflightLog: RequestLogContext = { model: logCtx.model, provider: logCtx.provider };
      const preflight = await preflightComboStreamResponse(upstreamResponse, preflightLog,
        payload => {
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
          const type = (payload as { type?: unknown }).type;
          return (type === "error" || type === "response.failed" || type === "response.incomplete")
            && upstreamErrorMessageFromPayload(payload) === ENCRYPTED_FUNCTION_OUTPUT_REJECTION;
        }, {
          allowMissingContentType: !recoveryContentType && parsed.stream,
          replayReadErrors: true,
        });
      if (options.abortSignal?.aborted) return transportFailureResponse(options.abortSignal.reason);
      upstreamResponse = preflight.response;
      if (preflight.kind === "failed") {
        if (!configuredTransientSendBudgetExhausted()) {
          const streamedOpaqueRecovery = await attemptOpaqueBlobRecovery({
            response: upstreamResponse,
            outboundBody: request.body,
            adapterName: transportState.adapter.name,
            parsed,
            guard: opaqueBlobRecoveryGuard,
            signal: upstream.signal,
          }, rebuildAndRefetch);
          if (streamedOpaqueRecovery.kind === "failed") return streamedOpaqueRecovery.response;
          if (streamedOpaqueRecovery.kind === "recovered") {
            resetStreamedOpaqueBlobLogContext(logCtx);
            upstreamResponse = streamedOpaqueRecovery.response;
            continue passthroughRecovery;
          }
        }
        logCtx.upstreamError = preflightLog.upstreamError;
        logCtx.terminalHttpStatus = preflightLog.terminalHttpStatus;
        logCtx.terminalErrorCode = preflightLog.terminalErrorCode;
        logCtx.terminalIncompleteReason = preflightLog.terminalIncompleteReason;
      }
    }
    // Console Go (opencode-zen / opencode-go) intermittently rejects a body it accepts seconds
    // later with 400 invalid_request_error / "Invalid upload request." Replay the byte-identical
    // request once after the exact gateway rejection. Single-shot guard.
    // This recovery reuses the captured request; other recovery kinds still rebuild.
    if (!consoleGoUploadRetryGuard.attempted) {
      const uploadRejectionBody = await consoleGoUploadRejectionBody(
        upstreamResponse,
        consoleGoUploadRetryGuard.attempted,
        upstream.signal,
      );
      if (uploadRejectionBody !== undefined
        && !configuredTransientSendBudgetExhausted()
        && isTransientConsoleGoUploadRejection({
          status: upstreamResponse.status,
          errorBody: uploadRejectionBody,
          outboundUrl: request.url,
        })) {
        consoleGoUploadRetryGuard.attempted = true;
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        if (!upstream.signal.aborted) {
          try {
            await sleepWithAbort(CONSOLE_GO_UPLOAD_RETRY_DELAY_MS, upstream.signal);
          } catch { return clientCancelledResponse(); }
        }
        if (upstream.signal.aborted) return clientCancelledResponse();
        const result = await rebuildAndRefetch("console-go-upload-retry");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
        continue passthroughRecovery;
      }
    }
    // Reasoning-effort downgrade: a rung the catalog still advertises can be refused upstream --
    // the metadata records the model's ladder, not this account's entitlement (a Muse Code
    // subscription gates max on muse-spark-1.3-contributor, for example). Learn the refusal so
    // later turns clamp before dispatch, then replay once at the next lower published rung
    // instead of failing the turn; requestedEffort/effectiveEffort keep both values in usage.
    if (!reasoningEffortDowngradeGuard.attempted) {
      const rejectionText = await reasoningEffortRejectionText(
        upstreamResponse,
        reasoningEffortDowngradeGuard.attempted,
        upstream.signal,
      );
      const downgrade = rejectionText === undefined
        ? undefined
        : planReasoningEffortDowngrade({
            provider: route.provider,
            modelId: parsed.modelId,
            requested: parsed.options.reasoning,
            rejectionText,
          });
      if (downgrade && !configuredTransientSendBudgetExhausted()) {
        reasoningEffortDowngradeGuard.attempted = true;
        parsed.options.reasoning = downgrade.effort;
        try { void upstreamResponse.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
        const result = await rebuildAndRefetch("reasoning-effort-downgrade");
        if ("failed" in result) return result.failed;
        upstreamResponse = result;
        continue passthroughRecovery;
      }
    }

    const streamRecoveryContentType = upstreamResponse.headers.get("content-type")?.toLowerCase() ?? "";
    const protocolRecoveryCandidate = upstreamResponse.ok
      && !!upstreamResponse.body
      && !isNonReplayableResponse(upstreamResponse)
      && !isCodexWsUpstreamResponse(upstreamResponse)
      // A downstream WebSocket turn that fell back to HTTP must relay response.created
      // immediately so the client can address the turn and receive explicit control
      // refusal. The recovery preflight must retain that event until output commits, so
      // the two contracts cannot share one body owner.
      && !(options.nativeControl && options.inboundTransport === "websocket")
      && remainingTransientSendBudget(TRANSIENT_RETRY_MAX_ATTEMPTS) > 0
      && (streamRecoveryContentType.includes("text/event-stream") || (!streamRecoveryContentType && parsed.stream));
    if (protocolRecoveryCandidate) {
      upstreamResponse = deferProtocolSafeResetRecovery(
        upstreamResponse,
        { model: logCtx.model, provider: logCtx.provider },
        error => refetchAfterProtocolSafeReset(
          (_recovery, signal = upstream.signal) => fetchWithTransientRetry(
            () => fetchWithHeaderTimeout(
              request.url,
              applyUpstreamRecoveryInit({
                method: request.method,
                headers: request.headers,
                body: request.body,
              }, "connection-reset"),
              signal,
              connectMs,
              true,
              providerFetch(route.provider, options.codexWsRuntimeIdentity, {
                httpOnly: true,
                providerName: route.providerName,
                modelId: route.modelId,
                dispatchOverride: oauthDispatch(request),
                beforeDispatch: headers => {
                  if (signal.aborted) throw signal.reason;
                  if (!transportState.selectionIsCurrent(transportState.requestBindings.get(request))) {
                    throw new Error("Credential selection changed before pre-output stream recovery");
                  }
                  if (isCanonicalOpenAiForwardProvider(route.provider)) {
                    createCodexReserveDispatchGuard(
                      admissionState.authCtx,
                      options.codexAuthPolicy ?? config,
                      route.modelId,
                      options.admission,
                      options.visionDescribeTerminal === true,
                    )?.(headers);
                  }
                  transportState.noteRoutedAttemptSend(passthroughEstimate, "connection-reset");
                },
              }),
              route.provider.authMode === "forward",
            ).then(adoptObservedResponse),
            {
              abortSignal: signal,
              label: safeHostLabel(request.url),
              attempts: Math.min(1, remainingTransientSendBudget(TRANSIENT_RETRY_MAX_ATTEMPTS)),
              onSendsConsumed: noteTransientSends,
            },
          ),
          error,
          {
            abortSignal: upstream.signal,
            label: safeHostLabel(request.url),
            acceptResponse: candidate => {
              const type = candidate.headers.get("content-type")?.toLowerCase() ?? "";
              return type.includes("text/event-stream") || (!type && parsed.stream);
            },
          },
        ),
        { allowMissingContentType: !streamRecoveryContentType && parsed.stream },
      );
    }
    break;
    }

  return {
    codexSafetyBufferingOptions,
    imageGenCallAliases,
    routedCustomToolNames,
    routedCustomToolRepairNames,
    routedToolSearchNames,
    rememberPassthroughResponse,
    selfNamedNamespaceScrubAuthorization,
    providerExecutedCallTypes,
    get request(): Awaited<ReturnType<typeof transportState.adapter.buildRequest>> {
      return request;
    },
    set request(value: Awaited<ReturnType<typeof transportState.adapter.buildRequest>>) {
      request = value;
    },
    functionRepairSchemas,
    get outboundRequestBody(): Record<string, unknown> | undefined {
      return outboundRequestBody;
    },
    set outboundRequestBody(value: Record<string, unknown> | undefined) {
      outboundRequestBody = value;
    },
    declaredWireToolNames,
    declaredBareWireToolNames,
    declaredNamelessClientCallTypes,
    authorizedBareNamespaceToolAliases,
    normalizeFunctionCompletionJson,
    get undeclaredToolGuardActive(): typeof undeclaredToolGuardActive {
      return undeclaredToolGuardActive;
    },
    set undeclaredToolGuardActive(value: typeof undeclaredToolGuardActive) {
      undeclaredToolGuardActive = value;
    },
    noteInspectedPayload,
    rememberPassthroughResponseChecked,
    upstream,
    connectMs,
    upstreamResponse,
  };
}

export type PassthroughExchange = Exclude<Awaited<ReturnType<typeof preparePassthroughExchange>>, Response>;
