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
 * Cursor Connect transport limits (probe-verified 2026-07-21):
 *
 * COUNT limit: ~332 tools per AgentRunRequest.mcp_tools.  Sending 333+
 * McpToolDefinition entries triggers `resource_exhausted` regardless of
 * payload size (verified with minimal stub schemas).
 *
 * BYTE limit: ~128 KB total protobuf payload for mcp_tools.  With full
 * JSON schemas (~566 bytes/tool average), this caps us at ~230 tools.
 *
 * Hybrid strategy: send up to CURSOR_TOOL_COUNT_BUDGET tools, but stub
 * the inputSchema for tools beyond the byte budget so the model sees all
 * tool names/descriptions while staying under both limits.  Full schemas
 * for stubbed tools are provided via a text catalog in the system prompt
 * and via tool_search on demand.
 *
 * See https://github.com/lidge-jun/opencodex/issues/190
 */
const CURSOR_TOOL_COUNT_BUDGET = 330;

/**
 * Approximate byte budget for the mcp_tools protobuf field.  Probe showed
 * 128 KB is the server-side ceiling; we use 120 KB for margin.
 */
const CURSOR_TOOL_BYTE_BUDGET = 120_000;

/**
 * Approximate encoded size of a stub schema (`{"type":"object","properties":{}}`).
 * Used to estimate how much byte-space stubbed tools consume.
 */
const STUB_SCHEMA_BYTES = 30;

const CURSOR_DEFERRED_TOOLS_NOTE = [
  "[opencodex] Some tools have abbreviated schemas due to a transport limit.",
  "Their full argument schemas are listed in the tool catalog below.",
  "Use `tool_search` to load any tool's full schema on demand.",
].join(" ");

const CURSOR_DEFERRED_TOOLS_NOTE_NO_SEARCH = [
  "[opencodex] Some tools have abbreviated schemas due to a transport limit.",
  "Their full argument schemas are listed in the tool catalog below.",
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
): { tools: OcxTool[]; trimmed: boolean; countTrimmed: boolean } {
  if (tools.length <= CURSOR_TOOL_COUNT_BUDGET) return { tools: [...tools], trimmed: false, countTrimmed: false };

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
  let countTrimmed = false;
  const cappedNative = native.length > CURSOR_TOOL_COUNT_BUDGET
    ? (() => { trimmed = true; countTrimmed = true; return native.slice(0, CURSOR_TOOL_COUNT_BUDGET); })()
    : native;

  // Sort namespaces smallest-first to maximise the number of namespaces that fit.
  const sorted = [...namespaceGroups.entries()].sort((a, b) => a[1].length - b[1].length);

  let remaining = CURSOR_TOOL_COUNT_BUDGET - cappedNative.length - reserved.length;
  const kept: OcxTool[] = [...cappedNative, ...reserved];

  for (const [, group] of sorted) {
    if (group.length <= remaining) {
      kept.push(...group);
      remaining -= group.length;
    } else {
      trimmed = true;
      countTrimmed = true;
      // Stop — no more namespaces fit.
      break;
    }
  }

  // If we broke early, all subsequent namespaces are also trimmed.
  if (kept.length < tools.length) { trimmed = true; countTrimmed = true; }

  return { tools: kept, trimmed, countTrimmed };
}

/**
 * Estimate the encoded protobuf size of a tool's inputSchema.
 * Uses JSON stringification length as a proxy (protobuf Value encoding
 * is roughly 1.1-1.3x the JSON length for typical schemas).
 */
function estimateSchemaBytes(tool: OcxTool): number {
  const schema = tool.parameters ?? {};
  const jsonLen = JSON.stringify(schema).length;
  // protobuf Value encoding overhead: ~1.2x JSON + field tags
  return Math.ceil(jsonLen * 1.2) + 20;
}

/**
 * Determine which tools should have their schemas stubbed to stay under
 * the byte budget.  Native tools and the first N namespace tools keep
 * full schemas; the rest get stubs.  Returns the set of wire-names that
 * should be stubbed.
 */
function computeStubbedTools(tools: readonly OcxTool[]): Set<string> {
  const stubbed = new Set<string>();
  let cumulativeBytes = 0;

  // Process tools in order: native first (they keep full schemas),
  // then namespace tools in their existing order.
  for (const tool of tools) {
    const wireName = tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
    const schemaBytes = estimateSchemaBytes(tool);

    if (cumulativeBytes + schemaBytes > CURSOR_TOOL_BYTE_BUDGET) {
      // This tool's full schema would exceed the byte budget — stub it.
      stubbed.add(wireName);
      cumulativeBytes += STUB_SCHEMA_BYTES;
    } else {
      cumulativeBytes += schemaBytes;
    }
  }

  return stubbed;
}

/**
 * Build a compact text catalog of stubbed tools for injection into the
 * system prompt.  The model reads this to understand argument structures
 * for tools whose protobuf schemas were stubbed.
 */
function buildTextCatalog(tools: readonly OcxTool[], stubbedNames: ReadonlySet<string>): string | undefined {
  const entries: string[] = [];
  for (const tool of tools) {
    const wireName = tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
    if (!stubbedNames.has(wireName)) continue;
    const schema = tool.parameters ?? {};
    const props = (schema as Record<string, unknown>).properties;
    const required = (schema as Record<string, unknown>).required;
    const propSummary = props && typeof props === "object"
      ? Object.entries(props as Record<string, Record<string, unknown>>)
          .map(([k, v]) => `${k}: ${v?.type ?? "any"}${(required as string[] | undefined)?.includes(k) ? "*" : ""}`)
          .join(", ")
      : "";
    entries.push(`- ${wireName}: ${tool.description.slice(0, 120)} | args: {${propSummary}}`);
  }
  if (entries.length === 0) return undefined;
  return [
    "[opencodex] Tool schema catalog (abbreviated schemas — use these to construct arguments):",
    ...entries,
    "(*) = required parameter",
  ].join("\n");
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

  const { tools: budgetedTools, trimmed, countTrimmed } = enforceCursorToolBudget(rawTools, reservedNames);

  // Compute which tools need stubbed schemas to stay under the byte budget.
  const stubbedToolNames = computeStubbedTools(budgetedTools);
  const hasStubbedTools = stubbedToolNames.size > 0;

  // Only suggest tool_search if it actually survived the budget.
  const hasToolSearch = budgetedTools.some(t => t.name === "tool_search");
  const needsNote = trimmed || hasStubbedTools;
  const deferredNote = needsNote
    ? (hasToolSearch ? CURSOR_DEFERRED_TOOLS_NOTE : CURSOR_DEFERRED_TOOLS_NOTE_NO_SEARCH)
    : undefined;

  // Build text catalog for stubbed tools.
  const textCatalog = hasStubbedTools ? buildTextCatalog(budgetedTools, stubbedToolNames) : undefined;

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
      ...(textCatalog ? [textCatalog] : []),
    ],
    messages: parsed.context.messages
      .map(requestMessage)
      .filter((message): message is CursorRequestMessage => !!message && message.content.length > 0),
    rawMessages: parsed.context.messages,
    ...(budgetedTools.length ? { tools: budgetedTools } : {}),
    ...(stubbedToolNames.size > 0 ? { stubbedToolNames } : {}),
    ...(parsed.options.toolChoice ? { toolChoice: parsed.options.toolChoice } : {}),
    ...(parsed.options.parallelToolCalls !== undefined ? { parallelToolCalls: parsed.options.parallelToolCalls } : {}),
  };
}
