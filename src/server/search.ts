/**
 * /v1/alpha/search relay.
 *
 * codex-rs's built-in search client executes CLIENT-SIDE: it POSTs `alpha/search` against the
 * configured base_url with the same ChatGPT bearer auth used for model requests. Under Design B
 * injection base_url is this proxy, so the request otherwise dies on the /v1/* JSON-404 guard.
 * The endpoint is private to the ChatGPT Codex backend, so the honest answer while a forward
 * provider is configured is to copy bytes. When none is, a configured web-search sidecar
 * (anthropic / xai / gemini / exa) can still answer — see src/web-search/alpha-search.ts.
 * That fallback never runs while a forward candidate exists, and never borrows a different
 * paid backend than the one the operator named.
 */
import { formatErrorResponse } from "../bridge";
import {
  CodexAccountCooldownError,
  codexMainProfileDrainingResponse,
  cooldownErrorResponse,
  CodexAuthContextError,
  CodexMainProfileDrainingError,
  CodexModelAvailabilityError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
} from "../codex/auth-context";
import { codexAccountNamespaceForModel } from "../codex/account-namespace-match";
import { NATIVE_RESERVE_MODEL } from "../codex/catalog/native-models";
import { isCodexReserveRequestEligible } from "../codex/loopback-target";
import type { DataPlaneAdmission } from "./auth-cors";
import {
  admissionScopeDenial,
} from "./admission-model-scope";
import { formatCodexProviderForLog } from "../codex/routing";
import { signalWithTimeout } from "../lib/abort";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { sidecarEnter } from "../lib/sidecar-tracker";
import type { OcxConfig } from "../types";
import {
  listOpenAiForwardSidecarCandidates,
  resolveFirstUsableOpenAiSidecar,
  type ExactOpenAiSidecarAccount,
} from "../providers/openai-sidecar";
import { previewRouteModel, routeModel } from "../router";
import { handleAlphaSearchSidecarFallback, handleDevinAlphaSearch } from "../web-search/alpha-search";
import { readJsonRequestBody, resolveInboundBodyLimitBytes } from "./request-decompress";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "./auth-cors";
import type { RequestLogContext } from "./request-log";
import { codexLogAccountId, decodeRequestErrorResponse } from "./responses";
import type { AdmissionLease } from "../lib/admission";
import { codexAccountSelectionForTurn } from "./lifecycle";
import { codexModelAvailabilityErrorResponse } from "./responses/codex-auth-error";

/**
 * Default TOTAL deadline for one search relay. alpha/search is non-streaming JSON — response
 * headers arrive only when the search finishes — so the budget must cover the whole request.
 * Overridable via config.search.timeoutMs; never config.connectTimeoutMs, whose documented
 * contract is the DNS/TCP/TLS/header-arrival budget (a 10s connect budget would kill every
 * long-running search).
 */
const SEARCH_UPSTREAM_TIMEOUT_MS = 200_000;
export const SEARCH_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

