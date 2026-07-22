import type { OcxUsage } from "../../types";
import type { AgentServerMessage, McpArgs, ToolCall } from "./gen/agent_pb";
import { decodeCursorArgsMap } from "./arg-codec";
import { normalizeArgKeys } from "./arg-normalize";
import { OCX_RESPONSES_TOOL_PROVIDER, normalizeCursorWireName, responsesToolNameFromCursorWire } from "./tool-definitions";
import type { CursorServerMessage } from "./types";

export interface CursorProtobufEventState {
  usage: OcxUsage;
  /**
   * Absolute conversation context size from Cursor's `conversationCheckpointUpdate.usedTokens`
   * (authoritative cumulative context, NOT a per-turn delta). Kept separate from `usage.outputTokens`
   * so it is never folded into the additive per-turn output count. Surfaced as `done.usage.totalTokens`
   * so Codex's `last_token_usage.total_tokens` reflects the real active context. Mirrors the Kiro
   * contextUsagePercentage SOT fix (devlog 142.10): absolute context and additive output must not
   * share one field, or Codex double-counts (e.g. 10000 then 10300 surfacing as 20300).
   */
  contextTokens?: number;
  /** Best-effort active input context used only when Cursor never emits a checkpoint this turn. */
  fallbackInputTokens?: number;
  openToolCalls: Map<string, { name: string; args: string }>;
  completedToolCalls: Set<string>;
  /** Set once a terminal `done`/truncation has been emitted, so post-terminal frames stay inert. */
  terminated?: boolean;
  clientToolNames?: Set<string>;
  parallelToolCalls?: boolean;
  startedClientToolCalls: number;
  /** Tool wire-name → original JSON Schema parameters object, for arg-key normalization. */
  toolSchemas?: Map<string, unknown>;
  /** Cursor wire-name → original Responses/Codex tool name for this request. */
  cursorToolNameMap?: Map<string, string>;
}

export function createCursorProtobufEventState(options: { clientToolNames?: Iterable<string>; parallelToolCalls?: boolean; toolSchemas?: Map<string, unknown>; cursorToolNameMap?: Map<string, string>; fallbackInputTokens?: number } = {}): CursorProtobufEventState {
  return {
    // Cursor provides no authoritative usage frame; token counts are heuristic estimates from
    // checkpoint/delta events, so mark estimated from the start.
    usage: { inputTokens: 0, outputTokens: 0, estimated: true },
    ...(options.fallbackInputTokens !== undefined ? { fallbackInputTokens: options.fallbackInputTokens } : {}),
    openToolCalls: new Map(),
    completedToolCalls: new Set(),
    ...(options.clientToolNames ? { clientToolNames: new Set(options.clientToolNames) } : {}),
    ...(options.parallelToolCalls !== undefined ? { parallelToolCalls: options.parallelToolCalls } : {}),
    startedClientToolCalls: 0,
    ...(options.toolSchemas ? { toolSchemas: options.toolSchemas } : {}),
    ...(options.cursorToolNameMap ? { cursorToolNameMap: options.cursorToolNameMap } : {}),
  };
}

/** Exported for live-transport's client-tool frame classification (finalize revocation). */
export function mcpArgsFromToolCall(toolCall: ToolCall | undefined): McpArgs | undefined {
  if (toolCall?.tool.case !== "mcpToolCall") return undefined;
  const args = toolCall.tool.value.args;
  return args?.providerIdentifier === OCX_RESPONSES_TOOL_PROVIDER ? args : undefined;
}

function mcpWireNameFromArgs(args: McpArgs | undefined): string | undefined {
  const raw = args?.toolName || args?.name;
  // Models may call the Cursor-displayed `mcp_<provider>_<tool>` name; fold it to the advertised name.
  return raw && raw.length > 0 ? normalizeCursorWireName(raw) : undefined;
}

function mcpCursorWireName(toolCall: ToolCall | undefined): string | undefined {
  return mcpWireNameFromArgs(mcpArgsFromToolCall(toolCall));
}

