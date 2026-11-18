import {
  isCyberPolicyCode,
  isCyberPolicyMessage,
  isTerminalRefusalCode,
  safetyRefusalCodeFromMessage,
} from "./errors";
import { isNonReplayableUpstreamCode } from "./upstream-retry";

const SERIALIZED_HARD_CODE =
  /\bcode\s*[:=]\s*["']?(?:cyber_policy|origin_rejected|bio_policy|misalignment_policy_violation|invalid_prompt|upstream_no_response|upstream_closed_before_response|upstream_reset_replay_refused)\b/i;

export interface ExtractedJsonEnvelope {
  value: unknown;
  prefix: string;
  suffix: string;
}

const HARD_REFUSAL_TOKEN =
  /\b(?:cyber_policy|origin_rejected|bio_policy|misalignment_policy_violation|invalid_prompt)\b/i;

function isAuthoritativeHardRefusalProse(str: string | undefined): boolean {
  if (!str) return false;
  const s = str.trim();
  if (!s) return false;
  if (isCyberPolicyMessage(s)) return true;
  if (/origin_rejected/i.test(s)) return true;
  if (HARD_REFUSAL_TOKEN.test(s)) return true;
  if (SERIALIZED_HARD_CODE.test(s)) return true;
  if (safetyRefusalCodeFromMessage(s)) return true;
  return false;
}

/**
 * Extract a balanced or prefixed JSON object/array envelope from error text,
 * capturing any authoritative diagnostic prefix and suffix outside the JSON delimiters.
 */
export function extractJsonEnvelopeWithContext(text: string): ExtractedJsonEnvelope | undefined {
  let s = text.trim();
  let strippedPrefix = "";
  for (let d = 0; d < 3; d += 1) {
    if (s.startsWith("Provider error 400: ")) {
      strippedPrefix += s.slice(0, "Provider error 400: ".length);
      s = s.slice("Provider error 400: ".length).trim();
    } else if (s.startsWith("Provider error: ")) {
      strippedPrefix += s.slice(0, "Provider error: ".length);
      s = s.slice("Provider error: ".length).trim();
    } else if (s.startsWith("Gateway error 400: ")) {
      strippedPrefix += s.slice(0, "Gateway error 400: ".length);
      s = s.slice("Gateway error 400: ".length).trim();
    } else if (s.startsWith("Gateway error: ")) {
      strippedPrefix += s.slice(0, "Gateway error: ".length);
      s = s.slice("Gateway error: ".length).trim();
    }
    if (s.startsWith("data:") && !s.includes("\n")) {
      strippedPrefix += s.slice(0, "data:".length);
      s = s.slice("data:".length).trim();
    }
  }
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const value = JSON.parse(s.slice(firstBrace, lastBrace + 1));
      return {
        value,
        prefix: (strippedPrefix + " " + s.slice(0, firstBrace)).trim(),
        suffix: s.slice(lastBrace + 1).trim(),
      };
    } catch {
      // ignore
    }
  }
  const firstBracket = s.indexOf("[");
  const lastBracket = s.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      const value = JSON.parse(s.slice(firstBracket, lastBracket + 1));
      return {
        value,
        prefix: (strippedPrefix + " " + s.slice(0, firstBracket)).trim(),
        suffix: s.slice(lastBracket + 1).trim(),
      };
    } catch {
      // ignore
    }
  }
  return undefined;
}

/**
 * Extract a balanced or prefixed JSON object/array envelope from error text.
 * Strips common gateway prefixes and extracts content between the outermost JSON delimiters.
 */
