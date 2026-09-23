import type { OcxContentPart, OcxToolCall, OcxToolResultMessage } from "../types";
import { normalizeToolId } from "./kiro-wire";

function stringifyValue(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function contentText(content: string | OcxContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map(part => {
      if (part.type === "text" || part.type === "document") return part.text;
      if (part.type === "image") return `[image:${part.detail ?? "auto"}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function appendFallbackText(base: string, fallback: string): string {
  return [base, fallback].filter(Boolean).join("\n\n");
}

export function toolCallFallbackText(toolCall: OcxToolCall): string {
  return [
    `Tool call fallback (${toolCall.name}, id ${normalizeToolId(toolCall.id)}):`,
    stringifyValue(toolCall.arguments ?? {}),
  ].join("\n");
}

export function toolResultFallbackText(toolResult: OcxToolResultMessage): string {
  return [
    `Tool result fallback (${toolResult.toolName}, id ${normalizeToolId(toolResult.toolCallId)}, ${toolResult.isError ? "error" : "success"}):`,
    contentText(toolResult.content) || "(empty)",
  ].join("\n");
}
