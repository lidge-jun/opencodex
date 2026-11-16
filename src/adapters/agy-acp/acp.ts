/**
 * Agent Client Protocol (v1) framing for the official Antigravity CLI (`agy acp`).
 *
 * `agy acp` speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. One ACP session answers one
 * turn: initialize -> session/new -> session/set_config_option (model, then thought level) ->
 * session/prompt, with session/update notifications streaming in between. This module is pure: it
 * never spawns a process, never touches the network and never sees a credential (the CLI owns its
 * own sign-in), so the framing and the terminal table are testable against captured lines.
 *
 * Framing descends from the retired Devin CLI ACP module (f97612c956^:src/adapters/devin-cli/acp.ts)
 * with three deliberate departures: frames are dispatched by shape rather than by numeric id (both
 * directions may reuse an id), stop reasons map through a complete terminal table instead of passing
 * through, and nothing child-authored ever reaches an error message.
 */
import type { AdapterEvent, OcxParsedRequest, OcxToolCall, OcxUsage } from "../../types";

/** Hard ceiling on a single buffered stdout line. */
export const MAX_ACP_LINE_BYTES = 8 * 1024 * 1024;
/** Hard ceiling on total stdout bytes consumed for one turn. */
export const MAX_ACP_TOTAL_BYTES = 64 * 1024 * 1024;
/** Ceiling on the flattened conversation handed to one ACP prompt. */
export const MAX_ACP_PROMPT_CHARS = 200_000;
/** ACP v1 "Authentication required". */
export const ACP_AUTH_REQUIRED = -32000;
/** JSON-RPC "Method not found". */
export const ACP_METHOD_NOT_FOUND = -32601;

export type JsonRpcId = number | string;
type Frame = Record<string, unknown>;

export function initializeFrame(id: JsonRpcId, clientVersion: string): Frame {
  // No client capabilities: the CLI must not delegate file system or terminal work to this proxy.
  return {
    jsonrpc: "2.0", id, method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "opencodex", version: clientVersion } },
  };
}

export function sessionNewFrame(id: JsonRpcId, cwd: string, systemPrompt?: string): Frame {
  const params: Frame = { cwd, mcpServers: [] };
  if (systemPrompt) params.systemPrompt = { mode: "append", content: [{ type: "text", text: systemPrompt }] };
  return { jsonrpc: "2.0", id, method: "session/new", params };
}

export function setConfigOptionFrame(id: JsonRpcId, sessionId: string, configId: string, value: string): Frame {
  return { jsonrpc: "2.0", id, method: "session/set_config_option", params: { sessionId, configId, value } };
}

export function sessionPromptFrame(id: JsonRpcId, sessionId: string, text: string): Frame {
  return { jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text }] } };
}

export function sessionCancelFrame(sessionId: string): Frame {
  return { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } };
}

/**
 * The only answer to session/request_permission: cancelled. A headless proxy turn has nobody to
 * approve a tool, and the CLI's own permission engine (request-review) is the boundary this provider
 * relies on, so every ask is refused. No option is ever selected, allow-shaped or otherwise.
 */
export function permissionCancelledFrame(id: JsonRpcId): Frame {
  return { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } };
}

/** Fixed answer to any other agent-to-client request (fs/*, terminal/*, ...): never executed here. */
export function methodNotFoundFrame(id: JsonRpcId): Frame {
  return { jsonrpc: "2.0", id, error: { code: ACP_METHOD_NOT_FOUND, message: "Method not found" } };
}

export type ClassifiedFrame =
  | { kind: "request"; id: JsonRpcId; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "response"; id: JsonRpcId; result?: unknown; error?: { code?: unknown } }
  | { kind: "invalid" };

const isId = (value: unknown): value is JsonRpcId =>
  (typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && value.length > 0 && value.length <= 128);

/** Classify by JSON-RPC shape: a method with an id is a request, without one a notification. */
export function classifyFrame(frame: unknown): ClassifiedFrame {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return { kind: "invalid" };
  const f = frame as Frame;
  if (typeof f.method === "string") {
    if (f.id === undefined) return { kind: "notification", method: f.method, params: f.params };
    return isId(f.id) ? { kind: "request", id: f.id, method: f.method, params: f.params } : { kind: "invalid" };
  }
  if (isId(f.id) && ("result" in f || "error" in f)) {
    const error = f.error && typeof f.error === "object" ? f.error as { code?: unknown } : undefined;
    return { kind: "response", id: f.id, ...(error ? { error } : { result: f.result }) };
  }
  return { kind: "invalid" };
}

