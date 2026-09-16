import type { OcxUsage } from "../types";
import { kiroTruncationReason } from "./kiro-truncation";

export type ParsedKiroEvent =
  | { type: "content"; data?: string; modelId?: string }
  | { type: "reasoning"; data?: string; signature?: string; redactedContent?: string }
  | { type: "context_usage"; contextUsagePercentage: number }
  | { type: "tool"; name?: string; toolUseId?: string; input?: string; stop?: boolean }
  | { type: "truncation"; data: string }
  | { type: "metadata"; usage?: OcxUsage; contextUsagePercentage?: number; stopReason?: string }
  | { type: "message_metadata"; conversationId?: string }
  | { type: "invalid_state"; message?: string }
  | { type: "error"; reason?: string; message?: string };

const KNOWN_EVENT_TYPES = new Set([
  "assistantResponseEvent",
  "reasoningContentEvent",
  "toolUseEvent",
  "messageMetadataEvent",
  "metadataEvent",
  // Authoritative context pressure. Every capture (kiro-cli 2.14.1 and 2.16.0) put the percentage
  // HERE and left `metadataEvent` carrying only `stopReason`; metadataEvent's own
  // contextUsagePercentage stays supported as a fallback rather than being dropped.
  "contextUsageEvent",
  "invalidStateEvent",
  "error",
]);

function malformed(eventType: string, detail: string): never {
  throw new Error(`invalid Kiro ${eventType} payload: ${detail}`);
}

function parseObject(eventType: string, payload: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return malformed(eventType, "expected valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return malformed(eventType, "expected an object");
  }
  return value as Record<string, unknown>;
}

function optionalString(eventType: string, obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return malformed(eventType, `${key} must be a string`);
  return value;
}

function optionalBoolean(eventType: string, obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") return malformed(eventType, `${key} must be a boolean`);
  return value;
}

