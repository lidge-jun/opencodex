/**
 * Anthropic `tool_use.id` for a translated function call.
 *
 * Routed upstreams name their calls in their own style (`call_…` from OpenAI Responses, `fc_…`,
 * bare UUIDs), and Claude Code shows those ids to its clients verbatim. Claude Remote Control did
 * not render the approval card for a tool_use whose id lacked Anthropic's `toolu_` prefix, so a
 * routed session waiting on an approval looked idle from another device. Prefixing keeps the
 * upstream id recoverable for debugging and is stable across turns: the client echoes the prefixed
 * id back, the inbound translator replays it unchanged as the Responses `call_id`, and a second
 * pass leaves an id that already starts with `toolu_` alone.
 */
export function claudeToolUseId(callId: unknown): string {
  if (typeof callId !== "string" || callId.length === 0) {
    return `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  return callId.startsWith("toolu_") ? callId : `toolu_${callId}`;
}
