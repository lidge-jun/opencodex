import { CursorMidstreamEchoObserver, stripAssistantEchoedToolEnvelope } from "../adapters/cursor/envelope-echo";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stripOutputTextFields(value: unknown): boolean {
  let stripped = false;
  if (Array.isArray(value)) {
    for (const item of value) stripped = stripOutputTextFields(item) || stripped;
    return stripped;
  }
  if (!isRecord(value)) return false;
  if (typeof value.text === "string") {
    const next = stripAssistantEchoedToolEnvelope(value.text);
    if (next !== value.text) {
      value.text = next;
      stripped = true;
    }
  }
  if (typeof value.delta === "string") {
    const next = stripAssistantEchoedToolEnvelope(value.delta);
    if (next !== value.delta) {
      value.delta = next;
      stripped = true;
    }
  }
  for (const nested of Object.values(value)) {
    stripped = stripOutputTextFields(nested) || stripped;
  }
  return stripped;
}

/** Strip a whole-line [Tool Result] echo from a completed Responses JSON body. */
export function stripGrokUpstreamEnvelopeEchoFromResponsesJson(json: string): string {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!stripOutputTextFields(parsed)) return json;
    return JSON.stringify(parsed);
  } catch {
    return json;
  }
}

/**
 * Drop grok-4.6 mid-turn [Tool Result] envelopes on the xAI Responses SSE path.
 * Cursor already quarantines this on protobuf; xAI relays SSE verbatim, so the
 * same paste otherwise lands in Codex as a successful final answer.
 */
export function createGrokUpstreamEnvelopeEchoBlockRewrite(): SseBlockRewrite {
  const observer = new CursorMidstreamEchoObserver();
  let suppress = false;
  const rewrite: SseBlockRewrite = (block) => {
    const payload = sseDataPayload(block);
    if (payload === null || payload === "[DONE]") return [block];
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return [block];
    }
    if (!isRecord(event) || typeof event.type !== "string") return [block];
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      if (suppress) return [];
      observer.feed(event.delta);
      const kept = stripAssistantEchoedToolEnvelope(event.delta);
      const found = observer.findings().length > 0 || kept !== event.delta;
      if (!found) return [block];
      suppress = true;
      if (!kept || kept === event.delta) return [];
      event.delta = kept;
      return [replaceSseDataPayload(block, JSON.stringify(event))];
    }
    if (suppress && event.type === "response.output_text.delta") return [];
    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      const kept = stripAssistantEchoedToolEnvelope(event.text);
      if (kept === event.text) return [block];
      event.text = kept;
      return [replaceSseDataPayload(block, JSON.stringify(event))];
    }
    if (event.type === "response.completed" || event.type === "response.output_item.done") {
      if (stripOutputTextFields(event)) {
        return [replaceSseDataPayload(block, JSON.stringify(event))];
      }
    }
    return [block];
  };
  return rewrite;
}
