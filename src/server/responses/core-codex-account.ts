import type { OcxConfig, OcxProviderConfig, OcxParsedRequest } from "../../types";
import type { CodexAuthContext, CodexAuthPolicyConfig } from "../../codex/auth-context";
import type { CodexUpstreamOutcome } from "../../codex/routing";
import {
  recordCodexUpstreamOutcome,
  computeQuotaCooldown,
  formatCodexProviderForLog,
} from "../../codex/routing";
import type { CodexWsQuotaObserver } from "./codex-ws-metadata";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { isCodexAccountGenerationLive } from "../../codex/account-store";
import { applyAccountQuotaFromUpstreamHeaders as applyCapturedCodexQuota } from "../../codex/quota";
import type { RouteResult } from "../../router";
import {
  normalizeUpstreamHostCircuitThreshold,
  upstreamHostHealthKey,
  resetUpstreamHostHealth,
} from "../../codex/upstream-host-health";
import { safeOriginLabel, fetchWithHeaderTimeout, providerFetch } from "./fetch-helpers";
import { classifyPoolRecoveryDispatch } from "../../routing/probe-lease";
import { formatErrorResponse } from "../../bridge";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { upstreamErrorMessageFromPayload, isRateLimitOrQuotaFailureMessage } from "../../lib/errors";
import { isNonReplayableResponse, isTransientUpstreamStatus } from "../../lib/upstream-retry";
import type { RequestLogContext } from "../request-log";
import type { DataPlaneAdmission } from "../auth-cors";
import type { InboundWire } from "../../providers/registry";
import type { BunRuntimeGateInput } from "./ws-upstream";
import type { TranslatorBudget } from "../../lib/translator-budget";
import type { AdmissionLease } from "../../lib/admission";
import {
  resolveCodexModelEntitlements,
  invalidateCodexModelEntitlementsForAccount,
  entitledCodexAccountIdsForModel,
} from "../../codex/model-entitlements";
import type { TransientSendBudget } from "../../lib/upstream-retry";
import { resolveAdapter, resolveWireProtocolOverride } from "../adapter-resolve";
import { codexAccountSelectionForTurn } from "../lifecycle";
import { isNativeMainTrafficBlocked } from "../../codex/native-profile-startup";
import { MAIN_CODEX_ACCOUNT_ID } from "../../codex/main-account";
import { slugsEquivalent } from "../../providers/slug-codec";
import {
  codexProbeLeaseId,
  codexTransientProbeGrant,
  codexProbeQuotaScope,
  releaseCodexAuthContextProbeLease,
  resolveCodexAuthContext,
  CodexPoolAuthenticationError,
  CodexAuthContextError,
  CodexAccountCooldownError,
  CodexMainProfileDrainingError,
  headersForCodexAuthContext,
  applyCodexAuthContextToProvider,
  stripCodexRuntimeProviderFields,
  createCodexReserveDispatchGuard,
} from "../../codex/auth-context";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../../codex/catalog/native-models";
import { isRequestExecutionBudget } from "../../lib/request-execution-budget";
import type { SingleUseDispatchPermit } from "../../lib/request-execution-budget";
import { hasForwardableCodexBearer } from "../auth-cors";
import { bindRouteReasoningReplayScope } from "./core-replay";
import {
  conversationStateBindingFromAuth,
  applyAccountChangeConversationStateScrub,
  conversationCarriesUploadedFiles,
} from "./account-change-state";
import {
  recordAdapterReasoning,
  recordAdapterTier,
  sealRequestAttemptIdentity,
  recordAttemptCredentialSource,
  noteProviderAttemptSend,
} from "../request-log";
import { codexAuthContextLogLabel } from "../../codex/account-label";
import { chargeWorkflowSends } from "../../lib/workflow-budget";
import type { ResponsesTerminalStatus } from "../../bridge";

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




export function codexLogAccountId(authCtx: CodexAuthContext): string | null {
  return authCtx.kind === "pool" || authCtx.kind === "main-pool" ? authCtx.accountId : null;
}


