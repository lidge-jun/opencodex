import type { OcxProviderConfig } from "../types";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { fetchWithResetRetry, applyUpstreamRecoveryInit } from "../lib/upstream-retry";
import { parseSidecarSSE } from "../web-search/parse";
import type { SidecarOutcomeRecorder } from "../web-search/executor";

export interface VisionSettings {
  model: string;
  timeoutMs: number;
}

/** A description, or an `error` string when it couldn't run (caller injects a graceful marker). */
export type DescribeOutcome = { text: string; error?: string };

const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
/** ~20 MB — generous enough for screenshots; rejects pathological payloads before forwarding. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Validate an image URL before forwarding. Data URLs are checked for an allowed media type and a sane
 * decoded size (a malformed/huge/unsupported one would otherwise 400 at the backend or waste tokens).
 * Remote https URLs are passed through — the ChatGPT backend fetches them, not this proxy (so there's
 * no SSRF surface here). Returns an error string when the URL must be rejected, else null.
 */
function validateImageUrl(url: string): string | null {
  if (url.startsWith("data:")) {
    const m = /^data:([^;,]+?)(;base64)?,(.*)$/s.exec(url);
    if (!m) return "malformed data URL";
    const mime = m[1].toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mime)) return `unsupported image type "${mime}"`;
    if (m[2]) {
      const bytes = Math.floor((m[3].length * 3) / 4);
      if (bytes > MAX_IMAGE_BYTES) return `image too large (~${Math.round(bytes / 1024 / 1024)}MB)`;
    }
    return null;
  }
  if (url.startsWith("https://")) return null;
  return "unsupported image URL scheme (expected data: or https:)";
}

/**
 * Describe ONE image via a gpt vision model through the ChatGPT forward backend — the path that has
 * native image input. Reuses selected forwarded OAuth headers. The user's own request text is
 * passed as context so the description is focused. Never throws — returns `{error}` on failure.
 */
export async function describeImage(
  imageUrl: string,
  detail: string | undefined,
  contextText: string,
  forwardProvider: OcxProviderConfig,
  selectedForwardHeaders: Headers,
  settings: VisionSettings,
  abortSignal?: AbortSignal,
  recordOutcome?: SidecarOutcomeRecorder,
): Promise<DescribeOutcome> {
  const invalid = validateImageUrl(imageUrl);
  if (invalid) return { text: "", error: invalid };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (forwardProvider.headers) Object.assign(headers, forwardProvider.headers);
  for (const h of FORWARD_HEADERS) {
    const v = selectedForwardHeaders.get(h);
    if (v) headers[h] = v;
  }
  const content: unknown[] = [];
  if (contextText) content.push({ type: "input_text", text: `The user's request about this image: ${contextText}` });
  content.push({ type: "input_image", image_url: imageUrl, detail: detail ?? "high" });

  const body = {
    model: settings.model,
    instructions:
      "You are a vision describer for a text-only model that cannot see the image. Describe the image " +
      "thoroughly and factually so that model can fully reason about it: transcribe any visible text " +
      "verbatim, and note UI/layout, colors, branding/logos, charts, and notable details. Focus on " +
      "what's relevant to the user's request. Output only the description.",
    input: [{ type: "message", role: "user", content }],
    reasoning: { effort: "low" },
    // The ChatGPT (codex) backend rejects `max_output_tokens` ("Unsupported parameter"); the
    // description is clamped downstream (DESC_MAX_CHARS) instead.
    store: false,
    stream: true,
  };
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("vision");
  const t0 = Date.now();
  try {
    const res = await fetchWithResetRetry(
      recovery => fetch(`${forwardProvider.baseUrl}/responses`, applyUpstreamRecoveryInit({
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: linkedSignal.signal,
      }, recovery)),
      { abortSignal: linkedSignal.signal, label: "vision-sidecar" },
    );
    recordOutcome?.(res.status);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[vision] sidecar HTTP ${res.status} (${Date.now() - t0}ms)`);
      return { text: "", error: `vision sidecar HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    let parsed;
    try {
      parsed = await parseSidecarSSE(res);
    } finally {
      detachBodyGuard();
    }
    // The backend can return HTTP 200 then stream a `response.failed`/`error` event with no text;
    // surface that as a describe error instead of an empty (silently-blank) description.
    if (!parsed.text.trim() && parsed.error) return { text: "", error: parsed.error };
    return { text: parsed.text };
  } catch (e) {
    recordOutcome?.(e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error");
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[vision] sidecar ${kind} (${Date.now() - t0}ms)`);
    return { text: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
