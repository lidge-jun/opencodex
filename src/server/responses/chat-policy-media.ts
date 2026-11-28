import { chatToResponsesBody } from "../../protocols/codecs/chat";

/** Reuse the chronological Chat projection without dropping instruction attachments. */
export function restoreChatInstructionMedia(
  projected: Record<string, unknown>, original: unknown,
): Record<string, unknown> {
  const restored = chatToResponsesBody(original, { preserveInstructionMedia: true });
  return { ...projected, input: restored.input, instructions: restored.instructions };
}
