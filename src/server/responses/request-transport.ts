import { SendBudgetExhaustedError } from "../../lib/upstream-retry";
import { rebindPhysicalSend } from "../../lib/request-execution-budget";
import { anthropicModelQuotaFor } from "../../oauth/anthropic-model-quota";
import { anthropicRatePolicyFor } from "../../oauth/anthropic-rate-limit-policy";
import { configuredAnthropicInstance } from "../../providers/anthropic-instance";
import { resolveAnthropicMessagesUrl } from "../../adapters/anthropic";
import { bindAnthropicRefusalCredentialForSend } from "../../oauth/anthropic-account-refusal";
import { captureAnthropicPhysicalSendOwnership, anthropicPhysicalSendOwnershipIsCurrent, type AnthropicPhysicalSendOwnership } from "../../oauth/anthropic-send-ownership";
import type { ResponsesRequestContext, ResponsesAdmissionState } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { OAuthAccessSnapshot } from "../../oauth";
import {
  captureOAuthAccountSelection,
  commitOAuthAccountSelection,
  getAccountCredentialWithStatus,
  credentialGeneration,
  getAccountSet,
} from "../../oauth/store";
import { refreshKiroAccountModelsDetached } from "../../providers/kiro-model-catalog";
import type { ProviderAdapter, AdapterRequest } from "../../adapters/base";
import { releaseProviderRequestSlot, waitForProviderRequestSlot, type ProviderRequestSlot } from "../../providers/request-pacing";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../../types";
import type { AnthropicAccountSelectionReason } from "../../oauth/anthropic-routing";
import { resolveAnthropicModelRouteForInstance, routeCandidates, type AnthropicRouteDecision } from "../../oauth/anthropic-model-routes";
import {
  anthropicRoutingFor,
  AnthropicAccountCooldownError,
  formatAnthropicProviderForLog,
  anthropicSessionKeyFromParts,
} from "../../oauth/anthropic-routing";
import {
  OAuthAccountPausedError,
  getValidAccessSnapshotForAccount,
  forceRefreshOAuthAccessSnapshot,
  getValidAccessTokenSnapshot,
  OAuthLoginRequiredError,
  publicOAuthAuthenticationErrorMessage,
  UnsupportedOAuthProviderError,
} from "../../oauth";
import {
  GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST,
  GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST,
  eligibleFailoverAccounts,
  forgetGenericFailoverRoster,
  isGenericFailoverProvider,
  isProactivePreferenceEnabled,
  preferredInitialAccount,
  refusalAwareInitialKiroAccount,
  noteGenericPoolSelection,
} from "../../oauth/generic-account-failover";
import { tryKiroAlternateAfterTerminalRefresh } from "../../oauth/kiro-terminal-failover";
import { classifyModelFamilyForQuota } from "../../oauth/account-quota-rank";
import { expandInferenceOAuthSendBudget } from "../inference/context";
import { stampOAuthAccountLabel, usesApiKeyAccount } from "../../providers/label";
import { resolveProviderTransport } from "../../providers/xai-transport";
import { captureRouteStaticPolicy } from "../../router";
import { CopilotAutoHttpError, resolveCopilotAuto } from "../../providers/github-copilot-auto";
import { renameRoutedIdentityInContext } from "../../adapters/identity";
import { resolveCopilotApiBaseUrl } from "../../oauth/github-copilot";
import {
  providerApiKeySelectionIsCurrent,
  resolveCurrentProviderApiKeyTransport,
} from "../../providers/api-key-selection";
import { resolveAdapter, resolveWireProtocolOverride } from "../adapter-resolve";
import { providerFetch, sendWithConnectionPolicy } from "./fetch-helpers";
import type { ProviderFetchOptions } from "./fetch-helpers";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import { recordAnthropicAccountQuotaFromHeadersForInstance, hasPassiveAccountQuota } from "../../providers/quota";
import { checkOutboundBodySize, describeOutboundBodyRefusal } from "./outbound-body-guard";
import { formatErrorResponse } from "../../bridge";
import { bindRouteReasoningReplayScope } from "./core-replay";
import { sessionIdHeaderFromRequest, normalizeLogConversationId } from "../request-log-conversation";
import { redactSecretString } from "../../lib/redact";
import { selectProactiveApiKeyTransport } from "../../providers/key-failover";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { providerConsumesCallerAuthorization } from "../../providers/caller-authorization";
import { releaseCodexAuthContextProbeLease, stripCodexRuntimeProviderFields } from "../../codex/auth-context";
import {
  beginRequestAttempt,
  sealRequestAttemptIdentity,
  recordAttemptCredentialSource,
  recordAdapterTierMetadata,
  noteProviderAttemptSend,
  recordKeyAttemptFailure,
  recordKeyAttemptUsage,
} from "../request-log";
import type { AttemptRecoveryKind } from "../../usage/log";
import { bindAttemptDeliveryRecorder } from "../../usage/attempt-delivery";
import { resolvePassiveRouteSubjectId } from "../passive-route-linker";
import { clientCancelledResponse } from "./core-errors";
import { acquireAccountLease, KIRO_ACCOUNT_WAIT_MS } from "../../oauth/kiro-account-load";

/** Return a renewed Chat wire to the native owner before sending inference. */
export class CopilotAutoAdapterHandoff extends Error {
  constructor(readonly adapter: ProviderAdapter) {
    super("Copilot Auto dispatch requires the Chat adapter");
  }
}

