/**
 * /v1/images/{generations,edits} relay (issue #83).
 *
 * codex-rs's standalone image_gen extension executes CLIENT-SIDE: it POSTs
 * `{base_url}/images/generations` (edits when reference images are attached) with the same
 * ChatGPT bearer auth it uses for chat. Under Design B injection base_url IS this proxy, so
 * without a route the tool died on the /v1/* JSON-404 guard. Only an OpenAI-family upstream
 * can serve these endpoints — routed providers (Cursor, Kiro, Gemini, …) have no image
 * generation surface — so the handler relays the body verbatim to the ChatGPT forward
 * provider, an OpenAI API-key provider, or an explicitly selected compatible custom provider and
 * passes the response through untouched:
 * codex's images client parses `{created, data:[{b64_json}]}` strictly and Debug-prints
 * error bodies into the model-visible failure, so upstream errors must stay legible.
 */
import { formatErrorResponse } from "../bridge";
import {
  CodexAccountCooldownError,
  codexMainProfileDrainingResponse,
  cooldownErrorResponse,
  CodexAuthContextError,
  CodexMainProfileDrainingError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
} from "../codex/auth-context";
import { formatCodexProviderForLog } from "../codex/routing";
import { signalWithTimeout } from "../lib/abort";
import { readBoundedResponseBytes, type BoundedBytesResult } from "../lib/bounded-body";
import { sidecarEnter } from "../lib/sidecar-tracker";
import type { OcxConfig } from "../types";
import { resolveFirstUsableOpenAiSidecar, selectImagesProvider } from "../providers/openai-sidecar";
import { getProviderRegistryEntry } from "../providers/registry";
import { readJsonRequestBody } from "./request-decompress";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "./auth-cors";
import type { RequestLogContext } from "./request-log";
import { codexLogAccountId, decodeRequestErrorResponse } from "./responses";
import { getValidAccessToken, getOAuthCredentialProjectId } from "../oauth/index";
import { safeAntigravityHttpErrorMessage } from "../adapters/google-errors";
import { sanitizeUpstreamErrorText } from "../adapters/upstream-http-error";
import { ANTIGRAVITY_REQUEST_UA } from "../adapters/google-antigravity-wire";
import {
  decodeValidatedImageBase64,
  fetchPublicHttpsImage,
  MAX_ENCODED_BYTES_PER_IMAGE,
  sniffImageExtension,
  type PinnedDownloadFn,
} from "../images/artifacts";
import { findXaiProvider, resolveXaiImageAuthToken } from "../images/plan";
import { callXaiImages } from "../images/xai-client";
import type { AdmissionLease } from "../lib/admission";
import { codexAccountSelectionForTurn } from "./lifecycle";

export type ImagesEndpoint = "generations" | "edits";

/** Image generation is slow (tens of seconds); bound a hung upstream, not a working one. */
const IMAGES_UPSTREAM_TIMEOUT_MS = 300_000;

/**
 * Cap for the buffered upstream response body (100 MiB). Images responses are JSON documents
 * containing base64-encoded images — typically a few MB. This prevents an oversized or malicious
 * response from exhausting process memory. The xAI `/v1/images` relay also uses this as the
 * combined decoded-byte and base64-encoded output budget across the whole batch.
 */
export const IMAGES_RESPONSE_MAX_BYTES = 100 * 1024 * 1024;

interface ImageResponseBytesOptions {
  signal?: AbortSignal;
  /** Smaller values are used only by focused reader tests. */
  maxBytes?: number;
}

function cancelUnlockedResponseBody(response: Response | undefined, reason?: unknown): void {
  const body = response?.body;
  if (!body || body.locked) return;
  try {
    void body.cancel(reason).catch(() => undefined);
  } catch {
    // A broken stream can throw synchronously from cancel().
  }
}

