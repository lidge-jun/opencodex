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
 * Destination (#4236) and transport: postLocalChatCompletion in
 * src/lib/local-chat-completion.ts, which resolves the unauthenticated
 * loopback listener when one is enabled and otherwise the BIND address.
 */
import type { OcxConfig } from "../types";
import { localAdmissionToken } from "../lib/local-destinations";
import { localChatCompletionBaseUrl, postLocalChatCompletion } from "../lib/local-chat-completion";
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

/**
 * The admission ladder: env token, hardened service token file, first configured API key.
 *
 * Shared with every other local client through `localAdmissionToken` so the credential this
 * self-fetch presents cannot drift from the one the Codex provider table and the Claude launch
 * env carry. Never the admin token.
 */
export function routedDescribeAdmissionToken(config: Pick<OcxConfig, "apiKeys">): string | undefined {
  return localAdmissionToken(config);
}

/** Base URL seam for tests; production always self-fetches the resolved local destination. */
export function routedDescribeBaseUrl(
  config: Pick<OcxConfig, "port" | "hostname" | "unauthenticatedLoopbackListener">,
): string {
  return localChatCompletionBaseUrl(config);
}

export async function describeImageRouted(
  imageUrl: string,
  _detail: string | undefined,
  contextText: string,
  routedModel: string,
  config: Pick<OcxConfig, "port" | "hostname" | "apiKeys" | "unauthenticatedLoopbackListener">,
  settings: VisionSettings,
  abortSignal?: AbortSignal,
  baseUrlOverride?: string,
): Promise<DescribeOutcome> {
  const invalid = validateImageUrl(imageUrl);
  if (invalid) return { text: "", error: invalid };

  return postLocalChatCompletion({
    config,
    label: "routed describe",
    logTag: "vision",
    timeoutMs: settings.timeoutMs,
    maxResponseBytes: MAX_ROUTED_RESPONSE_BYTES,
    headers: { [VISION_DESCRIBE_TERMINAL_HEADER]: "1" },
    abortSignal,
    baseUrlOverride,
    body: {
      model: routedModel,
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
    },
  });
}
