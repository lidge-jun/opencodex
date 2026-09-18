import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";

const GROK_CONTROL_FRAME_TYPES: Record<string, true> = {
  "codex.rate_limits": true,
  "codex.response.metadata": true,
};

const GROK_RESPONSE_INTEGER_TIMESTAMP_FIELDS = ["created_at", "completed_at"] as const;

function rewriteIntegralTimestamp(payload: string, field: string, value: number, event: unknown): string | null {
  const fieldPattern = new RegExp(
    `"${field}"(\\s*:\\s*)(-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)(?=\\s*[,}])`,
    "g",
  );
  let candidate: RegExpExecArray | null = null;
  for (const match of payload.matchAll(fieldPattern)) {
    if (match[2] === String(value) || Number(match[2]) !== value) continue;
    if (candidate !== null) return null;
    candidate = match;
  }
  if (candidate?.index === undefined) return payload;

  const numberOffset = candidate.index + candidate[0].lastIndexOf(candidate[2]);
  const rewritten = `${payload.slice(0, numberOffset)}${value}${payload.slice(numberOffset + candidate[2].length)}`;
  try {
    return JSON.stringify(JSON.parse(rewritten)) === JSON.stringify(event) ? rewritten : null;
  } catch {
    return null;
  }
}

/**
 * Hide Codex-only control frames from Grok's strict Responses decoder.
 *
 * The inspection branch still sees these frames before this client-facing
 * rewrite, so quota accounting and response metadata remain available to the
 * proxy while Grok receives only its declared Responses event variants.
 */
export function createGrokResponsesControlFrameBlockRewrite(): SseBlockRewrite {
  return (block) => {
    let eventName = "";
    // SSE overwrites the event type on every event field, including empty resets.
    // Like sseDataPayload, remove only one optional ASCII space after the colon.
    for (const line of block.split(/\r?\n/)) {
      if (line === "event") eventName = "";
      else if (line.startsWith("event:")) {
        const value = line.slice("event:".length);
        eventName = value.startsWith(" ") ? value.slice(1) : value;
      }
    }
    if (GROK_CONTROL_FRAME_TYPES[eventName] === true) return [];

    const payload = sseDataPayload(block);
    if (payload === null || payload === "[DONE]") return [block];

    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return [block];
    }
    if (!event || typeof event !== "object" || Array.isArray(event) || !("type" in event)) return [block];
    return typeof event.type === "string" && GROK_CONTROL_FRAME_TYPES[event.type] === true
      ? []
      : [block];
  };
}

/** Normalize safe integer response timestamps for Grok's strict Responses decoder. */
export function createGrokResponsesTimestampBlockRewrite(): SseBlockRewrite {
  return (block) => {
    const payload = sseDataPayload(block);
    if (payload === null || payload === "[DONE]") return [block];

    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return [block];
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return [block];
    const eventRecord = event as Record<string, unknown>;
    if (typeof eventRecord.type !== "string" || !eventRecord.type.startsWith("response.")) return [block];
    if (!eventRecord.response || typeof eventRecord.response !== "object" || Array.isArray(eventRecord.response)) {
      return [block];
    }
    const response = eventRecord.response as Record<string, unknown>;
    let rewrittenPayload = payload;
    for (const field of GROK_RESPONSE_INTEGER_TIMESTAMP_FIELDS) {
      const value = response[field];
      if (value === undefined) continue;
      if (typeof value !== "number" || value < 0 || !Number.isSafeInteger(value)) return [block];
      const rewritten = rewriteIntegralTimestamp(rewrittenPayload, field, value, event);
      if (rewritten === null) return [block];
      rewrittenPayload = rewritten;
    }
    return rewrittenPayload === payload ? [block] : [replaceSseDataPayload(block, rewrittenPayload)];
  };
}
