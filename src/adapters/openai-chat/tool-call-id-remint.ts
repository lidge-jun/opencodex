import { isConformingToolCallId, MAX_TOOL_CALL_ID_LENGTH } from "../tool-call-id";
import type { OcxMessage } from "../../types";

/**
 * Remint a tool-call id the client's history already carries.
 *
 * Some upstreams mint tool-call ids deterministically per RESPONSE rather than per call: the same
 * `call-0-0` on every turn of a conversation. Anthropic's wire requires `tool_use.id` to identify
 * one call, and a client that has already stored that id for an earlier call cannot pair the new
 * result to the new call — it drops one of them, the turn becomes an assistant message whose
 * tool call has no result, and the model re-issues the same call forever.
 *
 * The first occurrence of an id is emitted byte-identical, so prompt-cache keys, reasoning-replay
 * lookups, and every upstream that already mints unique ids stay untouched. Only a repeat — against
 * the history the caller seeded, or against a call already emitted in this response — is rewritten,
 * to the smallest unused suffix that still fits Anthropic's id bound.
 */
export function createToolCallIdReminter(reservedIds: Iterable<string>): (rawId: string) => string {
  const occupied = new Set(reservedIds);
  const nextSuffixByBase = new Map<string, number>();
  return rawId => {
    if (!occupied.has(rawId)) {
      occupied.add(rawId);
      return rawId;
    }
    // A non-conforming source is sanitized, never dropped: the wire still needs an id, and the
    // occupied check below covers a sanitized form that now equals some other call's id.
    const base = isConformingToolCallId(rawId) ? rawId : rawId.replace(/[^a-zA-Z0-9_-]/g, "_");
    // Resume after the last suffix considered for this effective base. Restarting at 2 made a
    // response containing N copies of one id perform O(N²) occupied-set probes synchronously.
    for (let n = nextSuffixByBase.get(base) ?? 2; ; n++) {
      // Hyphen, not underscore: an id that extends another id as `<earlier>_<digits>` is parsed by
      // at least one client as a batch sub-call of `<earlier>`, which pairs the second call's
      // result to the first call. A `-<n>` suffix is in the same id family without that reading.
      const suffix = `-${n}`;
      const candidate = base.slice(0, Math.max(1, MAX_TOOL_CALL_ID_LENGTH - suffix.length)) + suffix;
      if (!occupied.has(candidate)) {
        nextSuffixByBase.set(base, n + 1);
        occupied.add(candidate);
        return candidate;
      }
    }
  };
}

/**
 * Tool-call ids the client's own history has already fixed: every assistant tool call it kept, plus
 * every tool result that answered one. A response repeating any of them is the collision this
 * module exists for.
 *
 * Read from the client's history rather than from earlier responses because the client is the
 * authority on uniqueness here: it is the side that drops duplicates, so the proxy cannot observe
 * the ids it discarded — a dropped id only ever exists as the absence it caused. A Messages client
 * sends the whole conversation on every turn, which is why one turn's history is a complete picture
 * of the ids that may not be reused.
 */
export function reservedToolCallIdsFromHistory(messages: readonly OcxMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") ids.add(part.id);
      }
      continue;
    }
    if (message.role === "toolResult") ids.add(message.toolCallId);
  }
  return ids;
}
