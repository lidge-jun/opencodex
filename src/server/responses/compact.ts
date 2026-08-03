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
import { routeModel } from "../../router";
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
  cooldownErrorResponse,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
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
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "../auth-cors";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar, type ResolvedOpenAiForwardSidecar } from "../../providers/openai-sidecar";
import { isCanonicalOpenAiForwardProvider, supportsNativeResponsesCompactEndpoint } from "../../providers/openai-tiers";
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

import { decodeRequestErrorResponse, handleResponses, usesCodexForwardPoolAuth } from "./core";
import { fetchWithHeaderTimeout, providerFetch, safeHostLabel } from "./fetch-helpers";

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
}): Promise<{ authCtx: CodexAuthContext; provider: OcxProviderConfig; headers: Headers } | null> {
  const { req, config, route, selectedModelId, excludeAccountId } = args;
  if (!route.codexAccountMode || !excludeAccountId) return null;
  try {
    const authCtx = await resolveCodexAuthContext(req.headers, config, route.codexAccountMode, {
      ...(selectedModelId ? { modelId: selectedModelId } : {}),
      excludeAccountId,
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
  } catch {
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
    route = routeModel(config, raw.model);
  } catch (err) {
    return formatErrorResponse(404, "invalid_request_error", err instanceof Error ? err.message : String(err));
  }
  const selectedModelId = route.modelId;
  logCtx.requestedModel = raw.model;
  logCtx.model = selectedModelId;
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

  if (route.codexAccountMode === "direct") {
    try { validateForwardAdmissionCredential(req.headers, config); }
    catch (err) {
      if (err instanceof ForwardAdmissionCredentialError) return formatErrorResponse(401, "authentication_error", err.message);
      throw err;
    }
  }

  // Native /responses/compact exists on the canonical ChatGPT backend and on the
  // official OpenAI API. Any other Responses-shaped gateway must take the routed
  // summarizer path below, or compaction fails against an endpoint it never had (#422).
  if (supportsNativeResponsesCompactEndpoint(route.providerName, route.provider)) {
    // Native ChatGPT/OpenAI model: forward the compact request verbatim to the real backend.
    // Resolve the SAME pool/thread auth context as /v1/responses — forwarding the caller's raw
    // headers would run compaction on the wrong account (or 401) whenever a pool account is
    // active for this thread while normal turns succeed.
    let compactProvider = route.provider;
    let authCtx: CodexAuthContext = { kind: "main", accountId: null };
    const headers = new Headers({ "content-type": "application/json" });
    try {
      if (route.codexAccountMode) {
        authCtx = await resolveCodexAuthContext(req.headers, config, route.codexAccountMode, {
          accountId: route.codexAccountId,
          modelId: selectedModelId,
        });
        const selected = headersForCodexAuthContext(req.headers, authCtx);
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
    const base = (compactProvider.baseUrl ?? "").replace(/\/$/, "");
    if (compactProvider.authMode !== "forward" && compactProvider.apiKey) {
      headers.set("authorization", `Bearer ${resolveEnvValue(compactProvider.apiKey)}`);
    }
    const { reasoning: _reasoning, ...compactBodyRaw } = raw as typeof raw & { reasoning?: unknown };
    // The regular /v1/responses path applies sanitizeReasoningInputContent via the adapter's
    // buildRequest, but the compact endpoint forwards directly. Apply the same sanitizer here
    // so routed-model reasoning items (reasoning_text content) don't 400 the ChatGPT backend.
    const compactBody = sanitizeReasoningInputContent(compactBodyRaw) as typeof compactBodyRaw;
    const compactUrl = `${base}/responses/compact`;
    const compactThreadId = req.headers.get("x-codex-parent-thread-id");
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
        threadId: compactThreadId,
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
        providerFetch(sendProvider),
      );
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
      const outcome = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "connect_error";
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
        try {
          upstream = await sendCompactAttempt(alternate.provider, alternate.headers, "single");
        } catch (err) {
          if (req.signal.aborted) {
            recordCompactPoolOutcome(outcomeCtx, 499);
            return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
          }
          const outcome = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "connect_error";
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
    return buffered;
  }

  // ROUTED model: run the v2 synthetic-compaction turn internally (appends COMPACT_PROMPT, no
  // tools) and decode the resulting ocx1 envelope into plain v1 replacement-history items.
  const inputItems = Array.isArray(raw.input) ? (raw.input as unknown[]) : [];
  const internalBody = {
    ...raw,
    stream: false,
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
  const response = await handleResponses(internalReq, config, logCtx, { abortSignal: req.signal });
  if (!response.ok) return response;
  let json: { output?: unknown[]; status?: unknown; error?: unknown };
  try {
    json = await response.json() as { output?: unknown[]; status?: unknown; error?: unknown };
  } catch {
    return formatErrorResponse(502, "server_error", "compaction turn returned a non-JSON response");
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
