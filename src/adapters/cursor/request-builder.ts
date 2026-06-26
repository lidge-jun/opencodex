import type {
  OcxAssistantContentPart,
  OcxContentPart,
  OcxMessage,
  OcxParsedRequest,
} from "../../types";
import type { CursorRequestMessage, CursorRunRequest } from "./types";

const CURSOR_EFFORT_SUFFIXES = ["low", "medium", "high", "max", "xhigh"] as const;

/** Map a Codex reasoning effort label to Cursor's model-id effort suffix. */
function mapReasoningToCursorEffort(reasoning: string | undefined): string {
  switch ((reasoning ?? "").toLowerCase()) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "max":
    case "xhigh":
      return "max";
    // "high"/"none"/unknown → high: a bare reasoning-model id is rejected (ERROR_BAD_MODEL_NAME) and
    // `-high` is the broadly-available variant (e.g. claude-4.6-opus ships only -high/-max).
    default:
      return "high";
  }
}

function hasCursorEffortSuffix(id: string): boolean {
  return CURSOR_EFFORT_SUFFIXES.some(s => id.endsWith(`-${s}`) || id.includes(`-${s}-`));
}

// Cursor's own non-reasoning models take NO effort suffix (e.g. `composer-2.5`, `cursor-small`); a
// `-high` on these is rejected. Only reasoning families (claude/gpt/gemini/grok/…) carry the suffix.
const CURSOR_NO_EFFORT_PREFIXES = ["composer", "cursor-", "cheetah", "code-supernova", "auto"];

function cursorModelTakesEffortSuffix(id: string): boolean {
  return !CURSOR_NO_EFFORT_PREFIXES.some(p => id === p || id.startsWith(p));
}

/**
 * Cursor model ids encode the reasoning effort as a suffix (`claude-4.6-opus-high`); a bare id is
 * rejected `ERROR_BAD_MODEL_NAME`. Append the mapped effort suffix when the id doesn't already carry
 * one. (Per-model suffix availability varies; this maps the common reasoning families — a user can
 * always pass a fully-qualified id like `cursor/claude-4.6-opus-max` to bypass the mapping.)
 */
function normalizeCursorModelId(modelId: string, reasoning?: string): string {
  const id = modelId.startsWith("cursor/") ? modelId.slice("cursor/".length) : modelId;
  if (hasCursorEffortSuffix(id) || !cursorModelTakesEffortSuffix(id)) return id;
  return `${id}-${mapReasoningToCursorEffort(reasoning)}`;
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
    modelId: normalizeCursorModelId(parsed.modelId, parsed.options.reasoning),
    conversationId: parsed.previousResponseId ?? generatedConversationId(),
    system: [...(parsed.context.systemPrompt ?? [])],
    messages: parsed.context.messages
      .map(requestMessage)
      .filter((message): message is CursorRequestMessage => !!message && message.content.length > 0),
  };
}
