/**
 * Agent Client Protocol framing for the Devin CLI.
 *
 * `devin acp` speaks newline-delimited JSON-RPC on stdin/stdout. One ACP session
 * answers one prompt, so a turn is: initialize -> session/new -> session/prompt,
 * with session/update notifications streaming in between and a unary reply to
 * the prompt carrying the stop reason and usage.
 *
 * This module is pure. It never spawns a process and never touches the network,
 * so the framing and the event mapping are testable against captured lines, the
 * same discipline src/adapters/coding-agent/protocol.ts follows for the
 * stream-json CLIs.
 */
import type { AdapterEvent, OcxParsedRequest, OcxToolCall, OcxUsage } from "../../types";

/** Hard ceiling on a single buffered stdout line. */
export const MAX_ACP_LINE_BYTES = 8 * 1024 * 1024;
/** Hard ceiling on total stdout bytes consumed for one turn. */
export const MAX_ACP_TOTAL_BYTES = 64 * 1024 * 1024;

export class AcpProtocolError extends Error {
  readonly code = "protocol_error";
  readonly status = 502;
  constructor(message: string) {
    super(message);
    this.name = "AcpProtocolError";
  }
}

export const ACP_INITIALIZE_ID = 1;
export const ACP_SESSION_NEW_ID = 2;
export const ACP_SESSION_PROMPT_ID = 3;

export function initializeFrame(clientVersion: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: ACP_INITIALIZE_ID,
    method: "initialize",
    params: { protocolVersion: 1, clientInfo: { name: "opencodex", version: clientVersion }, capabilities: {} },
  };
}

export function sessionNewFrame(cwd: string, modelId?: string): Record<string, unknown> {
  const params: Record<string, unknown> = { cwd, mcpServers: [] };
  // The CLI picks its own default when no model is named, which is what an
  // unset or vendor-default selection should do.
  if (modelId) params.model = modelId;
  return { jsonrpc: "2.0", id: ACP_SESSION_NEW_ID, method: "session/new", params };
}

export function sessionPromptFrame(sessionId: string, prompt: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: ACP_SESSION_PROMPT_ID,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: prompt }] },
  };
}

/**
 * Answer a permission request without a human.
 *
 * A headless turn has nobody to approve a tool call, and an unanswered
 * `session/request_permission` stalls the agent until the turn times out. The
 * answer is a refusal by default: this provider runs an agent in the operator's
 * own tree, and auto-approving whatever it asks for would let any prompt that
 * reaches the proxy read, write and execute there. Approval is an explicit
 * operator decision, and only then is an allow-shaped option preferred over
 * positional guessing — the first option in a real prompt is sometimes the
 * rejection.
 */
export function permissionResponseFrame(
  id: number | string,
  options: Array<{ optionId?: string; name?: string; kind?: string }> | undefined,
  allowed = false,
): Record<string, unknown> {
  if (!allowed) {
    return { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } };
  }
  const list = options ?? [];
  const allow =
    list.find((o) => typeof o.kind === "string" && /^allow/i.test(o.kind)) ??
    list.find((o) => /allow|accept|yes/i.test(`${o.optionId ?? ""} ${o.name ?? ""}`));
  if (!allow?.optionId) {
    // Nothing offered says "allow". Guessing at `list[0]` here is how an
    // auto-answer selects a rejection and calls it approval.
    return { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } };
  }
  return { jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } };
}

/**
 * Flatten an OcxContext into the single prompt string one ACP session takes.
 *
 * ACP has no multi-message history on session/prompt, so the conversation is
 * projected into labelled blocks. Tool calls and results are rendered rather
 * than dropped, because a turn that omits them loses the thread of a tool loop.
 */
export function buildAcpPrompt(parsed: OcxParsedRequest): string {
  const blocks: string[] = [];
  const system = parsed.context.systemPrompt?.filter((line) => line.trim().length > 0).join("\n");
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
      : parts.map((p) => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n");
    if (message.role === "assistant" && Array.isArray(parts)) {
      const calls = parts
        .filter((p): p is OcxToolCall => p.type === "toolCall")
        .map((c) => `[call ${c.name} id=${c.id}]\n${JSON.stringify(c.arguments ?? {})}`)
        .join("\n\n");
      if (calls) text = text ? `${text}\n\n${calls}` : calls;
    }
    if (!text.trim()) continue;
    const label = message.role === "assistant" ? "Assistant" : message.role === "developer" ? "System" : "User";
    blocks.push(fence(label, text));
  }
  if (blocks.length === 0) return "(empty)";
  const joined = blocks.join("\n\n");
  // Keep the oldest turns rather than the newest when trimming: the tail is
  // what the agent is answering.
  return joined.length > MAX_ACP_PROMPT_CHARS
    ? `[truncated]\n${joined.slice(joined.length - MAX_ACP_PROMPT_CHARS)}`
    : joined;
}

export type AcpTurnOutcome = { stopReason?: string; usage?: OcxUsage };

/** ACP stop reasons that mean the turn ended normally. */
const NATURAL_STOP = new Set(["end_turn", "stop", "completed"]);

export function mapAcpStopReason(reason: unknown): string | undefined {
  if (typeof reason !== "string" || NATURAL_STOP.has(reason)) return undefined;
  if (reason === "max_tokens") return "max_tokens";
  return reason;
}

export function mapAcpUsage(raw: unknown): OcxUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const input = typeof u.inputTokens === "number" ? u.inputTokens : 0;
  const output = typeof u.outputTokens === "number" ? u.outputTokens : 0;
  if (input === 0 && output === 0) return undefined;
  const total = typeof u.totalTokens === "number" ? u.totalTokens : input + output;
  return { inputTokens: input, outputTokens: output, ...(total > 0 ? { totalTokens: total } : {}) };
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
 * Translate one session/update notification into adapter events.
 *
 * Tool lifecycle is explicit in ACP: `tool_call` opens one and
 * `tool_call_update` with a terminal status closes it, so the caller does not
 * have to infer boundaries from interleaving the way a delta-only wire forces.
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
  // The CLI's own tool calls are NOT client tools. Devin executes them itself
  // inside its session, so emitting tool_call_start here would either fail the
  // turn — the Responses bridge rejects a tool Codex never declared — or ask
  // Codex to run something the agent has already run. Vendor tools stay
  // internal and Codex keeps ownership of mutation, which is the same rule the
  // CodeBuddy and Qoder adapters follow.
  //
  // They are not dropped silently, though. A Devin tool operation that runs
  // longer than the bridge's stall timeout would otherwise look like upstream
  // silence and get the still-working turn aborted, so an internal update
  // becomes a heartbeat: proof of life without a client-visible tool.
  if (kind === "tool_call" || kind === "tool_call_update" || kind === "plan" || kind === "current_mode_update") {
    return [{ type: "heartbeat" }];
  }
  return [];
}
/** Ceiling on the flattened conversation handed to one ACP prompt. */
export const MAX_ACP_PROMPT_CHARS = 200_000;

/** Fence a block label so a message body cannot forge one. */
function fence(label: string, body: string): string {
  // A user or tool result that contains a line reading `[System]` would
  // otherwise appear to open a system block in the flattened prompt.
  return `[${label}]\n${body.replace(/^\[(System|User|Assistant|Tool)\]/gm, " $&")}`;
}