export async function handleSearch(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  turnAdmissionLease?: AdmissionLease,
  admission?: DataPlaneAdmission,
): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req, undefined, resolveInboundBodyLimitBytes(config.maxInboundBodyBytes));
  } catch (err) {
    return decodeRequestErrorResponse(err, "search");
  }
  const model = (body as { model?: unknown } | null)?.model;
  if (typeof model === "string" && model) logCtx.model = model;

  if (typeof model === "string" && model.trim()) {
    try {
      const route = previewRouteModel(config, model);
      if (route.providerName === "devin" || route.staticPolicy.model.adapter === "devin") {
        const denial = admissionScopeDenial(config, admission, model, route);
        if (denial) return denial;
        logCtx.provider = route.providerName;
        logCtx.routeDecision = route.routeDecision;
        return handleDevinAlphaSearch(
          body,
          route.providerName,
          config.search?.timeoutMs ?? SEARCH_UPSTREAM_TIMEOUT_MS,
          req.signal,
        );
      }
    } catch {
      // Preview is advisory: existing relay/fallback still owns unsupported or unroutable models.
    }
  }

  try { validateForwardAdmissionCredential(req.headers, config); }
  catch (err) {
    if (err instanceof ForwardAdmissionCredentialError) return formatErrorResponse(401, "authentication_error", err.message);
    throw err;
  }

  let exactAccount: ExactOpenAiSidecarAccount | undefined;
  let relayBody = body;
  const accountNamespace = typeof model === "string"
    ? codexAccountNamespaceForModel(config.codexAccountNamespaces, model)
    : undefined;
  if (accountNamespace && typeof model === "string") {
    try {
      const route = routeModel(config, model);
      if (!route.codexAccountId || route.codexAccountNamespace !== accountNamespace) {
        return formatErrorResponse(400, "invalid_request_error", "Invalid Codex account-qualified search model");
      }
      // This branch resolves a model through the router and bills the account it
      // names, so a scoped key is held to the same destination rule it is held
      // to on the inference path.
      const denial = admissionScopeDenial(config, admission, model, route);
      if (denial) return denial;
      exactAccount = { accountId: route.codexAccountId, modelId: route.modelId };
      logCtx.provider = `${route.providerName}-${accountNamespace}`;
      logCtx.routeDecision = route.routeDecision;
      // The ChatGPT search endpoint only understands the native model slug. The
      // account namespace is proxy routing syntax and must not cross the wire.
      relayBody = { ...(body as Record<string, unknown>), model: route.modelId };
    } catch (err) {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        err instanceof Error ? err.message : "Invalid Codex account-qualified search model",
      );
    }
  }

  if (isCodexReserveRequestEligible(config, admission) && (exactAccount?.modelId ?? model) === NATIVE_RESERVE_MODEL) {
    return formatErrorResponse(400, "invalid_request_error",
      "Luna Reserve compatibility is only available as a conversation model, not the standalone search relay. Choose another search model.");
  }
  const candidates = listOpenAiForwardSidecarCandidates(config);
  if (candidates.length === 0) {
    return handleAlphaSearchSidecarFallback(body, config, req.signal, logCtx, admission);
  }

  let upstream: Awaited<ReturnType<typeof resolveFirstUsableOpenAiSidecar>>;
  try {
    upstream = await resolveFirstUsableOpenAiSidecar(candidates, req.headers, config, {
      exactAccount,
      admission,
      beginCodexAccountSelection: codexAccountSelectionForTurn(turnAdmissionLease),
    });
    if (!upstream) {
      return formatErrorResponse(
        401,
        "authentication_error",
        "web search relay needs ChatGPT auth (Authorization header)",
      );
    }
    logCtx.provider = accountNamespace
      ? `${upstream.providerName}-${accountNamespace}`
      : formatCodexProviderForLog(upstream.providerName, codexLogAccountId(upstream.authContext), config);
  } catch (err) {
    if (err instanceof CodexAccountCooldownError) {
      return cooldownErrorResponse(err, Date.now(), accountNamespace);
    }
    if (err instanceof CodexMainProfileDrainingError) return codexMainProfileDrainingResponse();
    if (err instanceof CodexThreadAffinityExpiredError) {
      return formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
    }
    if (err instanceof CodexAuthContextError) {
      const safeAccountLabel = accountNamespace
        ? `openai-${accountNamespace}`
        : formatCodexProviderForLog("openai", err.accountId, config);
      console.error(`[search] Pool account ${safeAccountLabel} token failed; reauthentication required`);
      return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
    }
    if (err instanceof CodexModelAvailabilityError) return codexModelAvailabilityErrorResponse(err);
    if (err instanceof CodexPoolAuthenticationError) return formatErrorResponse(401, "authentication_error", err.message);
    throw err;
  }

  if (!accountNamespace) {
    // An unqualified search model is never routed: the caller's own string is
    // relayed to whichever ChatGPT account this upstream resolved to, and that
    // account is billed for it. The qualified branch above was already judged
    // against the route it resolved, so it is not judged twice here.
    const searchModel = typeof model === "string" && model.trim() ? model : undefined;
    const denial = admissionScopeDenial(config, admission, searchModel, {
      providerName: upstream.providerName,
      modelId: searchModel,
    });
    if (denial) {
      upstream.releaseProbeLease?.();
      return denial;
    }
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (upstream.provider.headers) Object.assign(headers, upstream.provider.headers);
  for (const [name, value] of upstream.headers) headers[name] = value;
  const url = `${upstream.provider.baseUrl}/alpha/search`;
  const timeoutMs = config.search?.timeoutMs ?? SEARCH_UPSTREAM_TIMEOUT_MS;
  const linkedSignal = signalWithTimeout(timeoutMs, req.signal);
  const sidecarExit = sidecarEnter("search");
  let upstreamResponse: Response | undefined;
  try {
    upstreamResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(relayBody),
      signal: linkedSignal.signal,
      // Credential-bearing: do not follow a cross-origin 3xx. Bun strips `Authorization`
      // across origins but forwards nonstandard headers such as `chatgpt-account-id`,
      // `session_id`, and `x-codex-turn-metadata` to the redirect target.
      redirect: "manual",
    });
    const observed = await readBoundedResponseBytes(upstreamResponse, {
      maxBytes: SEARCH_RESPONSE_MAX_BYTES,
      signal: linkedSignal.signal,
    });
    if (observed.oversized) {
      upstream.recordOutcome?.(upstreamResponse.status);
      return formatErrorResponse(
        502,
        "upstream_error",
        `search response too large (exceeded ${SEARCH_RESPONSE_MAX_BYTES} bytes)`,
      );
    }
    upstream.recordOutcome?.(upstreamResponse.status);
    const relayHeaders: Record<string, string> = {};
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) relayHeaders["content-type"] = contentType;
    return new Response(observed.bytes, { status: upstreamResponse.status, headers: relayHeaders });
  } catch (err) {
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", "search request canceled by client");
    }
    if (linkedSignal.signal.aborted || (err instanceof Error && err.name === "TimeoutError")) {
      upstream.recordOutcome?.("timeout");
      return formatErrorResponse(504, "upstream_error", "search upstream timed out");
    }
    upstream.recordOutcome?.("connect_error");
    return formatErrorResponse(
      502,
      "upstream_error",
      `search relay failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
    // A response that aborted before the reader attached still owns its upstream socket.
    // Consumed/cancelled bodies are already closed; locked bodies remain owned by the reader.
    const pendingBody = upstreamResponse?.body;
    if (pendingBody && !pendingBody.locked) {
      try { void pendingBody.cancel().catch(() => undefined); } catch { /* already closed */ }
    }
  }
}
