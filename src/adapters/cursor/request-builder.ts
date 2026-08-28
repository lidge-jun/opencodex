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
import type { CursorRequestMessage, CursorRequestedModelParameter, CursorRunRequest } from "./types";
import { cursorCheckpointModelAffinityId, cursorWireModelSelection, type CursorRoutingLevel } from "./discovery";
import { cursorUltraBaseModelId } from "./discovery";
import { decodeCursorCallId } from "./call-id";
import { cursorGrokFastSelection, resolveCursorSelection } from "./catalog";
import {
  cursorMcpToolEncodedSize,
  cursorMcpToolsEncodedSize,
  cursorToolAllowedByChoice,
  cursorToolChoiceAliases,
  cursorStructuredEditTools,
  cursorToolWireName,
  cursorToolsForActivePrompt,
  isCursorStructuredEditToolName,
  isBareCodexShellBridgeTool,
  isCursorExecutionPathTool,
  isCursorWaitTool,
} from "./tool-definitions";
import { lookupCursorThreadConversation } from "./thread-continuity";
import {
  getCursorCheckpoint,
  getCursorCheckpointForPrefix,
  type CursorCheckpointInvalidationReason,
  type CursorCheckpointSnapshot,
} from "./checkpoint-store";
import { extractCursorImageUrls } from "./images";

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
  // Execution path (bare or opencodex-responses `exec` / `exec_command` / `shell_command`)
  // outranks filler so a crowded catalog cannot drop the Codex shell bridge (#399).
  if (isCursorExecutionPathTool(tool)) return 0;
  if (isBareCodexShellBridgeTool(tool)) return 0;
  // `wait` only resumes a yielded exec cell. Keep it with the execution path, but after
  // `exec` itself so a large wait schema cannot starve the tool that creates the cell.
  if (isCursorWaitTool(tool)) return 1;
  if (!tool.namespace && tool.name === "apply_patch") return 2;
  // Structured edit tools convert to apply_patch on the return path, so they must survive the
  // same byte/count truncation as the freeform tool they stand in for (#1017).
  if (!tool.namespace && isCursorStructuredEditToolName(tool.name)) return 2;
  if (cursorToolChoiceAliases(tool).some(name => selectedNames.has(name))) return 3;
  if (tool.loadedFromToolSearch) return 4;
  if (!tool.namespace) return 5;
  return 6;
}

