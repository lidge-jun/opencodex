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

/** Reject media that cannot survive Responses projection; user images may be captioned first. */
export function responsesHasUnsupportedInputMedia(body: unknown, options: { captionUserImages?: boolean } = {}): boolean {
  if (hasUnsupportedInstructions(body, "input")) return true;
  if (!record(body) || !Array.isArray(body.input)) return false;
  const messageMedia = body.input.some(item => record(item)
    && (item.type === "agent_message" || ((item.type === undefined || item.type === "message") && item.role === "user"))
    && Array.isArray(item.content) && item.content.some(part => record(part) && typeof part.type === "string"
      && MEDIA_PART_TYPES.has(part.type)
      && !(options.captionUserImages === true && part.type === "input_image" && item.role === "user"
        && (item.type === undefined || item.type === "message"))));
  const toolMedia = body.input.some(item => record(item)
    && (item.type === "function_call_output" || item.type === "custom_tool_call_output")
    && Array.isArray(item.output) && item.output.some(part => record(part) && typeof part.type === "string"
      && MEDIA_PART_TYPES.has(part.type)));
  return messageMedia || toolMedia;
}

/** A rebuilt search result may be removed later, but every other tool image is refused first. */
export function responsesHasUnsupportedToolMedia(body: unknown): boolean {
  if (!record(body) || !Array.isArray(body.input)) return false;
  const searchCallIds = new Set(body.input.flatMap(item => record(item) && item.type === "function_call"
    && item.name === "web_search" && typeof item.call_id === "string" ? [item.call_id] : []));
  return body.input.some(item => record(item)
    && (item.type === "function_call_output" || item.type === "custom_tool_call_output")
    && !(typeof item.call_id === "string" && searchCallIds.has(item.call_id))
    && Array.isArray(item.output) && item.output.some(part => record(part) && typeof part.type === "string"
      && MEDIA_PART_TYPES.has(part.type)));
}

/** Inspect Chat instructions before their non-text parts disappear during Responses projection. */
export function chatHasUnsupportedInstructionMedia(body: unknown): boolean {
  return hasUnsupportedInstructions(body, "messages");
}