function decodeMcpArgs(args: McpArgs | undefined): string {
  return JSON.stringify(decodeCursorArgsMap(args?.args));
}

function decodeMcpArgsNormalized(args: McpArgs | undefined, state: CursorProtobufEventState): string {
  const decoded = decodeCursorArgsMap(args?.args);
  const toolName = mcpWireNameFromArgs(args);
  if (toolName && state.toolSchemas?.has(toolName)) {
    return JSON.stringify(normalizeArgKeys(decoded, state.toolSchemas.get(toolName)));
  }
  return JSON.stringify(decoded);
}

function hasMcpArgBytes(args: McpArgs | undefined): boolean {
  return Object.keys(args?.args ?? {}).length > 0;
}

function isCompleteJson(text: string): boolean {
  if (text.length === 0) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Schema-normalize a JSON-text argument blob for a named tool, if a schema is known. */
function normalizeJsonText(text: string, toolName: string | undefined, state: CursorProtobufEventState): string {
  if (!toolName || !state.toolSchemas?.has(toolName)) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify(normalizeArgKeys(parsed as Record<string, unknown>, state.toolSchemas.get(toolName)));
    }
  } catch {
    // Not parseable as an object: leave as-is.
  }
  return text;
}

/**
 * Resolve the authoritative argument string for a completed client tool call.
 *
 * Cursor sends args two ways: incrementally as `argsTextDelta` (buffered into `open.args`, never
 * streamed onward), and/or as a structured protobuf map on `toolCallCompleted`. We emit the args
 * exactly once, at completion, so they can always be schema-normalized regardless of which form
 * arrived. The completed map wins when present (canonical); otherwise the buffered streamed text is
 * used. Returns an empty string when there are no args (the bridge serializes that as `{}`).
 */
function resolveCompletedArgs(buffered: string, args: McpArgs | undefined, state: CursorProtobufEventState): string {
  if (hasMcpArgBytes(args)) return decodeMcpArgsNormalized(args, state);
  const name = mcpWireNameFromArgs(args);
  if (isCompleteJson(buffered)) return normalizeJsonText(buffered, name, state);
  return "";
}

export function mapSyntheticMcpExecToToolEvents(
  args: McpArgs,
  fallbackCallId = "cursor_mcp_exec",
  options: { allowEmptyArgs?: boolean; state?: CursorProtobufEventState } = {},
): CursorServerMessage[] {
  if (args.providerIdentifier !== OCX_RESPONSES_TOOL_PROVIDER) return [];
  if (options.allowEmptyArgs !== true && !hasMcpArgBytes(args)) return [];
  const cursorWireName = mcpWireNameFromArgs(args);
  if (!cursorWireName) return [{ type: "error", message: "Cursor requested a Responses tool without a tool name" }];
  const callId = args.toolCallId || fallbackCallId;
  if (options.state?.completedToolCalls.has(callId)) return [];
  if (options.state) {
    // Native-exec delivers the whole client tool call at once. Record it (no-op if already opened by
    // an earlier started/partial event), then emit the atomic start -> delta -> end unit.
    const out: CursorServerMessage[] = [...recordToolCall(options.state, callId, cursorWireName)];
    if (out.some(event => event.type === "error")) return out;
    const open = options.state.openToolCalls.get(callId);
    const finalArgs = resolveCompletedArgs(open?.args ?? "", args, options.state);
    out.push(...commitToolCall(options.state, callId, finalArgs));
    return out;
  }
  // Stateless fallback (no shared event state): emit a complete, self-contained tool call.
  return [
    { type: "tool_call_start", id: callId, name: responsesToolNameFromCursorWire(cursorWireName) },
    { type: "tool_call_delta", arguments: decodeMcpArgs(args) },
    { type: "tool_call_end", id: callId },
  ];
}

