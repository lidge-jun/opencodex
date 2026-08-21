import { createGoogleAdapter } from "../adapters/google";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { createTranslatorBudget } from "../lib/translator-budget";
import type { SidecarOutcomeRecorder } from "../web-search/executor";
import { getOAuthCredentialProjectId, getValidAccessToken, publicOAuthAuthenticationErrorMessage } from "../oauth";
import { resolveActiveProviderApiKey } from "../providers/api-keys";

export interface ChatVisionSettings {
  model: string;
  timeoutMs: number;
  detail?: string;
  reasoning?: string;
}

export type DescribeChatOutcome = { text: string; error?: string };

/**
 * Fail before any credential acquisition or network activity when the destination
 * is not HTTPS. The vision sidecar sends user images, so an `http:` baseUrl must
 * never see a bearer token or an outbound request — checked BEFORE the OAuth token
 * lookup, BEFORE Authorization construction, and BEFORE any fetch.
 */
function httpsGuardError(baseUrl: string, allowLoopbackHttp: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return "invalid provider baseUrl";
  }
  if (parsed.protocol === "https:") return null;
  // Cleartext is acceptable only when the bytes never leave the host: a local
  // OpenAI-compatible server (e.g. http://127.0.0.1:1234/v1) is a legitimate
  // chat-vision destination. Remote http: destinations stay rejected before
  // any token fetch or network call.
  const host = parsed.hostname.replace(/^\[|]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (allowLoopbackHttp && parsed.protocol === "http:" && loopback) return null;
  return `provider baseUrl must use HTTPS (got ${parsed.protocol})`;
}

const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function validateImageInput(imageUrl: string): { mime?: string; base64Data?: string; error?: string } {
  if (imageUrl.startsWith("data:")) {
    const match = /^data:([^;,]+?)(;base64)?,(.*)$/s.exec(imageUrl);
    if (!match || !match[2]) return { error: "malformed data URL" };
    const mime = match[1].toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mime)) return { error: `unsupported image type "${mime}"` };
    const bytes = Math.floor((match[3].length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) return { error: `image too large (~${Math.round(bytes / 1024 / 1024)}MB)` };
    return { mime, base64Data: match[3] };
  }
  if (imageUrl.startsWith("https://")) {
    return {};
  }
  return { error: "unsupported image URL scheme (expected data: or https:)" };
}

function toChatImagePart(imageUrl: string, detail?: string): Record<string, unknown> {
  return { type: "image_url", image_url: { url: imageUrl, detail: detail ?? "high" } };
}

async function describeImageGoogle(
  imageUrl: string,
  detail: string | undefined,
  contextText: string,
  provider: OcxProviderConfig,
  providerName: string,
  settings: ChatVisionSettings,
  abortSignal?: AbortSignal,
  recordOutcome?: SidecarOutcomeRecorder,
  executor: typeof globalThis.fetch = globalThis.fetch,
): Promise<DescribeChatOutcome> {
  const imageValidation = validateImageInput(imageUrl);
  if (imageValidation.error) return { text: "", error: imageValidation.error };
  const destinationError = httpsGuardError(provider.baseUrl, provider.authMode !== "oauth");
  if (destinationError) return { text: "", error: destinationError };
  let requestProvider = provider;
  if (provider.authMode === "oauth") {
    try {
      const token = await getValidAccessToken(providerName);
      const project = provider.googleMode === "cloud-code-assist"
        ? getOAuthCredentialProjectId(providerName)
        : provider.project;
      requestProvider = { ...provider, apiKey: token, ...(project ? { project } : {}) };
    } catch (e) {
      return { text: "", error: `google oauth token failed: ${publicOAuthAuthenticationErrorMessage(e)}` };
    }
  } else {
    const apiKey = resolveActiveProviderApiKey(provider);
    if (!apiKey) return { text: "", error: "provider has no API key" };
    requestProvider = { ...provider, apiKey };
  }

  const parsed = {
    modelId: settings.model,
    context: {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: contextText || "Describe this image." },
          { type: "image", imageUrl, detail },
        ],
        timestamp: Date.now(),
      }],
    },
    stream: true,
    options: { maxOutputTokens: 1024, reasoning: settings.reasoning ?? "low" },
  } as OcxParsedRequest;
  const budget = createTranslatorBudget();
  const adapter = createGoogleAdapter(requestProvider);
  const sidecarExit = sidecarEnter("vision");
  // Bound the AI Studio fallback below: created lazily, cleaned up in finally.
  let fallbackSignal: ReturnType<typeof signalWithTimeout> | undefined;
  try {
    const request = await adapter.buildRequest(parsed, {
      headers: new Headers(),
      translatorBudget: budget,
      abortSignal,
    });
    const response = adapter.fetchResponse
      ? await adapter.fetchResponse(request, {
        abortSignal,
        timeoutMs: settings.timeoutMs,
        stream: true,
        returnRawErrors: true,
        executor,
      })
      : (fallbackSignal = signalWithTimeout(settings.timeoutMs, abortSignal), await executor(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        // AI Studio leaves fetchResponse undefined, so this fallback must bound
        // the request itself: without a timeout a stalled upstream holds a
        // VISION_CONCURRENCY worker open indefinitely. signalWithTimeout
        // merges settings.timeoutMs with the caller's abortSignal; cleanup()
        // in finally releases the merged listener.
        signal: fallbackSignal.signal,
      }));
    recordOutcome?.(response.status);
    if (!response.ok) {
      return { text: "", error: `google sidecar HTTP ${response.status}` };
    }
    let text = "";
    for await (const event of adapter.parseStream(response, budget)) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "error") return { text: "", error: "google sidecar stream error" };
    }
    const trimmed = text.trim();
    if (!trimmed) return { text: "", error: "google sidecar produced no description" };
    return { text: trimmed };
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    recordOutcome?.(kind);
    return { text: "", error: `google sidecar ${kind}` };
  } finally {
    fallbackSignal?.cleanup();
    sidecarExit();
  }
}

