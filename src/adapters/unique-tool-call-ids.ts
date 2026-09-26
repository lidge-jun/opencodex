import type { ProviderAdapter } from "./base";
import type { AdapterEvent, OcxMessage } from "../types";
import { createToolCallIdReminter, reservedToolCallIdsFromHistory } from "./openai-chat/tool-call-id-remint";

/**
 * Give every tool call in a conversation a wire id the client has not already stored.
 *
 * The openai-chat adapter forwards `tool_calls[].id` upstream-verbatim, which is correct for an
 * upstream that mints a fresh random id per call. An upstream that derives the id from the call's
 * position in its response mints the same `call-0-0` on every turn. The client has already paired
 * that id with an earlier call, so it drops the duplicate; the dropped call has no result, the turn
 * reads as an assistant message with no content, and the model re-issues the same call forever.
 *
 * Applied as a wrapper rather than inside the adapter so the adapter's own id handling stays
 * untouched, matching how this repository already scopes a wire-compatibility policy
 * (`withClinePassDeepSeekV4ToolReplayCompatibility`).
 *
 * Reminting happens at emission — on the events the adapter yields — never at ingestion: ingestion
 * matches streamed deltas and continuation fragments against the id the upstream sent, so rewriting
 * there would strip a pending call of its own identity mid-stream. The ids to avoid come from the
 * caller's own history, captured where the request is built because that is the only point that sees
 * the inbound conversation; the client is the authority on which ids are taken, since it is the side
 * that discards the duplicates the proxy would otherwise never observe.
 *
 * The first occurrence of an id is emitted byte-identical, so prompt-cache keys, reasoning-replay
 * lookups, and upstreams that already mint unique ids are unaffected.
 */
export function withUniqueToolCallIds(adapter: ProviderAdapter): ProviderAdapter {
  // Set where the request is built and consumed by the two emission paths below — the same
  // build-into-parse handoff the openai-chat adapter already uses for its requested model id. The
  // identity default means a parse that runs without a build cannot fail: it has no history to
  // collide with.
  let remintToolCallId: (rawId: string) => string = id => id;

  const remintEvents = (events: AdapterEvent[]): AdapterEvent[] =>
    events.map(event => event.type === "tool_call_start" ? { ...event, id: remintToolCallId(event.id) } : event);

  return {
    ...adapter,

    async buildRequest(parsed, incoming) {
      const history: OcxMessage[] | undefined = parsed.context?.messages;
      remintToolCallId = createToolCallIdReminter(
        Array.isArray(history) ? reservedToolCallIdsFromHistory(history) : [],
      );
      return adapter.buildRequest(parsed, incoming);
    },

    async *parseStream(response, budget, tierMetadata): AsyncGenerator<AdapterEvent> {
      for await (const event of adapter.parseStream(response, budget, tierMetadata)) {
        yield event.type === "tool_call_start" ? { ...event, id: remintToolCallId(event.id) } : event;
      }
    },

    ...(adapter.parseResponse
      ? {
        async parseResponse(response, budget, tierMetadata) {
          return remintEvents(await adapter.parseResponse!(response, budget, tierMetadata));
        },
      }
      : {}),
  };
}
