import type { Server } from "bun";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse, type ResponsesTerminalStatus } from "../../bridge";
import {
  getConfigPath,
  multiAgentGuidanceEnabled,
  resolveEnvValue,
} from "../../config";
import { parseRequest } from "../../responses/parser";
import { buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary, extractCompactUserMessages } from "../../responses/compaction";
import { FORWARD_HEADERS, sanitizeReasoningInputContent } from "../../adapters/openai-responses";
import { expandPreviousResponseInput, previousResponseProviderState, rememberResponseState } from "../../responses/state";
import { NoEligiblePolicyCandidateError, routeModel } from "../../router";
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
import { modelInList, namespacedToolName } from "../../types";
import type { AdapterEvent, CodexAccountMode, OcxConfig, OcxParsedRequest, OcxProviderConfig, OcxProviderContinuationState, OcxUsage } from "../../types";
import {
  forceRefreshOAuthAccessSnapshot,
  getOAuthCredentialApiBaseUrl,
  getOAuthCredentialProjectId,
  getValidAccessTokenSnapshot,
  type OAuthAccessSnapshot,
  UnsupportedOAuthProviderError,
} from "../../oauth";
import { buildWebSearchTool, planWebSearch, runWithWebSearch, shouldResolveOpenAiWebSearchSidecar } from "../../web-search";
import { describeImagesInPlace, planVisionSidecar, shouldResolveOpenAiVisionSidecar, stripImagesInPlace } from "../../vision";
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
  materializeCodexUpstreamAuth,
  CodexMainSubstitutionUnavailableError,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  codexProbeLeaseId,
  codexProbeQuotaScope,
  releaseCodexAuthContextProbeLease,
  type CodexAuthContext,
} from "../../codex/auth-context";
import {
  formatCodexProviderForLog,
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "../../codex/routing";
import {
  fetchWithResetRetry,
  fetchWithTransientRetry,
  applyUpstreamRecoveryInit,
  type UpstreamSendRecovery,
} from "../../lib/upstream-retry";
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
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "../auth-cors";
import type { DataPlaneAdmission } from "../auth-cors";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar, type ResolvedOpenAiForwardSidecar } from "../../providers/openai-sidecar";
import { CODEX_FORWARD_BASE_URL, isCanonicalOpenAiForwardProvider, supportsNativeResponsesCompactEndpoint } from "../../providers/openai-tiers";
import { slugsEquivalent } from "../../providers/slug-codec";
import { applyOpenAiVirtualModel, resolveOpenAiCompactModel } from "../../providers/openai-virtual-models";
import { isUsageDebugEnabled } from "../../usage/debug";
import { readJsonRequestBody, DecompressedBodyTooLargeError, UnsupportedContentEncodingError } from "../request-decompress";
import { resolveAdapter, resolveWireProtocolOverride } from "../adapter-resolve";
import { hasKeyPoolFailover, rotateProviderTransportOn429 } from "../../providers/key-failover";
import { shouldAttemptImageTierRetry } from "../image-retry";
import { resolveProviderTransport } from "../../providers/xai-transport";
import type { WsData } from "../ws-bridge";
import { codexAccountSelectionForTurn, registerTurn, trackStreamLifetime, unregisterTurn } from "../lifecycle";
import type { AdmissionLease } from "../../lib/admission";
import { redactSecretString } from "../../lib/redact";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { supportedLadderFor } from "../effort-policy";
import {
  beginRequestAttempt,
  catalogModelSupportsServiceTier,
  finishRequestAttempt,
  inspectResponseLogJson,
  noteAttemptSend,
  readConfiguredCodexServiceTier,
  requestLogSpeedLabel,
  sealRequestAttemptIdentity,
  usageFromResponsesPayload,
  type RequestLogContext,
} from "../request-log";
import type { AttemptRecoveryKind } from "../../usage/log";
import {
  consumeForInspection,
  consumeForResponseLogMetadata,
  markNativePassthroughSseResponse,
  relaySseWithFailedTail,
  relayWithAbort,
  sanitizePassthroughHeaders,
} from "../relay";
import { hasResponsesItemIdRepair, relaySseWithResponsesItemIdRepair } from "../responses-item-id-repair";
import type { EffectiveSubagentRoster, SpawnAgentSurface } from "../../codex/catalog";
import { codexAuthContextLogLabel } from "../../codex/account-label";