function isPinnedCursorTool(tool: OcxTool, selectedNames: ReadonlySet<string>): boolean {
  return toolPriority(tool, selectedNames) <= 3;
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
  const catalog = tools ?? [];
  const baseEligible = catalog.filter(tool => cursorToolAllowedByChoice(tool, toolChoice, catalog));
  // Synthetic structured edit tools ride along with the freeform apply_patch tool (#1017). They are
  // part of the advertised catalog, so their serialized size counts toward the byte ceiling here.
  const synthetic = cursorStructuredEditTools(catalog, toolChoice);
  const eligible = [...baseEligible, ...synthetic];
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

  // Phase 1: selected tools + execution path + apply_patch (priority <= 3).
  // Pins are admitted before filler so a crowded catalog cannot drop the Codex execution path (#399).
  for (const candidate of candidates) {
    if (!isPinnedCursorTool(candidate.tool, selectedNames)) continue;
    tryKeep(candidate.tool);
  }

  // Phase 2: remaining tools by priority.
  for (const candidate of candidates) {
    tryKeep(candidate.tool);
  }

  const evictNonExecutionPath = (needBytes: number): void => {
    for (let i = kept.length - 1; i >= 0; i--) {
      const occupant = kept[i];
      if (!occupant || isCursorExecutionPathTool(occupant)) continue;
      kept.splice(i, 1);
      keptSet.delete(occupant);
      keptBytes -= cursorMcpToolEncodedSize(occupant, toolChoice);
      if (kept.length < CURSOR_TOOL_COUNT_LIMIT && keptBytes + needBytes <= CURSOR_TOOL_BYTES_LIMIT) {
        return;
      }
    }
  };

  // Force-admit at least one execution-path tool when one was eligible. Priority-0
  // admission can still fail if the tool itself is larger than leftover room after
  // earlier same-priority pins; evict wait/patch/filler rather than ship wait-only.
  for (const tool of eligible) {
    if (!isCursorExecutionPathTool(tool) || keptSet.has(tool)) continue;
    const need = cursorMcpToolEncodedSize(tool, toolChoice);
    if (need > CURSOR_TOOL_BYTES_LIMIT) continue;
    evictNonExecutionPath(need);
    tryKeep(tool);
    if (keptSet.has(tool)) break;
  }

  const eligibleHasExecutionPath = eligible.some(isCursorExecutionPathTool);
  const keptHasExecutionPath = eligible.some(tool => keptSet.has(tool) && isCursorExecutionPathTool(tool));
  // Never advertise `wait` after dropping the tool that creates the exec cell.
  if (eligibleHasExecutionPath && !keptHasExecutionPath) {
    for (const tool of eligible) {
      if (!isCursorWaitTool(tool) || !keptSet.has(tool)) continue;
      keptSet.delete(tool);
      const index = kept.indexOf(tool);
      if (index >= 0) kept.splice(index, 1);
      keptBytes -= cursorMcpToolEncodedSize(tool, toolChoice);
    }
  }

  return {
    tools: eligible.filter(tool => keptSet.has(tool)),
    // Synthetic tools are pinned in phase 1 and never reported as omitted; the note counts only
    // tools the client itself requested.
    omitted: baseEligible.filter(tool => !keptSet.has(tool)),
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
 * Resolve a `cursor/<model>` selection + Codex reasoning effort to Cursor's requested model shape.
 * Most models encode effort in a flat id (`claude-4.6-opus-high`). Grok Fast is parameterized
 * instead: current Cursor clients send the matching Grok base id plus `effort` and `fast` parameters.
 * A fully-qualified id (one that is not a known effort base) passes through unchanged.
 */
function normalizeCursorModelId(modelId: string, reasoning?: string): {
  modelId: string;
  requestedModelParameters?: readonly CursorRequestedModelParameter[];
  routingLevel?: CursorRoutingLevel;
  maxMode?: boolean;
} {
  // Router ids (auto / auto-<level>) keep their dedicated wire selection.
  const selection = cursorWireModelSelection(modelId);
  if (selection.routingLevel !== undefined || selection.modelId === "default") return selection;
  // Umbrella catalog resolution (devlog 260828_cursor_umbrella_catalog): one
  // resolver owns effort composition, variant dimensions, the synthetic -1m
  // marker (ultra -> Max Mode, evidence-gated), and the cursor- wire prefix.
  const id = selection.modelId;
  // Grok Fast stays parameterized: current Cursor clients send the base id
  // plus effort/fast parameters instead of the flattened -fast id.
  const grokFast = cursorGrokFastSelection(id, reasoning);
  if (grokFast) {
    return {
      ...selection,
      modelId: grokFast.wireBaseId,
      requestedModelParameters: [
        { id: "effort", value: grokFast.effort },
        { id: "fast", value: "true" },
      ],
    };
  }
  const resolved = resolveCursorSelection(id, reasoning);
  return {
    ...selection,
    ...(resolved.maxMode ? { maxMode: true } : {}),
    modelId: resolved.wireId,
  };
}

function contentPartToText(part: OcxContentPart | OcxAssistantContentPart): string | undefined {
  switch (part.type) {
    case "text":
      return part.text;
    case "thinking":
      return part.thinking;
    case "image":
      // Images ride UserMessage.selected_context (SelectedImage) instead of text.
      return undefined;
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
    `call_id: ${decodeCursorCallId(message.toolCallId)}`,
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
      {
        const content = contentToText(message.content);
        // Image-only turns survive as empty content; the encoder keeps them userMessageAction.
        if (content.length === 0 && extractCursorImageUrls(message.content).length === 0) {
          return undefined;
        }
        return { role: message.role, content };
      }
    case "assistant":
      {
        const content = contentToText(message.content);
        return content.length > 0 ? { role: "assistant", content } : undefined;
      }
    case "toolResult":
      return {
        role: "tool",
        content: toolResultToText(message),
      };
  }
}

/**
 * Rebuild the text `messages` channel from prepared `rawMessages` so omission markers
 * and JPEG-rewritten parts stay visible to activePromptText after image preparation.
 */
export function cursorRequestMessagesFromRaw(
  messages: readonly OcxMessage[] | undefined,
): CursorRequestMessage[] {
  if (!messages?.length) return [];
  return messages
    .map(requestMessage)
    .filter((message): message is CursorRequestMessage => !!message);
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
 * Priority: force-fresh → isolate helper → remembered → client thread owner → random.
 * Never use OpenAI Responses `previous_response_id` (resp_*) or shared `prompt_cache_key`
 * (cache-cohort fingerprint, not conversation ownership).
 */
export function resolveCursorConversationId(
  parsed: OcxParsedRequest,
  _wireModelId: string,
  options: CreateCursorRequestOptions = {},
): string {
  if (options.forceFreshConversation === true) return generatedCursorConversationId();
  if (parsed._cursorIsolateConversation === true) return generatedCursorConversationId();
  if (parsed._cursorConversationId) return parsed._cursorConversationId;
  const threadId = cursorClientThreadOwner(parsed);
  if (threadId) {
    const recovered = lookupCursorThreadConversation(threadId, parsed._cursorIdentityScope);
    if (recovered) return recovered;
    return cursorConversationIdFromClientThread(`thread:${threadId}`, parsed._cursorIdentityScope);
  }
  return generatedCursorConversationId();
}

export function cursorClientThreadOwner(parsed: OcxParsedRequest): string | undefined {
  return parsed._clientThreadId?.trim() || parsed._cursorClientThreadId?.trim() || undefined;
}

function updateFramed(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

export function cursorInstructionDigest(parsed: OcxParsedRequest): string {
  const hash = createHash("sha256").update("ocx:cursor:sys:");
  for (const line of parsed.context.systemPrompt ?? []) updateFramed(hash, line);
  for (const message of parsed.context.messages) {
    if (message.role !== "developer") continue;
    updateFramed(hash, contentToText(message.content));
  }
  return hash.digest("hex");
}

export function cursorCoveredPrefixDigest(parsed: OcxParsedRequest, coveredMessageCount: number): string {
  const hash = createHash("sha256").update("ocx:cursor:prefix:");
  updateFramed(hash, cursorInstructionDigest(parsed));
  for (const message of parsed.context.messages.slice(0, coveredMessageCount)) {
    updateFramed(hash, message.role);
    updateFramed(hash, contentToText(message.content));
  }
  return hash.digest("hex");
}

export interface CreateCursorRequestOptions {
  /** Force a brand-new Cursor conversation id even when remembered state exists. */
  forceFreshConversation?: boolean;
}

function lookupPrefixSnapshot(
  parsed: OcxParsedRequest,
  request: CursorRunRequest,
  identityScope: string,
): CursorCheckpointSnapshot | undefined {
  const systemDigest = cursorInstructionDigest(parsed);
  const modelId = cursorCheckpointModelAffinityId(request.modelId);
  for (let covered = parsed.context.messages.length; covered >= 1; covered--) {
    const snapshot = getCursorCheckpointForPrefix({
      conversationId: request.conversationId,
      prefixDigest: cursorCoveredPrefixDigest(parsed, covered),
      systemDigest,
      coveredMessageCount: covered,
      identityScope,
      modelId,
    });
    if (snapshot) return snapshot;
  }
  return undefined;
}

function lineageMismatch(
  parsed: OcxParsedRequest,
  snapshot: CursorCheckpointSnapshot,
): CursorCheckpointInvalidationReason | undefined {
  const covered = snapshot.coveredMessageCount;
  if (covered === undefined || covered < 0 || covered > parsed.context.messages.length) {
    return "lineage_mismatch";
  }
  if (!snapshot.prefixDigest || !snapshot.systemDigest) return "lineage_mismatch";
  if (snapshot.systemDigest !== cursorInstructionDigest(parsed)) return "lineage_mismatch";
  if (snapshot.prefixDigest !== cursorCoveredPrefixDigest(parsed, covered)) return "lineage_mismatch";
  const lastRole = parsed.context.messages.at(-1)?.role;
  if (lastRole === "toolResult" && covered >= parsed.context.messages.length) return "trailing_tool_result";
  return undefined;
}

function resolveCursorCheckpoint(
  parsed: OcxParsedRequest,
  request: CursorRunRequest,
  options: CreateCursorRequestOptions,
): { snapshot: CursorCheckpointSnapshot } | { reason: CursorCheckpointInvalidationReason } {
  if (options.forceFreshConversation === true) return { reason: "force_fresh" };
  if (parsed._compactionRequest === true || parsed._contextCompactionBoundary === true) return { reason: "compaction" };
  const isolated = parsed._cursorIsolateConversation === true;
  const cursorState = parsed._providerContinuation?.cursor;
  const ref = isolated ? undefined : cursorState?.checkpointRef;
  const identityScope = parsed._cursorIdentityScope?.trim() || "local";
  let snapshot: CursorCheckpointSnapshot | undefined;
  if (ref) {
    snapshot = getCursorCheckpoint(ref);
    if (!snapshot) return { reason: "expired" };
  } else {
    if (
      isolated
      || (!parsed._cursorConversationId && !cursorClientThreadOwner(parsed))
    ) return { reason: "missing_ref" };
    snapshot = lookupPrefixSnapshot(parsed, request, identityScope);
    if (!snapshot) return { reason: "missing_ref" };
  }
  if (snapshot.conversationId !== request.conversationId) {
    return { reason: "conversation_changed" };
  }
  if (snapshot.identityScope !== identityScope) return { reason: "identity_changed" };
  if (cursorCheckpointModelAffinityId(snapshot.modelId) !== cursorCheckpointModelAffinityId(request.modelId)) {
    return { reason: "model_changed" };
  }
  if (parsed.context.messages.at(-1)?.role !== "toolResult" && cursorState?.checkpointUsable === false) {
    return { reason: "trailing_tool_result" };
  }
  const lineage = lineageMismatch(parsed, snapshot);
  if (lineage) return { reason: lineage };
  return { snapshot };
}

export function createCursorRequest(
  parsed: OcxParsedRequest,
  options: CreateCursorRequestOptions = {},
): CursorRunRequest {
  const messages = cursorRequestMessagesFromRaw(parsed.context.messages);
  const activeText = [...messages].reverse().find(message => message.role === "user" || message.role === "developer")?.content ?? "";
  const visibleTools = cursorToolsForActivePrompt(parsed.context.tools, activeText, parsed.options.toolChoice);
  const budget = applyCursorToolBudget(visibleTools, parsed.options.toolChoice);
  const limitNote = catalogLimitNote(budget.tools, budget.omitted);
  const model = normalizeCursorModelId(parsed.modelId, parsed.options.reasoning);
  const request: CursorRunRequest = {
    modelId: model.modelId,
    ...(model.requestedModelParameters ? { requestedModelParameters: model.requestedModelParameters } : {}),
    ...(model.routingLevel ? { routingLevel: model.routingLevel } : {}),
    ...(model.maxMode ? { maxMode: true } : {}),
    conversationId: resolveCursorConversationId(parsed, model.modelId, options),
    system: [...(parsed.context.systemPrompt ?? []), ...(limitNote ? [limitNote] : [])],
    messages,
    rawMessages: parsed.context.messages,
    ...(parsed._compactionRequest === true || parsed._contextCompactionBoundary === true ? { contextUsageReset: true } : {}),
    ...(parsed._compactionRequest === true ? { contextUsageStoreCheckpoints: false } : {}),
    ...(budget.tools.length ? { tools: budget.tools } : {}),
    // Bare API caller (no tools, no Codex thread identity): suppress Cursor's default
    // native tool catalog instead of paying its ~10-15K token preamble (devlog 260826 040).
    ...(budget.tools.length === 0 && !cursorClientThreadOwner(parsed)
      ? { suppressDefaultCursorToolCatalog: true }
      : {}),
    ...(parsed.options.toolChoice ? { toolChoice: parsed.options.toolChoice } : {}),
    ...(parsed.options.parallelToolCalls !== undefined ? { parallelToolCalls: parsed.options.parallelToolCalls } : {}),
  };
  const resolved = resolveCursorCheckpoint(parsed, request, options);
  if ("reason" in resolved) {
    request.continuationMode = "full-replay";
    request.checkpointInvalidationReason = resolved.reason;
    return request;
  }
  request.checkpointBytes = resolved.snapshot.checkpointBytes;
  request.continuationMode = "checkpoint";
  if (parsed.context.messages.at(-1)?.role === "toolResult" && resolved.snapshot.coveredMessageCount !== undefined) {
    request.checkpointSuffixStart = resolved.snapshot.coveredMessageCount;
  }
  return request;
}
