import type { OcxProviderConfig } from "../types";
import { CLAUDE_CODE_HEADERS, claudeCodeSessionId } from "../adapters/client-fingerprint";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { fetchWithResetRetry, applyUpstreamRecoveryInit } from "../lib/upstream-retry";
import { getValidAccessToken } from "../oauth";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION } from "../oauth/anthropic";
import type { DescribeOutcome, VisionSettings } from "./describe";

const ANTHROPIC_VISION_MAX_TOKENS = 1024;
const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DESCRIBE_INSTRUCTION =
  "You are a vision describer for a text-only model that cannot see the image. Describe the image " +
  "thoroughly and factually so that model can fully reason about it: transcribe any visible text " +
  "verbatim, and note UI/layout, colors, branding/logos, charts, and notable details. Focus on " +
  "what's relevant to the user's request. Output only the description.";

type AnthropicImageBlock =
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "image"; source: { type: "url"; url: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function buildImageBlock(imageUrl: string): { block?: AnthropicImageBlock; error?: string } {
  if (imageUrl.startsWith("data:")) {
    // Anthropic's base64 image source requires actual base64 bytes, so a non-base64 data URL
    // (e.g. `data:image/png,raw`) is rejected here. This is intentionally stricter than the OpenAI
    // vision executor, which forwards the raw data URL to `image_url` (review F3, documented delta).
    const match = /^data:([^;,]+?)(;base64)?,(.*)$/s.exec(imageUrl);
    if (!match || !match[2]) return { error: "malformed data URL" };
    const mime = match[1].toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mime)) return { error: `unsupported image type "${mime}"` };
    const bytes = Math.floor((match[3].length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) return { error: `image too large (~${Math.round(bytes / 1024 / 1024)}MB)` };
    return { block: { type: "image", source: { type: "base64", media_type: mime, data: match[3] } } };
  }
  if (imageUrl.startsWith("https://")) {
    return { block: { type: "image", source: { type: "url", url: imageUrl } } };
  }
  return { error: "unsupported image URL scheme (expected data: or https:)" };
}

/** Fold Anthropic Messages text deltas into one description. Malformed frames are ignored. */
export async function parseAnthropicVisionSSE(res: Response): Promise<DescribeOutcome> {
  if (!res.body) return { text: "", error: "anthropic vision sidecar returned no response body" };

  let text = "";
  let terminalError = "";
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";

  const processFrame = (rawFrame: string): void => {
    let dataLine = "";
    for (const line of rawFrame.split("\n")) {
      if (line.startsWith("data:")) dataLine += line.slice(line.startsWith("data: ") ? 6 : 5);
    }
    if (!dataLine || dataLine === "[DONE]") return;
    let data: unknown;
    try { data = JSON.parse(dataLine); } catch { return; }
    if (!isRecord(data)) return;

    if (data.type === "content_block_delta") {
      const delta = isRecord(data.delta) ? data.delta : {};
      if (delta.type === "text_delta" && typeof delta.text === "string") text += delta.text;
    } else if (data.type === "error") {
      const error = isRecord(data.error) ? data.error : {};
      terminalError = typeof error.message === "string" ? error.message : "anthropic vision sidecar stream error";
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        processFrame(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
      }
    }
    buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
    if (buffer.trim()) processFrame(buffer);
  } catch {
    // A mid-stream read/decode failure after partial text is NOT a usable description. Mark it
    // terminal so the caller returns an error and never caches an incomplete result (review F1).
    if (!terminalError) terminalError = "anthropic vision sidecar stream ended abnormally";
  }

  const trimmed = text.trim();
  // A terminal error (an in-stream `error` frame OR an abnormal body failure) invalidates any partial
  // text: return an error outcome so vision/index.ts never caches an incomplete description (review F1).
  if (terminalError) return { text: "", error: terminalError };
  if (!trimmed) return { text: "", error: "anthropic vision sidecar produced no description" };
  return { text: trimmed };
}

/** Describe one image through a stored Anthropic OAuth credential. Never throws. */
export async function describeImageAnthropic(
  imageUrl: string,
  detail: string | undefined,
  contextText: string,
  providerName: string,
  provider: OcxProviderConfig,
  settings: VisionSettings,
  abortSignal?: AbortSignal,
): Promise<DescribeOutcome> {
  const image = buildImageBlock(imageUrl);
  if (!image.block) return { text: "", error: image.error ?? "invalid image" };

  let token: string;
  try {
    token = await getValidAccessToken(providerName);
  } catch (error) {
    return { text: "", error: `anthropic vision sidecar auth failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "Accept": "text/event-stream",
    "User-Agent": "@anthropic-ai/sdk/0.74.0",
    "Authorization": `Bearer ${token}`,
    "anthropic-beta": ANTHROPIC_OAUTH_BETA,
    ...CLAUDE_CODE_HEADERS,
    "X-Claude-Code-Session-Id": claudeCodeSessionId(token),
    "x-client-request-id": crypto.randomUUID(),
  };
  if (provider.headers) Object.assign(headers, provider.headers);

  const content: unknown[] = [];
  if (contextText) content.push({ type: "text", text: `The user's request about this image: ${contextText}` });
  content.push(image.block);
  const body = {
    model: settings.model,
    max_tokens: ANTHROPIC_VISION_MAX_TOKENS,
    thinking: { type: "disabled" },
    system: [
      { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
      { type: "text", text: DESCRIBE_INSTRUCTION },
    ],
    messages: [{ role: "user", content }],
    stream: true,
  };

  // Anthropic image blocks have no detail field, but detail remains part of the cache identity.
  void detail;
  const base = provider.baseUrl.replace(/\/v1\/?$/, "");
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("vision");
  const startedAt = Date.now();
  try {
    const res = await fetchWithResetRetry(
      recovery => fetch(`${base}/v1/messages`, applyUpstreamRecoveryInit({
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: linkedSignal.signal,
      }, recovery)),
      { abortSignal: linkedSignal.signal, label: "vision-sidecar-anthropic" },
    );
    if (!res.ok) {
      const responseText = await res.text().catch(() => "");
      console.warn(`[vision] anthropic sidecar HTTP ${res.status} (${Date.now() - startedAt}ms)`);
      return { text: "", error: `anthropic vision sidecar HTTP ${res.status}: ${responseText.slice(0, 200)}` };
    }
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    try {
      return await parseAnthropicVisionSSE(res);
    } finally {
      detachBodyGuard();
    }
  } catch (error) {
    const kind = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[vision] anthropic sidecar ${kind} (${Date.now() - startedAt}ms)`);
    return { text: "", error: error instanceof Error ? error.message : String(error) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