export function isFixedCodexAccount(authCtx: CodexAuthContext): boolean {
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


export function codexWsQuotaObserver(authCtx: CodexAuthContext, provider: OcxProviderConfig, modelId?: string): CodexWsQuotaObserver | undefined {
  if (!isCanonicalOpenAiForwardProvider(provider) || !usesCodexForwardPoolAuth(authCtx, provider)) return undefined;
  const { accountId, writerGeneration } = authCtx;
  const credentialGeneration = authCtx.kind === "pool" ? authCtx.generation : undefined;
  const mainWriter = authCtx.kind === "main-pool" ? authCtx.mainQuotaWriter : undefined;
  return headers => {
    if (credentialGeneration !== undefined && !isCodexAccountGenerationLive(accountId, credentialGeneration)) return;
    applyCapturedCodexQuota(accountId, headers, writerGeneration, mainWriter, { modelId, poolWriter: authCtx.kind === "pool" ? authCtx.poolQuotaWriter : undefined });
  };
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


export function normalizeCodexUnsupportedModelDetail(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}


export function isAllowListedCodexAccountModel400(
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


export async function shouldRetryCodexPoolAccountModel400(
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
export function codexQuotaFailureMessage(body: string): string | undefined {
  try {
    const payload = JSON.parse(body) as unknown;
    const canonical = upstreamErrorMessageFromPayload(payload);
    if (canonical !== undefined) return canonical;
    if (typeof payload === "string") return payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const record = payload as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    return typeof record.error === "string" ? record.error : undefined;
  } catch {
    // Plain-text gateways remain supported. Valid JSON is inspected only at recognized
    // message fields so echoed request content elsewhere cannot trigger account cooldown.
    return body;
  }
}


export async function shouldRetryCodexPoolAccountQuota(
  response: Response,
  signal?: AbortSignal,
): Promise<boolean> {
  // A post-send WebSocket gateway status must not become a second account's send; the
  // body carries no quota evidence either, but the marker is the contract, not the prose.
  if (isNonReplayableResponse(response)) return false;
  if (response.status === 402 || response.status === 429) {
    // Status alone used to authorize the move, which is right for a limit the ACCOUNT owns and
    // wrong for one it merely belongs to. An organization- or project-scoped exhaustion refuses
    // every credential inside that organization, so the second account meets the same counter
    // and the only thing the rotation buys is a second cold prompt prefix (#4546). Positive
    // evidence is required to withhold it: the helper fails closed, so an unreadable or
    // ambiguous body keeps the broad #584 behaviour unchanged, and `rate_limit_exceeded`,
    // `slow_down` and plan-level exhaustion still rotate exactly as before.
    const { codexScopedExhaustionCode } = await import("../../codex/quota-rejection");
    return await codexScopedExhaustionCode(response, { signal }) === undefined;
  }
  if (response.status < 500 || response.status >= 600) return false;
  try {
    // Reject malformed UTF-8 instead of matching quota words around replacement characters.
    const body = await readBoundedResponseBody(response.clone(), { signal, fatalUtf8: true });
    const message = body.displaySafe && !body.truncated
      ? codexQuotaFailureMessage(body.text)
      : undefined;
    return message !== undefined
      && isRateLimitOrQuotaFailureMessage(message);
  } catch {
    return false;
  }
}


/**
 * A pre-stream upstream 5xx another Codex account may still be able to serve.
 *
 * `server_is_overloaded` is the shape this exists for. The ChatGPT backend refuses in a few
 * hundred milliseconds, the body carries no quota evidence, and nothing in that exchange is
 * account health — so the pool keeps choosing the same account and every request fails on it
 * while the other accounts sit idle. That is what an operator sees as the pool refusing to move.
 *
 * The status stays exactly as upstream sent it. `classifyCodexUpstreamOutcome` maps 5xx to the
 * transient class, so the account earns an ordinary failure streak and `upstreamFailoverThreshold`
 * decides when it is soft-avoided, rather than a quota cooldown it never earned.
 *
 * Deliberately narrow. {@link isNonReplayableResponse} still refuses: a post-send WebSocket
 * gateway status means the body already reached the origin, so sending it from a second account
 * could duplicate a turn the origin may still be running. A 5xx whose body confirms quota is not
 * routed here either — {@link shouldRetryCodexPoolAccountQuota} classifies that one first and
 * carries the cooldown with it.
 */
export function shouldRetryCodexPoolAccountTransient(response: Response): boolean {
  return !isNonReplayableResponse(response) && isTransientUpstreamStatus(response.status);
}


export interface CodexPoolAccountRetryArgs {
  /** Sanitized caller input, before any selected Pool credential was materialized. */
  callerAuthHeaders: Headers;
  config: OcxConfig;
  route: { providerName: string; modelId: string; provider: OcxProviderConfig };
  parsed: OcxParsedRequest;
  logCtx: RequestLogContext;
  options: {
    admission?: DataPlaneAdmission;
    codexAuthPolicy?: CodexAuthPolicyConfig;
    visionDescribeTerminal?: boolean;
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
    /** The logical request's execution budget: the account move is its fourth send. */
    sendBudget?: TransientSendBudget;
    /** Root workflow this turn belongs to, so the move is charged there as well. */
    workflowRootId?: string;
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
    authCtx: CodexAuthContext,
    request: Awaited<ReturnType<ReturnType<typeof resolveAdapter>["buildRequest"]>>,
  ) => void;
}


export type CodexPoolAccountRetryResult =
  | {
    kind: "retried";
    authCtx: CodexAuthContext;
    request: Awaited<ReturnType<ReturnType<typeof resolveAdapter>["buildRequest"]>>;
    upstreamResponse: Response;
    selectedForwardHeaders: Headers;
  }
  | { kind: "no-alternate" }
  | {
    kind: "transport";
    error: unknown;
    authCtx: CodexAuthContext;
  };


/** Keep retry-stage entitlement snapshots inside the native-main selection fence. */
export async function resolveCodexRetryModelEntitlements(
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


export const CODEX_ACCOUNT_GATED_CANONICAL_WIRE_MODELS: ReadonlyMap<string, string> = new Map([
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


export function applyCodexAccountGatedWireNormalization(parsed: OcxParsedRequest, route: RouteResult, logCtx?: RequestLogContext): void {
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
export async function codexDenialOutcomeMeta(response: Response): Promise<{ denial?: "workspace" | "entitlement" }> {
  if (response.status !== 403) return {};
  const { classifyCodexPreStreamRejection } = await import("../../codex/quota-rejection");
  const rejection = await classifyCodexPreStreamRejection(response);
  return rejection.denial ? { denial: rejection.denial } : {};
}


export function codexQuotaOutcomeMeta(response: Response): {
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
export function shouldDeferCodexResetDerivedCooldown(response: Response, enabled?: boolean): boolean {
  return enabled === true
    && (response.status === 429 || response.status === 402)
    && computeQuotaCooldown(codexQuotaOutcomeMeta(response)).source === "reset-derived";
}


/**
 * One bounded alternate-account retry for Codex pool auth. Used for allow-listed
 * model-400 and for pre-stream 429/402 quota failures (#584).
 */
export async function retryCodexPoolOnAlternateAccount(
  args: CodexPoolAccountRetryArgs,
): Promise<CodexPoolAccountRetryResult> {
  const {
    callerAuthHeaders, config, route, parsed, logCtx, options, firstAuthCtx, firstResponse,
    outcomeStatus, upstream, connectMs, passthroughEstimate, stream,
  } = args;
  const inboundWire = options.inboundWire ?? "responses";
  const entitlementResolver = options.resolveCodexModelEntitlements ?? resolveCodexModelEntitlements;
  let retryAuthCtx: CodexAuthContext | undefined;
  // A transient 5xx must record even when this request cannot move: the ordinary terminal
  // recorder only fires for an OK event-stream body, so a pre-stream refusal would otherwise
  // leave the account looking healthy no matter how many times it refused, and the pool would
  // keep handing it the next request.
  const recordUnmovedTransientOutcome = (): void => {
    if (!isTransientUpstreamStatus(outcomeStatus)) return;
    recordCodexUpstreamOutcome(config, firstAuthCtx.accountId, outcomeStatus, {
      threadId: firstAuthCtx.affinityKey,
      fixedAccount: firstAuthCtx.fixedAccount,
      modelId: route.modelId,
      probeLeaseId: codexProbeLeaseId(firstAuthCtx),
      probeQuotaScope: codexProbeQuotaScope(firstAuthCtx),
      transientProbe: codexTransientProbeGrant(firstAuthCtx),
      writerGeneration: firstAuthCtx.writerGeneration,
    });
  };
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
    recordUnmovedTransientOutcome();
    return { kind: "no-alternate" };
  }
  // An uploaded file is readable only by the account it was sent to, so NO alternate can serve
  // this body. Which account would be chosen does not change that, which is why this asks before
  // the resolution rather than after it: refusing here reserves no send, cancels no response, and
  // leaves the caller holding the first account's rejection to return unchanged (#4710). The
  // initial-dispatch sites answer with a 400 instead, because there is no earlier response there
  // to fall back to. A same-account replay -- the gated-model 400 ladder above -- is unaffected,
  // since it never leaves the issuing account.
  if (!retryAuthCtx && conversationCarriesUploadedFiles(parsed._rawBody)) {
    recordUnmovedTransientOutcome();
    return { kind: "no-alternate" };
  }
  // An account move is the guarded profile's fourth send and draws the single shared
  // final-recovery reserve. Nothing bounded it per request before: `excludeAccountId` excludes
  // only the account that just failed, and the caller's recovery loop can return here after the
  // alternate fails too, so one request could walk the pool an account at a time. The permit is
  // consumed immediately before the physical send, so a resolution that finds no alternate
  // costs nothing.
  const executionBudget = isRequestExecutionBudget(args.options.sendBudget)
    ? args.options.sendBudget
    : undefined;
  let accountMovePermit: SingleUseDispatchPermit | undefined;
  if (!retryAuthCtx && executionBudget) {
    const decision = executionBudget.reserveDispatch({
      sendClass: "account-failover",
      targetKey: `${route.providerName}|${route.modelId}|alternate-account`,
    });
    if (!decision.allowed) {
      recordUnmovedTransientOutcome();
      return { kind: "no-alternate" };
    }
    accountMovePermit = decision.permit;
  }
  try {
    retryAuthCtx ??= await resolveCodexAuthContext(
        callerAuthHeaders,
        config,
        "pool",
        {
          excludeAccountId: firstAuthCtx.accountId,
          admission: options.admission,
          codexAuthPolicy: options.codexAuthPolicy,
          modelId: route.modelId,
          requestScopedMainCredential: hasForwardableCodexBearer(callerAuthHeaders, config),
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
      // The reservation is the charge now, so an abandoned move has to hand its send back.
      accountMovePermit?.release();
      await firstResponse.body?.cancel().catch(() => undefined);
      releaseCodexAuthContextProbeLease(firstAuthCtx);
      throw error;
    }
  }
  // A validated request-owned main bearer is a real alternate when the failed credential was a
  // stored Pool account. It has no Pool account id to promote or cool, but it can own this one
  // bounded replay. The resolver already refuses it when main itself is the excluded credential.
  if (
    retryAuthCtx?.kind !== "pool"
    && retryAuthCtx?.kind !== "main-pool"
    && retryAuthCtx?.kind !== "main"
  ) {
    // A body-confirmed quota response may arrive under HTTP 5xx. Without an alternate,
    // the ordinary terminal recorder sees only that wire status and would misclassify it
    // as transient, leaving the exhausted account immediately selectable next turn.
    if (outcomeStatus !== firstResponse.status && (outcomeStatus === 429 || outcomeStatus === 402)) {
      recordCodexUpstreamOutcome(config, firstAuthCtx.accountId, outcomeStatus, {
        ...codexQuotaOutcomeMeta(firstResponse),
        threadId: firstAuthCtx.affinityKey,
        modelId: route.modelId,
        probeLeaseId: codexProbeLeaseId(firstAuthCtx),
        probeQuotaScope: codexProbeQuotaScope(firstAuthCtx),
        transientProbe: codexTransientProbeGrant(firstAuthCtx),
        writerGeneration: firstAuthCtx.writerGeneration,
      });
    }
    // No usable alternate was resolved, so the reserved move never becomes a send.
    accountMovePermit?.release();
    recordUnmovedTransientOutcome();
    return { kind: "no-alternate" };
  }

  const quotaMeta = { ...codexQuotaOutcomeMeta(firstResponse), ...(await codexDenialOutcomeMeta(firstResponse)) };
  if (outcomeStatus === 429 || outcomeStatus === 402) {
    const { applyAccountQuotaFromUpstreamHeaders } = await import("../../codex/auth-api");
    applyAccountQuotaFromUpstreamHeaders(
      firstAuthCtx.accountId,
      firstResponse.headers,
      firstAuthCtx.writerGeneration,
      firstAuthCtx.kind === "main-pool" ? firstAuthCtx.mainQuotaWriter : undefined,
      { modelId: route.modelId, poolWriter: firstAuthCtx.kind === "pool" ? firstAuthCtx.poolQuotaWriter : undefined },
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
      transientProbe: codexTransientProbeGrant(firstAuthCtx),
      writerGeneration: firstAuthCtx.writerGeneration,
      // Retry already advanced the RR ring via excludeAccountId — reuse for promotion.
      ...(retryAuthCtx.accountId ? { promoteAccountId: retryAuthCtx.accountId } : {}),
    });
  };
  // Only a combo reset-derived outcome is deferred. Retry-After, defaults, and
  // ordinary requests must block the first account before the alternate send.
  if (!deferFirstOutcome) recordFirstOutcome();
  const retryHeaders = headersForCodexAuthContext(callerAuthHeaders, retryAuthCtx, options.codexAuthPolicy ?? config, route.modelId, options.admission);
  const retryProvider = applyCodexAuthContextToProvider(
    stripCodexRuntimeProviderFields(route.provider),
    retryAuthCtx,
    "pool",
  );
  const retryAdapter = resolveAdapter(
    resolveWireProtocolOverride(route.providerName, route.modelId, retryProvider, inboundWire),
    config.cacheRetention,
    route.providerName,
  );
  bindRouteReasoningReplayScope({
    parsed,
    providerName: route.providerName,
    provider: retryProvider,
    adapterName: retryAdapter.name,
    codexAuthContext: retryAuthCtx,
    forwardHeaders: retryHeaders,
  });
  {
    const binding = conversationStateBindingFromAuth(
      retryAuthCtx,
      firstAuthCtx.kind === "pool" || firstAuthCtx.kind === "main-pool"
        ? firstAuthCtx.affinityKey
        : undefined,
    );
    if (binding) {
      applyAccountChangeConversationStateScrub({
        body: parsed._rawBody,
        parsed,
        bindingKey: binding.bindingKey,
        servingAccountId: binding.accountId,
        priorAccountId: firstAuthCtx.accountId,
        logCtx,
      });
    }
  }
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
  recordAttemptCredentialSource(logCtx.activeAttempt, route.providerName, route.provider, retryAdapter.name);

  const retrySameConfirmedAccount = outcomeStatus === 400
    && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(route.modelId)
    && retryAuthCtx.accountId === firstAuthCtx.accountId;
  // Live Daybreak traffic has produced long runs of unsupported-model 400s from different
  // upstream shards even while the authenticated roster continues to grant the model. Permit
  // seven additional same-account sends (eight total including the original), re-checking the
  // exact allow-listed body and fresh entitlement before every later send. Alternate-account and
  // quota recovery retain their historical one-send bound.
  //
  // Two different bounds, and the effective one is the smaller. `maxRetrySends` answers "how
  // many times is it worth re-asking THIS account for a model its roster still grants"; the
  // shared budget answers "how many times may this LOGICAL REQUEST reach upstream in total,
  // across every layer that can re-send". A ladder of eight layered on sends the request had
  // already made is exactly the per-request multiplication #4546 is about, so the ladder is
  // capped at what the request has left. The floor of one keeps the single retry this function
  // was called to make -- the move already paid for itself with its own permit -- and each rung
  // past the first reserves its own send below, so a refusal stops the ladder with the last
  // upstream answer intact.
  // The ladder replays to the SAME account, so it must reserve under the same target key the
  // other legs use. Folding the account id in made every rung read as a target change, which
  // spent the one cross-account slot a real move needs on a same-account replay.
  const ladderTargetKey = `${route.providerName}|${route.modelId}`;
  // The ladder keeps its OWN bound rather than drawing on what the request has left. Clamping it
  // to the shared total looked right and broke a working, pinned path: #2097 fixes this recovery
  // at eight same-account dispatches (tests/server/server-auth.test.ts), and a request that has
  // already spent sends would silently stop short of it. Reconciling an eight-send same-account
  // ladder with a four-send request total is a policy decision, not a clamp to add in passing.
  // What this diff does fix is that the rungs are now CHARGED instead of free.
  const maxRetrySends = retrySameConfirmedAccount ? 7 : 1;
  let retrySendCount = 0;
  let upstreamResponse: Response;
  try {
    while (true) {
      // The same-account gated-model 400 ladder below keeps its own `maxRetrySends` bound and
      // does not take the reserve again; only the move itself does.
      if (accountMovePermit) {
        // The pool-wide recovery window is consulted BEFORE the request-local permit is used.
        // `reserveDispatch` charges at reservation time and `release()` is the only way back, so
        // using the permit first and refusing afterwards would spend a send the request never
        // made. An account move is recovery traffic like any other: one request's own budget
        // cannot see that a thousand other requests are moving at the same moment, which is
        // precisely the amplification this window exists to bound (#4701).
        //
        // A refusal here is not a new failure mode: "no alternate was available" is already the
        // outcome when the pool has nowhere to move this request to, and it is handled.
        if (!classifyPoolRecoveryDispatch("retry").admitted) {
          accountMovePermit.release();
          accountMovePermit = undefined;
          // The alternate context was resolved and will not send. Hand back whatever recovery
          // lease it is holding rather than leaving that account unprobeable.
          releaseCodexAuthContextProbeLease(retryAuthCtx);
          recordUnmovedTransientOutcome();
          return { kind: "no-alternate" };
        }
        const charged = accountMovePermit.use();
        accountMovePermit = undefined;
        if (!charged) {
          releaseCodexAuthContextProbeLease(retryAuthCtx);
          recordUnmovedTransientOutcome();
          return { kind: "no-alternate" };
        }
        // The move is a physical send like any other, so the root workflow is charged too.
        chargeWorkflowSends(args.options.workflowRootId, 1);
      }
      noteProviderAttemptSend(logCtx, route.providerName, route.provider, passthroughEstimate);
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
            onCodexWsQuota: codexWsQuotaObserver(retryAuthCtx, route.provider, route.modelId),
            beforeDispatch: isCanonicalOpenAiForwardProvider(route.provider)
              ? createCodexReserveDispatchGuard(retryAuthCtx, options.codexAuthPolicy ?? config, route.modelId, options.admission, options.visionDescribeTerminal === true) : undefined,
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
      // Caller-owned main is an alternate-account replay and can never enter the bounded
      // same-stored-account 400 loop above. Keep that invariant explicit for the account-id reads.
      if (retryAuthCtx.kind === "main") break;
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
      // The next rung is another physical send of this logical request: a same-account,
      // same-target replay, charged as an ordinary transient send rather than as a move.
      // Reserved here, immediately before looping back, so a refusal stops the ladder with the
      // last upstream 400 intact instead of spending a send it cannot make.
      // Every rung is CHARGED, and a refusal does not end the ladder. That asymmetry is
      // deliberate and it is the one place the shared cap yields. This is a same-account,
      // same-target replay of a model-gating 400 whose own bound is eight dispatches, pinned by
      // #2097; letting a spent request budget cut it to four would break a recovery that works
      // today, which is precisely the mistake 040_send_budget.md warns a flat ceiling makes.
      // The request total still governs everything that changes target or credential.
      if (executionBudget) {
        const rung = executionBudget.reserveDispatch({
          sendClass: "transient",
          targetKey: ladderTargetKey,
        });
        if (rung.allowed) rung.permit.use();
        chargeWorkflowSends(args.options.workflowRootId, 1);
      }
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
    const quotaStatus = [httpStatusOverride, logCtx?.terminalHttpStatus]
      .find(value => value === 429 || value === 402);
    if (status === "incomplete" && quotaStatus === undefined) {
      // Normal limit/content-filter/stall terminal — the account served the
      // request. Don't penalize account health; record success to clear any
      // prior soft-avoid so a healthy account isn't stuck avoided.
      recordCodexUpstreamOutcome(config, authCtx.accountId, 200, {
        threadId: authCtx.affinityKey,
        fixedAccount: authCtx.fixedAccount,
        modelId,
        probeLeaseId: codexProbeLeaseId(authCtx),
        probeQuotaScope: codexProbeQuotaScope(authCtx),
        transientProbe: codexTransientProbeGrant(authCtx),
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
      : (quotaStatus ?? httpStatusOverride ?? logCtx?.terminalHttpStatus ?? 502);
    recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, {
      threadId: authCtx.affinityKey,
      fixedAccount: authCtx.fixedAccount,
      modelId,
      probeLeaseId: codexProbeLeaseId(authCtx),
      probeQuotaScope: codexProbeQuotaScope(authCtx),
      transientProbe: codexTransientProbeGrant(authCtx),
      writerGeneration: authCtx.writerGeneration,
      // A mid-stream terminal can carry a semantic 401 long after the credential was
      // replaced. It is never replayed — the client already saw output — but it must
      // not retire the replacement either (#2887).
      ...(authCtx.kind === "pool" ? { credentialGeneration: authCtx.generation } : {}),
    });
  };
}
