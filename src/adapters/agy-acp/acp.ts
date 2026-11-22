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
import { parseDataUrl } from "../image";
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

export function sessionNewFrame(id: JsonRpcId, cwd: string, systemPrompt?: string, mcpServers: readonly object[] = []): Frame {
  const params: Frame = { cwd, mcpServers };
  if (systemPrompt) params.systemPrompt = { mode: "append", content: [{ type: "text", text: systemPrompt }] };
  return { jsonrpc: "2.0", id, method: "session/new", params };
}

export function setConfigOptionFrame(id: JsonRpcId, sessionId: string, configId: string, value: string): Frame {
  return { jsonrpc: "2.0", id, method: "session/set_config_option", params: { sessionId, configId, value } };
}

export function sessionPromptFrame(id: JsonRpcId, sessionId: string, prompt: string | AcpPromptBlock[]): Frame {
  return { jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt } };
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

/** Keep both ends of a priority block and preserve image placeholders as indivisible units. */
function clipPromptBlock(text: string, limit: number, imagePattern?: RegExp): string {
  if (text.length <= limit) return text;
  const cut = "\n[...truncated...]\n";
  const images = imagePattern ? Array.from(text.matchAll(imagePattern)) : [];
  const imageChars = images.reduce((sum, image) => sum + image[0].length, 0);
  const half = Math.floor((limit - cut.length - imageChars) / 2);
  if (half < 1) throw new UnsupportedAcpMedia("The inline images exceed the ACP replay budget.");
  let left = half;
  let right = text.length - half;
  const middle: string[] = [];
  for (const image of images) {
    const start = image.index;
    const end = start + image[0].length;
    if (end <= left || start >= right) continue;
    left = Math.min(left, start);
    right = Math.max(right, end);
    middle.push(image[0]);
  }
  return text.slice(0, left) + cut + middle.join("") + text.slice(right);
}

/**
 * Flatten the conversation into the single text block one ACP prompt carries. ACP has no
 * multi-message history on session/prompt. System text is included only when the CLI did not
 * advertise `sessionCapabilities.systemPrompt` (then it travels on session/new instead, never both).
 */
export function buildAcpPrompt(parsed: OcxParsedRequest, includeSystem: boolean, imagePattern?: RegExp): string {
  const messages = parsed.context.messages;
  const latestUser = messages.findLastIndex(message => message.role === "user");
  const blocks: { text: string; priority: boolean }[] = [];
  const add = (text: string, priority = false) => blocks.push({ text, priority });
  const system = includeSystem ? acpSystemText(parsed) : "";
  if (system) add(fence("System", system), true);

  // A short "go ahead" can refer to both an earlier request and the preceding proposal.
  const before = messages.slice(0, Math.max(latestUser, 0));
  const priorUser = before.findLastIndex(m => m.role === "user");
  const priorReply = before.findLastIndex(m => m.role === "assistant" && m.content.some(p => p.type === "text"));
  const final = messages.at(-1);
  const pairedCall = final?.role === "toolResult" ? messages.findLastIndex(m =>
    m.role === "assistant" && m.content.some(p => p.type === "toolCall" && p.id === final.toolCallId)) : -1;
  for (const [index, message] of messages.entries()) {
    const priority = index === latestUser || index === priorUser || index === priorReply
      || index === pairedCall || index === messages.length - 1;
    if (message.role === "toolResult") {
      const body = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      const status = message.isError ? " error" : "";
      add(fence("Tool", `[result${status} id=${message.toolCallId}]\n${body}`), priority);
      continue;
    }
    const parts = typeof message.content === "string" ? [] : message.content;
    let text = typeof message.content === "string" ? message.content
      : parts.map(p => p.type === "text" ? p.text : "").filter(Boolean).join("\n");
    if (message.role === "assistant") {
      const calls = message.content.filter((p): p is OcxToolCall => p.type === "toolCall")
        .map(c => `[call ${c.name} id=${c.id}]\n${JSON.stringify(c.arguments ?? {})}`);
      text = [text, ...calls].filter(Boolean).join("\n\n");
    }
    if (!text.trim()) continue;
    const label = message.role === "assistant" ? "Assistant" : message.role === "developer" ? "System" : "User";
    add(fence(label, text), priority);
  }
  if (!blocks.length) return "(empty)";
  const joined = blocks.map(block => block.text).join("\n\n");
  if (joined.length <= MAX_ACP_PROMPT_CHARS) return joined;

  // Keep the decision, approved scope, paired call and outcome in order under pressure.
  // Reserve space for both ends of each anchor (a command result often ends with its exit status).
  const header = "[truncated]\n";
  let remaining = MAX_ACP_PROMPT_CHARS - header.length;
  const count = Math.max(1, blocks.filter(b => b.priority).length);
  const allowance = Math.floor(remaining / count) - 2;
  const kept = new Map<number, string>();
  for (const [i, block] of blocks.entries()) {
    if (!block.priority) continue;
    const text = clipPromptBlock(block.text, allowance, imagePattern);
    kept.set(i, text);
    remaining -= text.length + 2;
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.priority || block.text.length + 2 > remaining) continue;
    kept.set(i, block.text);
    remaining -= block.text.length + 2;
  }
  return header + blocks.flatMap((_, i) => kept.has(i) ? [kept.get(i)!] : []).join("\n\n");
}