/**
 * Record (open) a client tool call WITHOUT emitting `tool_call_start`. The outward start is deferred
 * to completion (see commitToolCall) so each Cursor tool call surfaces to the bridge as one atomic,
 * self-contained start -> delta -> end unit. This lets Cursor open several tool calls in parallel
 * (or interleave their partial-arg streams) without cross-wiring: nothing reaches the single-current-
 * call bridge until a call completes, and completed calls are emitted whole, one after another.
 * Returns an error only for a genuinely unknown (un-advertised) tool name.
 */
function recordToolCall(state: CursorProtobufEventState, callId: string, cursorWireName: string): CursorServerMessage[] {
  if (state.completedToolCalls.has(callId)) return [];
  if (state.openToolCalls.has(callId)) return [];
  if (state.clientToolNames && !state.clientToolNames.has(cursorWireName)) {
    return [{ type: "error", message: `Cursor requested unknown Responses tool: ${cursorWireName}` }];
  }
  state.openToolCalls.set(callId, { name: responsesToolNameFromCursorWire(cursorWireName, state.cursorToolNameMap), args: "" });
  state.startedClientToolCalls++;
  return [];
}

/**
 * Emit a completed client tool call as one atomic unit: `tool_call_start` (deferred from open time),
 * the full normalized arguments delta when present, then `tool_call_end`. The call must already be
 * recorded in `openToolCalls`. Because each completion emits a whole non-interleaved unit, the bridge
 * (which tracks a single current tool call) serializes parallel Cursor calls correctly.
 */
function commitToolCall(state: CursorProtobufEventState, callId: string, finalArgs: string): CursorServerMessage[] {
  const open = state.openToolCalls.get(callId);
  if (!open) return [];
  const out: CursorServerMessage[] = [{ type: "tool_call_start", id: callId, name: open.name }];
  if (finalArgs.length > 0) out.push({ type: "tool_call_delta", arguments: finalArgs });
  out.push(...endToolCall(state, callId));
  return out;
}

/**
 * Buffer Cursor's cumulative `argsTextDelta` into the open call WITHOUT emitting a delta. Args are
 * emitted once, normalized, at completion (see resolveCompletedArgs), so a mis-keyed or
 * non-canonical streamed blob can still be repaired before Codex sees it. `argsTextDelta` is
 * cumulative; keep the longest value seen.
 */
function bufferToolArgs(state: CursorProtobufEventState, callId: string, cumulative: string): void {
  const open = state.openToolCalls.get(callId);
  if (!open) return;
  if (cumulative.length >= open.args.length) open.args = cumulative;
}

function endToolCall(state: CursorProtobufEventState, callId: string): CursorServerMessage[] {
  if (!state.openToolCalls.has(callId)) return [];
  state.openToolCalls.delete(callId);
  state.completedToolCalls.add(callId);
  return [{ type: "tool_call_end", id: callId }];
}

