/**
 * Agent Client Protocol framing for the official Antigravity CLI (`agy acp`).
 *
 * `agy acp` is Google's own ACP server. It speaks newline-delimited JSON-RPC on stdin/stdout and
 * signs in with the credential the operator cached through an interactive `agy` session
 * (`oauth-personal`). OpenCodex is only the ACP client here: it never reads, copies or forwards
 * that credential.
 *
 * One turn is initialize -> session/new -> optional config changes -> session/prompt, with
 * session/update notifications streaming in between and a unary reply to the prompt carrying the
 * stop reason and usage.
 *
 * This module is pure. It never spawns a process, so the framing and the event mapping are
 * testable against captured lines. The frame shapes below were captured from Antigravity CLI
 * 1.5.9 (ACP protocol version 1).
 */
import type { AdapterEvent, OcxUsage } from "../../types";

/** Hard ceiling on a single buffered stdout line. */
export const MAX_ACP_LINE_BYTES = 8 * 1024 * 1024;
/** Hard ceiling on total stdout bytes consumed for one turn. */
export const MAX_ACP_TOTAL_BYTES = 64 * 1024 * 1024;

export const ACP_INITIALIZE_ID = 1;
export const ACP_SESSION_NEW_ID = 2;
export const ACP_SESSION_PROMPT_ID = 3;
/** Session configuration requests count up from here, clear of the fixed ids above. */
export const ACP_SESSION_CONFIG_ID = 100;

export type AcpFrame = Record<string, unknown>;

export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
}

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function initializeFrame(clientVersion: string): AcpFrame {
  return {
    jsonrpc: "2.0",
    id: ACP_INITIALIZE_ID,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientInfo: { name: "opencodex", version: clientVersion },
      // The client offers no filesystem or terminal capability. Every action the agent can take
      // on the operator's machine goes through the client's own tools, which Codex executes.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    },
  };
}

/**
 * Open a session with the isolated tool catalog and the caller's instructions.
 *
 * The instructions travel through the server's own extension: `initialize` advertises
 * `_meta.antigravity.systemPrompt.append`, and a string under the same key on session/new is
 * appended to the agent's system prompt.
 */
export function sessionNewFrame(cwd: string, mcpServers: AcpMcpServer[], systemAppend: string | undefined): AcpFrame {
  const params: Record<string, unknown> = {
    cwd,
    mcpServers: mcpServers.map(server => ({ name: server.name, command: server.command, args: server.args, env: [] })),
  };
  if (systemAppend) {
    params._meta = { antigravity: { systemPrompt: { append: systemAppend } } };
  }
  return { jsonrpc: "2.0", id: ACP_SESSION_NEW_ID, method: "session/new", params };
}

export function setConfigOptionFrame(id: number, sessionId: string, configId: string, value: string): AcpFrame {
  return { jsonrpc: "2.0", id, method: "session/set_config_option", params: { sessionId, configId, value } };
}

export function setModelFrame(id: number, sessionId: string, modelId: string): AcpFrame {
  return { jsonrpc: "2.0", id, method: "session/set_model", params: { sessionId, modelId } };
}

export function sessionPromptFrame(sessionId: string, prompt: AcpContentBlock[]): AcpFrame {
  return { jsonrpc: "2.0", id: ACP_SESSION_PROMPT_ID, method: "session/prompt", params: { sessionId, prompt } };
}

/**
 * Refuse a permission request for one of the agent's own tools.
 *
 * Codex owns execution, so the agent's built-in tools never run on the operator's machine through
 * this provider. The server offers a `reject_once` option; when it does not, the request is
 * cancelled, which the server also treats as a refusal.
 */
export function permissionRefusalFrame(
  id: number | string,
  options: Array<{ optionId?: unknown; kind?: unknown }> | undefined,
): AcpFrame {
  const reject = (options ?? []).find(option => option.kind === "reject_once" && typeof option.optionId === "string");
  const outcome = reject
    ? { outcome: "selected", optionId: reject.optionId }
    : { outcome: "cancelled" };
  return { jsonrpc: "2.0", id, result: { outcome } };
}