import {
  codexAccountGatedCanonicalWireModel,
  decodeRequestErrorResponse,
  handleResponses,
  preAuthUpstreamHostCircuitKey,
  upstreamHostCircuitOpenResponse,
  usesCodexForwardPoolAuth,
} from "./core";
import { fetchWithHeaderTimeout, providerFetch, safeHostLabel, safeOriginLabel } from "./fetch-helpers";

export const COMPACT_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

export function compactResponseTooLargeError(): Response {
  return new Response(JSON.stringify({
    error: {
      message: "Compact response exceeded 32 MiB",
      type: "compact_response_too_large",
      code: "compact_response_too_large",
    },
  }), { status: 502, headers: { "Content-Type": "application/json" } });
}



/**
 * Resolve one eligible pool account other than `excludeAccountId`, and build everything
 * the alternate send needs. Returns null when no alternate exists or construction fails,
 * in which case the caller keeps the first account's rejection intact.
 *
 * Mirrors the auth resolution the native compact branch already does for the first
 * account, so the alternate is built the same way rather than through a second,
 * divergent path.
 */
async function resolveAlternateCompactContext(args: {
  req: Request;
  config: OcxConfig;
  route: { provider: OcxProviderConfig; codexAccountMode?: CodexAccountMode };
  selectedModelId: string | undefined;
  excludeAccountId: string | null;
  turnAdmissionLease?: AdmissionLease;
}): Promise<{ authCtx: CodexAuthContext; provider: OcxProviderConfig; headers: Headers } | null> {
  const { req, config, route, selectedModelId, excludeAccountId, turnAdmissionLease } = args;
  if (!route.codexAccountMode || !excludeAccountId) return null;
  try {
    const authCtx = await resolveCodexAuthContext(req.headers, config, route.codexAccountMode, {
      ...(selectedModelId ? { modelId: selectedModelId } : {}),
      excludeAccountId,
      beginCodexAccountSelection: codexAccountSelectionForTurn(turnAdmissionLease),
    });
    if (!authCtx.accountId || authCtx.accountId === excludeAccountId) return null;
    const provider = applyCodexAuthContextToProvider(route.provider, authCtx, route.codexAccountMode);
    const headers = new Headers({ "content-type": "application/json" });
    const selected = headersForCodexAuthContext(req.headers, authCtx);
    for (const name of FORWARD_HEADERS) {
      const value = selected.get(name);
      if (value) headers.set(name, value);
    }
    const override = (provider as { _codexAccountOverride?: { accessToken: string; chatgptAccountId: string } })._codexAccountOverride;
    if (override) {
      headers.set("authorization", `Bearer ${override.accessToken}`);
      headers.set("chatgpt-account-id", override.chatgptAccountId);
    }
    if (provider.apiKey) headers.set("authorization", `Bearer ${resolveEnvValue(provider.apiKey)}`);
    return { authCtx, provider, headers };
  } catch (err) {
    if (err instanceof CodexMainProfileDrainingError) {
      // The native-main fence can start after account A has already rejected the
      // request. Treat the now-fenced main profile as no alternate and preserve A's
      // real rejection instead of replacing it with a synthetic drain response.
      return null;
    }
    // No eligible alternate (all cooled, affinity expired, reauth needed) — the caller
    // returns the first account's rejection unchanged, which is today's behavior.
    return null;
  }
}

/**
 * Headers a client needs to back off correctly after a pool rejection. The buffered
 * response is rebuilt from scratch, so anything not listed here is dropped — which is
 * what silently discarded `Retry-After` and the reset hints from a 429 before.
 * Deliberately narrow: no hop-by-hop headers, no content-length (the buffered body sets
 * its own), no cookies.
 */
