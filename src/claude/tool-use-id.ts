import { createHash } from "node:crypto";

/** Longest id we emit: the prefixed id is replayed upstream as `call_id`, and Responses caps it at 64. */
const MAX_TOOL_USE_ID_LENGTH = 64;
const DIGEST_LENGTH = 16;

/**
 * Anthropic `tool_use.id` for a translated function call.
 *
 * Routed upstreams name their calls in their own style (`call_…` from OpenAI Responses, `fc_…`,
 * bare UUIDs), and Claude Code shows those ids to its clients verbatim. Claude Remote Control did
 * not render the approval card for a tool_use whose id lacked Anthropic's `toolu_` prefix, so a
 * routed session waiting on an approval looked idle from another device. Prefixing keeps the
 * upstream id recoverable for debugging and is stable across turns: the client echoes the prefixed
 * id back, the inbound translator replays it unchanged as the Responses `call_id`, and a second
 * pass leaves an id that already starts with `toolu_` alone. An id the prefix would push past 64
 * characters keeps its head plus a digest of the whole id, so it stays unique and deterministic.
 */
export function claudeToolUseId(callId: unknown): string {
  if (typeof callId !== "string" || callId.length === 0) {
    return `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  if (callId.startsWith("toolu_")) return callId;
  const prefixed = `toolu_${callId}`;
  if (prefixed.length <= MAX_TOOL_USE_ID_LENGTH) return prefixed;
  const digest = createHash("sha256").update(callId).digest("hex").slice(0, DIGEST_LENGTH);
  return `${prefixed.slice(0, MAX_TOOL_USE_ID_LENGTH - DIGEST_LENGTH - 1)}_${digest}`;
}
