import type { ResponsesRequestContext, ResponsesAdmissionState } from "./core-options";
import type { PreparedResponsesRequest } from "./request-prepare";
import type { OAuthAccessSnapshot } from "../../oauth";
import {
  captureOAuthAccountSelection,
  commitOAuthAccountSelection,
  getAccountCredentialWithStatus,
  credentialGeneration,
} from "../../oauth/store";
import type { ProviderAdapter, AdapterRequest } from "../../adapters/base";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../../types";
import type { AnthropicAccountSelectionReason } from "../../oauth/anthropic-routing";
import {
  isAnthropicAccountPoolEnabled,
  getAnthropicPoolAccessSnapshot,
  commitAnthropicSelectionRouting,
  formatAnthropicProviderForLog,
  anthropicSessionKeyFromParts,
  resolveAnthropicAccountForSession,
  getAnthropicPoolRetryAfterSeconds,
  hasAnthropicFailoverQuorum,
} from "../../oauth/anthropic-routing";
import {
  getValidAccessSnapshotForAccount,
  forceRefreshOAuthAccessSnapshot,
  getValidAccessTokenSnapshot,
  publicOAuthAuthenticationErrorMessage,
  UnsupportedOAuthProviderError,
} from "../../oauth";
import {
  GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST,
  GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST,
  eligibleFailoverAccounts,
  forgetGenericFailoverRoster,
  isGenericFailoverProvider,
  preferredInitialAccount,
  noteGenericPoolSelection,
} from "../../oauth/generic-account-failover";
import { classifyModelFamilyForQuota } from "../../oauth/account-quota-rank";
import { expandInferenceOAuthSendBudget } from "../inference/context";
import { stampOAuthAccountLabel, usesApiKeyAccount } from "../../providers/label";
import { resolveProviderTransport } from "../../providers/xai-transport";
import { resolveCopilotApiBaseUrl } from "../../oauth/github-copilot";
import {
  providerApiKeySelectionIsCurrent,
  resolveCurrentProviderApiKeyTransport,
} from "../../providers/api-key-selection";
import { resolveAdapter, resolveWireProtocolOverride } from "../adapter-resolve";
import { providerFetch, sendWithConnectionPolicy } from "./fetch-helpers";
import type { ProviderFetchOptions } from "./fetch-helpers";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import { recordAnthropicAccountQuotaFromHeaders, hasPassiveAccountQuota } from "../../providers/quota";
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


  // OAuth providers: swap in a fresh access token (auto-refreshed) as the Bearer key, so the
  // existing openai-chat / anthropic adapters authenticate with no change.
  const isOAuth401ReplayProvider = (
    route.providerName === "xai"
    || route.providerName === "github-copilot"
    || route.providerName === "kiro"
    || route.providerName === "google-antigravity"
    || route.providerName === "orcarouter-oauth"
  ) && route.provider.authMode === "oauth";
  let sentOAuthSnapshot: OAuthAccessSnapshot | undefined;
  let replayOAuthCredentialSnapshot: Pick<OAuthAccessSnapshot, "accountId" | "generation"> | undefined;
  let anthropicPoolAccountId: string | null = null;
  let anthropicPoolFailovers = 0;
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
      if (!oauthSelection) return null;
      const proactiveEnabled = route.providerName === "anthropic"
        ? isAnthropicAccountPoolEnabled(config)
        : (config.providers[route.providerName]?.oauthAccountFailover?.enabled
          ?? config.oauthAccountFailover?.enabled) === true;
      if (proactive && candidate.accountId !== oauthSelection.accountId && !proactiveEnabled) {
        oauthSelection = captureOAuthAccountSelection(route.providerName);
        if (!oauthSelection) return null;
        candidate = route.providerName === "anthropic"
          ? await getAnthropicPoolAccessSnapshot(oauthSelection.accountId)
          : await getValidAccessSnapshotForAccount(route.providerName, oauthSelection.accountId, { requireUsableAccount: true });
      }
      const committed = await commitOAuthAccountSelection(route.providerName, candidate.accountId, {
        expectedSelection: oauthSelection,
        expectedCredentialGeneration: candidate.generation,
        requireUsableAccount: true,
      });
      if (committed) {
        if (route.providerName === "anthropic" && !commitAnthropicSelectionRouting(
          candidate.accountId, oauthSelection, committed,
          { config, sessionKey: anthropicSessionKey, reason: anthropicReason, expectedCredentialGeneration: candidate.generation },
        )) return null;
        oauthSelection = committed;
        servingOAuthSnapshot = candidate;
        forgetGenericFailoverRoster(route.providerName);
        return candidate;
      }
      // A newer manual choice wins over this request's old proposal, including A→B→A.
      // Resolve that choice, not the rejected candidate, before trying admission again.
      oauthSelection = captureOAuthAccountSelection(route.providerName);
      if (!oauthSelection) return null;
      candidate = route.providerName === "anthropic"
        ? await getAnthropicPoolAccessSnapshot(oauthSelection.accountId)
        : await getValidAccessSnapshotForAccount(route.providerName, oauthSelection.accountId, { requireUsableAccount: true });
      if (route.provider.googleMode === "cloud-code-assist" && !candidate.projectId) return null;
    }
    return null;
  };
  const refreshResolvedOAuthSelection = async (sent: OAuthAccessSnapshot): Promise<OAuthAccessSnapshot> => {
    const current = captureOAuthAccountSelection(route.providerName);
    const unchanged = current?.accountId === oauthSelection?.accountId
      && current?.revision === oauthSelection?.revision;
    const candidate = unchanged ? await forceRefreshOAuthAccessSnapshot(sent) : sent;
    const admitted = await commitResolvedOAuthSelection(candidate);
    if (!admitted) throw new Error("OAuth selection changed during credential recovery");
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
  ): Promise<OAuthAccessSnapshot | null> => {
    if (route.provider.googleMode === "cloud-code-assist" && !snapshot.projectId) return null;
    const committed = await commitResolvedOAuthSelection(snapshot);
    if (!committed) return null;
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
    if (route.providerName === "kiro") {
      const kiroContext = { ...(snapshot.kiro ?? {}) };
      // Terminal-guard continuations are rebuilt from a shallow clone. Updating only the
      // outer request pairs the new bearer with the failed account's region/profile on
      // the retry. Keep both owners synchronized; for ordinary paths they are identical.
      parsed._kiroAuthContext = kiroContext;
      if (retryParsed !== parsed) retryParsed._kiroAuthContext = { ...kiroContext };
    }
    // Re-stamp: a request that rotated accounts must be attributed to the account that actually
    // served it. All three rotation sites funnel through here, so this is the only re-stamp
    // needed -- and putting it anywhere else would let one of the three drift.
    stampOAuthAccountLabel(logCtx, route.providerName, route.provider, snapshot.accountId);
    if (route.providerName === "anthropic") {
      anthropicPoolAccountId = snapshot.accountId;
      logCtx.provider = formatAnthropicProviderForLog("anthropic", snapshot.accountId, config);
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
    if (route.provider.authMode === "forward") return true;
    if (!binding) return false;
    if (binding.kind === "api-key") return providerApiKeySelectionIsCurrent(config, route.providerName, binding.provider);
    const selected = captureOAuthAccountSelection(route.providerName);
    const row = getAccountCredentialWithStatus(route.providerName, binding.snapshot.accountId);
    return selected?.accountId === binding.selection.accountId && selected?.revision === binding.selection.revision
      && !!row && !row.needsReauth && row.credential.expires > Date.now()
      && credentialGeneration(row.credential) === binding.snapshot.generation;
  };
  const resolveSelectionAdapter = (provider: OcxProviderConfig, retention = config.cacheRetention): ProviderAdapter => {
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
  const refreshDispatchAdapter = async (requestParsed: OcxParsedRequest): Promise<ProviderAdapter> => {
    if (route.provider.authMode === "oauth") {
      if (!servingOAuthSnapshot || !await applyFailoverSnapshot(servingOAuthSnapshot, requestParsed)) {
        throw new Error("OAuth account selection changed before dispatch");
      }
    } else {
      const current = resolveCurrentProviderApiKeyTransport(config, route.providerName, route.provider);
      if (!current) throw new Error("API key selection is unavailable before dispatch");
      route.provider = current;
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
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!selectionIsCurrent(adapterBindings.get(selectedAdapter))) selectedAdapter = await refreshRunTurnAdapter(requestParsed);
      const binding = adapterBindings.get(selectedAdapter);
      const run = rawRunTurns.get(selectedAdapter);
      if (!run) throw new Error("Selected provider no longer supports this turn transport");
      let sent = false;
      let refused = false;
      // Both main and image-loop callers already acquired the initial pacing slot.
      // Subsequent physical messages retain this adapter/credential and are paced normally.
      const fetch = providerFetch(route.provider, options.codexWsRuntimeIdentity, {
        providerName: route.providerName, modelId: route.modelId, pacingSlotAcquired: true,
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
      try {
        await run(requestParsed, { ...incoming, providerFetch: fetch }, event => { if (!refused) emit(event); });
      } catch (error) {
        if (!refused) throw error;
      }
      if (!refused) return;
      // The adapter may map the guard's exception to an error event. Neither that
      // event nor a refused send may escape before retrying the newly selected account.
      selectedAdapter = await refreshRunTurnAdapter(requestParsed);
    }
    throw new Error("Account selection changed repeatedly before turn dispatch");
  };
  const oauthDispatch = (wireRequest: AdapterRequest, requestParsed = parsed): ProviderFetchOptions["dispatchOverride"] => {
    if (route.provider.authMode === "forward") return undefined;
    return async (input, init, execute) => {
      let destination = input;
      let dispatchInit = init;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (selectionIsCurrent(requestBindings.get(wireRequest))) {
          const fetchImpl = (route.provider as OcxProviderConfig & { fetch?: typeof globalThis.fetch }).fetch ?? execute;
          const binding = requestBindings.get(wireRequest);
          const snapshot = route.providerName === "anthropic" && anthropicPoolAccountId && binding?.kind === "oauth"
            ? binding.snapshot : undefined;
          const writerGeneration = snapshot ? captureConfigGeneration() : 0;
          const sentHeaders = snapshot ? new Headers(dispatchInit.headers) : undefined;
          const ownsBearer = snapshot !== undefined
            && sentHeaders?.get("authorization") === `Bearer ${snapshot.accessToken}`
            && !sentHeaders?.has("x-api-key");
          // Reselection can choose a provider override instead of the supplied executor.
          // Either way the send crosses the physical boundary, so the connection policy is
          // applied around whichever implementation was just selected (#4992).
          commitKeyAttemptSend();
          // The binding travels with the send, so a rebuilt request resolves its provider route
          // against the destination it is actually going to rather than the one this dispatch
          // started with. Account reselection can move the upstream host, which would otherwise
          // apply a host-scoped decision to a different host.
          const response = await sendWithConnectionPolicy(
            fetchImpl,
            destination,
            { ...dispatchInit, redirect: "manual" },
            { providerName: route.providerName, provider: route.provider },
          );
          if (!response.ok) await recordKeyAttemptFailure(logCtx, response, dispatchInit.signal ?? options.abortSignal);
          // Observe each physical response before retries replace it. The binding belongs to
          // this dispatch, so a manual switch cannot file A's headers against B. Header
          // overrides and credential replacement make ownership unprovable: skip those writes.
          if (ownsBearer && snapshot) {
            try {
              const current = getAccountCredentialWithStatus("anthropic", snapshot.accountId);
              if (current && !current.needsReauth && credentialGeneration(current.credential) === snapshot.generation) {
                recordAnthropicAccountQuotaFromHeaders(snapshot.accountId, response.headers, writerGeneration);
              }
            } catch { /* best-effort observation cannot fail the response */ }
          }
          return response;
        }
        const nextAdapter = await refreshDispatchAdapter(requestParsed);
        // Rebind before rebuilding: the rebuild's bridged-search restore and continuation
        // restore key on the serving identity, which must be the refreshed route's, not the
        // credential whose selection just lapsed.
        bindRouteReasoningReplayScope({ parsed: requestParsed, providerName: route.providerName, provider: route.provider,
          adapterName: nextAdapter.name, oauthCredentialSnapshot: replayOAuthCredentialSnapshot });
        const rebuilt = await nextAdapter.buildRequest(requestParsed, {
          headers: requestState.selectedForwardHeaders, translatorBudget,
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
        const admitted = await commitResolvedOAuthSelection(await getAnthropicPoolAccessSnapshot(selection.accountId), true, selection.reason);
        if (!admitted) return formatErrorResponse(409, "conflict_error", "OAuth account selection changed; retry the request");
        anthropicPoolAccountId = admitted.accountId;
        route.provider = { ...route.provider, apiKey: admitted.accessToken };
        logCtx.provider = formatAnthropicProviderForLog("anthropic", admitted.accountId, config);
      } else {
        // Prefer the account with known headroom BEFORE the first attempt. Rotation alone
        // only reacts to a 429, so a turn could open on an account a previous probe already
        // measured as spent. A null answer means "use the active account", so every provider
        // without quota evidence keeps the resolution it has today.
        const preferredAccountId = isGenericFailoverProvider(route.providerName, route.provider)
          ? preferredInitialAccount(config, route.providerName, Date.now(), route.modelId)
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
        const admitted = await commitResolvedOAuthSelection(resolved, true);
        if (!admitted) return formatErrorResponse(409, "conflict_error", "OAuth account selection changed; retry the request");
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
        if (route.providerName === "anthropic" && hasAnthropicFailoverQuorum()) {
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
  let adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, inboundWire, route.staticPolicy);
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
    passiveQuotaWriterGeneration,
    applyFailoverSnapshot,
    selectionIsCurrent,
    resolveSelectionAdapter,
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
