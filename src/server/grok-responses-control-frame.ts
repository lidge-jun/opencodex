import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";

const GROK_CONTROL_FRAME_TYPES: Record<string, true> = {
  "codex.rate_limits": true,
  "codex.response.metadata": true,
};

const GROK_RESPONSE_INTEGER_TIMESTAMP_FIELDS = ["created_at", "completed_at"] as const;

type JsonRange = { start: number; end: number };

function skipJsonWhitespace(payload: string, index: number): number {
  while (index < payload.length && /[\t\n\r ]/.test(payload[index] ?? "")) index += 1;
  return index;
}

function findJsonStringEnd(payload: string, start: number): number | undefined {
  for (let index = start + 1; index < payload.length; index += 1) {
    if (payload[index] === "\\") index += 1;
    else if (payload[index] === '"') return index + 1;
  }
  return undefined;
}

function findJsonValueEnd(payload: string, start: number): number | undefined {
  if (payload[start] === '"') return findJsonStringEnd(payload, start);
  if (payload[start] !== "{" && payload[start] !== "[") {
    let index = start;
    while (index < payload.length && !",}]".includes(payload[index] ?? "")) index += 1;
    return index;
  }

  let depth = 0;
  let inString = false;
  for (let index = start; index < payload.length; index += 1) {
    const char = payload[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

function findResponseObjectRange(payload: string): JsonRange | null {
  let cursor = skipJsonWhitespace(payload, 0);
  if (payload[cursor] !== "{") return null;
  cursor += 1;
  let responseRange: JsonRange | null = null;

  while (cursor < payload.length) {
    cursor = skipJsonWhitespace(payload, cursor);
    if (payload[cursor] === "}") return responseRange;
    if (payload[cursor] !== '"') return null;
    const keyEnd = findJsonStringEnd(payload, cursor);
    if (keyEnd === undefined) return null;
    let key: unknown;
    try {
      key = JSON.parse(payload.slice(cursor, keyEnd));
    } catch {
      return null;
    }

    cursor = skipJsonWhitespace(payload, keyEnd);
    if (payload[cursor] !== ":") return null;
    const valueStart = skipJsonWhitespace(payload, cursor + 1);
    const valueEnd = findJsonValueEnd(payload, valueStart);
    if (valueEnd === undefined) return null;
    if (key === "response" && payload[valueStart] === "{") {
      responseRange = { start: valueStart, end: valueEnd };
    }

    cursor = skipJsonWhitespace(payload, valueEnd);
    if (payload[cursor] === "}") return responseRange;
    if (payload[cursor] !== ",") return null;
    cursor += 1;
  }
  return null;
}

function rewriteIntegralTimestamp(payload: string, field: string, value: number, event: unknown): string | null {
  const responseRange = findResponseObjectRange(payload);
  if (responseRange === null) return null;
  let cursor = responseRange.start + 1;
  let candidate: { start: number; length: number } | null = null;
  while (cursor < responseRange.end) {
    cursor = skipJsonWhitespace(payload, cursor);
    if (payload[cursor] === "}") break;
    if (payload[cursor] !== '"') return null;
    const keyEnd = findJsonStringEnd(payload, cursor);
    if (keyEnd === undefined) return null;
    let key: unknown;
    try {
      key = JSON.parse(payload.slice(cursor, keyEnd));
    } catch {
      return null;
    }
    cursor = skipJsonWhitespace(payload, keyEnd);
    if (payload[cursor] !== ":") return null;
    const valueStart = skipJsonWhitespace(payload, cursor + 1);
    const valueEnd = findJsonValueEnd(payload, valueStart);
    if (valueEnd === undefined || valueEnd > responseRange.end) return null;
    const valueToken = payload.slice(valueStart, valueEnd).trimEnd();
    if (
      key === field &&
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(valueToken) &&
      valueToken !== String(value) &&
      Number(valueToken) === value
    ) {
      if (candidate !== null) return null;
      candidate = { start: valueStart, length: valueToken.length };
    }
    cursor = skipJsonWhitespace(payload, valueEnd);
    if (payload[cursor] === "}") break;
    if (payload[cursor] !== ",") return null;
    cursor += 1;
  }
  if (candidate === null) return payload;

  const rewritten = `${payload.slice(0, candidate.start)}${value}${payload.slice(candidate.start + candidate.length)}`;
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
