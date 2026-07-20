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
import { toolChoiceAliases, isAllowedToolChoice } from "../../types";
import type { OcxToolChoice } from "../../types";

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

const CURSOR_DEFERRED_TOOLS_NOTE_NO_SEARCH = [
  "[opencodex] Not all tools could be advertised to Cursor due to a transport limit.",
  "Some MCP/app tools were omitted. Start a new session if you need access to them.",
].join(" ");

/**
 * Extract the set of tool wire-names that are explicitly required or allowed by
 * the current `toolChoice` option, so the budget pass can reserve them.
 */
function toolChoiceRequiredNames(toolChoice: OcxToolChoice | undefined): Set<string> {
  if (!toolChoice || toolChoice === "auto" || toolChoice === "none") return new Set();
  if (toolChoice === "required") return new Set(); // "required" doesn't name specific tools
  if ("name" in toolChoice) return new Set([toolChoice.name]);
  if (isAllowedToolChoice(toolChoice)) return new Set(toolChoice.allowedTools);
  return new Set();
}

/**
 * Collect tool wire-names that appear in prior tool-result messages, indicating
 * they were loaded via `tool_search` in a previous turn and must remain callable.
 */
function previouslyUsedToolNames(messages: readonly OcxMessage[]): Set<string> {
  const names = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const wire = msg.toolNamespace ? `${msg.toolNamespace}__${msg.toolName}` : msg.toolName;
      names.add(wire);
      names.add(msg.toolName);
    }
  }
  return names;
}

/**
 * Enforce a tool budget for the Cursor transport. Native (non-namespace) tools
 * are always kept. Namespaces are added smallest-first until the budget is full;
 * remaining namespaces are dropped (the model can still discover them via
 * tool_search). Returns the filtered tool list and whether any trimming occurred.
 *
 * Tools that are explicitly required by `toolChoice` or that appear in prior
 * tool-result messages (i.e. loaded via tool_search) are reserved and always kept,
 * even if their namespace would otherwise be trimmed.
 */
function enforceCursorToolBudget(
  tools: readonly OcxTool[],
  reservedNames: ReadonlySet<string>,
): { tools: OcxTool[]; trimmed: boolean } {
  if (tools.length <= CURSOR_TOOL_BUDGET) return { tools: [...tools], trimmed: false };

  const native: OcxTool[] = [];
  const reserved: OcxTool[] = [];
  const namespaceGroups = new Map<string, OcxTool[]>();
  for (const tool of tools) {
    const wireName = tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
    if (reservedNames.has(wireName) || reservedNames.has(tool.name)) {
      reserved.push(tool);
      continue;
    }
    if (tool.namespace) {
      const group = namespaceGroups.get(tool.namespace) ?? [];
      group.push(tool);
      namespaceGroups.set(tool.namespace, group);
    } else {
      native.push(tool);
    }
  }

  // Cap native tools at budget if there are too many bare-function tools.
  let trimmed = false;
  const cappedNative = native.length > CURSOR_TOOL_BUDGET
    ? (() => { trimmed = true; return native.slice(0, CURSOR_TOOL_BUDGET); })()
    : native;

  // Sort namespaces smallest-first to maximise the number of namespaces that fit.
  const sorted = [...namespaceGroups.entries()].sort((a, b) => a[1].length - b[1].length);

  let remaining = CURSOR_TOOL_BUDGET - cappedNative.length - reserved.length;
  const kept: OcxTool[] = [...cappedNative, ...reserved];

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

  // Collect names that must survive trimming: toolChoice targets + previously used tools.
  const required = toolChoiceRequiredNames(parsed.options.toolChoice);
  const used = previouslyUsedToolNames(parsed.context.messages);
  const reservedNames = new Set([...required, ...used]);

  const { tools: budgetedTools, trimmed } = enforceCursorToolBudget(rawTools, reservedNames);

  // Only suggest tool_search if it actually survived the budget.
  const hasToolSearch = budgetedTools.some(t => t.name === "tool_search");
  const deferredNote = trimmed
    ? (hasToolSearch ? CURSOR_DEFERRED_TOOLS_NOTE : CURSOR_DEFERRED_TOOLS_NOTE_NO_SEARCH)
    : undefined;

  return {
    modelId: normalizeCursorModelId(parsed.modelId, parsed.options.reasoning),
    // The Cursor conversation id comes ONLY from remembered state (_cursorConversationId). Do NOT fall
    // back to the OpenAI Responses previous_response_id (resp_*): that is a Responses-chain id in a
    // different namespace and would start an unrelated Cursor conversation, breaking tool-result
    // continuation. If we have no remembered Cursor conversation, start a fresh one.
    conversationId: parsed._cursorConversationId ?? generatedCursorConversationId(),
    system: [
      ...(parsed.context.systemPrompt ?? []),
      ...(deferredNote ? [deferredNote] : []),
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
