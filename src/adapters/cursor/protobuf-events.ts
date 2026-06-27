import type { OcxUsage } from "../../types";
import type { AgentServerMessage, McpArgs, ToolCall } from "./gen/agent_pb";
import { decodeCursorArgsMap } from "./arg-codec";
import { OCX_RESPONSES_TOOL_PROVIDER } from "./tool-definitions";
import type { CursorServerMessage } from "./types";

export interface CursorProtobufEventState {
  usage: OcxUsage;
  openToolCalls: Map<string, { name: string; args: string }>;
  clientToolNames?: Set<string>;
  parallelToolCalls?: boolean;
  startedClientToolCalls: number;
}

export function createCursorProtobufEventState(options: { clientToolNames?: Iterable<string>; parallelToolCalls?: boolean } = {}): CursorProtobufEventState {
  return {
    usage: { inputTokens: 0, outputTokens: 0 },
    openToolCalls: new Map(),
    ...(options.clientToolNames ? { clientToolNames: new Set(options.clientToolNames) } : {}),
    ...(options.parallelToolCalls !== undefined ? { parallelToolCalls: options.parallelToolCalls } : {}),
    startedClientToolCalls: 0,
  };
}

function mcpArgsFromToolCall(toolCall: ToolCall | undefined): McpArgs | undefined {
  if (toolCall?.tool.case !== "mcpToolCall") return undefined;
  const args = toolCall.tool.value.args;
  return args?.providerIdentifier === OCX_RESPONSES_TOOL_PROVIDER ? args : undefined;
}

function mcpToolName(toolCall: ToolCall | undefined): string | undefined {
  const args = mcpArgsFromToolCall(toolCall);
  const name = args?.toolName || args?.name;
  return name && name.length > 0 ? name : undefined;
}

function decodeMcpArgs(args: McpArgs | undefined): string {
  return JSON.stringify(decodeCursorArgsMap(args?.args));
}

function hasMcpArgBytes(args: McpArgs | undefined): boolean {
  return Object.keys(args?.args ?? {}).length > 0;
}

export function mapSyntheticMcpExecToToolEvents(
  args: McpArgs,
  fallbackCallId = "cursor_mcp_exec",
  options: { allowEmptyArgs?: boolean; suppressStart?: boolean; state?: CursorProtobufEventState } = {},
): CursorServerMessage[] {
  if (args.providerIdentifier !== OCX_RESPONSES_TOOL_PROVIDER) return [];
  if (options.allowEmptyArgs !== true && !hasMcpArgBytes(args)) return [];
  const name = args.toolName || args.name;
  if (!name) return [{ type: "error", message: "Cursor requested a Responses tool without a tool name" }];
  const callId = args.toolCallId || fallbackCallId;
  if (options.state) {
    const out: CursorServerMessage[] = [];
    if (options.suppressStart !== true) out.push(...startToolCall(options.state, callId, name));
    if (out.some(event => event.type === "error")) return out;
    out.push(...appendToolArgs(options.state, callId, decodeMcpArgs(args)));
    out.push(...endToolCall(options.state, callId));
    return out;
  }
  const out: CursorServerMessage[] = [];
  if (options.suppressStart !== true) out.push({ type: "tool_call_start", id: callId, name });
  out.push({ type: "tool_call_delta", arguments: decodeMcpArgs(args) });
  out.push({ type: "tool_call_end", id: callId });
  return out;
}

function startToolCall(state: CursorProtobufEventState, callId: string, name: string): CursorServerMessage[] {
  if (state.openToolCalls.has(callId)) return [];
  if (state.clientToolNames && !state.clientToolNames.has(name)) {
    return [{ type: "error", message: `Cursor requested unknown Responses tool: ${name}` }];
  }
  if (state.parallelToolCalls === false && state.startedClientToolCalls > 0) {
    return [{ type: "error", message: "Cursor requested multiple parallel Responses tool calls but parallel_tool_calls is false" }];
  }
  state.openToolCalls.set(callId, { name, args: "" });
  state.startedClientToolCalls++;
  return [{ type: "tool_call_start", id: callId, name }];
}

function appendToolArgs(state: CursorProtobufEventState, callId: string, nextArgs: string): CursorServerMessage[] {
  if (nextArgs.length === 0) return [];
  const open = state.openToolCalls.get(callId);
  const delta = open ? nextArgs.slice(open.args.length) : nextArgs;
  if (open) {
    if (!nextArgs.startsWith(open.args)) {
      state.openToolCalls.delete(callId);
      return [{ type: "error", message: `Cursor sent non-prefix Responses tool arguments for call ${callId}` }];
    }
    open.args = nextArgs;
  }
  if (delta.length === 0) return [];
  return [{ type: "tool_call_delta", arguments: delta }];
}

function endToolCall(state: CursorProtobufEventState, callId: string): CursorServerMessage[] {
  if (!state.openToolCalls.has(callId)) return [];
  state.openToolCalls.delete(callId);
  return [{ type: "tool_call_end", id: callId }];
}

export function mapCursorProtobufServerMessage(
  serverMessage: AgentServerMessage,
  state: CursorProtobufEventState,
): CursorServerMessage[] {
  if (serverMessage.message.case === "conversationCheckpointUpdate") {
    const usedTokens = serverMessage.message.value.tokenDetails?.usedTokens ?? 0;
    if (usedTokens > state.usage.outputTokens) state.usage.outputTokens = usedTokens;
    return [];
  }

  if (serverMessage.message.case !== "interactionUpdate") return [];
  const update = serverMessage.message.value.message;
  switch (update.case) {
    case "textDelta":
      return update.value.text ? [{ type: "text", text: update.value.text }] : [];
    case "thinkingDelta":
      return update.value.text ? [{ type: "thinking", thinking: update.value.text }] : [];
    case "toolCallStarted": {
      const name = mcpToolName(update.value.toolCall);
      return name ? startToolCall(state, update.value.callId, name) : [];
    }
    case "partialToolCall": {
      const out: CursorServerMessage[] = [];
      const name = mcpToolName(update.value.toolCall);
      if (name) out.push(...startToolCall(state, update.value.callId, name));
      if (state.openToolCalls.has(update.value.callId)) {
        out.push(...appendToolArgs(state, update.value.callId, update.value.argsTextDelta));
      }
      return out;
    }
    case "toolCallDelta":
      // Cursor's typed deltas currently cover native exec internals (shell/task/edit). Client
      // Responses tools return as McpToolCall plus partial args text, so native deltas stay internal.
      return [];
    case "toolCallCompleted": {
      const out: CursorServerMessage[] = [];
      const name = mcpToolName(update.value.toolCall);
      const args = mcpArgsFromToolCall(update.value.toolCall);
      const openBeforeStart = state.openToolCalls.get(update.value.callId);
      if (name && !hasMcpArgBytes(args) && (!openBeforeStart || openBeforeStart.args.length === 0)) return [];
      if (name) out.push(...startToolCall(state, update.value.callId, name));
      const open = state.openToolCalls.get(update.value.callId);
      if (open && args) {
        out.push(...appendToolArgs(state, update.value.callId, decodeMcpArgs(args)));
      }
      out.push(...endToolCall(state, update.value.callId));
      return out;
    }
    case "tokenDelta":
      state.usage.outputTokens += update.value.tokens;
      return [];
    case "turnEnded":
      return [{ type: "done", usage: { ...state.usage } }];
    default:
      return [];
  }
}