export async function describeImageChat(
  imageUrl: string,
  detail: string | undefined,
  contextText: string,
  provider: OcxProviderConfig,
  providerName: string,
  settings: ChatVisionSettings,
  abortSignal?: AbortSignal,
  recordOutcome?: SidecarOutcomeRecorder,
  executor: typeof globalThis.fetch = globalThis.fetch,
): Promise<DescribeChatOutcome> {
  const imageValidation = validateImageInput(imageUrl);
  if (imageValidation.error) return { text: "", error: imageValidation.error };
  if (provider.adapter === "google") {
    return describeImageGoogle(
      imageUrl,
      detail,
      contextText,
      provider,
      providerName,
      settings,
      abortSignal,
      recordOutcome,
      executor,
    );
  }
  const destinationError = httpsGuardError(provider.baseUrl, provider.authMode !== "oauth");
  if (destinationError) return { text: "", error: destinationError };
  let authHeader = "";
  if (provider.authMode === "oauth") {
    try {
      const token = await getValidAccessToken(providerName);
      authHeader = `Bearer ${token}`;
    } catch (e) {
      return { text: "", error: `oauth token failed: ${publicOAuthAuthenticationErrorMessage(e)}` };
    }
  } else {
    const apiKey = resolveActiveProviderApiKey(provider);
    if (apiKey) {
      authHeader = `Bearer ${apiKey}`;
    } else if (provider.apiKey !== undefined || (provider.apiKeyPool?.length ?? 0) > 0) {
      return { text: "", error: "provider has no API key or OAuth token" };
    } else {
      // Preserve legacy static-header auth only when no configured key exists;
      // unresolved env references must never fall through to raw placeholders.
      const fallback = provider.headers?.Authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      if (fallback) authHeader = `Bearer ${fallback}`;
      else if (provider.authMode !== "local" && provider.keyOptional !== true) {
        return { text: "", error: "provider has no API key or OAuth token" };
      }
    }
    // authMode "local" / keyOptional: keyless destination, no Authorization header.
  }

  const content: unknown[] = [
    { type: "text", text: contextText || "Describe this image." },
    toChatImagePart(imageUrl, detail),
  ];
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: [{ role: "user", content }],
    stream: true,
    max_tokens: 1024,
  };
  // Forward the planned reasoning through the provider-aware wire mapping,
  // mirroring the openai-chat adapter: OpenAI-compatible targets carry
  // reasoning_effort, gateway-object targets carry reasoning.enabled/effort.
  if (settings.reasoning && settings.reasoning !== "none") {
    if (provider.reasoningWireFormat === "gateway-object") {
      body.reasoning = { enabled: true, effort: settings.reasoning };
    } else {
      body.reasoning_effort = settings.reasoning;
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(provider.headers ?? {}),
    // The resolved credential must win over any static provider header: a
    // configured Authorization would otherwise replace a freshly rotated OAuth
    // token / API key and break every authenticated request with 401.
    ...(authHeader ? { Authorization: authHeader } : {}),
  };

  const linkedSignal = signalWithTimeout(settings.timeoutMs ?? 30_000, abortSignal);
  const sidecarExit = sidecarEnter("vision");
  const t0 = Date.now();
  try {
    const baseUrl = provider.baseUrl.replace(/\/$/, "");
    const url = new URL(`${baseUrl}/chat/completions`);
    const res = await executor(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: linkedSignal.signal,
    });
    recordOutcome?.(res.status);
    if (!res.ok) {
      console.warn(`[vision] chat sidecar HTTP ${res.status} (${Date.now() - t0}ms)`);
      return { text: "", error: `chat sidecar HTTP ${res.status}` };
    }
    if (!res.body) return { text: "", error: "chat sidecar returned no response body" };
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    let text = "";
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const consumeLine = (line: string) => {
        const s = line.replace(/^data:\s*/, "").trim();
        if (!s || s === "[DONE]") return;
        try {
          const j = JSON.parse(s);
          const delta = j.choices?.[0]?.delta?.content;
          if (typeof delta === "string") text += delta;
          else if (Array.isArray(delta)) {
            for (const part of delta) if (typeof part?.text === "string") text += part.text;
          }
          const message = j.choices?.[0]?.message?.content;
          if (typeof message === "string") text += message;
        } catch { /* ignore non-JSON data lines */ }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      }
      consumeLine(buf);
      const trimmed = text.trim();
      if (!trimmed) return { text: "", error: "chat sidecar produced no description" };
      return { text: trimmed };
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    recordOutcome?.(kind);
    console.warn(`[vision] chat sidecar error (${Date.now() - t0}ms)`);
    return { text: "", error: `chat sidecar ${kind}` };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