/**
 * Read one image relay response as exact raw bytes under the same cap used by
 * the public handler. A trustworthy Content-Length can reject obvious excess
 * before attaching a reader; the streaming reader remains authoritative when
 * the header is absent or understated.
 */
export async function readImageResponseBytes(
  response: Response,
  options: ImageResponseBytesOptions = {},
): Promise<BoundedBytesResult> {
  const signal = options.signal;
  if (signal?.aborted) {
    cancelUnlockedResponseBody(response, signal.reason);
    throw signal.reason;
  }
  if (response.body === null) {
    return { bytes: new Uint8Array(0), oversized: false };
  }

  const maxBytes = options.maxBytes ?? IMAGES_RESPONSE_MAX_BYTES;
  const contentLength = response.headers.get("content-length");
  const declaredBytes = contentLength === null ? Number.NaN : Number(contentLength);
  if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxBytes) {
    cancelUnlockedResponseBody(
      response,
      new DOMException("Response body size limit reached", "QuotaExceededError"),
    );
    return { bytes: new Uint8Array(0), oversized: true };
  }

  return readBoundedResponseBytes(response, { maxBytes, signal });
}

const CCA_IMAGE_MODEL = "gemini-3.1-flash-image";

/**
 * Google Gemini finishReasons that indicate a permanent content/safety block.
 * When any of these is present, the same prompt will always fail — retrying
 * wastes paid quota. The response is surfaced as 400 (non-retryable) instead
 * of 502 (which codex retries up to 5 times).
 */
const CCA_BLOCKING_FINISH_REASONS: ReadonlySet<string> = new Set([
  "SAFETY",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "RECITATION",
]);

