/** Recognize object parts before inspecting caller-provided instruction content. */
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);
const MEDIA_PART_TYPES = new Set(["input_image", "input_video", "input_audio", "input_file", "image", "image_url", "video", "video_url", "audio", "file", "document"]);

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

/** Reject media that parsing would erase from instruction or native agent-message inputs. */
/** Reject typed media before Responses projection can substitute text markers or drop references. */
export function responsesHasUnsupportedInputMedia(body: unknown): boolean {
  return hasUnsupportedInstructions(body, "input")
    || (record(body) && Array.isArray(body.input) && body.input.some(item =>
      record(item) && (item.type === "agent_message"
        || ((item.type === undefined || item.type === "message") && item.role === "user"))
      && Array.isArray(item.content)
      && item.content.some(part => record(part) && typeof part.type === "string" && MEDIA_PART_TYPES.has(part.type))));
}

/** Inspect Chat instructions before their non-text parts disappear during Responses projection. */
export function chatHasUnsupportedInstructionMedia(body: unknown): boolean {
  return hasUnsupportedInstructions(body, "messages");
}
