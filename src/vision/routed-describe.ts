/**
 * Describe ONE image via a ROUTED model through the proxy's own
 * /v1/chat/completions on loopback (#2188 roadmap 180 revised).
 *
 * One executor for every provider the router can reach: the chat inbound
 * translates image_url parts and each adapter compiles its own wire
 * (Anthropic blocks, Antigravity inlineData, xai Responses input_image, plain
 * openai-chat), so provider coverage is the router's job, not this file's.
 *
 * Recursion fence: the request carries `x-opencodex-vision-describe: 1`.
 * The Chat surface detects the raw header before its bridge rebuilds headers
 * and carries it into handleResponses as `visionDescribeTerminal`; a marked
 * request STRIPS images instead of planning another describe (depth cap 1,
 * holds under predicate drift and combo re-resolution — audit rounds 2-4).
 *
 * Admission ladder (audit round 3): configuredApiAuthToken() (env token) ||
 * service token file || first config.apiKeys entry, sent as
 * `x-opencodex-api-key` — never Authorization (gateway-cache.ts rule: an
 * admission secret in a forwardable header is a forwarding hazard). Loopback
 * binds require no token at all (resolveApiAuth admits loopback).
 *
 * Known limitation (recorded in roadmap 170): a bindHost where 127.0.0.1
 * does not answer cannot reach its own loopback — same latent limitation
 * gateway-cache has.
 */
import type { OcxConfig } from "../types";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { redactSecretString } from "../lib/redact";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { configuredApiAuthToken, configuredPort } from "../server/auth-cors";
import { loadServiceTokenFromFile } from "../lib/service-secrets";
import type { DescribeOutcome, VisionSettings } from "./describe";

export const VISION_DESCRIBE_TERMINAL_HEADER = "x-opencodex-vision-describe";

const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Bound the loopback JSON response; descriptions are clamped to ~2k chars by the caller anyway. */
const MAX_ROUTED_RESPONSE_BYTES = 4 * 1024 * 1024;

const DESCRIBE_INSTRUCTION =
  "You are a vision describer for a text-only model that cannot see the image. Describe the image "
  + "thoroughly and factually so that model can fully reason about it: transcribe any visible text "
  + "verbatim, and note UI/layout, colors, branding/logos, charts, and notable details. Focus on "
  + "what's relevant to the user's request. Output only the description.";

function validateImageUrl(url: string): string | null {
  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+?)(;base64)?,(.*)$/s.exec(url);
    if (!match) return "malformed data URL";
    const mime = match[1].toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mime)) return `unsupported image type "${mime}"`;
    if (match[2]) {
      const bytes = Math.floor((match[3].length * 3) / 4);
      if (bytes > MAX_IMAGE_BYTES) return `image too large (~${Math.round(bytes / 1024 / 1024)}MB)`;
    }
    return null;
  }
  if (url.startsWith("https://")) return null;
  return "unsupported image URL scheme (expected data: or https:)";
}

/** The admission ladder: env token, service token file, first configured API key. */
export function routedDescribeAdmissionToken(config: Pick<OcxConfig, "apiKeys">): string | undefined {
  const envToken = configuredApiAuthToken();
  if (envToken) return envToken;
  const fileToken = loadServiceTokenFromFile(process.env);
  if (fileToken) return fileToken;
  const first = config.apiKeys?.[0]?.key?.trim();
  return first || undefined;
}

/** Base URL seam for tests; production always self-fetches loopback. */
export function routedDescribeBaseUrl(config: Pick<OcxConfig, "port">): string {
  // config.port can be 0 (ephemeral bind, tests) or stale after a live port
  // override; the server records its ACTUAL bound port via setCorsOrigin at
  // startup, so prefer that when config carries no positive port.
  const port = config.port && config.port > 0 ? String(config.port) : configuredPort();
  return `http://127.0.0.1:${port}`;
}

export async function describeImageRouted(
  imageUrl: string,
  _detail: string | undefined,
  contextText: string,
  routedModel: string,
  config: Pick<OcxConfig, "port" | "apiKeys">,
  settings: VisionSettings,
  abortSignal?: AbortSignal,
  baseUrlOverride?: string,
): Promise<DescribeOutcome> {
  const invalid = validateImageUrl(imageUrl);
  if (invalid) return { text: "", error: invalid };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [VISION_DESCRIBE_TERMINAL_HEADER]: "1",
  };
  const admission = routedDescribeAdmissionToken(config);
  if (admission) headers["x-opencodex-api-key"] = admission;

  const requestBody = {
    model: routedModel,
    stream: false,
    messages: [
      { role: "system", content: DESCRIBE_INSTRUCTION },
      {
        role: "user",
        content: [
          ...(contextText ? [{ type: "text", text: `User's request context: ${contextText}` }] : []),
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  };

  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("vision");
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrlOverride ?? routedDescribeBaseUrl(config)}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: linkedSignal.signal,
      redirect: "manual",
    });
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    try {
      const raw = await res.text();
      if (raw.length > MAX_ROUTED_RESPONSE_BYTES) {
        return { text: "", error: "routed describe response exceeded byte bound" };
      }
      if (!res.ok) {
        return { text: "", error: `routed describe HTTP ${res.status}: ${redactSecretString(raw.slice(0, 200))}` };
      }
      let payload: unknown;
      try { payload = JSON.parse(raw); } catch {
        return { text: "", error: "routed describe returned non-JSON" };
      }
      const content = extractChatContent(payload);
      if (!content) return { text: "", error: "routed describe returned no text" };
      return { text: content };
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[vision] routed describe ${kind} (${Date.now() - t0}ms)`);
    return { text: "", error: redactSecretString(e instanceof Error ? e.message : String(e)) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}

function extractChatContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as { message?: unknown })?.message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" && content.trim().length > 0) return content;
  // Some adapters emit content parts; join text parts.
  if (Array.isArray(content)) {
    const joined = content
      .map(part => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .join("");
    if (joined.trim().length > 0) return joined;
  }
  return undefined;
}