/**
 * Convert the shared coding-agent replay (one Anthropic-shaped user frame) into ACP prompt blocks.
 *
 * Text stays text. Base64 images become ACP image blocks; the server advertises
 * `promptCapabilities.image`. A URL image has no ACP image form without its bytes, so it is named
 * in text rather than silently dropped.
 */
export function acpPromptFromReplayLine(line: string): AcpContentBlock[] {
  const frame = JSON.parse(line) as { message?: { content?: unknown } };
  const content = Array.isArray(frame.message?.content) ? frame.message.content as Array<Record<string, unknown>> : [];
  const blocks: AcpContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type !== "image") {
      continue;
    }
    const source = part.source as Record<string, unknown> | undefined;
    if (source?.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
      blocks.push({ type: "image", data: source.data, mimeType: source.media_type });
    } else if (source?.type === "url" && typeof source.url === "string") {
      blocks.push({ type: "text", text: `[image: ${source.url}]` });
    }
  }
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  return blocks;
}

/** ACP stop reasons that mean the turn ended normally. */
const NATURAL_STOP = new Set(["end_turn"]);

export function mapAcpStopReason(reason: unknown): string | undefined {
  if (typeof reason !== "string" || NATURAL_STOP.has(reason)) {
    return undefined;
  }
  return reason;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Map the prompt reply's usage. Antigravity reports `thoughtTokens` inside `outputTokens`
 * (captured: outputTokens 338 with thoughtTokens 307), so it is carried as the reasoning share of
 * output rather than added on top.
 */
export function mapAcpUsage(raw: unknown): OcxUsage | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const usage = raw as Record<string, unknown>;
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  if (input === 0 && output === 0) {
    return undefined;
  }
  const cachedRead = count(usage.cachedReadTokens);
  const cachedWrite = count(usage.cachedWriteTokens);
  const thought = count(usage.thoughtTokens);
  const total = count(usage.totalTokens) || input + output;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(cachedRead > 0 ? { cachedInputTokens: cachedRead, cacheReadInputTokens: cachedRead } : {}),
    ...(cachedWrite > 0 ? { cacheCreationInputTokens: cachedWrite } : {}),
    ...(thought > 0 ? { reasoningOutputTokens: thought } : {}),
    upstreamReported: true,
  };
}

function chunkText(content: unknown): string {
  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
}

/** Translate a text-bearing session/update into adapter events. Tool updates are handled by the caller. */
export function acpTextUpdateToEvents(update: Record<string, unknown>): AdapterEvent[] {
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const text = chunkText(update.content);
    return text ? [{ type: "text_delta", text }] : [];
  }
  if (kind === "agent_thought_chunk") {
    const text = chunkText(update.content);
    return text ? [{ type: "thinking_delta", thinking: text }] : [];
  }
  return [];
}

/** A tool call as the server reports it on `tool_call`, `tool_call_update` and permission requests. */
export interface AcpToolCall {
  toolCallId: string;
  name: string;
  rawInput: Record<string, unknown>;
}

export function readAcpToolCall(value: unknown): AcpToolCall | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const call = value as Record<string, unknown>;
  if (typeof call.toolCallId !== "string" || typeof call.name !== "string") {
    return undefined;
  }
  const input = call.rawInput ?? call.args;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return { toolCallId: call.toolCallId, name: call.name, rawInput: input as Record<string, unknown> };
}

/**
 * The server renders an MCP tool as `mcp_<server>_<tool>` (captured: `mcp_opencodex_exec_command`).
 */
export function antigravityMcpToolName(serverName: string, toolName: string): string {
  return `mcp_${serverName}_${toolName}`;
}

/**
 * Antigravity adds a `toolSummary` string to every tool call's arguments for its own UI. It is not
 * part of the client's schema, so it is removed unless the schema actually declares it.
 */
export function stripAntigravityToolSummary(
  input: Record<string, unknown>,
  inputSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const properties = inputSchema?.properties;
  if (properties && typeof properties === "object" && Object.hasOwn(properties, "toolSummary")) {
    return input;
  }
  if (!Object.hasOwn(input, "toolSummary")) {
    return input;
  }
  const { toolSummary: _summary, ...rest } = input;
  return rest;
}