function tokenCount(eventType: string, obj: Record<string, unknown>, key: string, required: boolean): number {
  const value = obj[key];
  if (value === undefined && !required) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return malformed(eventType, `${key} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * A cache counter Kiro did not report, kept as unknown rather than zero (#4546).
 *
 * `OcxUsage` omits cache fields it has no reading for, and `cacheHitRate` is null when
 * unobserved -- the convention everywhere except here. Coercing an absent counter to 0 makes
 * "the provider said nothing" indistinguishable from "nothing was cached", which is the
 * difference between a routing change that preserved the prompt cache and one that destroyed
 * it. A malformed value is still a malformed event; only absence is unknown.
 */
function optionalTokenCount(
  eventType: string,
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  if (obj[key] === undefined) return undefined;
  return tokenCount(eventType, obj, key, true);
}

function parseTokenUsage(eventType: string, value: unknown): OcxUsage | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    return malformed(eventType, "tokenUsage must be an object");
  }
  const usage = value as Record<string, unknown>;
  const uncached = tokenCount(eventType, usage, "uncachedInputTokens", true);
  const cacheRead = optionalTokenCount(eventType, usage, "cacheReadInputTokens");
  const cacheWrite = optionalTokenCount(eventType, usage, "cacheWriteInputTokens");
  const outputTokens = tokenCount(eventType, usage, "outputTokens", true);
  const totalTokens = tokenCount(eventType, usage, "totalTokens", true);
  // An unreported counter contributes nothing to the total, which is a different statement
  // from claiming it was measured as zero.
  const inputTokens = uncached + (cacheRead ?? 0) + (cacheWrite ?? 0);
  if (!Number.isSafeInteger(inputTokens)) return malformed(eventType, "input token usage overflowed");
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheRead !== undefined ? { cachedInputTokens: cacheRead, cacheReadInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheCreationInputTokens: cacheWrite } : {}),
  };
}

/** Decode a known Kiro event using its Smithy `:event-type` header. */
export function parseKiroEvent(eventType: string, payload: Uint8Array): ParsedKiroEvent | null {
  // Unknown event types are intentionally ignored without parsing or logging their payload.
  if (!KNOWN_EVENT_TYPES.has(eventType)) return null;
  const parsed = parseObject(eventType, payload);
  // A metadataEvent's `stopReason` is Kiro's own terminal verdict and must reach the parser
  // intact. The generic truncation sniffer matches substrings ("max_tokens", "length",
  // "context_length") across several keys, so it would swallow MAX_TOKENS before the switch
  // below ever runs. Gate on position rather than on the value: a value allowlist would keep
  // eating future reasons such as LENGTH_LIMIT, which matches the pattern today.
  const nativeStopReason = eventType === "metadataEvent"
    ? optionalString(eventType, parsed, "stopReason")
    : undefined;
  if (nativeStopReason === undefined) {
    const truncationReason = kiroTruncationReason(parsed);
    if (truncationReason) return { type: "truncation", data: truncationReason };
  }

  switch (eventType) {
    case "assistantResponseEvent":
      return {
        type: "content",
        ...(optionalString(eventType, parsed, "content") !== undefined
          ? { data: optionalString(eventType, parsed, "content") }
          : {}),
        ...(optionalString(eventType, parsed, "modelId") !== undefined
          ? { modelId: optionalString(eventType, parsed, "modelId") }
          : {}),
      };
    case "reasoningContentEvent":
      // `text` is plaintext reasoning; the GPT-5.6 family (sol/terra/luna) instead returns an
      // encrypted blob, and the field it arrives on has to be replayed unchanged (see
      // kiro/reasoning.ts): `signature` carries the `.KTR~~…` value verbatim and is what every
      // capture of those models sent, while `redactedContent` — the base64 shape a capture has
      // never shown — stays accepted for any model that sends it. Keyed off the wire field, not the
      // model id. Any of the three may be absent on a bare event.
      {
        const text = optionalString(eventType, parsed, "text");
        const signature = optionalString(eventType, parsed, "signature");
        const redacted = optionalString(eventType, parsed, "redactedContent");
        return {
          type: "reasoning",
          ...(text !== undefined ? { data: text } : {}),
          ...(signature !== undefined
            ? { signature }
            : redacted !== undefined
              ? { redactedContent: redacted }
              : {}),
        };
      }
    case "toolUseEvent":
      return {
        type: "tool",
        ...(optionalString(eventType, parsed, "name") !== undefined
          ? { name: optionalString(eventType, parsed, "name") }
          : {}),
        ...(optionalString(eventType, parsed, "toolUseId") !== undefined
          ? { toolUseId: optionalString(eventType, parsed, "toolUseId") }
          : {}),
        ...(optionalString(eventType, parsed, "input") !== undefined
          ? { input: optionalString(eventType, parsed, "input") }
          : {}),
        ...(optionalBoolean(eventType, parsed, "stop") !== undefined
          ? { stop: optionalBoolean(eventType, parsed, "stop") }
          : {}),
      };
    case "messageMetadataEvent":
      return {
        type: "message_metadata",
        conversationId:
          optionalString(eventType, parsed, "conversationId")
          ?? optionalString(eventType, parsed, "utteranceId"),
      };
    case "metadataEvent": {
      const contextUsagePercentage = parsed.contextUsagePercentage;
      if (
        contextUsagePercentage !== undefined
        && (typeof contextUsagePercentage !== "number" || !Number.isFinite(contextUsagePercentage))
      ) {
        return malformed(eventType, "contextUsagePercentage must be a finite number");
      }
      const stopReason = optionalString(eventType, parsed, "stopReason");
      return {
        type: "metadata",
        ...(parseTokenUsage(eventType, parsed.tokenUsage) !== undefined
          ? { usage: parseTokenUsage(eventType, parsed.tokenUsage) }
          : {}),
        ...(typeof contextUsagePercentage === "number" ? { contextUsagePercentage } : {}),
        ...(stopReason !== undefined ? { stopReason } : {}),
      };
    }
    case "contextUsageEvent": {
      const contextUsagePercentage = parsed.contextUsagePercentage;
      if (typeof contextUsagePercentage !== "number" || !Number.isFinite(contextUsagePercentage)) {
        return malformed(eventType, "contextUsagePercentage must be a finite number");
      }
      return { type: "context_usage", contextUsagePercentage };
    }
    case "invalidStateEvent":
      return { type: "invalid_state", message: optionalString(eventType, parsed, "message") };
    case "error":
      return {
        type: "error",
        reason:
          optionalString(eventType, parsed, "reason")
          ?? optionalString(eventType, parsed, "type")
          ?? optionalString(eventType, parsed, "__type"),
        message:
          optionalString(eventType, parsed, "message")
          ?? optionalString(eventType, parsed, "Message"),
      };
  }
  return null;
}
