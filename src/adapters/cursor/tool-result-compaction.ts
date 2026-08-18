import type { OcxContentPart, OcxAssistantContentPart, OcxToolResultMessage } from "../../types";
import { namespacedToolName } from "../../types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const CURSOR_TRUNCATION_MARKER = "\n…[truncated for Cursor external replay budget]";

const COMPUTER_USE_TOOL_NAMES = new Set([
  "node_repl",
  "node_repl__js",
  "mcp__node_repl__js",
  "get_app_state",
  "list_apps",
  "screenshot",
  "computer_use",
  "desktop",
]);

export function isNodeReplOrComputerUseTool(toolName?: string, toolNamespace?: string): boolean {
  if (toolNamespace && (toolNamespace === "mcp__node_repl" || toolNamespace.includes("computer_use") || toolNamespace.includes("node_repl"))) {
    return true;
  }
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  if (COMPUTER_USE_TOOL_NAMES.has(lower)) return true;
  if (lower.startsWith("mcp__node_repl") || lower.startsWith("mcp__computer_use")) return true;
  return false;
}

export function detectComputerUsePayload(text: string): boolean {
  return (
    text.includes("@oai/sky")
    || text.includes("SkyComputerUseError")
    || text.includes("get_app_state")
    || text.includes("list_apps")
    || text.includes("AXTree")
    || text.includes("AXUIElement")
    || text.includes("The user changed '")
    || text.includes("sky is not defined")
    || text.includes("unsupported import in exec")
  );
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

export function rawContentToText(content: string | readonly (OcxContentPart | OcxAssistantContentPart)[]): string {
  if (typeof content === "string") return content;
  return content
    .map(contentPartToText)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

const EMPTY_EXEC_OUTPUT_REGEX = /^(?:(?:Script completed|Command finished|Execution finished)[^\n]*\n+)?(?:Output:\s*)?<empty>\s*$/i;

/**
 * Normalizes tool result content:
 * 1. Converts empty/whitespace outer exec output on Computer Use/node_repl tools into an informative error.
 * 2. Catches SkyComputerUseError / Chrome state changes, Identifier collision errors, and missing sky bindings,
 *    marking isError=true and attaching recovery guidance so the model recovers immediately.
 */
export function normalizeToolResultContent(
  content: string | readonly (OcxContentPart | OcxAssistantContentPart)[],
  toolNamespace?: string,
  toolName?: string,
  isError = false,
): { text: string; isError: boolean } {
  let text = rawContentToText(content);
  let effectiveIsError = isError;
  const isComputerUseOrRepl = isNodeReplOrComputerUseTool(toolName, toolNamespace) || detectComputerUsePayload(text);

  // Check for empty or outer-exec empty output
  const trimmed = text.trim();
  const isEmptyOutput = trimmed.length === 0 || EMPTY_EXEC_OUTPUT_REGEX.test(trimmed);
  if (isEmptyOutput) {
    if (isComputerUseOrRepl || effectiveIsError) {
      text = "[empty output: tool executed with no stdout or return value. If this was a Computer Use action or node_repl script, verify application state with get_app_state.]";
      effectiveIsError = true;
    } else {
      text = "";
    }
    return { text, isError: effectiveIsError };
  }

  // Check for SkyComputerUseError: app/window focus changed
  if (text.includes("The user changed '") || text.includes("SkyComputerUseError")) {
    effectiveIsError = true;
    if (!text.includes("Re-query the latest state with `get_app_state`")) {
      const match = text.match(/The user changed '([^']+)'/);
      const app = match ? match[1] : "the active application";
      text = `SkyComputerUseError: The user changed '${app}'. Re-query the latest state with \`get_app_state\` before sending more actions.\n\n${text}`;
    }
  }

  // Check for node_repl variable re-declaration collision
  if (/Identifier '([^']+)' has already been declared/.test(text)) {
    effectiveIsError = true;
    if (!text.includes("In node_repl, use var or reassign")) {
      text = `${text}\n[node_repl note: In node_repl, use var, reassign without let/const, or wrap the snippet in a block scope '{ ... }'.]`;
    }
  }

  // Check for missing sky binding
  if (text.includes("sky is not defined")) {
    effectiveIsError = true;
    if (!text.includes("import @oai/sky")) {
      text = `${text}\n[node_repl note: Computer Use requires importing '@oai/sky' in node_repl: const { sky } = require('@oai/sky');]`;
    }
  }

  // Check for unsupported import in exec
  if (text.includes("unsupported import in exec")) {
    effectiveIsError = true;
    if (!text.includes("use mcp__node_repl__js")) {
      text = `${text}\n[exec note: Outer code-mode exec cannot import @oai/sky directly; use mcp__node_repl__js for Computer Use actions.]`;
    }
  }

  return { text, isError: effectiveIsError };
}

