import type { AdapterEvent, OcxProviderConfig } from "../../types";
import { modelInList } from "../../types";
import type { FreeformToolIdentity } from "./serialized-tool-call-content";

export const COMPLETED_TOOL_BLOCKS_PROTOCOL = "block-stop-v1";

export interface PendingChatToolCall {
  key: string;
  indexKey?: string;
  id: string;
  name: string;
  args: string;
  argsBytes: number;
  sawArgumentsString: boolean;
  blockCompleted?: boolean;
  emittedEarly?: boolean;
}

export function completedToolBlocksEnabled(
  requested: boolean,
  provider: OcxProviderConfig,
  responseHeaders: Headers,
  modelId: string,
): boolean {
  return requested
    && Object.entries(provider.headers ?? {}).some(([key, value]) =>
      key.toLowerCase() === "x-opencodex-tool-completion" && value === COMPLETED_TOOL_BLOCKS_PROTOCOL)
    && responseHeaders.get("x-opencodex-tool-completion") === COMPLETED_TOOL_BLOCKS_PROTOCOL
    && !modelInList(provider.inlineThinkTagModels, modelId);
}

export function observeCompletedToolBlock(
  call: PendingChatToolCall | undefined,
  marker: unknown,
  indexKey: string | undefined,
  id: string,
  hasFunctionDelta: boolean,
): "ordinary" | "completed" | "invalid" {
  if (!call?.blockCompleted && marker === undefined) return "ordinary";
  if (call?.blockCompleted || marker !== COMPLETED_TOOL_BLOCKS_PROTOCOL || !call
      || !indexKey || indexKey !== call.indexKey || !id || id !== call.id || hasFunctionDelta) return "invalid";
  call.blockCompleted = true;
  return "completed";
}

export function completedToolPrefix(
  calls: PendingChatToolCall[],
  blocked: boolean,
  freeformTools: Map<string, FreeformToolIdentity>,
  restoreName: (name: string) => string,
): AdapterEvent[] {
  if (blocked) return [];
  const events: AdapterEvent[] = [];
  for (const call of calls) {
    if (call.emittedEarly) continue;
    if (!call.blockCompleted || !call.id || !call.name.trim() || !call.sawArgumentsString || freeformTools.has(call.name)) break;
    let args: unknown;
    try { args = JSON.parse(call.args); } catch { break; }
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.hasOwn(args, "input")) break;
    call.emittedEarly = true;
    events.push({ type: "tool_call_start", id: call.id, name: restoreName(call.name) });
    events.push({ type: "tool_call_delta", arguments: call.args }, { type: "tool_call_end" });
  }
  return events;
}