interface AcpSelectOption {
  value: string;
}

interface AcpConfigOption {
  id: string;
  currentValue?: string;
  options: AcpSelectOption[];
}

function readConfigOptions(result: unknown): AcpConfigOption[] {
  const raw = (result as { configOptions?: unknown } | undefined)?.configOptions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const options: AcpConfigOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const option = entry as Record<string, unknown>;
    if (typeof option.id !== "string" || !Array.isArray(option.options)) {
      continue;
    }
    options.push({
      id: option.id,
      ...(typeof option.currentValue === "string" ? { currentValue: option.currentValue } : {}),
      options: option.options
        .filter((item): item is { value: string } => !!item && typeof (item as { value?: unknown }).value === "string")
        .map(item => ({ value: item.value })),
    });
  }
  return options;
}

function readAvailableModelIds(result: unknown): string[] {
  const models = (result as { models?: { availableModels?: unknown } } | undefined)?.models?.availableModels;
  if (!Array.isArray(models)) {
    return [];
  }
  return models
    .map(model => (model as { modelId?: unknown } | null)?.modelId)
    .filter((id): id is string => typeof id === "string");
}

/** One configuration change to send before the prompt. */
export type AcpSessionChange =
  | { kind: "config"; configId: string; value: string }
  | { kind: "model"; modelId: string };

export type AcpSessionPlan =
  | { ok: true; changes: AcpSessionChange[] }
  | { ok: false; offered: string[] };

/** Antigravity's thinking levels, lowest first. Codex's `xhigh` is Antigravity's `extra`. */
const THOUGHT_LADDER: ReadonlyArray<readonly string[]> = [
  ["low"],
  ["medium"],
  ["high"],
  ["extra", "xhigh"],
  ["max"],
];

function thoughtLevelFor(effort: string | undefined, option: AcpConfigOption | undefined): string | undefined {
  if (!effort || !option || option.options.length === 0) {
    return undefined;
  }
  const offered = new Set(option.options.map(item => item.value));
  let index = THOUGHT_LADDER.findIndex(names => names.includes(effort));
  if (index < 0) {
    return undefined;
  }
  // Clamp down to the highest level this account offers at or below the request.
  for (; index >= 0; index--) {
    const match = THOUGHT_LADDER[index]!.find(name => offered.has(name));
    if (match) {
      return match === option.currentValue ? undefined : match;
    }
  }
  return undefined;
}

/**
 * Decide which session changes select the requested model and thinking level.
 *
 * The server offers models two ways: `configOptions` (base ids such as `gemini-3.8-flash`, with a
 * separate `thought_level`) and `models.availableModels` (effort-suffixed ids such as
 * `gemini-3.8-flash-high`). A base id is selected through the config option; an id the server
 * lists only in `availableModels` is selected with session/set_model. An id offered neither way is
 * refused with the server's own list, because the server decides which models this client may use.
 */
export function planAcpSession(result: unknown, modelId: string, effort: string | undefined): AcpSessionPlan {
  const configOptions = readConfigOptions(result);
  const modelOption = configOptions.find(option => option.id === "model");
  const thoughtOption = configOptions.find(option => option.id === "thought_level");
  const availableModels = readAvailableModelIds(result);
  const changes: AcpSessionChange[] = [];

  if (modelOption?.options.some(option => option.value === modelId)) {
    if (modelOption.currentValue !== modelId) {
      changes.push({ kind: "config", configId: "model", value: modelId });
    }
    const level = thoughtLevelFor(effort, thoughtOption);
    if (level) {
      changes.push({ kind: "config", configId: "thought_level", value: level });
    }
    return { ok: true, changes };
  }
  if (availableModels.includes(modelId)) {
    changes.push({ kind: "model", modelId });
    return { ok: true, changes };
  }
  const offered = [...new Set([...(modelOption?.options.map(option => option.value) ?? []), ...availableModels])];
  return { ok: false, offered };
}