/**
 * Compacts base64 screenshots and oversized accessibility dumps within a tool-result payload.
 */
export function compactComputerUsePayload(text: string, maxBytes?: number): string {
  let compacted = text;

  // 1. Strip data:image base64 payloads (data:image/jpeg;base64,...)
  compacted = compacted.replace(
    /data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]{20,}/g,
    "[Screenshot image omitted for context budget; inspect accessibility tree below or query with get_app_state]",
  );

  // 2. Strip JSON screenshot fields containing long base64 strings
  compacted = compacted.replace(
    /"screenshot"\s*:\s*"[A-Za-z0-9+/=]{40,}"/g,
    '"screenshot": "[Screenshot base64 omitted for context budget]"',
  );

  // 3. Strip JSON image fields containing long base64 strings
  compacted = compacted.replace(
    /"(?:image|image_data)"\s*:\s*"[A-Za-z0-9+/=]{40,}"/g,
    '"image": "[Image base64 omitted for context budget]"',
  );

  // 4. Strip JPEG/PNG base64 signatures (/9j/4AAQSkZJRg... or iVBORw0KGgo...)
  compacted = compacted.replace(
    /(?:\/9j\/4AAQSkZJRg|iVBORw0KGgo)[A-Za-z0-9+/=]{40,}/g,
    "[Screenshot image data omitted for context budget]",
  );

  if (maxBytes === undefined) return compacted;

  const encoded = encoder.encode(compacted);
  if (encoded.byteLength <= maxBytes) return compacted;

  // 5. Structure-aware AX tree summarization if over budget
  if (compacted.includes("AXTree") || compacted.includes("get_app_state") || compacted.includes("AXUIElement") || compacted.includes("list_apps")) {
    const lines = compacted.split("\n");

    let foundWindow = false;
    let foundUrl = false;
    let windowInfo = "";
    let urlInfo = "";

    for (const line of lines) {
      if (!foundWindow && (line.includes("window") || line.includes("title:") || line.includes("/Applications/"))) {
        windowInfo = line.trim();
        foundWindow = true;
      }
      if (!foundUrl && (line.includes("http://") || line.includes("https://") || line.includes("url:"))) {
        urlInfo = line.trim();
        foundUrl = true;
      }
      if (foundWindow && foundUrl) break;
    }

    const noteParts: string[] = [];
    if (windowInfo) noteParts.push(`window: ${windowInfo.slice(0, 50)}`);
    if (urlInfo) noteParts.push(`url: ${urlInfo.slice(0, 50)}`);
    const note = noteParts.length > 0 ? ` (${noteParts.join(", ")})` : "";
    const trailer = `\n…[AX tree summarized for Cursor context budget${note}; query specific elements with get_app_state]${CURSOR_TRUNCATION_MARKER}`;
    const trailerBytes = encoder.encode(trailer).byteLength;
    const effectiveLimit = Math.max(0, maxBytes - trailerBytes);

    const summaryLines: string[] = [];
    let currentBytes = 0;
    for (const line of lines) {
      const lineBytes = encoder.encode(line).byteLength + (summaryLines.length > 0 ? 1 : 0);
      if (currentBytes + lineBytes <= effectiveLimit) {
        summaryLines.push(line);
        currentBytes += lineBytes;
      } else {
        break;
      }
    }

    const result = `${summaryLines.join("\n")}${trailer}`;
    if (encoder.encode(result).byteLength <= maxBytes) {
      return result;
    }
  }

  // 6. Safe UTF-8 substring truncation
  const markerEncoded = encoder.encode(CURSOR_TRUNCATION_MARKER);
  const keepBytes = Math.max(0, maxBytes - markerEncoded.byteLength);
  let end = Math.min(encoded.byteLength, keepBytes);
  while (end > 0 && end < encoded.byteLength && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return `${decoder.decode(encoded.subarray(0, end))}${CURSOR_TRUNCATION_MARKER}`;
}

export function formatToolResultToWireText(
  message: OcxToolResultMessage,
  options?: { maxBytes?: number; compact?: boolean },
): { text: string; wireOutput: string; isError: boolean } {
  const normalized = normalizeToolResultContent(
    message.content,
    message.toolNamespace,
    message.toolName,
    message.isError,
  );

  let outputText = normalized.text;
  if (options?.compact !== false) {
    outputText = compactComputerUsePayload(outputText, options?.maxBytes);
  }

  const wireOutput = [
    "[tool_result]",
    `call_id: ${message.toolCallId}`,
    `name: ${namespacedToolName(message.toolNamespace, message.toolName)}`,
    `is_error: ${normalized.isError}`,
    "output:",
    outputText,
  ].join("\n");

  return {
    text: outputText,
    wireOutput,
    isError: normalized.isError,
  };
}
