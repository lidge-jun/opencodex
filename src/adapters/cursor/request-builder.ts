import type {
  OcxAssistantContentPart,
  OcxContentPart,
  OcxMessage,
  OcxParsedRequest,
  OcxToolCall,
  OcxToolResultMessage,
} from "../../types";
import { namespacedToolName } from "../../types";
import type { CursorRequestMessage, CursorRunRequest } from "./types";
import { cursorCodexToWireModelId } from "./discovery";
import { cursorEffortSuffix } from "./effort-map";
import type { OcxTool } from "../../types";

/**
 * Maximum number of tools (native + namespace-inner) that the Cursor Connect
 * transport can register per session before returning `resource_exhausted`.
 * Empirically determined: 230 works, 340 fails. 200 provides safe margin.
 * See https://github.com/lidge-jun/opencodex/issues/190
 */
const CURSOR_TOOL_BUDGET = 200;

const CURSOR_DEFERRED_TOOLS_NOTE = [
  "[opencodex] Not all tools could be advertised to Cursor due to a transport limit.",
  "Additional MCP/app tools are available via `tool_search` — use it to discover",
  "and load tools by keyword when the task requires them.",
].join(" ");

/**
 * Enforce a tool budget for the Cursor transport. Native (non-namespace) tools
 * are always kept. Namespaces are added smallest-first until the budget is full;
 * remaining namespaces are dropped (the model can still discover them via
 * tool_search). Returns the filtered tool list and whether any trimming occurred.
 */
function enforceCursorToolBudget(tools: readonly OcxTool[]): { tools: OcxTool[]; trimmed: boolean } {
  if (tools.length <= CURSOR_TOOL_BUDGET) return { tools: [...tools], trimmed: false };

  const native: OcxTool[] = [];
  const namespaceGroups = new Map<string, OcxTool[]>();
  for (const tool of tools) {
    if (tool.namespace) {
      const group = namespaceGroups.get(tool.namespace) ?? [];
      group.push(tool);
      namespaceGroups.set(tool.namespace, group);
    } else {
      native.push(tool);
    }
  }

  // Sort namespaces smallest-first to maximise the number of namespaces that fit.
  const sorted = [...namespaceGroups.entries()].sort((a, b) => a[1].length - b[1].length);

  let remaining = CURSOR_TOOL_BUDGET - native.length;
  const kept: OcxTool[] = [...native];
  let trimmed = false;

  for (const [, group] of sorted) {
    if (group.length <= remaining) {
      kept.push(...group);
      remaining -= group.length;
    } else {
      trimmed = true;
      // Stop — no more namespaces fit.
      break;
    }
  }

  // If we broke early, all subsequent namespaces are also trimmed.
  if (kept.length < tools.length) trimmed = true;

  return { tools: kept, trimmed };
}

/**
 * Resolve a `cursor/<model>` selection + Codex reasoning effort to the actual Cursor model id. Cursor
* encodes the effort as a per-model suffix (`claude-4.6-opus-high`); `cursorEffortSuffix` picks the
 * right tier for that specific model (literal pass-through, with rank clamp fallback) or
* `undefined` for non-reasoning models like `composer-2.5`. A fully-qualified id (one that isn't a
* known effort base) passes through unchanged.
 */
function normalizeCursorModelId(modelId: string, reasoning?: string): string {
  const id = cursorCodexToWireModelId(modelId);
  const suffix = cursorEffortSuffix(id, reasoning);
  return suffix ? `${id}-${suffix}` : id;
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
      // Cursor does not accept OpenAI Responses assistant tool-call parts as native history here.
      // Rendering them as visible "[tool_call]" text leaks synthetic protocol markers back into
      // model output and can halt multi-tool continuations. The paired tool result carries the
      // call id/name/output Cursor needs for the next action.
      return undefined;
  }
}

function toolResultToText(message: OcxToolResultMessage): string {
  return [
    "[tool_result]",
    `call_id: ${message.toolCallId}`,
    `name: ${namespacedToolName(message.toolNamespace, message.toolName)}`,
    `is_error: ${message.isError}`,
    "output:",
    contentToText(message.content),
  ].join("\n");
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
        content: toolResultToText(message),
      };
  }
}

export function generatedCursorConversationId(): string {
  return `cursor_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function createCursorRequest(parsed: OcxParsedRequest): CursorRunRequest {
  const rawTools = parsed.context.tools ?? [];
  const { tools: budgetedTools, trimmed } = enforceCursorToolBudget(rawTools);

  return {
    modelId: normalizeCursorModelId(parsed.modelId, parsed.options.reasoning),
    // The Cursor conversation id comes ONLY from remembered state (_cursorConversationId). Do NOT fall
    // back to the OpenAI Responses previous_response_id (resp_*): that is a Responses-chain id in a
    // different namespace and would start an unrelated Cursor conversation, breaking tool-result
    // continuation. If we have no remembered Cursor conversation, start a fresh one.
    conversationId: parsed._cursorConversationId ?? generatedCursorConversationId(),
    system: [
      ...(parsed.context.systemPrompt ?? []),
      ...(trimmed ? [CURSOR_DEFERRED_TOOLS_NOTE] : []),
    ],
    messages: parsed.context.messages
      .map(requestMessage)
      .filter((message): message is CursorRequestMessage => !!message && message.content.length > 0),
    rawMessages: parsed.context.messages,
    ...(budgetedTools.length ? { tools: budgetedTools } : {}),
    ...(parsed.options.toolChoice ? { toolChoice: parsed.options.toolChoice } : {}),
    ...(parsed.options.parallelToolCalls !== undefined ? { parallelToolCalls: parsed.options.parallelToolCalls } : {}),
  };
}
