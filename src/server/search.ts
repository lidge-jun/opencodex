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
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
} from "../codex/auth-context";
import { formatCodexProviderForLog } from "../codex/routing";
import { signalWithTimeout } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { isProxyAdmissionSecret } from "./auth-cors";
import { readJsonRequestBody } from "./request-decompress";
import type { RequestLogContext } from "./request-log";
import { codexLogAccountId, decodeRequestErrorResponse, sidecarOutcomeRecorder } from "./responses";

const SEARCH_UPSTREAM_TIMEOUT_MS = 200_000;
const SEARCH_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

interface NamedProvider {
  name: string;
  provider: OcxProviderConfig;
}

function findSearchUpstream(config: OcxConfig): NamedProvider | undefined {
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.disabled !== true && provider.authMode === "forward") return { name, provider };
  }
  return undefined;
}

export async function handleSearch(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    return decodeRequestErrorResponse(err, "search");
  }
  const model = (body as { model?: unknown } | null)?.model;
  if (typeof model === "string" && model) logCtx.model = model;

  const upstream = findSearchUpstream(config);
  if (!upstream) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Built-in web search needs a ChatGPT forward provider, but none is configured in opencodex. "
      + "Routed and OpenAI API-key providers cannot serve /v1/alpha/search.",
    );
  }

  let authHeaders: Headers;
  let recordOutcome: ReturnType<typeof sidecarOutcomeRecorder>;
  try {
    const authCtx = await resolveCodexAuthContext(req.headers, config);
    if (!isCodexAuthContextUsable(authCtx, config)) {
      return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
    }
    authHeaders = headersForCodexAuthContext(req.headers, authCtx);
    const bearer = authHeaders.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (bearer && isProxyAdmissionSecret(bearer, config)) authHeaders.delete("authorization");
    if (!authHeaders.get("authorization")) {
      return formatErrorResponse(
        401,
        "authentication_error",
        "web search relay needs ChatGPT auth (Authorization header)",
      );
    }
    recordOutcome = sidecarOutcomeRecorder(config, authCtx);
    logCtx.provider = formatCodexProviderForLog(upstream.name, codexLogAccountId(authCtx), config);
  } catch (err) {
    if (err instanceof CodexAccountCooldownError) {
      return formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down");
    }
    if (err instanceof CodexThreadAffinityExpiredError) {
      return formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
    }
    if (err instanceof CodexAuthContextError) {
      const safeAccountLabel = formatCodexProviderForLog(upstream.name, err.accountId, config);
      console.error(`[search] Pool account ${safeAccountLabel} token failed; reauthentication required`);
      return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
    }
    throw err;
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (upstream.provider.headers) Object.assign(headers, upstream.provider.headers);
  for (const [name, value] of authHeaders) headers[name] = value;
  const url = `${upstream.provider.baseUrl}/alpha/search`;
  const timeoutMs = config.connectTimeoutMs ?? SEARCH_UPSTREAM_TIMEOUT_MS;
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
    recordOutcome?.(upstreamResponse.status);
    const relayHeaders: Record<string, string> = {};
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) relayHeaders["content-type"] = contentType;
    return new Response(payload, { status: upstreamResponse.status, headers: relayHeaders });
  } catch (err) {
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", "search request canceled by client");
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      recordOutcome?.("timeout");
      return formatErrorResponse(504, "upstream_error", "search upstream timed out");
    }
    recordOutcome?.("connect_error");
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
