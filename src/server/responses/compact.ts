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
  type CodexAuthContext,
} from "../../codex/auth-context";
import {
  formatCodexProviderForLog,
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "../../codex/routing";
import { fetchWithResetRetry, fetchWithTransientRetry, applyUpstreamRecoveryInit } from "../../lib/upstream-retry";
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



export async function bufferCompactResponse(upstream: Response, signal: AbortSignal): Promise<Response> {
  const reader = upstream.body?.getReader();
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  if (!reader) return new Response(null, { status: upstream.status, headers: { "Content-Type": contentType } });
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
  return new Response(body, { status: upstream.status, headers: { "Content-Type": contentType } });
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
  logCtx.provider = route.providerName;
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
        authCtx = await resolveCodexAuthContext(req.headers, config, route.codexAccountMode, { modelId: selectedModelId });
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
        return cooldownErrorResponse(err);
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
    if (compactProvider.apiKey) headers.set("authorization", `Bearer ${resolveEnvValue(compactProvider.apiKey)}`);
    const { reasoning: _reasoning, ...compactBodyRaw } = raw as typeof raw & { reasoning?: unknown };
    // The regular /v1/responses path applies sanitizeReasoningInputContent via the adapter's
    // buildRequest, but the compact endpoint forwards directly. Apply the same sanitizer here
    // so routed-model reasoning items (reasoning_text content) don't 400 the ChatGPT backend.
    const compactBody = sanitizeReasoningInputContent(compactBodyRaw) as typeof compactBodyRaw;
    const compactUrl = `${base}/responses/compact`;
    const compactThreadId = req.headers.get("x-codex-parent-thread-id");
    const connectMs = config.connectTimeoutMs ?? 200_000;
    const recordCompactPoolOutcome = (
      outcome: CodexUpstreamOutcome,
      meta: { retryAfter?: string | null; resetAt?: unknown | unknown[] } = {},
    ) => {
      if (!usesCodexForwardPoolAuth(authCtx, route.provider)) return;
      recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, {
        ...meta,
        threadId: compactThreadId,
        modelId: selectedModelId,
        probeLeaseId: codexProbeLeaseId(authCtx),
        probeQuotaScope: codexProbeQuotaScope(authCtx),
        writerGeneration: authCtx.kind === "pool" || authCtx.kind === "main-pool"
          ? authCtx.writerGeneration
          : undefined,
      });
    };
    let upstream: Response;
    try {
      // Same connect timeout + keep-alive reset + transient-5xx recovery as /v1/responses —
      // compact hits the same ChatGPT host and must soft-avoid / clear affinity (#186).
      upstream = await fetchWithTransientRetry(
        recovery => fetchWithHeaderTimeout(
          compactUrl,
          applyUpstreamRecoveryInit({
            method: "POST",
            headers,
            body: JSON.stringify({ ...compactBody, model: route.modelId }),
          }, recovery),
          req.signal,
          connectMs,
          false,
          providerFetch(compactProvider),
        ),
        { abortSignal: req.signal, label: safeHostLabel(compactUrl) },
      );
    } catch (err) {
      if (req.signal.aborted) {
        recordCompactPoolOutcome(499);
        return formatErrorResponse(499, "client_cancelled", "Client cancelled compact request");
      }
      const outcome = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "connect_error";
      recordCompactPoolOutcome(outcome);
      return formatErrorResponse(502, "upstream_error", "Failed to connect to compact upstream");
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
      recordCompactPoolOutcome(499);
      return buffered;
    }
    // Always record the real upstream status: a local buffering failure after a
    // 200 upstream response must not soft-avoid a healthy account or rotate a thread.
    recordCompactPoolOutcome(upstream.status, { retryAfter, resetAt });
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
