import type { AdapterEvent, OcxUsage } from "../../types";
import { isValidModelDiscoveryModelId } from "../../providers/model-discovery-limits";

export class TraeAcpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraeAcpProtocolError";
  }
}

export type TraeAcpMessage = Record<string, unknown>;
export type TraeAcpFrame =
  | { kind: "response"; id: number; result?: unknown; error?: { code?: number; message: string } }
  | { kind: "update"; sessionId: string; update: Record<string, unknown> }
  | { kind: "request"; id: number; method: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseTraeAcpMessage(value: unknown): TraeAcpFrame {
  const message = record(value);
  if (!message || message.jsonrpc !== "2.0") throw new TraeAcpProtocolError("Invalid ACP JSON-RPC envelope");
  if (message.method === "session/update") {
    const params = record(message.params);
    const update = record(params?.update);
    if (typeof params?.sessionId !== "string" || !update) throw new TraeAcpProtocolError("Invalid ACP session update");
    return { kind: "update", sessionId: params.sessionId, update };
  }
  if (typeof message.method === "string") {
    if (!Number.isSafeInteger(message.id)) throw new TraeAcpProtocolError("Invalid ACP request id");
    return { kind: "request", id: message.id as number, method: message.method };
  }
  if (!Number.isSafeInteger(message.id)) throw new TraeAcpProtocolError("Invalid ACP response id");
  if (message.error !== undefined) {
    const error = record(message.error);
    if (!error || typeof error.message !== "string" || error.message.length > 4096) {
      throw new TraeAcpProtocolError("Invalid ACP error response");
    }
    return { kind: "response", id: message.id as number, error: {
      ...(typeof error.code === "number" ? { code: error.code } : {}), message: error.message,
    } };
  }
  return { kind: "response", id: message.id as number, result: message.result };
}

export function parseTraeModels(result: unknown): string[] {
  const models = record(record(result)?.models)?.availableModels;
  if (!Array.isArray(models)) throw new TraeAcpProtocolError("ACP session did not provide a model catalog");
  const ids = new Set<string>();
  for (const row of models) {
    const id = record(row)?.modelId;
    if (isValidModelDiscoveryModelId(id)) ids.add(id);
    if (ids.size >= 256) break;
  }
  if (ids.size === 0) throw new TraeAcpProtocolError("ACP session returned no usable models");
  return [...ids];
}

export function traeSessionId(result: unknown): string {
  const id = record(result)?.sessionId;
  if (typeof id !== "string" || !id) throw new TraeAcpProtocolError("ACP session id is missing");
  return id;
}

export function traePromptEvents(sessionId: string, update: Record<string, unknown>): AdapterEvent[] {
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const content = record(update.content);
    if (content?.type !== "text" || typeof content.text !== "string") {
      throw new TraeAcpProtocolError("Invalid ACP text chunk");
    }
    if (!content.text) return [];
    return kind === "agent_message_chunk"
      ? [{ type: "text_delta", text: content.text }]
      : [{ type: "thinking_delta", thinking: content.text }];
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    return [{
      type: "error", status: 502, errorType: "upstream_error", code: "trae_tool_call_unsupported", retryable: false,
      message: "TRAE CN requested a tool through ACP, but this text-only provider does not expose client tools.",
    }];
  }
  if (kind !== "available_commands_update" && kind !== "current_mode_update" && kind !== "config_option_update"
    && kind !== "session_info_update" && kind !== "usage_update" && kind !== "plan"
    && kind !== "user_message_chunk") {
    throw new TraeAcpProtocolError(`Unsupported ACP session update for ${sessionId}: ${String(kind)}`);
  }
  return [];
}

export function traeStopReason(result: unknown): string {
  const stop = record(result)?.stopReason;
  if (stop === "end_turn") return "stop";
  if (stop === "max_tokens") return "max_tokens";
  if (stop === "refusal") return "refusal";
  if (stop === "cancelled") return "cancelled";
  throw new TraeAcpProtocolError(`Unsupported ACP stop reason: ${String(stop)}`);
}

export function traeUsage(result: unknown): OcxUsage | undefined {
  const usage = record(record(result)?.usage);
  if (!usage) return undefined;
  const number = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const inputTokens = number(usage.inputTokens);
  const outputTokens = number(usage.outputTokens);
  const totalTokens = number(usage.totalTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens, ...(totalTokens !== undefined ? { totalTokens } : {}), upstreamReported: true };
}
