import { createHash } from "node:crypto";
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
  cursorToolChoiceAliases,
  cursorToolWireName,
  cursorToolsForActivePrompt,
  isBareCodexShellBridgeTool,
} from "./tool-definitions";
import { lookupCursorThreadConversation } from "./thread-continuity";

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
  if (cursorToolChoiceAliases(tool).some(name => selectedNames.has(name))) return 0;
  // Shell bridge before apply_patch so a large patch schema cannot starve the only execution path (#399).
  if (isBareCodexShellBridgeTool(tool)) return 1;
  if (!tool.namespace && tool.name === "apply_patch") return 2;
  if (tool.loadedFromToolSearch) return 3;
  if (!tool.namespace) return 4;
  return 5;
}

function isPinnedCursorTool(tool: OcxTool, selectedNames: ReadonlySet<string>): boolean {
  return toolPriority(tool, selectedNames) <= 2;
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

  const tryKeep = (tool: OcxTool): boolean => {
    if (keptSet.has(tool) || kept.length >= CURSOR_TOOL_COUNT_LIMIT) return keptSet.has(tool);
    // Repeated protobuf message fields serialize as concatenated tag/length/value entries,
    // so each one-entry wrapper size is the exact additive contribution to McpTools.
    const candidateBytes = cursorMcpToolEncodedSize(tool, toolChoice);
    if (keptBytes + candidateBytes > CURSOR_TOOL_BYTES_LIMIT) return false;
    kept.push(tool);
    keptSet.add(tool);
    keptBytes += candidateBytes;
    return true;
  };

  // Phase 1: selected tools + shell bridge + apply_patch (priority <= 2).
  // Pins are admitted before filler so a crowded catalog cannot drop the Codex execution path (#399).
  for (const candidate of candidates) {
    if (!isPinnedCursorTool(candidate.tool, selectedNames)) continue;
    tryKeep(candidate.tool);
  }

  // Phase 2: remaining tools by priority.
  for (const candidate of candidates) {
    tryKeep(candidate.tool);
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

/** Derive an opaque provider-scoped Cursor id from the upstream client's conversation identity. */
export function cursorConversationIdFromClientThread(threadId: string, identityScope?: string): string {
  const digest = createHash("sha256")
    .update("ocx:cursor:thread:")
    .update(identityScope?.trim() || "local")
    .update("\0")
    .update(threadId)
    .digest("hex")
    .slice(0, 32);
  return `cursor_${digest}`;
}

/**
 * Resolve the Cursor conversation id for this turn.
 * Priority: force-fresh → isolate helper → remembered → thread override → client thread → random.
 * Never use OpenAI Responses `previous_response_id` (resp_*) or shared `prompt_cache_key`
 * (cache-cohort fingerprint, not conversation ownership).
 */
export function resolveCursorConversationId(
  parsed: OcxParsedRequest,
  _wireModelId: string,
  options: CreateCursorRequestOptions = {},
): string {
  if (options.forceFreshConversation === true) return generatedCursorConversationId();
  // Helper/shadow/compaction turns must not append into the parent's Cursor conversation,
  // even when previous_response_id restored the parent's remembered id.
  if (parsed._cursorIsolateConversation === true) return generatedCursorConversationId();
  if (parsed._cursorConversationId) return parsed._cursorConversationId;
  const threadId = parsed._clientThreadId?.trim();
  if (threadId) {
    const recovered = lookupCursorThreadConversation(threadId, parsed._cursorIdentityScope);
    if (recovered) return recovered;
    return cursorConversationIdFromClientThread(threadId, parsed._cursorIdentityScope);
  }
  return generatedCursorConversationId();
}

export interface CreateCursorRequestOptions {
  /** Force a brand-new Cursor conversation id even when remembered state exists. */
  forceFreshConversation?: boolean;
}

export function createCursorRequest(
  parsed: OcxParsedRequest,
  options: CreateCursorRequestOptions = {},
): CursorRunRequest {
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
    conversationId: resolveCursorConversationId(parsed, model.modelId, options),
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