/** Owns live credential selection and adapter bindings for one request. */
export async function prepareResponsesTransport(
  requestContext: Pick<ResponsesRequestContext, "config" | "logCtx" | "options" | "req">,
  admissionState: ResponsesAdmissionState,
  requestState: Pick<
    PreparedResponsesRequest,
    | "route"
    | "parsed"
    | "inboundWire"
    | "selectedForwardHeaders"
    | "translatorBudget"
  >,
) {
  const { config, logCtx, options, req } = requestContext;
  const { route, parsed, inboundWire, translatorBudget } = requestState;
  const anthropicInstance = route.provider.authMode === "oauth"
    ? configuredAnthropicInstance(config, route.providerName) : undefined;
  // Refuse custom/orphan B OAuth before any generic resolver can observe its auth row.
  if (route.providerName === "anthropic2" && route.provider.authMode === "oauth" && !anthropicInstance) {
    return formatErrorResponse(401, "authentication_error", "Anthropic Pool 2 requires an enabled builtin OAuth provider");
  }
  const anthropicRouting = anthropicInstance ? anthropicRoutingFor(anthropicInstance) : undefined;
  const anthropicQuota = anthropicInstance ? anthropicModelQuotaFor(anthropicInstance) : undefined;
  const anthropicRatePolicy = anthropicInstance ? anthropicRatePolicyFor(anthropicInstance) : undefined;
  const authorizedAnthropicTarget = anthropicInstance === "anthropic2"
    ? resolveAnthropicMessagesUrl(route.provider) : undefined;
  const anthropicAdmissionIsCurrent = (): boolean => {
    if (!anthropicInstance) return true;
    if (configuredAnthropicInstance(config, route.providerName) !== anthropicInstance || route.provider.authMode !== "oauth") return false;
    if (anthropicInstance !== "anthropic2") return true;
    try {
      return resolveAnthropicMessagesUrl(config.providers[anthropicInstance]!) === authorizedAnthropicTarget
        && resolveAnthropicMessagesUrl(route.provider) === authorizedAnthropicTarget;
    } catch { return false; }
  };
  if (!anthropicAdmissionIsCurrent()) {
    return formatErrorResponse(401, "authentication_error", "Anthropic Pool 2 provider target changed; retry the request");
  }
  const requireAnthropicAdmission = (): void => {
    if (!anthropicAdmissionIsCurrent()) throw new OAuthLoginRequiredError(anthropicInstance!);
  };
  const currentAnthropicRouteDecision = (): AnthropicRouteDecision | null => {
    requireAnthropicAdmission();
    if (!anthropicInstance || !anthropicRouting?.isAnthropicAccountPoolEnabled(config)) return null;
    const result = resolveAnthropicModelRouteForInstance(anthropicInstance, config, route.modelId);
    if (result.error) throw new Error("Invalid Anthropic model route configuration");
    return result.decision;
  };
  const rawKiroCap = route.providerName === "kiro" && route.provider.authMode === "oauth"
    ? config.providers.kiro?.oauthAccountFailover?.maxConcurrentPerAccount : undefined;
  const kiroCap = typeof rawKiroCap === "number" && Number.isInteger(rawKiroCap)
    && rawKiroCap >= 1 && rawKiroCap <= 100 ? rawKiroCap : undefined;
  const kiroLoadEnabled = route.providerName === "kiro" && route.provider.authMode === "oauth"
    && (kiroCap !== undefined || (config.pool?.kernel === true
      && config.providers.kiro?.oauthAccountFailover?.strategy === "least-loaded"
      && isProactivePreferenceEnabled(config, "kiro", Date.now())));
  const capacityResponse = () => new Response(JSON.stringify({ error: {
    type: "server_error", code: "account_capacity", message: "Kiro account capacity is temporarily full; retry shortly.",
  } }), { status: 503, headers: { "content-type": "application/json", "retry-after": "1" } });


  // OAuth providers: swap in a fresh access token (auto-refreshed) as the Bearer key, so the
  // existing openai-chat / anthropic adapters authenticate with no change.
  const isOAuth401ReplayProvider = (
    route.providerName === "xai"
    || route.providerName === "github-copilot"
    || route.providerName === "kiro"
    || route.providerName === "google-antigravity"
    || route.providerName === "orcarouter-oauth"
    // runTurn transport: the replay runs on the first-event preflight in run-turn-execution.
    || route.providerName === "devin"
  ) && route.provider.authMode === "oauth";
  let sentOAuthSnapshot: OAuthAccessSnapshot | undefined;
  // One inference-401 replay belongs to this request, even when Auto changes exchange wire.
  let oauth401ReplayAttempted = false;
  let replayOAuthCredentialSnapshot: Pick<OAuthAccessSnapshot, "accountId" | "generation"> | undefined;
  let anthropicPoolAccountId: string | null = null;
  let anthropicPoolFailovers = 0;
  let anthropicRouteDecision: AnthropicRouteDecision | null = null;
  // Generic OAuth rotation (#2568) for providers with no pool of their own. Bound to the account
  // the request actually used, so a concurrent rotation cannot cool an innocent replacement.
  let genericFailoverAccountId: string | null = null;
  let genericFailovers = 0;
  let oauthSelection = route.provider.authMode === "oauth"
    ? captureOAuthAccountSelection(route.providerName) : null;
  let servingOAuthSnapshot: OAuthAccessSnapshot | undefined;
  // These owners also serve early passthrough and sidecar sends. A dispatch-time
  // rebuild must update every later builder, without entering a later block's TDZ.
  let adapter: ProviderAdapter;
  let activeAdapter: ProviderAdapter;
  let runTurnAdapter: ProviderAdapter;
  let sameTargetRequest: AdapterRequest | undefined;
  let sameTargetParsed: OcxParsedRequest | undefined;
  let sameTargetToken = 0;
  let transportToken = 0;
  let imageTierBias = 0;
  const invalidateSameTargetRequest = (): void => { transportToken += 1; };
  type DispatchBinding =
    | { kind: "oauth"; selection: NonNullable<typeof oauthSelection>; snapshot: OAuthAccessSnapshot }
    | { kind: "api-key"; provider: OcxProviderConfig };
  const requestBindings = new WeakMap<AdapterRequest, DispatchBinding>();
  const adapterBindings = new WeakMap<ProviderAdapter, DispatchBinding>();
  const rawRunTurns = new WeakMap<ProviderAdapter, NonNullable<ProviderAdapter["runTurn"]>>();
  const commitResolvedOAuthSelection = async (
    candidate: OAuthAccessSnapshot,
    proactive = false,
    anthropicReason?: AnthropicAccountSelectionReason,
  ): Promise<OAuthAccessSnapshot | null> => {
    const maxSelectionAttempts = 3;
    for (let attempt = 0; attempt < maxSelectionAttempts; attempt++) {
      requireAnthropicAdmission();
      if (candidate.provider !== route.providerName) return null;
      if (anthropicInstance) anthropicRouteDecision = currentAnthropicRouteDecision();
      if (!oauthSelection) return null;
      const proactiveEnabled = anthropicInstance !== undefined
        ? anthropicRouting!.isAnthropicAccountPoolEnabled(config)
        : (config.providers[route.providerName]?.oauthAccountFailover?.enabled
          ?? config.oauthAccountFailover?.enabled) === true;
      if (proactive && candidate.accountId !== oauthSelection.accountId && !proactiveEnabled) {
        oauthSelection = captureOAuthAccountSelection(route.providerName);
        if (!oauthSelection) return null;
        candidate = anthropicInstance !== undefined
          ? await anthropicRouting!.getAnthropicPoolAccessSnapshot(oauthSelection.accountId)
          : await getValidAccessSnapshotForAccount(route.providerName, oauthSelection.accountId, { requireUsableAccount: true });
      }
      requireAnthropicAdmission();
      if (candidate.provider !== route.providerName) return null;
      if (anthropicInstance) anthropicRouteDecision = currentAnthropicRouteDecision();
      if (anthropicRouteDecision && !routeCandidates(anthropicRouting!.getEligibleAnthropicAccounts(Date.now(), route.modelId), anthropicRouteDecision).includes(candidate.accountId)) return null;
      const committed = await commitOAuthAccountSelection(route.providerName, candidate.accountId, {
        expectedSelection: oauthSelection,
        expectedCredentialGeneration: candidate.generation,
        requireUsableAccount: true,
      });
      requireAnthropicAdmission();
      if (committed) {
        if (anthropicInstance) anthropicRouteDecision = currentAnthropicRouteDecision();
        if (anthropicInstance !== undefined && !anthropicRouting!.commitAnthropicSelectionRouting(
          candidate.accountId, oauthSelection, committed,
          { config, sessionKey: anthropicSessionKey, reason: anthropicReason, expectedCredentialGeneration: candidate.generation, routeDecision: anthropicRouteDecision, model: route.modelId },
        )) return null;
        oauthSelection = committed;
        servingOAuthSnapshot = candidate;
        if (anthropicInstance) replayOAuthCredentialSnapshot = { accountId: candidate.accountId, generation: candidate.generation };
        forgetGenericFailoverRoster(route.providerName);
        return candidate;
      }
      // A newer manual choice wins over this request's old proposal, including A→B→A.
      // Resolve that choice, not the rejected candidate, before trying admission again.
      oauthSelection = captureOAuthAccountSelection(route.providerName);
      if (!oauthSelection) return null;
      // A revision also changes on per-account policy edits. Re-evaluate the selector
      // after credential waits even without a model route, rather than reusing stale active.
      const revisedAnthropic = anthropicInstance !== undefined
        ? anthropicRouting!.resolveAnthropicAccountForSession(anthropicSessionKey, config, Date.now(), anthropicRouteDecision, route.modelId) : null;
      const revisedAnthropicId = revisedAnthropic?.accountId;
      if (anthropicInstance !== undefined && !revisedAnthropicId) return null;
      if (revisedAnthropic) anthropicReason = revisedAnthropic.reason;
      candidate = anthropicInstance !== undefined
        ? await anthropicRouting!.getAnthropicPoolAccessSnapshot(revisedAnthropicId ?? oauthSelection.accountId)
        : await getValidAccessSnapshotForAccount(route.providerName, oauthSelection.accountId, { requireUsableAccount: true });
      if (route.provider.googleMode === "cloud-code-assist" && !candidate.projectId) return null;
    }
    return null;
  };
  const refreshResolvedOAuthSelection = async (sent: OAuthAccessSnapshot): Promise<OAuthAccessSnapshot> => {
    const current = captureOAuthAccountSelection(route.providerName);
    // Keyed on the account, not the selection revision: a selection that moved away and back
    // (A -> B -> A) before the 401 landed still serves the rejected credential, and skipping
    // the refresh would replay it and spend the one recovery attempt.
    const candidate = current?.accountId === sent.accountId ? await forceRefreshOAuthAccessSnapshot(sent) : sent;
    const admitted = await commitResolvedOAuthSelection(candidate);
    if (!admitted) throw new Error("OAuth selection changed during credential recovery");
    if (kiroLoadEnabled && options.accountLoad?.lease?.accountId !== admitted.accountId) {
      const signal = options.abortSignal ?? req.signal;
      const replayLease = await acquireAccountLease("kiro", admitted.accountId, {
        maxConcurrentPerAccount: kiroCap, signal,
      });
      if (!replayLease || !options.accountLoad || options.accountLoad.cancelled || signal.aborted) {
        replayLease?.release();
        throw new Error("Kiro replay account capacity is full");
      }
      options.accountLoad.lease?.release();
      options.accountLoad.lease = replayLease;
    }
    genericFailoverAccountId = admitted.accountId;
    stampOAuthAccountLabel(logCtx, route.providerName, route.provider, admitted.accountId);
    return admitted;
  };
  /**
   * Config generation captured where the serving credential is RESOLVED, not where the
   * quota is written. A streaming turn is a long await, so a generation captured at write
   * time cannot see a config or account change that happened earlier in the same turn —
   * the case the fence exists for. Stays 0 for every provider without a passive quota.
   */
  let passiveQuotaWriterGeneration = 0;
  const copilotRequestedModel = route.modelId;
  /** Project only bounded Copilot refusal metadata; upstream bodies and session tokens never reach the client. */
  const copilotRefusalResponse = (error: unknown): Response | undefined => {
    if (!(error instanceof CopilotAutoHttpError) || ![401, 403, 429].includes(error.status)) return;
    const response = formatErrorResponse(error.status, error.status === 429 ? "rate_limit_error" : "authentication_error",
      error.message);
    if (error.retryAfter) response.headers.set("retry-after", error.retryAfter);
    return response;
  };
  let copilotSessionExpiresAt = Infinity;
  let copilotNegotiationRefreshed = false;
  let copilotAutoAdapter: OcxProviderConfig["adapter"] | undefined;
  /** The operator-configured wire, captured before the first Auto negotiation can rewrite route.provider. */
  let copilotConfiguredWire: { adapter: OcxProviderConfig["adapter"]; responsesPath?: string;
    chatCompletionsPath?: string; apiVersion?: string } | undefined;
  /** Start every negotiation from the configured wire, so a previous credential's Auto adapter,
   *  endpoint and session headers never carry over to a credential that keeps the named model. */
  const copilotNegotiationBase = (provider: OcxProviderConfig): OcxProviderConfig => {
    if (!copilotConfiguredWire) return provider;
    const headers = new Headers(provider.headers);
    headers.delete("Copilot-Session-Token");
    if (copilotConfiguredWire.apiVersion === undefined) headers.delete("X-GitHub-Api-Version");
    else headers.set("X-GitHub-Api-Version", copilotConfiguredWire.apiVersion);
    const base: OcxProviderConfig = { ...provider, adapter: copilotConfiguredWire.adapter,
      headers: Object.fromEntries(headers) };
    if (copilotConfiguredWire.responsesPath === undefined) delete base.responsesPath;
    else base.responsesPath = copilotConfiguredWire.responsesPath;
    if (copilotConfiguredWire.chatCompletionsPath === undefined) delete base.chatCompletionsPath;
    else base.chatCompletionsPath = copilotConfiguredWire.chatCompletionsPath;
    return base;
  };
  /** Resolve the request's ephemeral wire selection and recover at most one OAuth negotiation 401. */
  const resolveCopilotSelection = async (requestParsed: OcxParsedRequest, insideDispatch = false): Promise<void> => {
    if (route.providerName !== "github-copilot" || route.provider.authMode === "forward") return;
    copilotConfiguredWire ??= {
      adapter: route.provider.adapter,
      responsesPath: route.provider.responsesPath,
      chatCompletionsPath: route.provider.chatCompletionsPath,
      apiVersion: new Headers(route.provider.headers).get("X-GitHub-Api-Version") ?? undefined,
    };
    /** Fence control-plane sends to the captured credential; reuse an already-held dispatch concurrency lease. */
    const negotiate = () => {
      const binding: DispatchBinding | undefined = oauthSelection && servingOAuthSnapshot
        ? { kind: "oauth", selection: { ...oauthSelection }, snapshot: servingOAuthSnapshot }
        : { kind: "api-key", provider: { ...route.provider } };
      return resolveCopilotAuto(copilotNegotiationBase(route.provider), copilotRequestedModel, requestParsed,
        options.abortSignal ?? req.signal, /** Fence each negotiation send against the captured credential binding before touching the network. */
          () => selectionIsCurrent(binding), !insideDispatch);
    };
    let selected: Awaited<ReturnType<typeof resolveCopilotAuto>>;
    try { selected = await negotiate(); }
    catch (error) {
      if (!(error instanceof CopilotAutoHttpError) || error.status !== 401 || copilotNegotiationRefreshed
        || oauth401ReplayAttempted || route.provider.authMode !== "oauth" || !servingOAuthSnapshot) throw error;
      copilotNegotiationRefreshed = true;
      const refreshed = await refreshResolvedOAuthSelection(servingOAuthSnapshot);
      route.provider = resolveProviderTransport(route.providerName,
        { ...route.provider, apiKey: refreshed.accessToken }, parsed.options.promptCacheKey,
        resolveCopilotApiBaseUrl(refreshed.apiBaseUrl));
      sentOAuthSnapshot = refreshed;
      replayOAuthCredentialSnapshot = { accountId: refreshed.accountId, generation: refreshed.generation };
      selected = await negotiate();
    }
    copilotSessionExpiresAt = selected.expiresAt ?? Infinity;
    route.provider = selected.provider;
    route.modelId = selected.modelId;
    route.staticPolicy = captureRouteStaticPolicy(route.providerName, route.modelId, route.provider,
      route.staticPolicy.effectiveAlias, inboundWire);
    copilotAutoAdapter = selected.auto ? selected.provider.adapter : undefined;
    for (const target of new Set([parsed, requestParsed])) {
      target.modelId = selected.modelId;
      if (target._rawBody && typeof target._rawBody === "object")
        (target._rawBody as { model?: string }).model = selected.modelId;
      target.context = renameRoutedIdentityInContext(target.context, selected.modelId);
    }
    logCtx.model = selected.modelId;
    if (logCtx.activeAttempt) logCtx.activeAttempt.model = selected.modelId;
  };
  /**
   * Apply a rotated account's FULL credential snapshot to the live route (#2568d).
   *
   * One helper for all three rotation sites on purpose. Each site used to inline the same four
   * lines, and the divergence that produced was the bug: `apiKey` was swapped while the routing
   * metadata paired with it stayed behind.
   *
   * Returns the admitted snapshot, which can differ when a newer manual selection wins the
   * proposal race. Returns null when the snapshot cannot be used safely, and the caller must then
   * abandon the rotation rather than send a half-applied identity:
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
  const applyFailoverSnapshot = async (
    snapshot: OAuthAccessSnapshot,
    retryParsed: OcxParsedRequest = parsed,
    insideDispatch = false,
  ): Promise<OAuthAccessSnapshot | null> => {
    requireAnthropicAdmission();
    if (snapshot.provider !== route.providerName) return null;
    if (route.provider.googleMode === "cloud-code-assist" && !snapshot.projectId) return null;
    const signal = options.abortSignal ?? req.signal;
    let speculative = kiroLoadEnabled && options.accountLoad?.lease?.accountId !== snapshot.accountId
      ? await acquireAccountLease("kiro", snapshot.accountId, { maxConcurrentPerAccount: kiroCap, signal }) : null;
    if (speculative && (options.accountLoad?.cancelled || signal.aborted)) { speculative.release(); return null; }
    if (kiroLoadEnabled && options.accountLoad?.lease?.accountId !== snapshot.accountId && !speculative) return null;
    let committed: OAuthAccessSnapshot | null;
    try { committed = await commitResolvedOAuthSelection(snapshot); }
    catch (error) { speculative?.release(); throw error; }
    if (!committed) { speculative?.release(); return null; }
    if (speculative && (options.accountLoad?.cancelled || signal.aborted)) { speculative.release(); return null; }
    if (kiroLoadEnabled && committed.accountId !== (speculative?.accountId ?? options.accountLoad?.lease?.accountId)) {
      speculative?.release();
      speculative = await acquireAccountLease("kiro", committed.accountId, { maxConcurrentPerAccount: kiroCap, signal });
      if (speculative && (options.accountLoad?.cancelled || signal.aborted)) { speculative.release(); return null; }
      if (!speculative) return null;
    }
    if (speculative && options.accountLoad) {
      options.accountLoad.lease?.release();
      options.accountLoad.lease = speculative;
    }
    snapshot = committed;
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
    await resolveCopilotSelection(retryParsed, insideDispatch);
    // Negotiation itself may have recovered a 401 with a newer committed credential.
    if (route.providerName === "github-copilot" && servingOAuthSnapshot) snapshot = servingOAuthSnapshot;
    if (route.providerName === "kiro") {
      const kiroContext = { ...(snapshot.kiro ?? {}) };
      // Terminal-guard continuations are rebuilt from a shallow clone. Updating only the
      // outer request pairs the new bearer with the failed account's region/profile on
      // the retry. Keep both owners synchronized; for ordinary paths they are identical.
      parsed._kiroAuthContext = kiroContext;
      if (retryParsed !== parsed) retryParsed._kiroAuthContext = { ...kiroContext };
    }
    if (route.providerName === "zed") {
      // Zed signs with its own user id; `snapshot.accountId` is the local slot hash.
      const zedContext = { userId: snapshot.providerUserId ?? "" };
      parsed._zedAuthContext = zedContext;
      if (retryParsed !== parsed) retryParsed._zedAuthContext = { ...zedContext };
    }
    // Re-stamp: a request that rotated accounts must be attributed to the account that actually
    // served it. All three rotation sites funnel through here, so this is the only re-stamp
    // needed -- and putting it anywhere else would let one of the three drift.
    stampOAuthAccountLabel(logCtx, route.providerName, route.provider, snapshot.accountId);
    if (anthropicInstance !== undefined) {
      anthropicPoolAccountId = snapshot.accountId;
      logCtx.provider = formatAnthropicProviderForLog(anthropicInstance!, snapshot.accountId, config);
    } else {
      genericFailoverAccountId = snapshot.accountId;
    }
    sentOAuthSnapshot = snapshot;
    replayOAuthCredentialSnapshot = { accountId: snapshot.accountId, generation: snapshot.generation };
    return snapshot;
  };
  // Key sends may be rebuilt while queued. Keep metadata pending until the guarded
  // physical dispatch binds it to the selection that actually reaches the upstream.
  let pendingKeySend: { estimate: number | undefined; recovery?: AttemptRecoveryKind } | undefined;
  const noteRoutedAttemptSend = (estimate: number | undefined, recovery?: AttemptRecoveryKind): void => {
    if (usesApiKeyAccount(route.provider)) pendingKeySend = { estimate, recovery };
    else noteProviderAttemptSend(logCtx, route.providerName, route.provider, estimate, recovery);
  };
  const commitKeyAttemptSend = (): void => {
    if (!usesApiKeyAccount(route.provider)) return;
    noteProviderAttemptSend(logCtx, route.providerName, route.provider,
      pendingKeySend?.estimate ?? logCtx.usageLogInputTokens, pendingKeySend?.recovery);
    pendingKeySend = undefined;
  };
  const bindKeyUsageFromBridge = (usage: OcxUsage | undefined): void => {
    logCtx.usageFromBridge = true;
    if (usesApiKeyAccount(route.provider)) {
      logCtx.usage = logCtx.activeAttempt?.usage;
      return;
    }
    if (usage) {
      logCtx.usage = usage;
      if (logCtx.activeAttempt) logCtx.activeAttempt.usage = usage;
    }
  };
  const selectionIsCurrent = (binding: DispatchBinding | undefined): boolean => {
    if (!anthropicAdmissionIsCurrent()) return false;
    if (route.provider.authMode === "forward") return true;
    if (!binding) return false;
    if (binding.kind === "api-key") return providerApiKeySelectionIsCurrent(config, route.providerName, binding.provider);
    if (binding.snapshot.provider !== route.providerName) return false;
    if (anthropicInstance) {
      anthropicRouteDecision = currentAnthropicRouteDecision();
      if (anthropicRouteDecision && !routeCandidates(anthropicRouting!.getEligibleAnthropicAccounts(Date.now(), route.modelId), anthropicRouteDecision).includes(binding.snapshot.accountId)) return false;
    }
    const selected = captureOAuthAccountSelection(route.providerName);
    const row = getAccountCredentialWithStatus(route.providerName, binding.snapshot.accountId);
    return selected?.accountId === binding.selection.accountId && selected?.revision === binding.selection.revision
      && !!row && !row.paused && !row.needsReauth && row.credential.expires > Date.now()
      && (anthropicInstance === undefined || !anthropicRouting!.getAnthropicAccountHealthSnapshot(binding.snapshot.accountId) && !anthropicRatePolicy!.anthropicRatePauseUntil(binding.snapshot.accountId) && !anthropicQuota!.anthropicFamilyRejected(binding.snapshot.accountId, route.modelId))
      && credentialGeneration(row.credential) === binding.snapshot.generation;
  };
  /** Bind the negotiated wire adapter and its built requests to the serving credential's authority. */
  const resolveSelectionAdapter = (provider: OcxProviderConfig, retention = config.cacheRetention): ProviderAdapter => {
    if (copilotAutoAdapter) provider = { ...provider, adapter: copilotAutoAdapter };
    const resolved = resolveAdapter(provider, retention, route.providerName);
    if (route.provider.authMode === "forward") return resolved;
    const binding: DispatchBinding | undefined = route.provider.authMode === "oauth"
      ? oauthSelection && servingOAuthSnapshot
        ? { kind: "oauth", selection: { ...oauthSelection }, snapshot: servingOAuthSnapshot }
        : undefined
      : { kind: "api-key", provider: { ...route.provider } };
    if (binding) adapterBindings.set(resolved, binding);
    // Observe terminals before search/image loops or continuation guards hide earlier rounds.
    // Each adapter parser is called once per physical response; bridge totals are client-only.
    const observedResponses = new WeakSet<object>();
    const observeUsage = (event: AdapterEvent, response: object): void => {
      if (usesApiKeyAccount(provider) && "usage" in event && event.usage && !observedResponses.has(response)) {
        observedResponses.add(response);
        recordKeyAttemptUsage(logCtx, event.usage);
      }
    };
    // Counted at the one seam every adapter parse passes, and counted for EVERY event rather
    // than only usage-bearing ones: the number this pairs with is the frame count the client
    // transport relayed, and a difference between the two is the loss signal (#3983). Reading
    // the current attempt through logCtx rather than capturing one keeps the count with the
    // attempt that is live when the event arrives, across a mid-request attempt rotation.
    const delivery = bindAttemptDeliveryRecorder(translatorBudget, () => logCtx.activeAttempt);
    const observeEvent = (event: AdapterEvent, response: object): void => {
      delivery.noteAdapterEvent();
      observeUsage(event, response);
    };
    const parseStream = resolved.parseStream.bind(resolved);
    resolved.parseStream = async function* (...args) {
      for await (const event of parseStream(...args)) { observeEvent(event, args[0]); yield event; }
    };
    if (resolved.parseResponse) {
      const parseResponse = resolved.parseResponse.bind(resolved);
      resolved.parseResponse = async (...args) => {
        const events = await parseResponse(...args);
        events.forEach(event => observeEvent(event, args[0]));
        return events;
      };
    }
    const build = resolved.buildRequest.bind(resolved);
    resolved.buildRequest = async (requestParsed, incoming) => {
      const request = await build(requestParsed, incoming);
      // Capture at adapter creation, never from mutable serving state after an await.
      if (binding) requestBindings.set(request, binding);
      return request;
    };
    if (resolved.runTurn) {
      const runTurn = resolved.runTurn.bind(resolved);
      rawRunTurns.set(resolved, (requestParsed, incoming, emit) => {
        const response = {};
        return runTurn(requestParsed, incoming, event => { observeEvent(event, response); emit(event); });
      });
      resolved.runTurn = (requestParsed, incoming, emit) => runSelectedTurn(resolved, requestParsed, incoming, emit);
    }
    return resolved;
  };
  /** Rebuild a stale queued selection while retaining the caller's dispatch lease and renewing Auto metadata. */
  const refreshDispatchAdapter = async (requestParsed: OcxParsedRequest): Promise<ProviderAdapter> => {
    requireAnthropicAdmission();
    if (route.provider.authMode === "oauth") {
      // Pacing may outlive admission. Preserve local pause/cooldown reasons even when
      // a strict route rejects the old proposal before another bearer can be resolved.
      let candidate = servingOAuthSnapshot;
      if (anthropicInstance !== undefined) {
        oauthSelection = captureOAuthAccountSelection(route.providerName);
        const accountId = await anthropicRouting!.resolveAnthropicDispatchAccountId(config, anthropicSessionKey, anthropicRouteDecision, route.modelId);
        candidate = await anthropicRouting!.getAnthropicPoolAccessSnapshot(accountId);
      }
      if (!candidate || !await applyFailoverSnapshot(candidate, requestParsed, true)) {
        if (anthropicInstance !== undefined) await anthropicRouting!.resolveAnthropicDispatchAccountId(config, anthropicSessionKey, anthropicRouteDecision, route.modelId);
        throw new Error("OAuth account selection changed before dispatch");
      }
    } else {
      const current = resolveCurrentProviderApiKeyTransport(config, route.providerName, route.provider);
      if (!current) throw new Error("API key selection is unavailable before dispatch");
      route.provider = current;
      await resolveCopilotSelection(requestParsed, true);
    }
    adapter = activeAdapter = runTurnAdapter = resolveSelectionAdapter(
      resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy),
    );
    invalidateSameTargetRequest();
    return adapter;
  };
  const refreshRunTurnAdapter = async (requestParsed: OcxParsedRequest): Promise<ProviderAdapter> => {
    requestParsed._cursorIdentityScope = undefined;
    requestParsed._cursorConversationId = undefined;
    if (requestParsed._providerContinuation?.cursor) {
      const { cursor: _oldCursor, ...rest } = requestParsed._providerContinuation;
      requestParsed._providerContinuation = rest;
    }
    return refreshDispatchAdapter(requestParsed);
  };
  const runSelectedTurn = async (
    selectedAdapter: ProviderAdapter,
    ...[requestParsed, incoming, emit]: Parameters<NonNullable<ProviderAdapter["runTurn"]>>
  ): Promise<void> => {
    const producer = options.sendBudget && "beginSpendProducer" in options.sendBudget
      ? (options.sendBudget as import("../../lib/request-execution-budget").RequestExecutionBudget).beginSpendProducer?.() : undefined;
    try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!selectionIsCurrent(adapterBindings.get(selectedAdapter))) selectedAdapter = await refreshRunTurnAdapter(requestParsed);
      const binding = adapterBindings.get(selectedAdapter);
      const run = rawRunTurns.get(selectedAdapter);
      if (!run) throw new Error("Selected provider no longer supports this turn transport");
      let sent = false;
      let refused = false;
      let attemptSlot: ProviderRequestSlot | undefined;
      // Both main and image-loop callers already acquired the initial pacing slot.
      // Subsequent physical messages retain this adapter/credential and are paced normally.
      try {
        attemptSlot = attempt === 0
          ? incoming.pacingSlot ?? await waitForProviderRequestSlot(route.providerName, route.provider, route.modelId, incoming.abortSignal)
          : await waitForProviderRequestSlot(route.providerName, route.provider, route.modelId, incoming.abortSignal);
        const fetch = providerFetch(route.provider, options.codexWsRuntimeIdentity, {
          providerName: route.providerName, modelId: route.modelId, pacingSlotAcquired: true,
          pacingSlot: attemptSlot,
          turnScopedPacing: true,
          beforeDispatch: () => {
            if (sent) return;
            if (!selectionIsCurrent(binding)) {
              refused = true;
              throw new Error("Account selection changed before the first turn dispatch");
            }
            commitKeyAttemptSend();
            sent = true;
          },
        });
        await run(requestParsed, { ...incoming, providerFetch: fetch }, event => { if (!refused) emit(event); });
      } catch (error) {
        if (!refused) throw error;
      } finally {
        releaseProviderRequestSlot(attemptSlot);
      }
      if (!refused) return;
      // The adapter may map the guard's exception to an error event. Neither that
      // event nor a refused send may escape before retrying the newly selected account.
      selectedAdapter = await refreshRunTurnAdapter(requestParsed);
    }
    throw new Error("Account selection changed repeatedly before turn dispatch");
    } finally { producer?.close(); }
  };
  /** Fence the physical send, with bounded credential/session rebuilds and safe negotiated refusals. */
  const oauthDispatch = (wireRequest: AdapterRequest, requestParsed = parsed, owner: "adapter" | "passthrough" = "adapter"): ProviderFetchOptions["dispatchOverride"] => {
    if (route.provider.authMode === "forward") return undefined;
    return /** Dispatch with the current binding and session, rebuilding at most three times before returning a safe refusal. */ async (input, init, execute) => {
      let destination = input;
      let dispatchInit = init;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (selectionIsCurrent(requestBindings.get(wireRequest)) && copilotSessionExpiresAt > Date.now() + 1000) {
          const fetchImpl = (route.provider as OcxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch ?? execute;
          const binding = requestBindings.get(wireRequest);
          const snapshot = anthropicInstance !== undefined && binding?.kind === "oauth"
            ? binding.snapshot : undefined;
          const target = destination instanceof Request ? destination.url : String(destination);
          if (authorizedAnthropicTarget && target !== authorizedAnthropicTarget) {
            throw new OAuthLoginRequiredError(anthropicInstance!);
          }
          const writerGeneration = snapshot ? captureConfigGeneration() : 0;
          const sentHeaders = snapshot ? new Headers(dispatchInit.headers) : undefined;
          const ownsBearer = snapshot !== undefined
            && sentHeaders?.get("authorization") === `Bearer ${snapshot.accessToken}`
            && !sentHeaders?.has("x-api-key");
          // Reselection can choose a provider override instead of the supplied executor.
          // Either way the send crosses the physical boundary, so the connection policy is
          // applied around whichever implementation was just selected (#4992).
          // The binding travels with the send, so a rebuilt request resolves its provider route
          // against the destination it is actually going to rather than the one this dispatch
          // started with. Account reselection can move the upstream host, which would otherwise
          // apply a host-scoped decision to a different host.
          const releaseFamily = snapshot ? anthropicQuota!.claimAnthropicFamilyRevalidation(snapshot.accountId, route.modelId) : () => {};
          if (!releaseFamily) throw new AnthropicAccountCooldownError(1);
          let response: Response;
          let physicalOwner: AnthropicPhysicalSendOwnership | null = null;
          try {
            requireAnthropicAdmission();
            if (!rebindPhysicalSend(options.sendBudget, { poolId: logCtx.spendPoolId ?? route.providerName,
              identityId: logCtx.accountLogLabel })) throw new SendBudgetExhaustedError();
            if (snapshot) {
              // Reserve the incarnation at this synchronous send boundary, never on return.
              physicalOwner = captureAnthropicPhysicalSendOwnership(snapshot);
              if (!physicalOwner || !anthropicPhysicalSendOwnershipIsCurrent(physicalOwner)) {
                throw new OAuthLoginRequiredError(anthropicInstance!);
              }
              sentOAuthSnapshot = snapshot;
              passiveQuotaWriterGeneration = writerGeneration;
            }
            commitKeyAttemptSend();
            response = await sendWithConnectionPolicy(
              fetchImpl,
              destination,
              { ...dispatchInit, redirect: "manual" },
              { providerName: route.providerName, provider: route.provider },
            );
          } finally { releaseFamily(); }
          // Observe each physical response before retries replace it. The binding belongs to
          // this dispatch, so a manual switch cannot file A's headers against B. Header
          // overrides and credential replacement make ownership unprovable: skip those writes.
          if (ownsBearer && snapshot && physicalOwner) {
            try {
              const current = getAccountCredentialWithStatus(anthropicInstance!, snapshot.accountId);
              if (anthropicPhysicalSendOwnershipIsCurrent(physicalOwner)
                && snapshot.provider === anthropicInstance && current && !current.needsReauth
                && current.credential.access === snapshot.accessToken
                && credentialGeneration(current.credential) === snapshot.generation) {
                bindAnthropicRefusalCredentialForSend(response, physicalOwner);
                recordAnthropicAccountQuotaFromHeadersForInstance(anthropicInstance!, snapshot.accountId, response.headers, writerGeneration, response.status, route.modelId);
              }
            } catch { /* best-effort observation cannot fail the response */ }
          }
          if (!response.ok) await recordKeyAttemptFailure(logCtx, response, dispatchInit.signal ?? options.abortSignal);
          return response;
        }
        let nextAdapter: ProviderAdapter;
        try { nextAdapter = await refreshDispatchAdapter(requestParsed); }
        catch (error) {
          const refusal = copilotRefusalResponse(error);
          if (refusal) return refusal;
          throw error;
        }
        if (owner === "passthrough" && route.providerName === "github-copilot" && nextAdapter.name === "openai-chat") {
          throw new CopilotAutoAdapterHandoff(nextAdapter);
        }
        // Rebind before rebuilding: the rebuild's bridged-search restore and continuation
        // restore key on the serving identity, which must be the refreshed route's, not the
        // credential whose selection just lapsed.
        bindRouteReasoningReplayScope({ parsed: requestParsed, providerName: route.providerName, provider: route.provider,
          adapterName: nextAdapter.name, oauthCredentialSnapshot: replayOAuthCredentialSnapshot });
        const rebuilt = await nextAdapter.buildRequest(requestParsed, {
          headers: requestState.selectedForwardHeaders, providerName: route.providerName, translatorBudget,
          ...(imageTierBias > 0 ? { imageTierBias } : {}),
        });
        const bodySize = checkOutboundBodySize(rebuilt.body, config.maxUpstreamBodyBytes);
        if (!bodySize.admitted) {
          rebuilt.releaseBodyObservation?.();
          return formatErrorResponse(413, "outbound_body_too_large", describeOutboundBodyRefusal(bodySize));
        }
        const headers = new Headers(dispatchInit.headers);
        for (const name of Object.keys(wireRequest.headers)) headers.delete(name);
        for (const [name, value] of Object.entries(rebuilt.headers)) headers.set(name, value);
        wireRequest.releaseBodyObservation?.();
        Object.assign(wireRequest, rebuilt);
        const binding = requestBindings.get(rebuilt);
        if (binding) requestBindings.set(wireRequest, binding);
        else requestBindings.delete(wireRequest);
        sameTargetRequest = wireRequest;
        sameTargetParsed = requestParsed;
        sameTargetToken = transportToken;
        destination = rebuilt.url;
        dispatchInit = { ...dispatchInit, method: rebuilt.method, headers, body: rebuilt.body };
        // The next iteration validates synchronously and calls fetch in that same turn.
      }
      throw new Error("OAuth account selection changed repeatedly before dispatch");
    };
  };
  const anthropicSessionKey = anthropicInstance !== undefined && route.provider.authMode === "oauth"
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
      if (anthropicInstance !== undefined && anthropicRouting!.isAnthropicAccountPoolEnabled(config)) {
        const routeResult = resolveAnthropicModelRouteForInstance(anthropicInstance, config, route.modelId);
        if (routeResult.error) return formatErrorResponse(400, "invalid_request_error", `Invalid Anthropic model routes: ${routeResult.error}`);
        anthropicRouteDecision = routeResult.decision;
        const selection = anthropicRouting!.resolveAnthropicAccountForSession(anthropicSessionKey, config, Date.now(), anthropicRouteDecision, route.modelId);
        if (!selection.accountId) {
          if (selection.reason === "paused") return formatErrorResponse(403, "permission_error", "Anthropic OAuth accounts are paused. Resume an account in account settings and retry.");
          // Route names may resemble account IDs; log only the matched rule position.
          if (anthropicRouteDecision) console.warn(`[${anthropicInstance}-pool] route:#${anthropicRouteDecision.position} ${selection.reason}; answering locally`);
          if (selection.reason === "all-cooled") {
            const retryAfterSec = anthropicRouting!.getAnthropicPoolRetryAfterSeconds(Date.now(), anthropicRouteDecision, route.modelId);
            return formatErrorResponse(
              429,
              "rate_limit_error",
              anthropicRouteDecision ? "Anthropic OAuth accounts for this model route are temporarily rate-limited" : "All Anthropic OAuth accounts are temporarily rate-limited",
              retryAfterSec !== null ? { retryAfter: String(retryAfterSec) } : undefined,
            );
          }
          return formatErrorResponse(401, "authentication_error", anthropicRouteDecision ? "No eligible Anthropic OAuth account for this model route" : "No eligible Anthropic OAuth account available");
        }
        const admitted = await commitResolvedOAuthSelection(await anthropicRouting!.getAnthropicPoolAccessSnapshot(selection.accountId), true, selection.reason);
        if (!admitted) return formatErrorResponse(409, "conflict_error", "OAuth account selection changed; retry the request");
        anthropicPoolAccountId = admitted.accountId;
        if (anthropicRouteDecision) console.info(`[${anthropicInstance}-pool] route:#${anthropicRouteDecision.position} ${selection.reason}`);
        route.provider = { ...route.provider, apiKey: admitted.accessToken };
        logCtx.provider = formatAnthropicProviderForLog(anthropicInstance!, admitted.accountId, config);
      } else {
        // Prefer the account with known headroom BEFORE the first attempt. Rotation alone
        // only reacts to a 429, so a turn could open on an account a previous probe already
        // measured as spent. A null answer means "use the active account", so every provider
        // without quota evidence keeps the resolution it has today.
        const refusalAwareId = route.providerName === "kiro" && oauthSelection?.accountId
          ? refusalAwareInitialKiroAccount(config, oauthSelection.accountId, Date.now(), route.modelId) : null;
        const preferredAccountId = refusalAwareId ?? (isGenericFailoverProvider(route.providerName, route.provider)
          ? preferredInitialAccount(config, route.providerName, Date.now(), route.modelId)
          : null);
        let safetyAlternateId: string | null = refusalAwareId;
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
            safetyAlternateId = null;
            resolved = await getValidAccessTokenSnapshot(route.providerName);
          }
        } else {
          const failedId = route.providerName === "kiro" ? oauthSelection?.accountId : undefined;
          const failedRow = failedId ? getAccountCredentialWithStatus("kiro", failedId) : null;
          const failedGeneration = failedRow ? credentialGeneration(failedRow.credential) : undefined;
          try {
            if (anthropicInstance === "anthropic2") {
              const accountId = oauthSelection?.accountId;
              if (!accountId) throw new OAuthLoginRequiredError(anthropicInstance);
              resolved = await anthropicRouting!.getAnthropicPoolAccessSnapshot(accountId);
            } else resolved = await getValidAccessTokenSnapshot(route.providerName);
          }
          catch (error) {
            if (route.providerName !== "kiro" || !(error instanceof OAuthLoginRequiredError)
              || !failedId || !failedGeneration) throw error;
            const alternate = await tryKiroAlternateAfterTerminalRefresh(config, failedId, failedGeneration);
            if (!alternate) throw error;
            resolved = alternate;
            safetyAlternateId = alternate.accountId;
          }
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
        const admitted = await commitResolvedOAuthSelection(resolved, safetyAlternateId === null);
        if (!admitted) return formatErrorResponse(409, "conflict_error", "OAuth account selection changed; retry the request");
        if (safetyAlternateId && admitted.accountId !== safetyAlternateId)
          return formatErrorResponse(409, "conflict_error", "OAuth account selection changed; retry the request");
        if (kiroLoadEnabled) {
          const transportSignal = options.abortSignal ?? req.signal;
          const lease = await acquireAccountLease("kiro", admitted.accountId, {
            maxConcurrentPerAccount: kiroCap, waitMs: KIRO_ACCOUNT_WAIT_MS, signal: transportSignal,
          });
          if (!lease) return transportSignal.aborted
            ? clientCancelledResponse() : capacityResponse();
          // The lease may be granted between the holder's cleanup and this install;
          // re-check cancellation before the holder can no longer reach it.
          if (options.accountLoad?.cancelled || transportSignal.aborted) {
            lease.release();
            return clientCancelledResponse();
          }
          if (options.accountLoad) options.accountLoad.lease = lease;
          else lease.release();
        }
        if (route.providerName === "kiro") {
          const account = getAccountSet("kiro")?.accounts.find(row => row.id === admitted.accountId);
          if (account) refreshKiroAccountModelsDetached(account, route.provider);
        }
        if (admitted.accountId !== resolved.accountId) usedPreferredAccount = true;
        resolved = admitted;
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
          // Advance the pool cursor only now that this account is actually admitted. The
          // helper returns immediately unless the kernel is on AND the strategy is
          // round-robin, so quota and fill-first pools reach it without being touched.
          noteGenericPoolSelection(config, route.providerName, resolved.accountId, route.modelId);
        }
        // Anthropic is excluded from isGenericFailoverProvider -- its own pool owns affinity and
        // a fail-closed local-cli credential rule -- so without this stamp its identity is
        // dropped whenever the pool flag is off, and a later 429 has no account to cool. Reactive
        // failover needs only the id: no affinity bind, no promotion, no quota-ranked pick. Those
        // are proactive and stay behind anthropicAccountPool.enabled.
        if (anthropicInstance !== undefined && anthropicRouting!.hasAnthropicFailoverQuorum()) {
          anthropicPoolAccountId = resolved.accountId;
        }
        // Captured beside the account it fences, so the two can never disagree.
        if (hasPassiveAccountQuota(route.providerName)) {
          passiveQuotaWriterGeneration = captureConfigGeneration();
        }
        if (route.providerName === "kiro") {
          // `{}` is intentional: this is an account-scoped request with no stored routing metadata.
          // Only genuinely accountless adapter calls leave the context undefined and use local/env fallback.
          parsed._kiroAuthContext = { ...(resolved.kiro ?? {}) };
        }
        if (route.providerName === "zed") {
          parsed._zedAuthContext = { userId: resolved.providerUserId ?? "" };
        }
        // Project identity belongs to the admitted account on EVERY request, including
        // the request after a pool transition made that account the persisted active one.
        if (route.provider.googleMode === "cloud-code-assist") {
          if (!resolved.projectId) return formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(new Error("Cloud Code Assist account project is unavailable")));
          route.provider = { ...route.provider, project: resolved.projectId };
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
      if (err instanceof OAuthAccountPausedError) {
        return formatErrorResponse(403, "permission_error", publicOAuthAuthenticationErrorMessage(err));
      }
      return formatErrorResponse(401, "authentication_error", publicOAuthAuthenticationErrorMessage(err));
    }
  }
  // Key-auth twin of the OAuth preference above: pick a warm key BEFORE the first attempt when
  // the committed one is already cooling, instead of spending the request earning a 429 the
  // runtime could already predict. The picker refuses to override a healthy committed key and
  // returns null without a configured strategy, so an ordinary install evaluates one predicate.
  //
  // It RETURNS a rebuilt route rather than mutating one, and the assignment has to land here --
  // ahead of the transport pin below, the adapterProvider copy that follows it, and the request
  // the HTTP path bakes later. The image bridge and web search read route.provider directly and
  // have no stale-selection re-read to save them, so ordering is the whole correctness argument.
  //
  // The Transport variant, not the bare picker: the picker answers with the PERSISTED row, and
  // a built-in provider stored in its valid minimal form would lose the adapter id, base URL
  // and static headers registry backfill supplies, throwing `Unknown adapter: undefined`.
  const proactiveKeyProvider = selectProactiveApiKeyTransport(
    config,
    route.providerName,
    route.provider,
    parsed.options.promptCacheKey,
  );
  if (proactiveKeyProvider) route.provider = proactiveKeyProvider;
  route.provider = resolveProviderTransport(
    route.providerName,
    route.provider,
    parsed.options.promptCacheKey,
    route.providerName === "github-copilot" && route.provider.authMode === "oauth"
      ? resolveCopilotApiBaseUrl(sentOAuthSnapshot?.apiBaseUrl)
      : undefined,
  );
  try { await resolveCopilotSelection(parsed); }
  catch (error) {
    if ((options.abortSignal ?? req.signal).aborted) return clientCancelledResponse();
    const refusal = copilotRefusalResponse(error);
    if (refusal) return refusal;
    return formatErrorResponse(502, "provider_error", "GitHub Copilot Auto negotiation failed; retry or check your Copilot account permissions.");
  }
  let adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy);
  if (copilotAutoAdapter) adapterProvider = { ...adapterProvider, adapter: copilotAutoAdapter };
  const stripClaudeMainAuth = options.stripClaudeMainAuthForNoncanonicalForward === true
    && !isCanonicalOpenAiForwardProvider(adapterProvider)
    && ((adapterProvider.adapter === "openai-responses" && adapterProvider.authMode === "forward")
      || providerConsumesCallerAuthorization(adapterProvider));
  if (stripClaudeMainAuth) {
    releaseCodexAuthContextProbeLease(admissionState.authCtx);
    admissionState.authCtx = { kind: "main", accountId: null };
    route.provider = stripCodexRuntimeProviderFields(route.provider);
    adapterProvider = stripCodexRuntimeProviderFields(adapterProvider);
    requestState.selectedForwardHeaders = new Headers(requestState.selectedForwardHeaders);
    requestState.selectedForwardHeaders.delete("authorization");
    requestState.selectedForwardHeaders.delete("chatgpt-account-id");
    delete route.codexAccountMode;
    delete route.codexAccountId;
    delete route.codexAccountNamespace;
    logCtx.provider = route.providerName;
    delete logCtx.accountLogLabel;
  }
  adapter = resolveSelectionAdapter(adapterProvider, config.cacheRetention);
  bindRouteReasoningReplayScope({
    parsed,
    providerName: route.providerName,
    provider: adapterProvider,
    adapterName: adapter.name,
    oauthCredentialSnapshot: replayOAuthCredentialSnapshot,
    codexAuthContext: admissionState.authCtx,
    forwardHeaders: requestState.selectedForwardHeaders,
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
  recordAttemptCredentialSource(logCtx.activeAttempt, route.providerName, adapterProvider, adapter.name);
  runTurnAdapter = adapter;
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

  const rawInput = (parsed._rawBody as { input?: unknown }).input;
  if (!isPassthrough && Array.isArray(rawInput) && rawInput.some(
    item => item !== null && typeof item === "object" && item.type === "computer_call_output",
  )) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "computer_call_output requires a Responses passthrough route; send screenshots as user input_image content on translated routes.",
    );
  }

  // Freeze the request ceiling before any 429 writes cooldowns. Selection still reads
  // live eligibility on every hop; cooled accounts cannot shorten this request's allowance.
  // The snapshot is clamped: a larger roster must not raise one request's hops or sends.
  const genericRosterSize = genericFailoverAccountId ? new Set([
    genericFailoverAccountId,
    ...eligibleFailoverAccounts(route.providerName, Date.now(), classifyModelFamilyForQuota(route.providerName, route.modelId)),
  ]).size : 0;
  const fundedAccounts = Math.min(genericRosterSize, GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST);
  const genericFailoverLimit = Math.max(GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST, fundedAccounts - 1);
  if (genericFailoverAccountId) expandInferenceOAuthSendBudget(options.sendBudget, fundedAccounts);

  return {
    genericFailoverLimit,
    isOAuth401ReplayProvider,
    get sentOAuthSnapshot(): OAuthAccessSnapshot | undefined {
      return sentOAuthSnapshot;
    },
    set sentOAuthSnapshot(value: OAuthAccessSnapshot | undefined) {
      sentOAuthSnapshot = value;
    },
    get replayOAuthCredentialSnapshot(): Pick<OAuthAccessSnapshot, "accountId" | "generation"> | undefined {
      return replayOAuthCredentialSnapshot;
    },
    set replayOAuthCredentialSnapshot(value: Pick<OAuthAccessSnapshot, "accountId" | "generation"> | undefined) {
      replayOAuthCredentialSnapshot = value;
    },
    get anthropicRouteDecision(): AnthropicRouteDecision | null { return anthropicRouteDecision; },
    get anthropicInstance() { return anthropicInstance; },
    currentAnthropicRouteDecision,
    get anthropicPoolAccountId(): string | null {
      return anthropicPoolAccountId;
    },
    set anthropicPoolAccountId(value: string | null) {
      anthropicPoolAccountId = value;
    },
    get anthropicPoolFailovers(): typeof anthropicPoolFailovers {
      return anthropicPoolFailovers;
    },
    set anthropicPoolFailovers(value: typeof anthropicPoolFailovers) {
      anthropicPoolFailovers = value;
    },
    get genericFailoverAccountId(): string | null {
      return genericFailoverAccountId;
    },
    set genericFailoverAccountId(value: string | null) {
      genericFailoverAccountId = value;
    },
    get genericFailovers(): typeof genericFailovers {
      return genericFailovers;
    },
    set genericFailovers(value: typeof genericFailovers) {
      genericFailovers = value;
    },
    get oauth401ReplayAttempted(): boolean { return oauth401ReplayAttempted; },
    set oauth401ReplayAttempted(value: boolean) { oauth401ReplayAttempted = value; },
    get adapter(): ProviderAdapter {
      return adapter;
    },
    set adapter(value: ProviderAdapter) {
      adapter = value;
    },
    get activeAdapter(): ProviderAdapter {
      return activeAdapter;
    },
    set activeAdapter(value: ProviderAdapter) {
      activeAdapter = value;
    },
    get runTurnAdapter(): ProviderAdapter {
      return runTurnAdapter;
    },
    set runTurnAdapter(value: ProviderAdapter) {
      runTurnAdapter = value;
    },
    get sameTargetRequest(): AdapterRequest | undefined {
      return sameTargetRequest;
    },
    set sameTargetRequest(value: AdapterRequest | undefined) {
      sameTargetRequest = value;
    },
    get sameTargetParsed(): OcxParsedRequest | undefined {
      return sameTargetParsed;
    },
    set sameTargetParsed(value: OcxParsedRequest | undefined) {
      sameTargetParsed = value;
    },
    get sameTargetToken(): typeof sameTargetToken {
      return sameTargetToken;
    },
    set sameTargetToken(value: typeof sameTargetToken) {
      sameTargetToken = value;
    },
    get transportToken(): typeof transportToken {
      return transportToken;
    },
    set transportToken(value: typeof transportToken) {
      transportToken = value;
    },
    get imageTierBias(): typeof imageTierBias {
      return imageTierBias;
    },
    set imageTierBias(value: typeof imageTierBias) {
      imageTierBias = value;
    },
    invalidateSameTargetRequest,
    requestBindings,
    adapterBindings,
    commitResolvedOAuthSelection,
    refreshResolvedOAuthSelection,
    get passiveQuotaWriterGeneration(): number { return passiveQuotaWriterGeneration; },
    applyFailoverSnapshot,
    selectionIsCurrent,
    resolveSelectionAdapter,
    resolveCopilotSelection,
    copilotRefusalResponse,
    refreshRunTurnAdapter,
    oauthDispatch,
    noteRoutedAttemptSend,
    commitKeyAttemptSend,
    bindKeyUsageFromBridge,
    anthropicSessionKey,
    isPassthrough,
  };
}

export type ResponsesTransport = Exclude<Awaited<ReturnType<typeof prepareResponsesTransport>>, Response>;
