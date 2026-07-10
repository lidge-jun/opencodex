import { formatErrorResponse } from "../bridge";
import {
  applyCodexAuthContextToProvider,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  type CodexAuthContext,
  type OcxRuntimeProviderConfig,
} from "../codex/auth-context";
import { formatCodexProviderForLog, recordCodexUpstreamOutcome } from "../codex/routing";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { MAX_DECOMPRESSED_BODY_BYTES } from "./request-decompress";
import { relayWithAbort, sanitizePassthroughHeaders } from "./relay";
import { registerTurn, trackStreamLifetime, unregisterTurn } from "./lifecycle";
import { fetchWithHeaderTimeout, linkAbortSignal } from "./responses";

export type ImagesOperation = "generations" | "edits";

export interface ImagesForwardProvider {
  name: string;
  provider: OcxProviderConfig;
}

class ImagesRequestBodyTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Images request body exceeds ${MAX_DECOMPRESSED_BODY_BYTES} bytes`);
  }
}

class ImagesUnsupportedContentEncodingError extends Error {
  constructor(readonly encoding: string) {
    super(`Unsupported Images request content-encoding: ${encoding}`);
  }
}

/**
 * Images calls originate from Codex's ChatGPT-authenticated local tool. Never select a key/OAuth
 * provider: doing so would mix credential classes and could send ChatGPT account headers to the
 * wrong upstream. Object-key iteration provides the documented stable final fallback.
 */
export function selectImagesForwardProvider(config: OcxConfig): ImagesForwardProvider | undefined {
  const candidates = [config.defaultProvider, "openai", "chatgpt", ...Object.keys(config.providers)];
  const seen = new Set<string>();
  for (const name of candidates) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const provider = config.providers[name];
    if (
      provider
      && provider.disabled !== true
      && provider.adapter === "openai-responses"
      && provider.authMode === "forward"
    ) {
      return { name, provider };
    }
  }
  return undefined;
}

async function readBoundedImagesBody(req: Request): Promise<ArrayBuffer> {
  const encoding = (req.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (encoding && encoding !== "identity") throw new ImagesUnsupportedContentEncodingError(encoding);

  const declaredRaw = req.headers.get("content-length")?.trim();
  if (declaredRaw && /^\d+$/.test(declaredRaw)) {
    const declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared > MAX_DECOMPRESSED_BODY_BYTES) {
      throw new ImagesRequestBodyTooLargeError(declared);
    }
  }

  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelPending = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const nextTotal = total + value.byteLength;
      if (!Number.isSafeInteger(nextTotal) || nextTotal > MAX_DECOMPRESSED_BODY_BYTES) {
        // Do not release the reader lock before cancel settles: doing so can sever cancellation
        // propagation to the incoming request stream. The 413 response itself must not wait on a
        // potentially slow cancel hook, so release asynchronously after either outcome.
        cancelPending = true;
        void reader.cancel("Images request body too large").then(
          () => { try { reader.releaseLock(); } catch { /* already released */ } },
          () => { try { reader.releaseLock(); } catch { /* already released */ } },
        );
        throw new ImagesRequestBodyTooLargeError(nextTotal);
      }
      chunks.push(value);
      total = nextTotal;
    }
  } finally {
    if (!cancelPending) reader.releaseLock();
  }

  if (chunks.length === 0) return new ArrayBuffer(0);
  const buffer = new ArrayBuffer(total);
  const body = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

function imagesAuthErrorResponse(err: unknown, providerName: string, config: OcxConfig): Response | undefined {
  if (err instanceof CodexAccountCooldownError) {
    return formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down");
  }
  if (err instanceof CodexThreadAffinityExpiredError) {
    return formatErrorResponse(409, "invalid_request_error", "Codex thread account affinity expired; start a new session");
  }
  if (err instanceof CodexAuthContextError) {
    const safeAccountLabel = formatCodexProviderForLog(providerName, err.accountId, config);
    console.error(`[codex-auth] Pool account ${safeAccountLabel} token failed; reauthentication required`);
    return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
  }
  return undefined;
}

function buildImagesHeaders(
  req: Request,
  provider: OcxRuntimeProviderConfig,
  authCtx: CodexAuthContext,
): Headers {
  const headers = new Headers(provider.headers);
  const selected = headersForCodexAuthContext(req.headers, authCtx);
  selected.forEach((value, name) => headers.set(name, value));

  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const version = req.headers.get("version");
  if (version) headers.set("version", version);

  // Keep the runtime pool credential authoritative even if trusted static provider headers happen
  // to carry auth fields. This mirrors the native Responses passthrough adapter's final override.
  const override = provider._codexAccountOverride;
  if (override) {
    headers.set("authorization", `Bearer ${override.accessToken}`);
    headers.set("chatgpt-account-id", override.chatgptAccountId);
  }
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  return headers;
}

function recordImagesPoolOutcome(
  config: OcxConfig,
  authCtx: CodexAuthContext,
  outcome: number | "connect_error" | "timeout",
  response?: Response,
): void {
  if (authCtx.kind !== "pool" && authCtx.kind !== "main-pool") return;
  recordCodexUpstreamOutcome(config, authCtx.accountId, outcome, response ? {
    retryAfter: response.headers.get("retry-after"),
    resetAt: [
      response.headers.get("x-codex-primary-reset-at"),
      response.headers.get("x-codex-secondary-reset-at"),
      response.headers.get("x-codex-tertiary-reset-at"),
    ],
  } : undefined);
}

export async function handleImagesRequest(
  req: Request,
  config: OcxConfig,
  operation: ImagesOperation,
): Promise<Response> {
  const selectedProvider = selectImagesForwardProvider(config);
  if (!selectedProvider) {
    return formatErrorResponse(503, "image_generation_unavailable", "No ChatGPT Images provider is available");
  }

  let authCtx: CodexAuthContext;
  try {
    authCtx = await resolveCodexAuthContext(req.headers, config);
  } catch (err) {
    const response = imagesAuthErrorResponse(err, selectedProvider.name, config);
    if (response) return response;
    throw err;
  }
  if (!isCodexAuthContextUsable(authCtx, config)) {
    return formatErrorResponse(401, "authentication_error", "Selected Codex account needs reauthentication");
  }

  let body: ArrayBuffer;
  try {
    body = await readBoundedImagesBody(req);
  } catch (err) {
    if (err instanceof ImagesUnsupportedContentEncodingError) {
      return formatErrorResponse(415, "invalid_request_error", err.message);
    }
    if (err instanceof ImagesRequestBodyTooLargeError) {
      return formatErrorResponse(413, "invalid_request_error", err.message);
    }
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", "Client closed the request");
    }
    return formatErrorResponse(400, "invalid_request_error", "Unable to read Images request body");
  }

  const provider = applyCodexAuthContextToProvider(selectedProvider.provider, authCtx);
  const headers = buildImagesHeaders(req, provider, authCtx);
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  const upstreamUrl = `${baseUrl}/images/${operation}`;
  const upstream = new AbortController();
  const unlinkRequestAbort = linkAbortSignal(upstream, req.signal);
  const connectMs = config.connectTimeoutMs ?? 200_000;
  registerTurn(upstream);

  let upstreamResponse: Response;
  try {
    // Images POSTs can create paid, non-idempotent work. One fetch only: no reset retry without a
    // source-proven idempotency contract.
    upstreamResponse = await fetchWithHeaderTimeout(upstreamUrl, {
      method: "POST",
      headers,
      body,
    }, upstream.signal, connectMs);
  } catch (err) {
    unregisterTurn(upstream);
    unlinkRequestAbort();
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", "Client closed the request");
    }
    const outcome = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "connect_error";
    recordImagesPoolOutcome(config, authCtx, outcome);
    upstream.abort();
    const message = outcome === "timeout"
      ? `Provider connect timeout after ${connectMs}ms`
      : "Provider unreachable";
    return formatErrorResponse(502, "upstream_error", message);
  }

  recordImagesPoolOutcome(config, authCtx, upstreamResponse.status, upstreamResponse);
  const responseHeaders = sanitizePassthroughHeaders(upstreamResponse.headers);
  const bodyRelay = relayWithAbort(upstreamResponse.body, upstream);
  if (!bodyRelay) {
    unregisterTurn(upstream);
    unlinkRequestAbort();
    return new Response(null, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  }
  const trackedBody = trackStreamLifetime(bodyRelay, upstream, unlinkRequestAbort);
  return new Response(trackedBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
