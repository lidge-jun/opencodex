import type { OcxUsage } from "../../types";
import type { AgentServerMessage, McpArgs, ToolCall } from "./gen/agent_pb";
import { textDecoder } from "./native-exec-common";
import { OCX_RESPONSES_TOOL_PROVIDER } from "./tool-definitions";
import type { CursorServerMessage } from "./types";

export interface CursorProtobufEventState {
  usage: OcxUsage;
  openToolCalls: Map<string, { name: string; args: string }>;
  clientToolNames?: Set<string>;
}

export function createCursorProtobufEventState(options: { clientToolNames?: Iterable<string> } = {}): CursorProtobufEventState {
  return {
    usage: { inputTokens: 0, outputTokens: 0 },
    openToolCalls: new Map(),
    ...(options.clientToolNames ? { clientToolNames: new Set(options.clientToolNames) } : {}),
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
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args?.args ?? {})) {
    const text = textDecoder.decode(value);
    try {
      out[key] = JSON.parse(text);
    } catch {
      out[key] = text;
    }
  }
  return JSON.stringify(out);
}

function startToolCall(state: CursorProtobufEventState, callId: string, name: string): CursorServerMessage[] {
  if (state.openToolCalls.has(callId)) return [];
  if (state.clientToolNames && !state.clientToolNames.has(name)) {
    return [{ type: "error", message: `Cursor requested unknown Responses tool: ${name}` }];
  }
  state.openToolCalls.set(callId, { name, args: "" });
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
      if (name) out.push(...startToolCall(state, update.value.callId, name));
      const open = state.openToolCalls.get(update.value.callId);
      const args = mcpArgsFromToolCall(update.value.toolCall);
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
