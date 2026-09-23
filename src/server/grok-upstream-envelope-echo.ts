import { ToolEnvelopeEchoFilter, stripToolEnvelopeEcho } from "../lib/tool-envelope-echo-filter";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function outputText(value: unknown, replacement?: (index: number, content: number, text: string) => string): void {
  if (!record(value) || !Array.isArray(value.output)) return;
  value.output.forEach((item: unknown, index: number) => {
    if (!record(item) || !Array.isArray(item.content)) return;
    item.content.forEach((part: unknown, content: number) => {
      if (record(part) && part.type === "output_text" && typeof part.text === "string") {
        part.text = replacement?.(index, content, part.text) ?? stripToolEnvelopeEcho(part.text);
      }
    });
  });
}

/**
 * The echo only appears when the model has seen a replayed tool envelope: a tool call or tool output
 * in this request's input, or a stored conversation continued through previous_response_id (its history
 * lives upstream and may hold tool results). A first turn with neither is never filtered, so a
 * legitimate answer that starts a line with "[Tool Result]" reaches the client intact.
 */
export function responsesRequestMayReplayToolOutput(rawBody: unknown): boolean {
  if (!record(rawBody)) return false;
  if (typeof rawBody.previous_response_id === "string" && rawBody.previous_response_id !== "") return true;
  if (!Array.isArray(rawBody.input)) return false;
  // A tool call counts too: xAI's paired tool-result repair answers a dangling call with a synthetic
  // output on the outbound request, so the model sees a tool result the caller never sent.
  return rawBody.input.some(item => record(item) && typeof item.type === "string" && /_call(_output)?$/.test(item.type));
}

/** Completed non-streaming Responses bodies use the same line-aware marker rule. */
export function stripGrokUpstreamEnvelopeEchoFromResponsesJson(json: string): string {
  try {
    const value = JSON.parse(json) as unknown;
    outputText(value);
    return JSON.stringify(value);
  } catch {
    return json;
  }
}

type TextState = {
  filter: ToolEnvelopeEchoFilter;
  delivered: string;
  lastDeltaBlock: string;
  lastDeltaEvent: Record<string, unknown>;
};

/** Keep xAI text deltas, done events, terminal snapshots and replay state in agreement. */
export function createGrokUpstreamEnvelopeEchoBlockRewrite(
  onCompletedResponse?: (response: Record<string, unknown>) => void,
): SseBlockRewrite {
  const states = new Map<string, TextState>();
  const key = (output: unknown, content: unknown): string =>
    `${typeof output === "number" ? output : 0}:${typeof content === "number" ? content : 0}`;
  const flush = (state: TextState): string[] => {
    const suffix = state.filter.finish();
    if (!suffix) return [];
    state.delivered += suffix;
    return [replaceSseDataPayload(state.lastDeltaBlock, JSON.stringify({ ...state.lastDeltaEvent, delta: suffix }))];
  };
  return (block) => {
    const payload = sseDataPayload(block);
    if (payload === null) return [block];
    if (payload === "[DONE]") return [...[...states.values()].flatMap(flush), block];
    let event: unknown;
    try { event = JSON.parse(payload); } catch { return [block]; }
    if (!record(event) || typeof event.type !== "string") return [block];
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      const id = key(event.output_index, event.content_index);
      let state = states.get(id);
      if (!state) {
        state = { filter: new ToolEnvelopeEchoFilter(), delivered: "", lastDeltaBlock: block, lastDeltaEvent: event };
        states.set(id, state);
      }
      state.lastDeltaBlock = block;
      state.lastDeltaEvent = event;
      const delta = state.filter.feed(event.delta);
      state.delivered += delta;
      if (!delta) return [];
      return [replaceSseDataPayload(block, JSON.stringify({ ...event, delta }))];
    }
    if (event.type === "response.output_text.done") {
      const state = states.get(key(event.output_index, event.content_index));
      if (!state) {
        if (typeof event.text !== "string") return [block];
        event.text = stripToolEnvelopeEcho(event.text);
        return [replaceSseDataPayload(block, JSON.stringify(event))];
      }
      const pending = flush(state);
      event.text = state.delivered;
      return [...pending, replaceSseDataPayload(block, JSON.stringify(event))];
    }
    if (event.type === "response.output_item.done" && record(event.item)) {
      const index = typeof event.output_index === "number" ? event.output_index : 0;
      const pending: string[] = [];
      if (Array.isArray(event.item.content)) {
        event.item.content.forEach((part: unknown, content: number) => {
          if (!record(part) || part.type !== "output_text" || typeof part.text !== "string") return;
          const state = states.get(key(index, content));
          if (state) { pending.push(...flush(state)); part.text = state.delivered; }
          else part.text = stripToolEnvelopeEcho(part.text);
        });
      }
      return [...pending, replaceSseDataPayload(block, JSON.stringify(event))];
    }
    if (event.type === "response.completed" && record(event.response)) {
      const pending = [...states.values()].flatMap(flush);
      outputText(event.response, (index, content, text) =>
        states.get(key(index, content))?.delivered ?? stripToolEnvelopeEcho(text));
      onCompletedResponse?.(event.response);
      return [...pending, replaceSseDataPayload(block, JSON.stringify(event))];
    }
    return [block];
  };
}
