/** Preserve typed instruction content for policy candidates that can actually consume it. */
export function restoreChatInstructionMedia(
  projected: Record<string, unknown>, original: unknown,
): Record<string, unknown> {
  if (typeof original !== "object" || original === null) return projected;
  const messages = (original as { messages?: unknown }).messages;
  const input = projected.input;
  if (!Array.isArray(messages) || !Array.isArray(input)) return projected;
  let cursor = 0;
  const nextConversation = (): number => input.findIndex((item, index) => index >= cursor
    && typeof item === "object" && item !== null && (item as { role?: unknown }).role === "user");
  const restored = [...input];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if ((role !== "system" && role !== "developer") || !Array.isArray(content)
      || !content.some(part => typeof part === "object" && part !== null
        && ["image_url", "video_url", "input_audio", "file"].includes(String((part as { type?: unknown }).type)))) continue;
    const converted = content.flatMap(part => {
      if (typeof part === "string") return [{ type: "input_text", text: part }];
      if (typeof part !== "object" || part === null) return [];
      const value = part as Record<string, unknown>;
      if (["text", "input_text", "output_text"].includes(String(value.type)) && typeof value.text === "string") {
        return [{ type: "input_text", text: value.text }];
      }
      if (value.type === "image_url") {
        const image = value.image_url;
        const url = typeof image === "string" ? image
          : typeof image === "object" && image !== null ? (image as { url?: unknown }).url : undefined;
        if (typeof url === "string") return [{ type: "input_image", image_url: url }];
      }
      if (value.type === "video_url") {
        const video = value.video_url;
        const url = typeof video === "string" ? video
          : typeof video === "object" && video !== null ? (video as { url?: unknown }).url : undefined;
        if (typeof url === "string") return [{ type: "input_video", video_url: url }];
      }
      if (value.type === "input_audio" || value.type === "input_file" || value.type === "file") return [structuredClone(value)];
      return [];
    });
    const instruction = { type: "message", role: "developer", content: converted };
    if (restored.length === 0 || cursor === 0 && typeof restored[0] === "object" && restored[0] !== null
      && (restored[0] as { role?: unknown }).role !== "user") {
      restored.unshift(instruction); cursor = 1; continue;
    }
    const next = nextConversation();
    restored.splice(next < 0 ? restored.length : next, 0, instruction);
    cursor = next < 0 ? restored.length : next + 1;
  }
  return { ...projected, input: restored };
}