const COMPACT_PASSTHROUGH_HEADERS = [
  "retry-after",
  "x-codex-primary-reset-at",
  "x-codex-secondary-reset-at",
  "x-codex-tertiary-reset-at",
  // A relayed 3xx keeps its Location so the client can follow it (#914).
  "location",
];

function compactResponseHeaders(upstream: Response): Headers {
  const headers = new Headers({ "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
  for (const name of COMPACT_PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export async function bufferCompactResponse(upstream: Response, signal: AbortSignal): Promise<Response> {
  const reader = upstream.body?.getReader();
  const headers = compactResponseHeaders(upstream);
  if (!reader) return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers });
  const declaredLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > COMPACT_RESPONSE_MAX_BYTES) {
    await reader.cancel("compact_response_too_large").catch(() => undefined);
    return compactResponseTooLargeError();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel(signal.reason).catch(() => undefined);
        return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > COMPACT_RESPONSE_MAX_BYTES) {
        await reader.cancel("compact_response_too_large").catch(() => undefined);
        return compactResponseTooLargeError();
      }
      chunks.push(value);
    }
  } catch {
    if (signal.aborted) return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    return formatErrorResponse(502, "upstream_error", "Failed to read compact response");
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}



export async function handleResponsesCompact(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  turnAdmissionLease?: AdmissionLease,
  admission?: DataPlaneAdmission,
): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    return decodeRequestErrorResponse(err, "responses-compact");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return formatErrorResponse(400, "invalid_request_error", "Invalid compaction request body");
  }
  const raw = body as { model?: unknown; input?: unknown };
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    return formatErrorResponse(400, "invalid_request_error", "compaction request requires a model");
  }

  let route;
  try {
    // Compact requests route through the same policy evaluation as normal
    // turns, so body-derived evidence (tools/image) must reach the first
    // evaluation too - not only the later handleResponses dispatch.
    route = routeModel(config, raw.model, evidenceFromBody(raw));
  } catch (err) {
    if (err instanceof NoEligiblePolicyCandidateError) {
      // Persist the evaluation trace (per-candidate exclusions + the
      // no-eligible reason) so a failed compact policy request stays
      // auditable, matching the other request handlers.
      logCtx.routeDecision = err.trace;
    }
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  const selectedModelId = route.modelId;
  // Derive from the RESOLVED route model, not the caller's raw string. An account-qualified
  // selector like `side/gpt-daybreak-blue-latest` does not match the gated map — `slugsEquivalent`
  // reads the account namespace as a routed provider prefix — so keying on `raw.model` sent
  // exactly the selector form back down the native compact endpoint this guard exists to avoid.
  // `route.modelId` is the same value `applyCodexAccountGatedWireNormalization` uses in core.ts.
  const accountGatedCompactWireModel = codexAccountGatedCanonicalWireModel(selectedModelId);
  logCtx.requestedModel = raw.model;
  logCtx.model = selectedModelId;
  logCtx.routeDecision = route.routeDecision;
  logCtx.provider = route.codexAccountNamespace
    ? `${route.providerName}-${route.codexAccountNamespace}`
    : route.providerName;
  logCtx.providerAdapter = route.provider.adapter;
  const virtual = resolveOpenAiCompactModel(route.providerName, selectedModelId);
  if (virtual) {
    route.modelId = virtual.wireModelId;
    logCtx.model = virtual.selectedModelId;
    logCtx.resolvedModel = virtual.wireModelId;
  } else {
    logCtx.resolvedModel = route.modelId;
  }

  // #1686: a bearer-presented admission secret is one of ours, so the stored main credential
  // is substituted below instead of the caller bearer being forwarded.
  // #2132: and only when the route is a native Codex one, which is the only route that can
  // consume that credential. See the longer note in core.ts resolveResponsesCodexAuth.
  const substituteMainCredential = admission?.source === "bearer"
    && route.codexAccountMode !== undefined;
  if (route.codexAccountMode === "direct" && !substituteMainCredential) {
    try { validateForwardAdmissionCredential(req.headers, config); }
    catch (err) {
      if (err instanceof ForwardAdmissionCredentialError) return formatErrorResponse(401, "authentication_error", err.message);
      throw err;
    }
  }

  // Native /responses/compact exists on the canonical ChatGPT backend and on the
  // official OpenAI API. Any other Responses-shaped gateway must take the routed
  // summarizer path below, or compaction fails against an endpoint it never had (#422).
  if (supportsNativeResponsesCompactEndpoint(route.providerName, route.provider) && !accountGatedCompactWireModel) {
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    }
    // The enclosing native-compact guard already restricts this path to
    // supported backends, so compact intentionally does not require the
    // regular Responses adapter check here.
    const preAuthCompactHostKey = preAuthUpstreamHostCircuitKey(route, config, {
      requireResponsesAdapter: false,
    });
    let compactHostAdmissionLease: UpstreamHostAdmissionLease | null = null;
    let authCtx: CodexAuthContext = { kind: "main", accountId: null };
    if (preAuthCompactHostKey) {
      const admission = acquireUpstreamHostAdmission(
        preAuthCompactHostKey,
        config.upstreamHostCircuitThreshold,
      );
      if (admission.kind === "blocked") {
        return upstreamHostCircuitOpenResponse(admission.retryAfterSeconds);
      }
      compactHostAdmissionLease = admission.lease;
    }
    try {
    // Native ChatGPT/OpenAI model: forward the compact request verbatim to the real backend.
    // Resolve the SAME pool/thread auth context as /v1/responses — forwarding the caller's raw
    // headers would run compaction on the wrong account (or 401) whenever a pool account is
    // active for this thread while normal turns succeed.
    let compactProvider = route.provider;
    const headers = new Headers({ "content-type": "application/json" });
    try {
      if (route.codexAccountMode) {
        authCtx = await resolveCodexAuthContext(req.headers, config, route.codexAccountMode, {
          accountId: route.codexAccountId,
          modelId: selectedModelId,
          substituteMainCredentialForDirect: substituteMainCredential,
          beginCodexAccountSelection: codexAccountSelectionForTurn(turnAdmissionLease),
        });
        logCtx.accountLogLabel = codexAuthContextLogLabel(authCtx, config);
        const selected = materializeCodexUpstreamAuth(req.headers, authCtx, { substituteMainCredential });
        compactProvider = applyCodexAuthContextToProvider(route.provider, authCtx, route.codexAccountMode);
        for (const name of FORWARD_HEADERS) {
          const value = selected.get(name);
          if (value) headers.set(name, value);
        }
        const override = (compactProvider as { _codexAccountOverride?: { accessToken: string; chatgptAccountId: string } })._codexAccountOverride;
        if (override) {
          headers.set("authorization", `Bearer ${override.accessToken}`);
          headers.set("chatgpt-account-id", override.chatgptAccountId);
        }
      }
    } catch (err) {
      if (err instanceof CodexAccountCooldownError) {
        return cooldownErrorResponse(err, Date.now(), route.codexAccountNamespace);
      }
      if (err instanceof CodexMainProfileDrainingError) return codexMainProfileDrainingResponse();
      if (err instanceof CodexThreadAffinityExpiredError) {
        return formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
      }
      if (err instanceof CodexAuthContextError) {
        return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
      }
      if (err instanceof CodexPoolAuthenticationError || err instanceof CodexDirectAuthenticationError) {
        return formatErrorResponse(401, "authentication_error", err.message);
      }
      throw err;
    }
    const base = isCanonicalOpenAiForwardProvider(compactProvider)
      ? CODEX_FORWARD_BASE_URL
      : (compactProvider.baseUrl ?? "").replace(/\/+$/, "");
    if (compactProvider.authMode !== "forward" && compactProvider.apiKey) {
      headers.set("authorization", `Bearer ${resolveEnvValue(compactProvider.apiKey)}`);
    }
    const { reasoning: _reasoning, ...compactBodyRaw } = raw as typeof raw & { reasoning?: unknown };
    // The regular /v1/responses path applies sanitizeReasoningInputContent via the adapter's
    // buildRequest, but the compact endpoint forwards directly. Apply the same sanitizer here
    // so routed-model reasoning items (reasoning_text content) don't 400 the ChatGPT backend.
    const compactBody = sanitizeReasoningInputContent(compactBodyRaw) as typeof compactBodyRaw;
    const compactUrl = `${base}/responses/compact`;
    const actualCompactHostKey = upstreamHostHealthKey(
      route.providerName,
      safeOriginLabel(compactUrl),
    );
    const compactHostKey = compactProvider.authMode === "forward"
      ? actualCompactHostKey
      : null;
    const compactHostCircuitEnabled = compactHostKey !== null
      && normalizeUpstreamHostCircuitThreshold(config.upstreamHostCircuitThreshold) > 0;
    if (compactHostKey !== null && !compactHostCircuitEnabled) {
      disableUpstreamHostCircuitForKey(actualCompactHostKey);
    }
    if (compactHostAdmissionLease && compactHostAdmissionLease.key !== compactHostKey) {
      releaseCodexAuthContextProbeLease(authCtx);
      return formatErrorResponse(502, "upstream_error", "Provider host changed after circuit admission");
    }
    if (req.signal.aborted) {
      releaseCodexAuthContextProbeLease(authCtx);
      return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    }
    if (!compactHostAdmissionLease && compactHostCircuitEnabled) {
      const admission = acquireUpstreamHostAdmission(
        compactHostKey!,
        config.upstreamHostCircuitThreshold,
      );
      if (admission.kind === "blocked") {
        releaseCodexAuthContextProbeLease(authCtx);
        return upstreamHostCircuitOpenResponse(admission.retryAfterSeconds);
      }
      compactHostAdmissionLease = admission.lease;
    }
    const settleObservedCompactHostResponse = (): void => {
      if (compactHostCircuitEnabled) {
        resetUpstreamHostHealth(actualCompactHostKey, compactHostAdmissionLease);
      } else {
        resetUpstreamHostHealth(actualCompactHostKey);
      }
      compactHostAdmissionLease = null;
    };
    const connectMs = config.connectTimeoutMs ?? 200_000;
    // Takes its context explicitly: the alternate-account flow below records a rejection
    // against A while promoting B, then records B's own outcome. A closure over a single
    // `authCtx` cannot express either.
    const recordCompactPoolOutcome = (
      ctx: CodexAuthContext,
      outcome: CodexUpstreamOutcome,
      meta: {
        retryAfter?: string | null;
        resetAt?: unknown | unknown[];
        promoteAccountId?: string;
      } = {},
    ) => {
      if (!usesCodexForwardPoolAuth(ctx, route.provider)) return;
      recordCodexUpstreamOutcome(config, ctx.accountId, outcome, {
        ...meta,
        threadId: ctx.kind === "pool" || ctx.kind === "main-pool" ? ctx.affinityKey : undefined,
        fixedAccount: ctx.fixedAccount,
        modelId: selectedModelId,
        probeLeaseId: codexProbeLeaseId(ctx),
        probeQuotaScope: codexProbeQuotaScope(ctx),
        writerGeneration: ctx.kind === "pool" || ctx.kind === "main-pool"
          ? ctx.writerGeneration
          : undefined,
      });
    };
    // Two recovery modes, mirroring retryCodexPoolOnAlternateAccount() on the regular
    // path (core.ts:396). The first account keeps the full ladder — transient-5xx retry
    // wrapping reset retry — because those retries happen before any alternate is even
    // considered. The alternate is one bounded send: a second ladder would multiply the
    // work an already-rejecting pool is doing.
    const sendCompactAttempt = (
      sendProvider: OcxProviderConfig,
      sendHeaders: Headers,
      recovery: "normal" | "single",
    ): Promise<Response> => {
      const doFetch = (upstreamRecovery?: UpstreamSendRecovery) => fetchWithHeaderTimeout(
        compactUrl,
        applyUpstreamRecoveryInit({
          method: "POST",
          headers: sendHeaders,
          body: JSON.stringify({ ...compactBody, model: route.modelId }),
        }, upstreamRecovery),
        req.signal,
        connectMs,
        false,
        providerFetch(sendProvider, undefined, {
          providerName: route.providerName,
          modelId: route.modelId,
        }),
        // Every credential-bearing forward send gets manual redirects, not only
        // pool sends: direct mode carries the caller's credential too (#914).
        sendProvider.authMode === "forward",
      ).then(res => {
        // Every real attempt response — including an intermediate 5xx the retry
        // wrapper replaces — proves the host was reached (#914 review).
        settleObservedCompactHostResponse();
        return res;
      });
      return recovery === "single"
        ? doFetch()
        : fetchWithTransientRetry(doFetch, { abortSignal: req.signal, label: safeHostLabel(compactUrl) });
    };

    // The account each outcome belongs to. Reassigned only when the alternate send below
    // actually happens, so every recorder call names the context that produced it.
    let outcomeCtx = authCtx;
    let upstream: Response;
    try {
      // Same connect timeout + keep-alive reset + transient-5xx recovery as /v1/responses —
      // compact hits the same ChatGPT host and must soft-avoid / clear affinity (#186).
      upstream = await sendCompactAttempt(compactProvider, headers, "normal");
    } catch (err) {
      if (req.signal.aborted) {
        recordCompactPoolOutcome(outcomeCtx, 499);
        return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
      }
      const outcome = classifyTransportFailureKind(err);
      // Host-level evidence stands regardless of pool membership (#914 review).
      if (outcome === "connect_neutral") {
        if (compactHostCircuitEnabled) {
          recordUpstreamHostFailure(actualCompactHostKey, {
            code: transportErrorCode(err),
            threshold: config.upstreamHostCircuitThreshold,
            lease: compactHostAdmissionLease,
          });
        } else {
          recordUpstreamHostFailure(actualCompactHostKey, { code: transportErrorCode(err) });
        }
      } else {
        releaseUpstreamHostAdmission(compactHostAdmissionLease);
      }
      compactHostAdmissionLease = null;
      recordCompactPoolOutcome(outcomeCtx, outcome);
      return formatErrorResponse(502, "upstream_error", "Failed to connect to compact upstream");
    }

    // Bounded same-request alternate: the regular /v1/responses path already does this
    // (core.ts:319-423) and recognizes exactly 429/402. Without it a pool rejection
    // surfaces to the client, which retries the compact task OUTSIDE the logical request
    // — reporting exhausted retries while another pool account sat idle (#913).
    if (
      (upstream.status === 429 || upstream.status === 402)
      && usesCodexForwardPoolAuth(authCtx, route.provider)
      && !authCtx.fixedAccount
      && route.codexAccountMode
      && !req.signal.aborted
    ) {
      const firstRetryAfter = upstream.headers.get("retry-after");
      const firstResetAt = [
        upstream.headers.get("x-codex-primary-reset-at"),
        upstream.headers.get("x-codex-secondary-reset-at"),
        upstream.headers.get("x-codex-tertiary-reset-at"),
      ].filter(Boolean);
      // Build the alternate COMPLETELY before cancelling the first body: if construction
      // throws, the first rejection is still intact and can be returned to the client.
      const alternate = await resolveAlternateCompactContext({
        req,
        config,
        route,
        selectedModelId,
        excludeAccountId: authCtx.accountId,
        turnAdmissionLease,
      });
      // Resolution can await a credential refresh, so the client may have gone away
      // while we were choosing B. Re-check before spending anything: recording A,
      // cancelling its body, and sending B are all observable side effects, and B's
      // quota is not ours to spend on a request nobody is waiting for.
      if (alternate && req.signal.aborted) {
        releaseCodexAuthContextProbeLease(alternate.authCtx);
        recordCompactPoolOutcome(outcomeCtx, 499);
        return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
      }
      if (alternate) {
        // Same order the regular path uses (core.ts:349-357): a 429/402 carries the
        // quota snapshot that produced it, so refresh A's cache before recording its
        // rejection. Skipping this leaves quota-strategy routing and the dashboard
        // reading numbers from before the account ran out.
        if (authCtx.kind === "pool" || authCtx.kind === "main-pool") {
          const { applyAccountQuotaFromUpstreamHeaders } = await import("../../codex/auth-api");
          applyAccountQuotaFromUpstreamHeaders(
            authCtx.accountId,
            upstream.headers,
            authCtx.writerGeneration,
          );
        }
        recordCompactPoolOutcome(authCtx, upstream.status, {
          retryAfter: firstRetryAfter,
          resetAt: firstResetAt,
          ...(alternate.authCtx.accountId ? { promoteAccountId: alternate.authCtx.accountId } : {}),
        });
        await upstream.body?.cancel().catch(() => undefined);
        outcomeCtx = alternate.authCtx;
        logCtx.accountLogLabel = codexAuthContextLogLabel(alternate.authCtx, config);
        try {
          upstream = await sendCompactAttempt(alternate.provider, alternate.headers, "single");
        } catch (err) {
          if (req.signal.aborted) {
            recordCompactPoolOutcome(outcomeCtx, 499);
            return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
          }
          const outcome = classifyTransportFailureKind(err);
          // Host-level evidence stands regardless of pool membership (#914 review).
          if (outcome === "connect_neutral") {
            if (compactHostCircuitEnabled) {
              recordUpstreamHostFailure(actualCompactHostKey, {
                code: transportErrorCode(err),
                threshold: config.upstreamHostCircuitThreshold,
                lease: compactHostAdmissionLease,
              });
            } else {
              recordUpstreamHostFailure(actualCompactHostKey, { code: transportErrorCode(err) });
            }
          } else {
            releaseUpstreamHostAdmission(compactHostAdmissionLease);
          }
          compactHostAdmissionLease = null;
          recordCompactPoolOutcome(outcomeCtx, outcome);
          return formatErrorResponse(502, "upstream_error", "Failed to connect to compact upstream");
        }
      }
    }
    const retryAfter = upstream.headers.get("retry-after");
    const resetAt = [
      upstream.headers.get("x-codex-primary-reset-at"),
      upstream.headers.get("x-codex-secondary-reset-at"),
      upstream.headers.get("x-codex-tertiary-reset-at"),
    ].filter(Boolean);
    const buffered = await bufferCompactResponse(upstream, req.signal);
    // Record pool health only after the body is fully delivered (or definitively failed).
    // A premature 200 would clear soft-avoid while the client still sees a buffer 502.
    if (buffered.status === 499) {
      recordCompactPoolOutcome(outcomeCtx, 499);
      return buffered;
    }
    // Always record the real upstream status: a local buffering failure after a
    // 200 upstream response must not soft-avoid a healthy account or rotate a thread.
    recordCompactPoolOutcome(outcomeCtx, upstream.status, { retryAfter, resetAt });
    // Lift usage and response metadata from the buffered upstream JSON into the
    // request log; the routed branch gets the same through handleResponses. The
    // synthetic buffer errors are not upstream bodies and stay uninspected.
    if (buffered.ok) inspectResponseLogJson(logCtx, await buffered.clone().text());
    return buffered;
    } finally {
      releaseUpstreamHostAdmission(compactHostAdmissionLease);
      releaseCodexAuthContextProbeLease(authCtx);
    }
  }

  // ROUTED model: run the v2 synthetic-compaction turn internally (appends COMPACT_PROMPT, no
  // tools) and decode the resulting ocx1 envelope into plain v1 replacement-history items.
  const inputItems = Array.isArray(raw.input) ? (raw.input as unknown[]) : [];
  const internalBody = {
    ...raw,
    // Canonical ChatGPT Responses rejects non-streaming turns. Daybreak cannot use the
    // native compact endpoint either, so run its synthetic compaction as SSE and collapse
    // the completed event back into the v1 compact JSON contract below.
    stream: accountGatedCompactWireModel ? true : false,
    input: [...inputItems, { type: "compaction_trigger" }],
  };
  const internalHeaders = new Headers({ "content-type": "application/json" });
  for (const name of FORWARD_HEADERS) {
    const value = req.headers.get(name);
    if (value) internalHeaders.set(name, value);
  }
  const internalReq = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: internalHeaders,
    body: JSON.stringify(internalBody),
  });
  const response = await handleResponses(internalReq, config, logCtx, { abortSignal: req.signal, turnAdmissionLease, ...(admission ? { admission } : {}) });
  if (!response.ok) return response;
  let json: { output?: unknown[]; status?: unknown; error?: unknown };
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    if (!response.body) {
      return formatErrorResponse(502, "server_error", "compaction turn returned an empty event stream");
    }
    const terminal = { status: "incomplete" as "completed" | "failed" | "incomplete" };
    let completed: { id?: unknown; output?: unknown; status?: unknown } | undefined;
    await new Promise<void>(resolve => {
      consumeForInspection(
        response.body!,
        status => { terminal.status = status; },
        req.signal,
        resolve,
        undefined,
        undefined,
        value => { completed = value; },
      );
    });
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
    }
    if (terminal.status !== "completed" || !completed) {
      return formatErrorResponse(502, "upstream_error", `compaction turn did not complete (status: ${terminal.status})`);
    }
    json = completed as { output?: unknown[]; status?: unknown; error?: unknown };
  } else {
    try {
      json = await response.json() as { output?: unknown[]; status?: unknown; error?: unknown };
    } catch {
      return formatErrorResponse(502, "server_error", "compaction turn returned a non-JSON response");
    }
  }
  // The internal turn answers 200 even when it failed or was truncated, so the body
  // has to be inspected. Reporting a failure beats installing "(no summary
  // available)" as replacement history and silently losing the conversation (#422).
  if (json.error) {
    const message = typeof json.error === "string"
      ? json.error
      : (json.error as { message?: unknown })?.message;
    return formatErrorResponse(502, "upstream_error", typeof message === "string" ? message : "compaction turn failed");
  }
  if (json.status !== "completed") {
    return formatErrorResponse(
      502,
      "upstream_error",
      `compaction turn did not complete (status: ${String(json.status ?? "unknown")})`,
    );
  }
  const compactionItems = (json.output ?? []).filter(
    (item): item is { type: string; encrypted_content?: string } =>
      !!item && typeof item === "object" && (item as { type?: string }).type === "compaction",
  );
  if (compactionItems.length !== 1) {
    return formatErrorResponse(
      502,
      "invalid_response_error",
      `compaction turn produced ${compactionItems.length} compaction items, expected exactly 1`,
    );
  }
  // The canonical Responses stream returns a real OpenAI-encrypted compaction item. OCX cannot
  // and should not decrypt it; /responses/compact callers can consume that item directly.
  if (accountGatedCompactWireModel) {
    return new Response(JSON.stringify({ output: compactionItems }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  const encrypted = compactionItems[0]!.encrypted_content;
  const decoded = typeof encrypted === "string" ? decodeCompactionSummary(encrypted) : null;
  // An empty `ocx1:` envelope decodes to "" rather than null, so length is what matters.
  if (decoded === null || decoded.trim().length === 0) {
    return formatErrorResponse(502, "invalid_response_error", "compaction turn produced an empty summary");
  }
  const summary = decoded;
  const output = buildCompactV1Output(extractCompactUserMessages(inputItems), summary);
  return new Response(JSON.stringify({ output }), { headers: { "Content-Type": "application/json" } });
}
