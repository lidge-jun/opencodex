/** Match the Go destination, including user-renamed provider entries. */
export function isOpenCodeGo(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.origin === "https://opencode.ai" && url.pathname.replace(/\/+$/, "") === "/zen/go/v1";
  } catch { return false; }
}

/** Public Responses rejects Codex's private agent_message variant, even with plaintext content. */
export function normalizeOpenCodeGoAgentMessages(body: unknown): unknown {
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
