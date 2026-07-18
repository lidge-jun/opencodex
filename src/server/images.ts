/**
 * /v1/images/{generations,edits} relay (issue #83).
 *
 * codex-rs's standalone image_gen extension executes CLIENT-SIDE: it POSTs
 * `{base_url}/images/generations` (edits when reference images are attached) with the same
 * ChatGPT bearer auth it uses for chat. Under Design B injection base_url IS this proxy, so
 * without a route the tool died on the /v1/* JSON-404 guard. Only an OpenAI-family upstream
 * can serve these endpoints — routed providers (Cursor, Kiro, Gemini, …) have no image
 * generation surface — so the handler relays the body verbatim to the ChatGPT forward
 * provider (or an OpenAI API-key provider) and passes the response through untouched:
 * codex's images client parses `{created, data:[{b64_json}]}` strictly and Debug-prints
 * error bodies into the model-visible failure, so upstream errors must stay legible.
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
import { resolveFirstUsableOpenAiSidecar, selectOpenAiImagesProvider } from "../providers/openai-sidecar";
import { readJsonRequestBody } from "./request-decompress";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "./auth-cors";
import type { RequestLogContext } from "./request-log";
import { codexLogAccountId, decodeRequestErrorResponse } from "./responses";

export type ImagesEndpoint = "generations" | "edits";

/** Image generation is slow (tens of seconds); bound a hung upstream, not a working one. */
const IMAGES_UPSTREAM_TIMEOUT_MS = 300_000;

/**
 * Cap for the buffered upstream response body (100 MiB). Images responses are JSON documents
 * containing base64-encoded images — typically a few MB. This prevents an oversized or malicious
 * response from exhausting process memory.
 */
const IMAGES_RESPONSE_MAX_BYTES = 100 * 1024 * 1024;

export async function handleImages(
  req: Request,
  config: OcxConfig,
  endpoint: ImagesEndpoint,
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
    return decodeRequestErrorResponse(err, "images");
  }
  const model = (body as { model?: unknown } | null)?.model;
  if (typeof model === "string" && model) logCtx.model = model;

  const candidates = selectOpenAiImagesProvider(config);
  if (candidates.forwardCandidates.length === 0 && !candidates.keyed) {
    // 400, not 5xx: codex retries every 5xx up to 5 total attempts, and this is a permanent
    // configuration state that must surface on the first attempt.
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Built-in image generation needs an OpenAI upstream (ChatGPT login or an OpenAI API-key provider), "
      + "but none is configured in opencodex. Routed providers cannot serve /v1/images/* — "
      + "add an OpenAI provider or disable the tool with `codex features disable image_generation`.",
    );
  }

  // Resolve forward auth first; failures are captured, not returned, so a configured keyed
  // provider can still serve the request (e.g. every pool account cooling down must not
  // 429 image_gen while api.openai.com sits idle).
  let forward: Awaited<ReturnType<typeof resolveFirstUsableOpenAiSidecar>>;
  let forwardAuthError: Response | undefined;
  if (candidates.forwardCandidates.length > 0) {
    try {
      forward = await resolveFirstUsableOpenAiSidecar(candidates.forwardCandidates, req.headers, config);
      if (forward) logCtx.provider = formatCodexProviderForLog(forward.providerName, codexLogAccountId(forward.authContext), config);
    } catch (err) {
      if (err instanceof CodexAccountCooldownError) {
        forwardAuthError = formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down");
      } else if (err instanceof CodexThreadAffinityExpiredError) {
        forwardAuthError = formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
      } else if (err instanceof CodexAuthContextError) {
        const safeAccountLabel = formatCodexProviderForLog("openai", err.accountId, config);
        console.error(`[images] Pool account ${safeAccountLabel} token failed; reauthentication required`);
        forwardAuthError = formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
      } else if (err instanceof CodexPoolAuthenticationError) {
        forwardAuthError = formatErrorResponse(401, "authentication_error", err.message);
      } else {
        throw err;
      }
    }
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  let url: string;
  if (forward) {
    const { provider } = forward;
    if (provider.headers) Object.assign(headers, provider.headers);
    for (const [name, value] of forward.headers) headers[name] = value;
    // The ChatGPT codex backend takes bare paths (matches the adapter's `${baseUrl}/responses`).
    url = `${provider.baseUrl}/images/${endpoint}`;
  } else if (forwardAuthError) {
    // A configured OpenAI pool mode owns its authentication failure. Do not hide a
    // broken/expired pool behind separately billed API-key image generation.
    return forwardAuthError;
  } else if (candidates.keyed) {
    const { provider, apiKey, providerName } = candidates.keyed;
    if (provider.headers) Object.assign(headers, provider.headers);
    headers["authorization"] = `Bearer ${apiKey}`;
    logCtx.provider = providerName;
    // Keyed providers tolerate baseUrl with or without /v1 (mirrors openai-responses.ts).
    url = `${provider.baseUrl.replace(/\/v1\/?$/, "")}/v1/images/${endpoint}`;
  } else {
    return formatErrorResponse(
      401,
      "authentication_error",
      "image generation relay needs ChatGPT auth (Authorization header) or an OpenAI API-key provider",
    );
  }

  const timeoutMs = config.images?.timeoutMs ?? IMAGES_UPSTREAM_TIMEOUT_MS;
  const linkedSignal = signalWithTimeout(timeoutMs, req.signal);
  const sidecarExit = sidecarEnter("images");
  try {
    // Images POSTs create paid, non-idempotent work. One fetch only: no reset retry without a
    // source-proven idempotency contract.
    const upstreamResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: linkedSignal.signal,
    });
    // Buffer rather than stream: the payload is one JSON document (base64 image, typically a few
    // MB), and buffering keeps the timeout window covering the whole exchange. Cap the size to
    // prevent an oversized response from exhausting process memory.
    const payload = await upstreamResponse.arrayBuffer();
    if (payload.byteLength > IMAGES_RESPONSE_MAX_BYTES) {
      return formatErrorResponse(502, "upstream_error", `image ${endpoint} response too large (${payload.byteLength} bytes)`);
    }
    forward?.recordOutcome?.(upstreamResponse.status);
    const relayHeaders: Record<string, string> = {};
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) relayHeaders["content-type"] = contentType;
    return new Response(payload, { status: upstreamResponse.status, headers: relayHeaders });
  } catch (err) {
    // Client cancel first: it aborts the linked signal too, and must not be logged as an
    // upstream failure (499 maps to client_closed_request in the request log).
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", `image ${endpoint} request canceled by client`);
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      forward?.recordOutcome?.("timeout");
      // codex retries 5xx up to 4 more times; a retried 504 is acceptable for a transient hang.
      return formatErrorResponse(504, "upstream_error", `image ${endpoint} upstream timed out`);
    }
    forward?.recordOutcome?.("connect_error");
    return formatErrorResponse(
      502,
      "upstream_error",
      `image ${endpoint} relay failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
