import type {
  OcxAssistantContentPart,
  OcxContentPart,
  OcxMessage,
  OcxParsedRequest,
  OcxToolCall,
  OcxToolResultMessage,
} from "../../types";
import { isAllowedToolChoice, namespacedToolName, toolChoiceAliases, type OcxTool, type OcxToolChoice } from "../../types";
import type { CursorRequestMessage, CursorRunRequest } from "./types";
import { cursorWireModelSelection, type CursorRoutingLevel } from "./discovery";
import { cursorEffortSuffix } from "./effort-map";
import {
  cursorMcpToolEncodedSize,
  cursorMcpToolsEncodedSize,
  cursorToolAllowedByChoice,
  cursorToolWireName,
  cursorToolsForActivePrompt,
} from "./tool-definitions";

/** Probe-verified Cursor Connect boundaries, with byte headroom for the enclosing field. */
export const CURSOR_TOOL_COUNT_LIMIT = 330;
export const CURSOR_TOOL_BYTES_LIMIT = 120_000;

interface CursorToolBudgetResult {
  tools: OcxTool[];
  omitted: OcxTool[];
}

function explicitlySelectedNames(choice: OcxToolChoice | undefined): Set<string> {
  if (!choice || choice === "auto" || choice === "none" || choice === "required") return new Set();
  return new Set("name" in choice ? [choice.name] : isAllowedToolChoice(choice) ? choice.allowedTools : []);
}

function toolPriority(tool: OcxTool, selectedNames: ReadonlySet<string>): number {
  if (toolChoiceAliases(tool).some(name => selectedNames.has(name))) return 0;
  if (tool.loadedFromToolSearch) return 1;
  if (!tool.namespace) return 2;
  return 3;
}

/**
 * Select one catalog used by both Cursor protobuf registration and call recognition.
 * Actual McpTools serialization is measured after every candidate so descriptions,
 * names, provider identifiers, and schemas all count toward the byte ceiling.
 */
export function applyCursorToolBudget(
  tools: readonly OcxTool[] | undefined,
  toolChoice: OcxToolChoice | undefined,
): CursorToolBudgetResult {
  const eligible = (tools ?? []).filter(tool => cursorToolAllowedByChoice(tool, toolChoice));
  if (
    eligible.length <= CURSOR_TOOL_COUNT_LIMIT
    && cursorMcpToolsEncodedSize(eligible, toolChoice) <= CURSOR_TOOL_BYTES_LIMIT
  ) return { tools: [...eligible], omitted: [] };

  const selectedNames = explicitlySelectedNames(toolChoice);
  const candidates = eligible
    .map((tool, index) => ({ tool, index, priority: toolPriority(tool, selectedNames) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index);
  const kept: OcxTool[] = [];
  const keptSet = new Set<OcxTool>();
  let keptBytes = 0;

  for (const candidate of candidates) {
    if (kept.length >= CURSOR_TOOL_COUNT_LIMIT) continue;
    // Repeated protobuf message fields serialize as concatenated tag/length/value entries,
    // so each one-entry wrapper size is the exact additive contribution to McpTools.
    const candidateBytes = cursorMcpToolEncodedSize(candidate.tool, toolChoice);
    if (keptBytes + candidateBytes > CURSOR_TOOL_BYTES_LIMIT) continue;
    kept.push(candidate.tool);
    keptSet.add(candidate.tool);
    keptBytes += candidateBytes;
  }

  return {
    tools: eligible.filter(tool => keptSet.has(tool)),
    omitted: eligible.filter(tool => !keptSet.has(tool)),
  };
}

function catalogLimitNote(kept: readonly OcxTool[], omitted: readonly OcxTool[]): string | undefined {
  if (omitted.length === 0) return undefined;
  const recoverable = kept.some(tool => tool.toolSearch || cursorToolWireName(tool) === "tool_search");
  const names = omitted.slice(0, 12).map(cursorToolWireName);
  const remainder = omitted.length - names.length;
  const omittedSummary = `${names.join(", ")}${remainder > 0 ? `, and ${remainder} more` : ""}`;
  return recoverable
    ? `[opencodex] Cursor's transport limit allows ${kept.length} of ${kept.length + omitted.length} client tools this turn. Omitted: ${omittedSummary}. Use tool_search for a needed omitted tool; tools returned by tool_search are prioritized on the next turn.`
    : `[opencodex] Cursor's transport limit allows ${kept.length} of ${kept.length + omitted.length} client tools this turn. Omitted and unavailable this turn: ${omittedSummary}.`;
}

/**
 * Resolve a `cursor/<model>` selection + Codex reasoning effort to the actual Cursor model id. Cursor
* encodes the effort as a per-model suffix (`claude-4.6-opus-high`); `cursorEffortSuffix` picks the
 * right tier for that specific model (literal pass-through, with rank clamp fallback) or
* `undefined` for non-reasoning models like `composer-2.5`. A fully-qualified id (one that isn't a
* known effort base) passes through unchanged.
 */
function normalizeCursorModelId(modelId: string, reasoning?: string): { modelId: string; routingLevel?: CursorRoutingLevel } {
  const selection = cursorWireModelSelection(modelId);
  const id = selection.modelId;
  const suffix = cursorEffortSuffix(id, reasoning);
  return { ...selection, modelId: suffix ? `${id}-${suffix}` : id };
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
  const messages = parsed.context.messages
    .map(requestMessage)
    .filter((message): message is CursorRequestMessage => !!message && message.content.length > 0);
  const activeText = [...messages].reverse().find(message => message.role === "user" || message.role === "developer")?.content ?? "";
  const visibleTools = cursorToolsForActivePrompt(parsed.context.tools, activeText, parsed.options.toolChoice);
  const budget = applyCursorToolBudget(visibleTools, parsed.options.toolChoice);
  const limitNote = catalogLimitNote(budget.tools, budget.omitted);
  const model = normalizeCursorModelId(parsed.modelId, parsed.options.reasoning);
  return {
    modelId: model.modelId,
    ...(model.routingLevel ? { routingLevel: model.routingLevel } : {}),
    // The Cursor conversation id comes ONLY from remembered state (_cursorConversationId). Do NOT fall
    // back to the OpenAI Responses previous_response_id (resp_*): that is a Responses-chain id in a
    // different namespace and would start an unrelated Cursor conversation, breaking tool-result
    // continuation. If we have no remembered Cursor conversation, start a fresh one.
    conversationId: parsed._cursorConversationId ?? generatedCursorConversationId(),
    system: [...(parsed.context.systemPrompt ?? []), ...(limitNote ? [limitNote] : [])],
    messages,
    rawMessages: parsed.context.messages,
    ...(parsed._compactionRequest === true || parsed._contextCompactionBoundary === true ? { contextUsageReset: true } : {}),
    ...(parsed._compactionRequest === true ? { contextUsageStoreCheckpoints: false } : {}),
    ...(budget.tools.length ? { tools: budget.tools } : {}),
    ...(parsed.options.toolChoice ? { toolChoice: parsed.options.toolChoice } : {}),
    ...(parsed.options.parallelToolCalls !== undefined ? { parallelToolCalls: parsed.options.parallelToolCalls } : {}),
  };
}