export function extractJsonEnvelope(text: string): unknown | undefined {
  return extractJsonEnvelopeWithContext(text)?.value;
}

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

  let unescaped = text.trim();
  for (let d = 0; d < 3; d += 1) {
    if (unescaped.startsWith("Provider error 400: ")) {
      unescaped = unescaped.slice("Provider error 400: ".length).trim();
    } else if (unescaped.startsWith("Provider error: ")) {
      unescaped = unescaped.slice("Provider error: ".length).trim();
    } else if (unescaped.startsWith("Gateway error 400: ")) {
      unescaped = unescaped.slice("Gateway error 400: ".length).trim();
    } else if (unescaped.startsWith("Gateway error: ")) {
      unescaped = unescaped.slice("Gateway error: ".length).trim();
    }
    if (unescaped.startsWith("data:") && !unescaped.includes("\n")) {
      unescaped = unescaped.slice("data:".length).trim();
    }
  }

  // Restrict structured policy/origin checks to authoritative diagnostic carriers
  // so echoed user request content (e.g. request.input, prompt, echoed body) does not
  // suppress valid recoveries (#8173).
  let parsed: unknown;
  let hasOuterRefusal = false;
  try {
    parsed = JSON.parse(unescaped);
  } catch {
    const extracted = extractJsonEnvelopeWithContext(unescaped);
    if (extracted) {
      parsed = extracted.value;
      if (
        isAuthoritativeHardRefusalProse(extracted.prefix)
        || isAuthoritativeHardRefusalProse(extracted.suffix)
      ) {
        hasOuterRefusal = true;
      }
    }
  }

  if (hasOuterRefusal) {
    return true;
  }

  if (parsed && typeof parsed === "object") {
    const queue: unknown[] = [parsed];
    let examined = 0;
    while (queue.length > 0 && examined < 32) {
      const candidate = queue.shift();
      examined += 1;
      if (!candidate || typeof candidate !== "object") continue;
      if (Array.isArray(candidate)) {
        if (candidate.length > 32) return true;
        for (const item of candidate) {
          if (item && typeof item === "object") {
            queue.push(item);
          } else if (typeof item === "string") {
            let itemParsed: unknown;
            let itemHasOuterRefusal = false;
            try {
              itemParsed = JSON.parse(item);
            } catch {
              const itemExtracted = extractJsonEnvelopeWithContext(item);
              if (itemExtracted) {
                itemParsed = itemExtracted.value;
                if (
                  isAuthoritativeHardRefusalProse(itemExtracted.prefix)
                  || isAuthoritativeHardRefusalProse(itemExtracted.suffix)
                ) {
                  itemHasOuterRefusal = true;
                }
              }
            }

            if (itemHasOuterRefusal) {
              return true;
            }

            if (itemParsed && typeof itemParsed === "object") {
              queue.push(itemParsed);
            } else if (isAuthoritativeHardRefusalProse(item)) {
              return true;
            }
          }
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

      // Authoritative diagnostic carriers only (avoid request echo fields like input, prompt, request, body, reason).
      // Parse structured diagnostic strings first so nested request echo is not matched by prose rules (#8173).
      for (const field of ["message", "error", "details", "detail", "last_error", "response", "errors"] as const) {
        const val = rec[field];
        if (typeof val === "string") {
          let innerParsed: unknown;
          let innerHasOuterRefusal = false;
          try {
            innerParsed = JSON.parse(val);
          } catch {
            const innerExtracted = extractJsonEnvelopeWithContext(val);
            if (innerExtracted) {
              innerParsed = innerExtracted.value;
              if (
                isAuthoritativeHardRefusalProse(innerExtracted.prefix)
                || isAuthoritativeHardRefusalProse(innerExtracted.suffix)
              ) {
                innerHasOuterRefusal = true;
              }
            }
          }

          if (innerHasOuterRefusal) {
            return true;
          }

          if (innerParsed && typeof innerParsed === "object") {
            queue.push(innerParsed);
          } else if (isAuthoritativeHardRefusalProse(val)) {
            return true;
          }
        } else if (val && typeof val === "object") {
          queue.push(val);
        }
      }
    }
    return false;
  }

  if (isAuthoritativeHardRefusalProse(unescaped)) return true;

  return false;
}
