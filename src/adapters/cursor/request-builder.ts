import type {
  OcxAssistantContentPart,
  OcxContentPart,
  OcxMessage,
  OcxParsedRequest,
} from "../../types";
import type { CursorRequestMessage, CursorRunRequest } from "./types";

function normalizeCursorModelId(modelId: string): string {
  return modelId.startsWith("cursor/") ? modelId.slice("cursor/".length) : modelId;
}

function contentPartToText(part: OcxContentPart | OcxAssistantContentPart): string | undefined {
  switch (part.type) {
    case "text":
      return part.text;
    case "thinking":
      return part.thinking;
    case "image":
      return `[image input unsupported by Cursor adapter phase 3: ${part.detail ?? "auto"}]`;
    case "toolCall":
      return undefined;
  }
}

function contentToText(content: string | readonly (OcxContentPart | OcxAssistantContentPart)[]): string {
  if (typeof content === "string") return content;
  return content
    .map(contentPartToText)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function requestMessage(message: OcxMessage): CursorRequestMessage | undefined {
  switch (message.role) {
    case "user":
    case "developer":
      return { role: message.role, content: contentToText(message.content) };
    case "assistant":
      return { role: "assistant", content: contentToText(message.content) };
    case "toolResult":
      return {
        role: "tool",
        content: contentToText(message.content),
      };
  }
}

function generatedConversationId(): string {
  return `cursor_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function createCursorRequest(parsed: OcxParsedRequest): CursorRunRequest {
  return {
    modelId: normalizeCursorModelId(parsed.modelId),
    conversationId: parsed.previousResponseId ?? generatedConversationId(),
    system: [...(parsed.context.systemPrompt ?? [])],
    messages: parsed.context.messages
      .map(requestMessage)
      .filter((message): message is CursorRequestMessage => !!message && message.content.length > 0),
  };
}
