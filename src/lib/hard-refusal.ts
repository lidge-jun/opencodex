import {
  isCyberPolicyCode,
  isCyberPolicyMessage,
  isTerminalRefusalCode,
  safetyRefusalCodeFromMessage,
} from "./errors";
import { isNonReplayableUpstreamCode } from "./upstream-retry";

/**
 * Detect a hard policy or origin refusal across known upstream envelope shapes and diagnostic text.
 * When an error is a hard refusal (e.g. cyber_policy, origin_rejected, bio_policy), recovery must
 * stop immediately without retrying or walking any parameter ladders (#8173).
 */
export function isHardPolicyOrOriginRefusal(text: string | undefined): boolean {
  if (!text) return false;
  if (isCyberPolicyMessage(text)) return true;
  if (/origin_rejected/i.test(text)) return true;

  let unescaped = text.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    if (unescaped.startsWith("Provider error 400: ")) {
      unescaped = unescaped.slice("Provider error 400: ".length).trim();
    }
    if (unescaped.startsWith("data:") && !unescaped.includes("\n")) {
      unescaped = unescaped.slice("data:".length).trim();
    }
  }

  try {
    const parsed = JSON.parse(unescaped) as Record<string, unknown>;
    const candidates = [
      parsed.error,
      (parsed.response as Record<string, unknown> | undefined)?.error,
      (parsed.response as Record<string, unknown> | undefined)?.last_error,
      parsed.last_error,
      parsed,
    ];

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const rec = candidate as Record<string, unknown>;

      const code = typeof rec.code === "string" ? rec.code.trim().toLowerCase().replaceAll("-", "_") : undefined;
      if (code) {
        if (
          isCyberPolicyCode(code)
          || code === "origin_rejected"
          || isTerminalRefusalCode(code)
          || isNonReplayableUpstreamCode(code)
        ) {
          return true;
        }
      }

      const type = typeof rec.type === "string" ? rec.type.trim().toLowerCase().replaceAll("-", "_") : undefined;
      if (type) {
        if (
          isCyberPolicyCode(type)
          || type === "origin_rejected"
          || isTerminalRefusalCode(type)
        ) {
          return true;
        }
      }

      if (typeof rec.message === "string") {
        if (
          isCyberPolicyMessage(rec.message)
          || /origin_rejected/i.test(rec.message)
          || safetyRefusalCodeFromMessage(rec.message)
        ) {
          return true;
        }
      }

      if (typeof rec.error === "string") {
        if (
          isCyberPolicyMessage(rec.error)
          || /origin_rejected/i.test(rec.error)
          || safetyRefusalCodeFromMessage(rec.error)
        ) {
          return true;
        }
      }
    }
  } catch {
    /* non-JSON payload handled by text matches above */
  }

  return false;
}
