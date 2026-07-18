/**
 * /v1/alpha/search relay.
 *
 * codex-rs's built-in search client executes CLIENT-SIDE: it POSTs `alpha/search` against the
 * configured base_url with the same ChatGPT bearer auth used for model requests. Under Design B
 * injection base_url is this proxy, so the request otherwise dies on the /v1/* JSON-404 guard.
 * The endpoint is private to the ChatGPT Codex backend, so routed providers and OpenAI API-key
 * providers cannot serve it. Relay the JSON request and response verbatim through the configured
 * ChatGPT forward provider.
 */
import { formatErrorResponse } from "../bridge";
import {
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
} from "../codex/auth-context";
import { formatCodexProviderForLog } from "../codex/routing";
import { signalWithTimeout } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import type { OcxConfig } from "../types";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar } from "../providers/openai-sidecar";
import { readJsonRequestBody } from "./request-decompress";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "./auth-cors";
import type { RequestLogContext } from "./request-log";
import { codexLogAccountId, decodeRequestErrorResponse } from "./responses";

/**
 * Default TOTAL deadline for one search relay. alpha/search is non-streaming JSON — response
 * headers arrive only when the search finishes — so the budget must cover the whole request.
 * Overridable via config.search.timeoutMs; never config.connectTimeoutMs, whose documented
 * contract is the DNS/TCP/TLS/header-arrival budget (a 10s connect budget would kill every
 * long-running search).
 */
const SEARCH_UPSTREAM_TIMEOUT_MS = 200_000;
const SEARCH_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

export async function handleSearch(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
): Promise<Response> {
  try { validateForwardAdmissionCredential(req.headers, config); }
  catch (err) {
    if (err instanceof ForwardAdmissionCredentialError) return formatErrorResponse(401, "authentication_error", err.message);
    throw err;
  }
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    return decodeRequestErrorResponse(err, "search");
  }
  const model = (body as { model?: unknown } | null)?.model;
  if (typeof model === "string" && model) logCtx.model = model;

  const candidates = listOpenAiForwardSidecarCandidates(config);
  if (candidates.length === 0) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Built-in web search needs a ChatGPT forward provider, but none is configured in opencodex. "
      + "Routed and OpenAI API-key providers cannot serve /v1/alpha/search.",
    );
  }

  let upstream: Awaited<ReturnType<typeof resolveFirstUsableOpenAiSidecar>>;
  try {
    upstream = await resolveFirstUsableOpenAiSidecar(candidates, req.headers, config);
    if (!upstream) {
      return formatErrorResponse(
        401,
        "authentication_error",
        "web search relay needs ChatGPT auth (Authorization header)",
      );
    }
    logCtx.provider = formatCodexProviderForLog(upstream.providerName, codexLogAccountId(upstream.authContext), config);
  } catch (err) {
    if (err instanceof CodexAccountCooldownError) {
      return formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down");
    }
    if (err instanceof CodexThreadAffinityExpiredError) {
      return formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
    }
    if (err instanceof CodexAuthContextError) {
      const safeAccountLabel = formatCodexProviderForLog("openai", err.accountId, config);
      console.error(`[search] Pool account ${safeAccountLabel} token failed; reauthentication required`);
      return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
    }
    if (err instanceof CodexPoolAuthenticationError) return formatErrorResponse(401, "authentication_error", err.message);
    throw err;
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (upstream.provider.headers) Object.assign(headers, upstream.provider.headers);
  for (const [name, value] of upstream.headers) headers[name] = value;
  const url = `${upstream.provider.baseUrl}/alpha/search`;
  const timeoutMs = config.search?.timeoutMs ?? SEARCH_UPSTREAM_TIMEOUT_MS;
  const linkedSignal = signalWithTimeout(timeoutMs, req.signal);
  const sidecarExit = sidecarEnter("search");
  try {
    const upstreamResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: linkedSignal.signal,
    });
    const payload = await upstreamResponse.arrayBuffer();
    if (payload.byteLength > SEARCH_RESPONSE_MAX_BYTES) {
      return formatErrorResponse(502, "upstream_error", `search response too large (${payload.byteLength} bytes)`);
    }
    upstream.recordOutcome?.(upstreamResponse.status);
    const relayHeaders: Record<string, string> = {};
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) relayHeaders["content-type"] = contentType;
    return new Response(payload, { status: upstreamResponse.status, headers: relayHeaders });
  } catch (err) {
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", "search request canceled by client");
    }
    if (err instanceof Error && err.name === "TimeoutError") {
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
  }
}
