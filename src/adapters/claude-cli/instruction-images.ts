const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Inspect the original Chat body before instruction content is reduced to text. */
export function chatHasInstructionImage(body: Record<string, unknown>): boolean {
  return Array.isArray(body.messages) && body.messages.some(message =>
    record(message) && (message.role === "developer" || message.role === "system")
    && Array.isArray(message.content) && message.content.some(part =>
      record(part) && (part.type === "image_url" || part.type === "image")));
}

/** System items are flattened by the Responses parser; inspect the original input as well. */
export function responsesHasInstructionImage(body: unknown): boolean {
  return record(body) && Array.isArray(body.input) && body.input.some(item =>
    record(item) && (item.type === undefined || item.type === "message")
    && (item.role === "developer" || item.role === "system")
    && Array.isArray(item.content) && item.content.some(part => record(part) && part.type === "input_image"));
}