export type AcpPromptBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export class UnsupportedAcpMedia extends Error {}

/** Preserve the transcript positions of images, including MCP tool results.
 * Compact text with the existing history policy before substituting image bytes.
 */
export function acpPromptBlocks(parsed: OcxParsedRequest, includeSystem: boolean, prefix?: string): AcpPromptBlock[] {
  const images: AcpPromptBlock[] = [];
  const marker = crypto.randomUUID();
  const messages = parsed.context.messages.map(message => {
    if (message.role === "assistant" || typeof message.content === "string") return message;
    const content = message.content.map(part => {
      if (part.type === "document") return { type: "text" as const, text: part.text };
      if (part.type !== "image") return part;
      const image = parseDataUrl(part.imageUrl);
      if (message.role === "developer" || !image || !image.mediaType.startsWith("image/") || !image.base64) {
        throw new UnsupportedAcpMedia("Gemini ACP requires inline image attachments in user messages or tool results.");
      }
      const index = images.push({ type: "image", data: image.base64, mimeType: image.mediaType }) - 1;
      return { type: "text" as const, text: marker + index + marker };
    });
    return { ...message, content };
  });
  const pattern = new RegExp(marker + "(\\d+)" + marker, "g");
  const text = buildAcpPrompt({ ...parsed, context: { ...parsed.context, messages } }, includeSystem, images.length ? pattern : undefined);
  const blocks: AcpPromptBlock[] = [];
  if (prefix) blocks.push({ type: "text", text: prefix + "\n\n" });
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) blocks.push({ type: "text", text: text.slice(offset, match.index) });
    blocks.push(images[Number(match[1])]!);
    offset = match.index + match[0].length;
  }
  if (offset < text.length) blocks.push({ type: "text", text: text.slice(offset) });
  return blocks;
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
  | { kind: "done"; stopReason?: "max_tokens" }
  | { kind: "refusal" }
  | { kind: "aborted" }
  | { kind: "error"; code: AcpFailureCode };

/**
 * Only end_turn and max_tokens complete an answer. A refusal ends the turn without retry.
 * A turn limit, an unrequested cancellation and anything unrecognised are errors.
 */
export function acpTerminal(stopReason: unknown, callerAborted: boolean): AcpTerminal {
  switch (stopReason) {
    case "end_turn": return { kind: "done" };
    case "max_tokens": return { kind: "done", stopReason: "max_tokens" };
    case "refusal": return { kind: "refusal" };
    case "max_turn_requests": return { kind: "error", code: "agy_acp_turn_limit" };
    case "cancelled": return callerAborted ? { kind: "aborted" } : { kind: "error", code: "agy_acp_cancelled" };
    default: return { kind: "error", code: "agy_acp_protocol" };
  }
}