/** Fence a block label so a message body cannot forge one. */
function fence(label: string, body: string): string {
  return `[${label}]\n${body.replace(/^\[(System|User|Assistant|Tool)\]/gm, " $&")}`;
}

/** The system text of a parsed request, or "" when there is none. */
export function acpSystemText(parsed: OcxParsedRequest): string {
  return parsed.context.systemPrompt?.filter(line => line.trim().length > 0).join("\n") ?? "";
}

/**
 * Flatten the conversation into the single text block one ACP prompt carries. ACP has no
 * multi-message history on session/prompt. System text is included only when the CLI did not
 * advertise `sessionCapabilities.systemPrompt` (then it travels on session/new instead, never both).
 */
export function buildAcpPrompt(parsed: OcxParsedRequest, includeSystem: boolean): string {
  const blocks: string[] = [];
  const system = includeSystem ? acpSystemText(parsed) : "";
  if (system) blocks.push(fence("System", system));
  for (const message of parsed.context.messages) {
    if (message.role === "toolResult") {
      const body = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      blocks.push(fence("Tool", `[result id=${message.toolCallId}]\n${body}`));
      continue;
    }
    const parts = typeof message.content === "string" ? [] : message.content;
    let text = typeof message.content === "string"
      ? message.content
      : parts.map(p => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n");
    if (message.role === "assistant" && Array.isArray(parts)) {
      const calls = parts
        .filter((p): p is OcxToolCall => p.type === "toolCall")
        .map(c => `[call ${c.name} id=${c.id}]\n${JSON.stringify(c.arguments ?? {})}`)
        .join("\n\n");
      if (calls) text = text ? `${text}\n\n${calls}` : calls;
    }
    if (!text.trim()) continue;
    const label = message.role === "assistant" ? "Assistant" : message.role === "developer" ? "System" : "User";
    blocks.push(fence(label, text));
  }
  if (blocks.length === 0) return "(empty)";
  const joined = blocks.join("\n\n");
  // Keep the newest turns when trimming: the tail is what the agent is answering.
  return joined.length > MAX_ACP_PROMPT_CHARS ? `[truncated]\n${joined.slice(joined.length - MAX_ACP_PROMPT_CHARS)}` : joined;
}

function chunkText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/**
 * Translate one session/update (other than config_option_update, which the driver owns) into
 * adapter events. The CLI's own tool calls are not client tools: the agent runs them inside its
 * session under its own permission engine, so they become heartbeats (proof of life) and never
 * tool_call_start, which would ask Codex to run something the agent already decided.
 */
export function acpUpdateToEvents(update: Record<string, unknown>): AdapterEvent[] {
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const text = chunkText(update.content);
    return text ? [{ type: "text_delta", text }] : [];
  }
  if (kind === "agent_thought_chunk") {
    const text = chunkText(update.content);
    return text ? [{ type: "thinking_delta", thinking: text }] : [];
  }
  if (typeof kind === "string") return [{ type: "heartbeat" }];
  return [];
}

export function mapAcpUsage(raw: unknown): OcxUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const input = typeof u.inputTokens === "number" && u.inputTokens >= 0 ? u.inputTokens : 0;
  const output = typeof u.outputTokens === "number" && u.outputTokens >= 0 ? u.outputTokens : 0;
  if (input === 0 && output === 0) return undefined;
  return { inputTokens: input, outputTokens: output };
}

export type AcpFailureCode =
  | "agy_acp_turn_limit" | "agy_acp_cancelled" | "agy_acp_protocol" | "agy_login_required"
  | "agy_acp_model_unproven" | "agy_acp_model_switched" | "agy_acp_unsupported_selection" | "agy_acp_unavailable";

export type AcpTerminal =
  | { kind: "done"; stopReason?: "max_tokens" | "content_filter" }
  | { kind: "aborted" }
  | { kind: "error"; code: AcpFailureCode };

/**
 * The complete terminal table (plan 080, B6). Only end_turn, max_tokens and refusal are a finished
 * answer; a turn limit, an unrequested cancellation and anything unrecognised are errors, because the
 * Responses bridge would otherwise read an unknown done reason as a completed turn.
 */
export function acpTerminal(stopReason: unknown, callerAborted: boolean): AcpTerminal {
  switch (stopReason) {
    case "end_turn": return { kind: "done" };
    case "max_tokens": return { kind: "done", stopReason: "max_tokens" };
    case "refusal": return { kind: "done", stopReason: "content_filter" };
    case "max_turn_requests": return { kind: "error", code: "agy_acp_turn_limit" };
    case "cancelled": return callerAborted ? { kind: "aborted" } : { kind: "error", code: "agy_acp_cancelled" };
    default: return { kind: "error", code: "agy_acp_protocol" };
  }
}