function decodedBytesFromBase64(encoded: string): number {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

/** Largest decoded payload whose base64 form still fits in `remainingEncoded`. */
function remainingRelayDecodedBytes(spentDecoded: number, spentEncoded: number): number {
  const remainingDecoded = IMAGES_RESPONSE_MAX_BYTES - spentDecoded;
  const remainingEncoded = IMAGES_RESPONSE_MAX_BYTES - spentEncoded;
  if (remainingDecoded <= 0 || remainingEncoded < 4) return 0;
  return Math.max(0, Math.min(remainingDecoded, 3 * Math.floor(remainingEncoded / 4)));
}

function wouldExceedRelayBudget(
  spentDecoded: number,
  spentEncoded: number,
  decodedBytes: number,
  encodedBytes: number,
): boolean {
  return spentDecoded + decodedBytes > IMAGES_RESPONSE_MAX_BYTES
    || spentEncoded + encodedBytes > IMAGES_RESPONSE_MAX_BYTES;
}

function xaiImageOutputTooLarge(): Response {
  return formatErrorResponse(
    502,
    "upstream_error",
    `xAI image generation output too large (exceeded ${IMAGES_RESPONSE_MAX_BYTES} bytes)`,
  );
}

function xaiImageDownloadFailed(): Response {
  return formatErrorResponse(502, "upstream_error", "xAI image download failed");
}

function xaiImageAuthMissing(): Response {
  return formatErrorResponse(
    400,
    "invalid_request_error",
    "xAI Imagine relay is enabled but no usable Grok CLI OAuth token or xAI API key was found. "
    + "Run `ocx login xai` or set an xAI API key. The request was not forwarded to ChatGPT.",
  );
}

/** Test seam: inject a pinned HTTPS GET so relay tests never open a real socket. */
let xaiResultPinnedDownload: PinnedDownloadFn | undefined;

export function setXaiResultPinnedDownloadForTests(fn: PinnedDownloadFn | undefined): void {
  xaiResultPinnedDownload = fn;
}

/**
 * Race a promise against an abort signal. If the signal aborts first, reject
 * immediately — our code stops awaiting the underlying operation even though
 * the HTTP request behind it may still complete. Used to make the non-cancellable
 * OAuth refresh chain responsive to client cancellation and deadline expiry.
 */
function abortableRace<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => { signal.removeEventListener("abort", onAbort); resolve(val); },
      (err) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

async function tryCcaImageGeneration(
  body: unknown,
  config: OcxConfig,
  logCtx: RequestLogContext,
  signal: AbortSignal,
  endpoint: ImagesEndpoint,
): Promise<Response | undefined> {
  if (endpoint !== "generations") return undefined;
  const provider = config.providers?.["google-antigravity"];
  if (!provider || provider.disabled) return undefined;

  const prompt = (body as { prompt?: unknown })?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    return formatErrorResponse(400, "invalid_request_error", "prompt is required and must not be empty");
  }

  const nRaw = (body as { n?: unknown })?.n;
  if (nRaw !== undefined && nRaw !== null) {
    const n = typeof nRaw === "number" ? nRaw : Number(nRaw);
    if (!Number.isInteger(n) || n !== 1) {
      return formatErrorResponse(400, "invalid_request_error", "CCA image generation supports n=1 only");
    }
  }

  // Create the deadline before credential resolution so the timeout covers
  // OAuth token refresh and project discovery, not just the upstream fetch.
  const timeoutMs = config.images?.timeoutMs ?? IMAGES_UPSTREAM_TIMEOUT_MS;
  const linkedSignal = signalWithTimeout(timeoutMs, signal);
  let token: string;
  try {
    // Race the OAuth refresh against the deadline signal. getValidAccessToken
    // chains through 4 layers (resolveAccessSnapshotForAccount →
    // refreshAndPersistAccessToken → refreshGenericAccountWithLock →
    // def.refresh()) that do HTTP calls without accepting a signal. Rather than
    // threading signal through the entire chain, race the whole call against
    // linkedSignal: when the signal aborts we stop awaiting and surface the
    // cancellation immediately instead of hanging on the refresh HTTP call.
    token = await abortableRace(getValidAccessToken("google-antigravity"), linkedSignal.signal);
  } catch (err) {
    linkedSignal.cleanup();
    // abortableRace rejects immediately when the signal fires, so client
    // cancellation and deadline expiry surface here. Parent abort propagates
    // into the linked signal, so check parent first (499) before the linked
    // signal (504).
    if (signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", "CCA image request canceled by client");
    }
    if (linkedSignal.signal.aborted) {
      return formatErrorResponse(504, "upstream_error", "CCA image generation timed out during authentication");
    }
    // Missing/revoked credential → 401 (re-login required); transient refresh/network → 502.
    const errName = err instanceof Error ? err.name : "";
    if (errName === "OAuthLoginRequiredError") {
      return formatErrorResponse(401, "invalid_request_error", "Google Antigravity login required: run 'ocx login google-antigravity'");
    }
    return formatErrorResponse(502, "upstream_error", "CCA image generation failed: OAuth token refresh failed");
  }
  const project = getOAuthCredentialProjectId("google-antigravity");
  if (!project) {
    linkedSignal.cleanup();
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Antigravity requires a discovered Cloud Code Assist project id (re-run `ocx login google-antigravity`).",
    );
  }

  logCtx.provider = "google-antigravity";
  logCtx.model = CCA_IMAGE_MODEL;

  // Pin to the registry endpoint — never use a config-level baseUrl override for OAuth token transmission.
  const registryEntry = getProviderRegistryEntry("google-antigravity");
  const baseUrl = registryEntry?.baseUrl ?? "https://daily-cloudcode-pa.googleapis.com";
  const envelope = {
    model: CCA_IMAGE_MODEL,
    userAgent: "antigravity",
    requestType: "agent",
    project,
    requestId: `agent-${crypto.randomUUID()}`,
    request: {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      sessionId: `ocx-img-${crypto.randomUUID().slice(0, 8)}`,
    },
  };
  let upstream: Response;
  try {
    try {
      upstream = await fetch(`${baseUrl}/v1internal:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": ANTIGRAVITY_REQUEST_UA,
        },
        body: JSON.stringify(envelope),
        signal: linkedSignal.signal,
      });
    } catch (err) {
      if (signal.aborted) return formatErrorResponse(499, "client_closed_request", "CCA image request canceled by client");
      if (err instanceof Error && err.name === "TimeoutError") {
        return formatErrorResponse(504, "upstream_error", "CCA image generation timed out");
      }
      // Network/DNS/runtime errors may embed the request URL or headers verbatim
      // (e.g. "fetch failed: https://…/v1internal:generateContent"). The token
      // lives in an Authorization header, not in the URL, but sanitize defensively
      // so no upstream-rejected credential or query param can reach the client,
      // and strip the internal base URL host from the surfaced message.
      const rawMsg = err instanceof Error ? err.message : String(err);
      const safeMsg = sanitizeUpstreamErrorText(rawMsg).replace(
        /https?:\/\/[^\s"'<>]+/gi,
        "[upstream-url]",
      );
      return formatErrorResponse(502, "upstream_error", `CCA image generation failed: ${safeMsg}`);
    }

    // Stream the upstream body with a bounded reader so an oversized or malicious
    // response is rejected mid-stream rather than after a full arrayBuffer() allocation.
    let payload: Uint8Array;
    try {
      const reader = upstream.body?.getReader();
      if (!reader) {
        return formatErrorResponse(502, "upstream_error", "CCA image response had no body");
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > IMAGES_RESPONSE_MAX_BYTES) {
            await reader.cancel().catch(() => {});
            return formatErrorResponse(502, "upstream_error", `CCA image response too large (exceeded ${IMAGES_RESPONSE_MAX_BYTES} bytes)`);
          }
          chunks.push(value);
        }
      } finally {
        try { await reader.cancel(); } catch { /* ignore */ }
        reader.releaseLock();
      }
      payload = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        payload.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } catch (err) {
      // Body-read timeout/abort: when CCA returns headers then stalls, the linked
      // signal's timeout aborts reader.read(), which rejects here. The rejection
      // often surfaces as AbortError (not TimeoutError), so distinguish by signal
      // state, not error name. Parent abort propagates into the linked signal, so
      // check the parent first: parent abort → 499 (client cancelled); linked-only
      // abort → 504 (upstream stall); anything else → 502 body-read failure.
      if (signal.aborted) {
        return formatErrorResponse(499, "client_closed_request", "CCA image request canceled by client");
      }
      if (linkedSignal.signal.aborted) {
        return formatErrorResponse(504, "upstream_error", "CCA image response timed out during body read");
      }
      const rawMsg = err instanceof Error ? err.message : String(err);
      const safeMsg = sanitizeUpstreamErrorText(rawMsg).replace(/https?:\/\/[^\s"'<>]+/gi, "[upstream-url]");
      return formatErrorResponse(502, "upstream_error", `CCA image body read failed: ${safeMsg}`);
    }

    if (!upstream.ok) {
      // Preserve auth/rate-limit and other permanent 4xx signals so callers can
      // distinguish retryable from permanent failures. Remaining 5xx collapse to 502.
      const text = new TextDecoder().decode(payload);
      const safeMsg = safeAntigravityHttpErrorMessage(upstream.status, text);
      if (upstream.status >= 400 && upstream.status < 500) {
        return formatErrorResponse(upstream.status, "upstream_error", safeMsg);
      }
      return formatErrorResponse(502, "upstream_error", safeMsg);
    }

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    } catch {
      return formatErrorResponse(502, "upstream_error", "CCA image response was not valid JSON");
    }
    const resp = (json.response ?? json) as {
      candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string }; text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    // Safety blocks are permanent for the same prompt — return 400 (non-retryable)
    // instead of 502 (which codex retries up to 5 times, wasting paid quota on a
    // prompt that will never succeed). Two blocking signals exist in the Gemini
    // API: promptFeedback.blockReason (prompt rejected before generation) and
    // candidate.finishReason (generation cut off by a content filter).
    const blockReason = resp.promptFeedback?.blockReason;
    if (typeof blockReason === "string" && blockReason.trim()) {
      return formatErrorResponse(400, "invalid_request_error", `CCA image generation blocked by safety filter (promptFeedback.blockReason: ${blockReason})`);
    }
    const candidate = resp.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (typeof finishReason === "string" && CCA_BLOCKING_FINISH_REASONS.has(finishReason)) {
      return formatErrorResponse(400, "invalid_request_error", `CCA image generation blocked by safety filter (finishReason: ${finishReason})`);
    }
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) {
      return formatErrorResponse(502, "upstream_error", "CCA image response had no valid parts array");
    }
    const images: { b64_json: string }[] = [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const data = part.inlineData?.data;
      if (typeof data !== "string" || data.length === 0) continue;
      if (data.length > MAX_ENCODED_BYTES_PER_IMAGE) {
        return formatErrorResponse(502, "upstream_error", "CCA image payload exceeds per-image size cap");
      }
      try {
        decodeValidatedImageBase64(data);
      } catch {
        return formatErrorResponse(502, "upstream_error", "CCA image payload failed base64/magic validation");
      }
      images.push({ b64_json: data });
    }
    if (images.length === 0) {
      return formatErrorResponse(502, "upstream_error", "CCA image model returned no image data");
    }
    // Only `{created, data:[{b64_json}]}` is returned — no token, projectId, or
    // upstream metadata leak through. The Authorization header is consumed by the
    // fetch above and never copied onto this Response.
    return new Response(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: images }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } finally {
    linkedSignal.cleanup();
  }
}

/**
 * Codex's client-side image_gen POSTs here. When the Grok Imagine bridge is
 * opted in, send that request to api.x.ai instead of ChatGPT.
 */
async function tryXaiImageRelay(
  body: unknown,
  config: OcxConfig,
  logCtx: RequestLogContext,
  signal: AbortSignal | undefined,
  endpoint: ImagesEndpoint,
): Promise<Response | undefined> {
  if (config.images?.bridgeEnabled !== true) return undefined;
  const found = findXaiProvider(config);
  if (!found) return undefined;
  const obj = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const prompt = typeof obj.prompt === "string" ? obj.prompt
    : typeof obj.input === "string" ? obj.input
    : "";
  if (!prompt.trim()) {
    return formatErrorResponse(400, "invalid_request_error", "image generation requires a prompt");
  }
  const n = typeof obj.n === "number" && Number.isFinite(obj.n) ? Math.max(1, Math.min(4, Math.floor(obj.n))) : 1;
  const size = typeof obj.size === "string" ? obj.size : undefined;
  const quality = typeof obj.quality === "string" ? obj.quality : undefined;
  const aspectRatio = typeof obj.aspect_ratio === "string" ? obj.aspect_ratio : undefined;
  let imageUrl: string | undefined;
  if (endpoint === "edits") {
    const images = obj.images;
    const first = Array.isArray(images) ? images[0] : undefined;
    if (typeof obj.image === "string") imageUrl = obj.image;
    else if (typeof obj.image_url === "string") imageUrl = obj.image_url;
    else if (first && typeof first === "object" && first !== null) {
      const rec = first as Record<string, unknown>;
      if (typeof rec.image_url === "string") imageUrl = rec.image_url;
      else if (typeof rec.url === "string") imageUrl = rec.url;
    }
    if (!imageUrl?.trim()) {
      return formatErrorResponse(400, "invalid_request_error", "image edits require an image URL");
    }
    imageUrl = imageUrl.trim();
  }
  const timeoutMs = config.images?.timeoutMs ?? IMAGES_UPSTREAM_TIMEOUT_MS;
  const linkedSignal = signalWithTimeout(timeoutMs, signal);
  try {
    let token: string | undefined;
    try {
      token = await abortableRace(resolveXaiImageAuthToken(found.provider), linkedSignal.signal);
    } catch {
      if (signal?.aborted) {
        return formatErrorResponse(499, "client_closed_request", `image ${endpoint} request canceled by client`);
      }
      if (linkedSignal.signal.aborted) {
        return formatErrorResponse(504, "upstream_error", `xAI image ${endpoint} timed out during authentication`);
      }
      return xaiImageAuthMissing();
    }
    if (!token) return xaiImageAuthMissing();
    logCtx.provider = "xai";
    logCtx.model = config.images?.bridgeModel ?? "grok-imagine-image-quality";
    const result = await callXaiImages(
      {
        prompt,
        model: logCtx.model,
        n,
        size,
        quality,
        aspectRatio,
        imageUrl,
      },
      { baseUrl: "https://api.x.ai/v1", token },
      linkedSignal.signal,
      timeoutMs,
    );
    const data: Array<{ b64_json: string }> = [];
    let spentDecoded = 0;
    let spentEncoded = 0;
    for (const img of result.images) {
      if (typeof img.b64_json === "string" && img.b64_json) {
        const encodedBytes = img.b64_json.length;
        if (encodedBytes > MAX_ENCODED_BYTES_PER_IMAGE) {
          return formatErrorResponse(502, "upstream_error", "xAI image payload exceeds per-image size cap");
        }
        try {
          decodeValidatedImageBase64(img.b64_json);
        } catch {
          return formatErrorResponse(502, "upstream_error", "xAI image payload failed base64/magic validation");
        }
        const decodedBytes = decodedBytesFromBase64(img.b64_json);
        if (wouldExceedRelayBudget(spentDecoded, spentEncoded, decodedBytes, encodedBytes)) {
          return xaiImageOutputTooLarge();
        }
        data.push({ b64_json: img.b64_json });
        spentDecoded += decodedBytes;
        spentEncoded += encodedBytes;
        continue;
      }
      if (typeof img.url !== "string" || !img.url) continue;
      const remaining = remainingRelayDecodedBytes(spentDecoded, spentEncoded);
      if (remaining <= 0) return xaiImageOutputTooLarge();
      let fetched: Response;
      try {
        fetched = await fetchPublicHttpsImage(img.url, {
          signal: linkedSignal.signal,
          pinnedDownload: xaiResultPinnedDownload,
          maxBytes: remaining,
        });
      } catch (err) {
        if (signal?.aborted || linkedSignal.signal.aborted) throw err;
        return xaiImageDownloadFailed();
      }
      const observed = await readImageResponseBytes(fetched, {
        maxBytes: remaining,
        signal: linkedSignal.signal,
      });
      if (observed.oversized) return xaiImageOutputTooLarge();
      if (observed.bytes.byteLength === 0) continue;
      if (!sniffImageExtension(observed.bytes)) return xaiImageDownloadFailed();
      const decodedBytes = observed.bytes.byteLength;
      const b64 = Buffer.from(observed.bytes).toString("base64");
      if (wouldExceedRelayBudget(spentDecoded, spentEncoded, decodedBytes, b64.length)) {
        return xaiImageOutputTooLarge();
      }
      data.push({ b64_json: b64 });
      spentDecoded += decodedBytes;
      spentEncoded += b64.length;
    }
    if (data.length === 0) {
      return formatErrorResponse(502, "upstream_error", "xAI image generation returned no usable images");
    }
    return new Response(JSON.stringify({ created: Math.floor(Date.now() / 1000), data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    if (signal?.aborted) {
      return formatErrorResponse(499, "client_closed_request", `image ${endpoint} request canceled by client`);
    }
    if (linkedSignal.signal.aborted || (err instanceof Error && err.name === "TimeoutError")) {
      return formatErrorResponse(504, "upstream_error", `xAI image ${endpoint} timed out`);
    }
    const status = typeof err === "object" && err && "status" in err && typeof (err as { status: unknown }).status === "number"
      ? (err as { status: number }).status
      : 502;
    const message = err instanceof Error ? err.message : String(err);
    const safeMessage = sanitizeUpstreamErrorText(message).replace(
      /https?:\/\/[^\s"'<>]+/gi,
      "[upstream-url]",
    );
    return formatErrorResponse(
      status >= 400 && status < 600 ? status : 502,
      "upstream_error",
      `xAI image ${endpoint} failed: ${safeMessage}`,
    );
  } finally {
    linkedSignal.cleanup();
  }
}

export async function handleImages(
  req: Request,
  config: OcxConfig,
  endpoint: ImagesEndpoint,
  logCtx: RequestLogContext,
  turnAdmissionLease?: AdmissionLease,
): Promise<Response> {
  let body: unknown;
  try {
    body = await readJsonRequestBody(req);
  } catch (err) {
    return decodeRequestErrorResponse(err, "images");
  }
  const model = (body as { model?: unknown } | null)?.model;
  if (typeof model === "string" && model) logCtx.model = model;

  const candidates = selectImagesProvider(config);
  // Explicit images.provider owns the route, including its validation errors.
  // Do not divert that selection to the xAI Imagine relay.
  if (config.images?.provider === undefined) {
    const xaiRelay = await tryXaiImageRelay(body, config, logCtx, req.signal, endpoint);
    if (xaiRelay) return xaiRelay;
  }
  if (candidates.error) {
    return formatErrorResponse(400, "invalid_request_error", candidates.error);
  }
  const explicitKeyedProvider = config.images?.provider !== undefined && candidates.keyed !== undefined;
  // Admission bearer is valid proxy auth (requireApiAuth already passed) but must never be
  // forwarded as OpenAI ChatGPT credentials. When the caller sent it, skip OpenAI forward
  // and allow CCA / keyed paths instead of rejecting the whole request.
  let skipOpenAiForwardForAdmissionBearer = false;
  if (!explicitKeyedProvider) {
    try { validateForwardAdmissionCredential(req.headers, config); }
    catch (err) {
      if (err instanceof ForwardAdmissionCredentialError) {
        skipOpenAiForwardForAdmissionBearer = true;
      } else {
        throw err;
      }
    }
  }

  const canUseOpenAiForward = !skipOpenAiForwardForAdmissionBearer && candidates.forwardCandidates.length > 0;

  if (!canUseOpenAiForward && !candidates.keyed) {
    const ccaResponse = await tryCcaImageGeneration(body, config, logCtx, req.signal, endpoint);
    if (ccaResponse) return ccaResponse;
    // 400, not 5xx: codex retries every 5xx up to 5 total attempts, and this is a permanent
    // configuration state that must surface on the first attempt.
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Built-in image generation needs an OpenAI upstream (ChatGPT login or an OpenAI API-key provider) "
      + "or a logged-in Google Antigravity (Cloud Code Assist) provider, "
      + "but none is configured in opencodex. Add a provider or disable the tool with `codex features disable image_generation`.",
    );
  }

  // Resolve forward auth first; failures are captured, not returned, so a configured keyed
  // provider can still serve the request (e.g. every pool account cooling down must not
  // 429 image_gen while api.openai.com sits idle).
  let forward: Awaited<ReturnType<typeof resolveFirstUsableOpenAiSidecar>>;
  let forwardAuthError: Response | undefined;
  if (canUseOpenAiForward) {
    try {
      forward = await resolveFirstUsableOpenAiSidecar(candidates.forwardCandidates, req.headers, config, {
        beginCodexAccountSelection: codexAccountSelectionForTurn(turnAdmissionLease),
      });
      if (forward) logCtx.provider = formatCodexProviderForLog(forward.providerName, codexLogAccountId(forward.authContext), config);
    } catch (err) {
      if (err instanceof CodexAccountCooldownError) {
        forwardAuthError = cooldownErrorResponse(err);
      } else if (err instanceof CodexMainProfileDrainingError) {
        forwardAuthError = codexMainProfileDrainingResponse();
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
    // Before surfacing the OpenAI auth failure, try CCA — the user may have a
    // valid Google Antigravity login even though their OpenAI pool is broken.
    const ccaResponse = await tryCcaImageGeneration(body, config, logCtx, req.signal, endpoint);
    if (ccaResponse) return ccaResponse;
    // No CCA either: a configured OpenAI pool mode owns its authentication failure.
    // Do not hide a broken/expired pool behind separately billed API-key image generation.
    return forwardAuthError;
  } else if (candidates.keyed) {
    const { provider, apiKey, providerName } = candidates.keyed;
    if (provider.headers) Object.assign(headers, provider.headers);
    headers["authorization"] = `Bearer ${apiKey}`;
    logCtx.provider = providerName;
    // Keyed providers tolerate baseUrl with or without /v1 (mirrors openai-responses.ts).
    url = `${provider.baseUrl.replace(/\/v1\/?$/, "")}/v1/images/${endpoint}`;
  } else {
    // No usable OpenAI credential — try CCA before giving up.
    const ccaResponse = await tryCcaImageGeneration(body, config, logCtx, req.signal, endpoint);
    if (ccaResponse) return ccaResponse;
    return formatErrorResponse(
      401,
      "authentication_error",
      "image generation relay needs ChatGPT auth (Authorization header) or an OpenAI API-key provider",
    );
  }

  const timeoutMs = config.images?.timeoutMs ?? IMAGES_UPSTREAM_TIMEOUT_MS;
  const linkedSignal = signalWithTimeout(timeoutMs, req.signal);
  const sidecarExit = sidecarEnter("images");
  let upstreamResponse: Response | undefined;
  try {
    // Images POSTs create paid, non-idempotent work. One fetch only: no reset retry without a
    // source-proven idempotency contract.
    upstreamResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: linkedSignal.signal,
      // Do not follow a cross-origin 3xx while carrying Codex credentials. Bun strips
      // `Authorization` across origins but forwards nonstandard headers, so
      // `chatgpt-account-id`, `session_id`, and `x-codex-turn-metadata` would reach the
      // redirect target. Verified with a two-server probe. The Responses path and native
      // compact already set this; the credential-bearing sidecars did not.
      redirect: "manual",
    });
    const observed = await readImageResponseBytes(upstreamResponse, {
      maxBytes: IMAGES_RESPONSE_MAX_BYTES,
      signal: linkedSignal.signal,
    });
    if (observed.oversized) {
      forward?.recordOutcome?.(upstreamResponse.status);
      return formatErrorResponse(
        502,
        "upstream_error",
        `image ${endpoint} response too large (exceeded ${IMAGES_RESPONSE_MAX_BYTES} bytes)`,
      );
    }
    const relayHeaders: Record<string, string> = {};
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) relayHeaders["content-type"] = contentType;
    // Fetch represents 204/205/304 responses with a null body. Preserve that
    // invariant: constructing those statuses with even an empty Uint8Array throws.
    const relayBody = upstreamResponse.body === null ? null : observed.bytes;
    const relayResponse = new Response(relayBody, {
      status: upstreamResponse.status,
      headers: relayHeaders,
    });
    forward?.recordOutcome?.(upstreamResponse.status);
    return relayResponse;
  } catch (err) {
    // Client cancel first: it aborts the linked signal too, and must not be logged as an
    // upstream failure (499 maps to client_closed_request in the request log).
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", `image ${endpoint} request canceled by client`);
    }
    if (linkedSignal.signal.aborted || (err instanceof Error && err.name === "TimeoutError")) {
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
    // If cancellation won before readImageResponseBytes attached its reader, the
    // response still owns an upstream body/socket. Consumed or locked bodies are
    // already owned by the reader and need no second cancellation.
    cancelUnlockedResponseBody(upstreamResponse);
  }
}
