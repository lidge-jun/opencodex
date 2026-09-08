import { sseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";

const GROK_CONTROL_FRAME_TYPES: Record<string, true> = {
  "codex.rate_limits": true,
  "codex.response.metadata": true,
};

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
