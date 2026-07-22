import type { OcxUsage } from "../types";
import { kiroTruncationReason } from "./kiro-truncation";

export type ParsedKiroEvent =
  | { type: "content"; data?: string; modelId?: string }
  | { type: "reasoning"; data?: string }
  | { type: "tool"; name?: string; toolUseId?: string; input?: string; stop?: boolean }
  | { type: "truncation"; data: string }
  | { type: "metadata"; usage?: OcxUsage; contextUsagePercentage?: number }
  | { type: "message_metadata"; conversationId?: string }
  | { type: "invalid_state"; message?: string }
  | { type: "error"; reason?: string; message?: string };

const KNOWN_EVENT_TYPES = new Set([
  "assistantResponseEvent",
  "reasoningContentEvent",
  "toolUseEvent",
  "messageMetadataEvent",
  "metadataEvent",
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

function parseTokenUsage(eventType: string, value: unknown): OcxUsage | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    return malformed(eventType, "tokenUsage must be an object");
  }
  const usage = value as Record<string, unknown>;
  const uncached = tokenCount(eventType, usage, "uncachedInputTokens", true);
  const cacheRead = tokenCount(eventType, usage, "cacheReadInputTokens", false);
  const cacheWrite = tokenCount(eventType, usage, "cacheWriteInputTokens", false);
  const outputTokens = tokenCount(eventType, usage, "outputTokens", true);
  const totalTokens = tokenCount(eventType, usage, "totalTokens", true);
  const inputTokens = uncached + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(inputTokens)) return malformed(eventType, "input token usage overflowed");
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: cacheRead,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
  };
}

/** Decode a known Kiro event using its Smithy `:event-type` header. */
export function parseKiroEvent(eventType: string, payload: Uint8Array): ParsedKiroEvent | null {
  // Unknown event types are intentionally ignored without parsing or logging their payload.
  if (!KNOWN_EVENT_TYPES.has(eventType)) return null;
  const parsed = parseObject(eventType, payload);
  const truncationReason = kiroTruncationReason(parsed);
  if (truncationReason) return { type: "truncation", data: truncationReason };

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
      return {
        type: "reasoning",
        ...(optionalString(eventType, parsed, "text") !== undefined
          ? { data: optionalString(eventType, parsed, "text") }
          : {}),
      };
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
      return {
        type: "metadata",
        ...(parseTokenUsage(eventType, parsed.tokenUsage) !== undefined
          ? { usage: parseTokenUsage(eventType, parsed.tokenUsage) }
          : {}),
        ...(typeof contextUsagePercentage === "number" ? { contextUsagePercentage } : {}),
      };
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
