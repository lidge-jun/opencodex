import type { AdapterRequest } from "../adapters/base";
import {
  replaceSseDataPayload,
  sseDataPayload,
  type SseBlockRewrite,
} from "./sse-payload-rewrite";

type Rec = Record<string, unknown>;
type CompatibilityFunctionCallRedirect = NonNullable<AdapterRequest["compatibilityFunctionCallRedirect"]>;

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function guidanceItem(id: string, text: string): Rec {
  return {
    type: "message",
    id,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

/** Canonical Responses lifecycle for one assistant guidance message. */
function guidanceBlocks(outputIndex: unknown, refId: string, text: string, newline: string): string[] {
  const id = `compat_${refId}`;
  const item = guidanceItem(id, text);
  const part = { type: "output_text", text: "", annotations: [] };
  const frames: Rec[] = [
    { type: "response.output_item.added", output_index: outputIndex, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: id, output_index: outputIndex, content_index: 0, part },
    { type: "response.output_text.delta", item_id: id, output_index: outputIndex, content_index: 0, delta: text },
    { type: "response.content_part.done", item_id: id, output_index: outputIndex, content_index: 0, part: { ...part, text } },
    { type: "response.output_item.done", output_index: outputIndex, item },
  ];
  return frames.map(frame => `event: ${frame.type}${newline}data: ${JSON.stringify(frame)}`);
}

interface CallIdentity {
  itemId?: string;
  callId?: string;
  outputIndex?: unknown;
}

interface RedirectedCall {
  ref: string;
  text: string;
  itemId?: string;
  callId?: string;
  outputIndex?: unknown;
}

function callIdentity(payload: Rec): CallIdentity | undefined {
  if (payload.type === "response.output_item.added" || payload.type === "response.output_item.done") {
    if (!isRecord(payload.item)) return undefined;
    return {
      ...(typeof payload.item.id === "string" ? { itemId: payload.item.id } : {}),
      ...(typeof payload.item.call_id === "string" ? { callId: payload.item.call_id } : {}),
      ...(Object.hasOwn(payload, "output_index") ? { outputIndex: payload.output_index } : {}),
    };
  }
  if (payload.type === "response.function_call_arguments.delta"
    || payload.type === "response.function_call_arguments.done"
    || payload.type === "response.custom_tool_call_input.delta"
    || payload.type === "response.custom_tool_call_input.done") {
    return {
      ...(typeof payload.item_id === "string" ? { itemId: payload.item_id } : {}),
      ...(Object.hasOwn(payload, "output_index") ? { outputIndex: payload.output_index } : {}),
    };
  }
  return undefined;
}

interface CompatibilityStreamRedirect {
  /** Replace the first call frame, drop its follow-ups, and repair terminal snapshots. */
  rewrite(payload: Rec, block: string): string[] | undefined;
}

/** Stateful redirect for streamed Responses calls injected only for provider admission. */
function createCompatibilityStreamRedirect(
  redirect: CompatibilityFunctionCallRedirect,
): CompatibilityStreamRedirect {
  const byItemId = new Map<string, RedirectedCall>();
  const byCallId = new Map<string, RedirectedCall>();
  const byOutputIndex = new Map<unknown, RedirectedCall>();
  // ID-less argument frames belong to the active call; the next named call clears it.
  let activeCall: RedirectedCall | undefined;
  const redirectedCall = (identity: CallIdentity | undefined): RedirectedCall | undefined => {
    if (!identity) return undefined;
    const itemCall = identity.itemId ? byItemId.get(identity.itemId) : undefined;
    const wireCall = identity.callId ? byCallId.get(identity.callId) : undefined;
    if (identity.itemId && identity.callId) {
      // Both IDs must identify the same call. A stale half cannot borrow the other half.
      return itemCall !== undefined && itemCall === wireCall ? itemCall : undefined;
    }
    if (identity.itemId || identity.callId) return itemCall ?? wireCall;
    if (Object.hasOwn(identity, "outputIndex")) return byOutputIndex.get(identity.outputIndex);
    return activeCall;
  };
  const forget = (identity: CallIdentity | undefined) => {
    // A current named call reclaims reused IDs and removes each old pair atomically.
    const calls = new Set<RedirectedCall>();
    if (identity?.itemId) {
      const call = byItemId.get(identity.itemId);
      if (call) calls.add(call);
    }
    if (identity?.callId) {
      const call = byCallId.get(identity.callId);
      if (call) calls.add(call);
    }
    if (identity && Object.hasOwn(identity, "outputIndex")) {
      const call = byOutputIndex.get(identity.outputIndex);
      if (call) calls.add(call);
    }
    for (const call of calls) {
      if (call.itemId && byItemId.get(call.itemId) === call) byItemId.delete(call.itemId);
      if (call.callId && byCallId.get(call.callId) === call) byCallId.delete(call.callId);
      if (Object.hasOwn(call, "outputIndex") && byOutputIndex.get(call.outputIndex) === call) {
        byOutputIndex.delete(call.outputIndex);
      }
    }
    activeCall = undefined;
  };
  const remember = (identity: CallIdentity | undefined, name: string): RedirectedCall => {
    forget(identity);
    const ref = identity?.callId ?? identity?.itemId ?? name;
    const call = {
      ref,
      text: redirect.message(name),
      ...(identity?.itemId ? { itemId: identity.itemId } : {}),
      ...(identity?.callId ? { callId: identity.callId } : {}),
      ...(identity && Object.hasOwn(identity, "outputIndex") ? { outputIndex: identity.outputIndex } : {}),
    };
    if (identity?.itemId !== undefined) byItemId.set(identity.itemId, call);
    if (identity?.callId !== undefined) byCallId.set(identity.callId, call);
    if (identity && Object.hasOwn(identity, "outputIndex")) byOutputIndex.set(identity.outputIndex, call);
    activeCall = call;
    return call;
  };

  return {
    rewrite(payload, block) {
      if (payload.type === "response.completed" || payload.type === "response.incomplete") {
        if (!isRecord(payload.response) || !Array.isArray(payload.response.output)) return undefined;
        let changed = false;
        const output = payload.response.output.map(item => {
          if (!isRecord(item) || (item.type !== "function_call" && item.type !== "custom_tool_call")) return item;
          const identity = {
            ...(typeof item.id === "string" ? { itemId: item.id } : {}),
            ...(typeof item.call_id === "string" ? { callId: item.call_id } : {}),
          };
          if (typeof item.name !== "string" || !redirect.names.has(item.name)) return item;
          changed = true;
          const known = redirectedCall(identity);
          if (known) return guidanceItem(`compat_${known.ref}`, known.text);
          const call = remember(identity, item.name);
          return guidanceItem(`compat_${call.ref}`, call.text);
        });
        if (!changed) return undefined;
        return [replaceSseDataPayload(block, JSON.stringify({
          ...payload,
          response: { ...payload.response, output },
        }))];
      }
      const identity = callIdentity(payload);
      const itemName = (payload.type === "response.output_item.added" || payload.type === "response.output_item.done")
        && isRecord(payload.item)
        && (payload.item.type === "function_call" || payload.item.type === "custom_tool_call")
        && typeof payload.item.name === "string"
        ? payload.item.name
        : undefined;
      const sparseName = payload.type === "response.function_call_arguments.done"
        && typeof payload.name === "string"
        ? payload.name
        : undefined;
      const name = itemName ?? sparseName;
      if (name !== undefined) {
        if (!redirect.names.has(name)) {
          // An explicit current name is authoritative if an upstream reuses an old ID.
          forget(identity);
          return undefined;
        }
        if (redirectedCall(identity)) return [];
        const call = remember(identity, name);
        const newline = block.includes("\r\n") ? "\r\n" : "\n";
        return guidanceBlocks(identity?.outputIndex, call.ref, call.text, newline);
      }
      if (redirectedCall(identity)) return [];
      return undefined;
    },
  };
}

/** Rewrite only calls to declarations injected by a provider compatibility profile. */
export function createCompatibilityCallRedirectBlockRewrite(
  redirect: CompatibilityFunctionCallRedirect,
): SseBlockRewrite {
  const stream = createCompatibilityStreamRedirect(redirect);
  return (block: string) => {
    const data = sseDataPayload(block);
    if (data === null || data === "[DONE]") return [block];
    try {
      const payload = JSON.parse(data);
      if (!isRecord(payload)) return [block];
      return stream.rewrite(payload, block) ?? [block];
    } catch {
      return [block];
    }
  };
}

/** Replace injected compatibility calls in one completed Responses JSON body. */
export function redirectCompatibilityCallsInJson(
  jsonText: string,
  redirect: CompatibilityFunctionCallRedirect | undefined,
): string {
  if (!redirect) return jsonText;
  try {
    const parsed = JSON.parse(jsonText);
    if (!isRecord(parsed) || !Array.isArray(parsed.output)) return jsonText;
    let changed = false;
    const output = parsed.output.map(item => {
      if (!isRecord(item) || (item.type !== "function_call" && item.type !== "custom_tool_call")) return item;
      if (typeof item.name !== "string" || !redirect.names.has(item.name)) return item;
      changed = true;
      const ref = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : "snapshot";
      return guidanceItem(`compat_${ref}`, redirect.message(item.name));
    });
    return changed ? JSON.stringify({ ...parsed, output }) : jsonText;
  } catch {
    return jsonText;
  }
}
