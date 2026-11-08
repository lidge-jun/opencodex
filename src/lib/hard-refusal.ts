import {
  isCyberPolicyCode,
  isCyberPolicyMessage,
  isTerminalRefusalCode,
  safetyRefusalCodeFromMessage,
} from "./errors";
import { isNonReplayableUpstreamCode } from "./upstream-retry";

const SERIALIZED_HARD_CODE =
  /\bcode\s*[:=]\s*["']?(?:cyber_policy|origin_rejected|bio_policy|misalignment_policy_violation|invalid_prompt|upstream_no_response|upstream_closed_before_response|upstream_reset_replay_refused)\b/i;

/**
 * Detect a hard policy or origin refusal across known upstream envelope shapes and diagnostic text.
 * When an error is a hard refusal (e.g. cyber_policy, origin_rejected, bio_policy), recovery must
 * stop immediately without retrying or walking any parameter ladders (#8173).
 *
 * Traverses bounded nested wrappers (e.g. Provider error 400, data:, nested error JSON) so wrapped
 * policy refusals are recognized rather than treated as prose.
 */
export function isHardPolicyOrOriginRefusal(text: string | undefined, depth = 0): boolean {
  if (!text || depth > 4) return false;
  if (isCyberPolicyMessage(text)) return true;
  if (/origin_rejected/i.test(text)) return true;
  if (SERIALIZED_HARD_CODE.test(text)) return true;

  let unescaped = text.trim();
  for (let d = 0; d < 3; d += 1) {
    if (unescaped.startsWith("Provider error 400: ")) {
      unescaped = unescaped.slice("Provider error 400: ".length).trim();
    }
    if (unescaped.startsWith("data:") && !unescaped.includes("\n")) {
      unescaped = unescaped.slice("data:".length).trim();
    }
  }

  try {
    const parsed = JSON.parse(unescaped) as Record<string, unknown>;
    const queue: unknown[] = [
      parsed,
      parsed.error,
      (parsed.response as Record<string, unknown> | undefined)?.error,
      (parsed.response as Record<string, unknown> | undefined)?.last_error,
      parsed.last_error,
    ];
    let examined = 0;
    while (queue.length > 0 && examined < 32) {
      const candidate = queue.shift();
      examined += 1;
      if (!candidate || typeof candidate !== "object") continue;
      if (Array.isArray(candidate)) {
        for (const item of candidate) {
          if (item && typeof item === "object") queue.push(item);
        }
        continue;
      }
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

      for (const field of ["message", "error", "details", "body", "reason", "last_error", "response"] as const) {
        const val = rec[field];
        if (typeof val === "string") {
          if (
            isCyberPolicyMessage(val)
            || /origin_rejected/i.test(val)
            || safetyRefusalCodeFromMessage(val)
            || isHardPolicyOrOriginRefusal(val, depth + 1)
          ) {
            return true;
          }
        } else if (val && typeof val === "object") {
          queue.push(val);
        }
      }
    }
  } catch {
    /* non-JSON payload handled by text matches above */
  }

  return false;
}