export function mapCursorProtobufServerMessage(
  serverMessage: AgentServerMessage,
  state: CursorProtobufEventState,
): CursorServerMessage[] {
  if (serverMessage.message.case === "conversationCheckpointUpdate") {
    const usedTokens = serverMessage.message.value.tokenDetails?.usedTokens ?? 0;
    // `usedTokens` is the ABSOLUTE conversation context size, not a per-turn output delta. Track it
    // separately (monotonic max) and surface it as `done.usage.totalTokens`; folding it into
    // `outputTokens` (which also accumulates `tokenDelta`) double-counts in Codex. See contextTokens.
    if (usedTokens > (state.contextTokens ?? 0)) state.contextTokens = usedTokens;
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
      const name = mcpCursorWireName(update.value.toolCall);
      // Record the open call but defer the outward tool_call_start to completion (atomic emission).
      return name ? recordToolCall(state, update.value.callId, name) : [];
    }
    case "partialToolCall": {
      const out: CursorServerMessage[] = [];
      const name = mcpCursorWireName(update.value.toolCall);
      if (name) out.push(...recordToolCall(state, update.value.callId, name));
      if (out.some(event => event.type === "error")) return out;
      // Buffer cumulative args; do not emit a delta. Args are emitted once, normalized, at completion.
      if (state.openToolCalls.has(update.value.callId)) {
        bufferToolArgs(state, update.value.callId, update.value.argsTextDelta);
      }
      return out;
    }
    case "toolCallDelta":
      // Cursor's typed deltas currently cover native exec internals (shell/task/edit). Client
      // Responses tools return as McpToolCall plus partial args text, so native deltas stay internal.
      return [];
    case "toolCallCompleted": {
      const out: CursorServerMessage[] = [];
      if (state.completedToolCalls.has(update.value.callId)) return [];
      const name = mcpCursorWireName(update.value.toolCall);
      const args = mcpArgsFromToolCall(update.value.toolCall);
      const openBeforeStart = state.openToolCalls.get(update.value.callId);
      // Empty-arg completion handling:
      //  - already open with empty args  -> wait for the native-exec args path (do not commit yet).
      //  - never started + not advertised -> Cursor prelude noise, drop it.
      //  - advertised client tool, not yet open -> a legitimate no-arg call: commit it (start+end)
      //    so it is not silently dropped; the bridge serializes empty args as "{}".
      if (name && !hasMcpArgBytes(args)) {
        if (openBeforeStart && openBeforeStart.args.length === 0) return [];
        // Only commit a no-arg call when the tool is *explicitly* advertised. Without an advertised
        // tool list we cannot tell a real no-arg call from a Cursor prelude, so we keep dropping it.
        const advertised = state.clientToolNames?.has(name) ?? false;
        if (!openBeforeStart && !advertised) return [];
      }
      // Ensure the call is recorded (covers a completion with no prior started/partial event), then
      // emit it as one atomic start -> delta -> end unit so parallel Cursor calls serialize cleanly.
      if (name) out.push(...recordToolCall(state, update.value.callId, name));
      if (out.some(event => event.type === "error")) return out;
      const open = state.openToolCalls.get(update.value.callId);
      if (open) {
        const finalArgs = resolveCompletedArgs(open.args, args, state);
        out.push(...commitToolCall(state, update.value.callId, finalArgs));
      }
      return out;
    }
    case "tokenDelta":
      state.usage.outputTokens += update.value.tokens;
      return [];
    case "turnEnded":
      return finalizeTurnEvents(state);
    default:
      return [];
  }
}

/**
 * Finalize a Cursor turn. If any client tool call is still open (started but never completed),
 * the stream was truncated and the partial tool call must not reach Codex as a completed call
 * with corrupt/empty arguments. Emit an explicit error instead of done (fail-closed).
 * Mirrors kiro-truncation.ts behavior.
 */
export function finalizeTurnEvents(state: CursorProtobufEventState): CursorServerMessage[] {
  state.terminated = true;
  if (state.openToolCalls.size > 0) {
    const openIds = [...state.openToolCalls.keys()].join(", ");
    // Clear so a second turnEnded (should not happen, but defensive) doesn't re-emit.
    state.openToolCalls.clear();
    return [{ type: "error", message: `Cursor stream ended with incomplete tool call(s): ${openIds}. Arguments may be truncated; the call was not committed.` }];
  }
  // Surface the absolute context size (when Cursor reported a checkpoint) as both totalTokens and
  // the estimated input side of Codex's visible `input + output` counter. Codex status lines can
  // render the additive pair instead of total_tokens, so leaving inputTokens at 0 makes a 16k-context
  // first turn display as "9 used". Keep outputTokens as the per-turn delta and clamp the inferred
  // input to 0 in case Cursor reports a checkpoint smaller than the streamed output delta.
  const usage: OcxUsage = state.contextTokens !== undefined
    ? {
        ...state.usage,
        inputTokens: Math.max(0, state.contextTokens - state.usage.outputTokens),
        totalTokens: state.contextTokens,
      }
    : state.fallbackInputTokens !== undefined
      ? {
          ...state.usage,
          inputTokens: state.fallbackInputTokens,
          totalTokens: state.fallbackInputTokens + state.usage.outputTokens,
        }
    : { ...state.usage };
  return [{ type: "done", usage }];
}
