/**
 * `agent_message` is Codex's private multi-agent input item: it exists only in the ChatGPT
 * Codex backend's schema. Codex replays every sub-agent reply in the history it sends, so
 * once a thread has used sub-agents, a routed Responses destination answers the whole body
 * with `422 unknown item type "agent_message"` and every later turn of that thread fails the
 * same way. Rewrite the item as the public user message it already is.
 *
 * Genuine ciphertext and unknown part types keep their existing fail-closed path: the
 * encrypted v2 task surface owns those, through `unreadable_encrypted_agent_task` and the
 * opt-in recovery route. Providers using `authMode: "forward"` never reach this function.
 */
export function normalizeRoutedAgentMessages(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.input)) return body;
  let changed = false;
  const input = record.input.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const message = item as Record<string, unknown>;
    if (message.type !== "agent_message" || !Array.isArray(message.content) || message.content.length === 0) return item;
    // Genuine ciphertext and unknown part types must retain their existing fail-closed path.
    if (!message.content.every(part => part && typeof part === "object"
      && ["input_text", "input_image", "input_file"].includes(part.type))) return item;
    const identities = Object.fromEntries(["author", "recipient"]
      .filter(key => typeof message[key] === "string")
      .map(key => [key, message[key]]));
    changed = true;
    return {
      type: "message", role: "user",
      content: [
        ...(Object.keys(identities).length ? [{ type: "input_text", text: `Agent message ${JSON.stringify(identities)}` }] : []),
        ...message.content,
      ],
    };
  });
  return changed ? { ...record, input } : body;
}
