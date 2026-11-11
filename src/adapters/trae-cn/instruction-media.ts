/** Recognize object parts before inspecting caller-provided instruction content. */
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);

/** Retain the unsupported-content fact before a wire parser reduces instructions to text. */
function hasUnsupportedInstructions(body: unknown, field: "input" | "messages"): boolean {
  if (!record(body)) return false;
  const messages = body[field];
  return Array.isArray(messages) && messages.some(message =>
    record(message) && (message.role === "system" || message.role === "developer")
    && Array.isArray(message.content) && message.content.some(part =>
      typeof part !== "string" && (!record(part) || typeof part.type !== "string"
        || !TEXT_PART_TYPES.has(part.type) || typeof part.text !== "string")));
}

/** Inspect original Responses instructions, including video, audio, file, and image parts. */
export function responsesHasUnsupportedInstructionMedia(body: unknown): boolean {
  return hasUnsupportedInstructions(body, "input");
}

/** Inspect Chat instructions before their non-text parts disappear during Responses projection. */
export function chatHasUnsupportedInstructionMedia(body: unknown): boolean {
  return hasUnsupportedInstructions(body, "messages");
}
