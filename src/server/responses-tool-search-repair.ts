import {
  isTranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../lib/translator-budget";
import {
  restoreRoutedToolSearchCalls,
} from "../responses/tool-search-compat";
import {
  replaceSseDataPayload,
  sseDataPayload,
  type SseBlockRewrite,
} from "./sse-payload-rewrite";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type PendingArgumentBlock = {
  block: string;
  itemId?: string;
  outputIndex?: number;
  retainedBytes: number;
};

const MAX_PENDING_ARGUMENT_FRAMES = 256;
const MAX_PENDING_ARGUMENT_BYTES = 1024 * 1024;

/**
 * Public Responses gateways stream a lowered search as a normal function lifecycle. Codex expects
 * only `tool_search_call` items, so classify each item before dropping its function-argument
 * frames. Unknown early argument frames stay bounded until their item arrives.
 */
export function createRoutedToolSearchRestoreBlockRewrite(
  names: ReadonlySet<string>,
  budget?: TranslatorBudget,
): SseBlockRewrite {
  const routedItemIds = new Set<string>();
  const ordinaryItemIds = new Set<string>();
  let pendingArguments: PendingArgumentBlock[] = [];
  let pendingArgumentBytes = 0;
  let passthrough = false;
  let disposed = false;

  const releaseAll = (): void => {
    if (disposed) return;
    disposed = true;
    if (pendingArgumentBytes > 0) {
      budget?.releaseRetained(pendingArgumentBytes, { kind: "retained_collectors" });
    }
    pendingArguments = [];
    pendingArgumentBytes = 0;
    routedItemIds.clear();
    ordinaryItemIds.clear();
  };

  const retainPending = (
    block: string,
    itemId: string | undefined,
    outputIndex: number | undefined,
  ): readonly string[] | null => {
    const retainedBytes = Buffer.byteLength(block, "utf8");
    const overflow = pendingArguments.length >= MAX_PENDING_ARGUMENT_FRAMES
      || pendingArgumentBytes + retainedBytes > MAX_PENDING_ARGUMENT_BYTES;
    if (overflow) {
      const flushed = [...pendingArguments.map(pending => pending.block), block];
      if (pendingArgumentBytes > 0) {
        budget?.releaseRetained(pendingArgumentBytes, { kind: "retained_collectors" });
      }
      pendingArguments = [];
      pendingArgumentBytes = 0;
      passthrough = true;
      routedItemIds.clear();
      ordinaryItemIds.clear();
      return flushed;
    }
    if (retainedBytes > 0) {
      try {
        budget?.chargeRetained(retainedBytes, { kind: "retained_collectors" });
      } catch (error) {
        if (!isTranslatorBudgetExceededError(error)) throw error;
        const flushed = [...pendingArguments.map(pending => pending.block), block];
        if (pendingArgumentBytes > 0) {
          budget?.releaseRetained(pendingArgumentBytes, { kind: "retained_collectors" });
        }
        pendingArguments = [];
        pendingArgumentBytes = 0;
        passthrough = true;
        routedItemIds.clear();
        ordinaryItemIds.clear();
        return flushed;
      }
    }
    pendingArguments.push({ block, itemId, outputIndex, retainedBytes });
    pendingArgumentBytes += retainedBytes;
    return null;
  };

  const takePending = (
    itemId: string | undefined,
    outputIndex: number | undefined,
  ): string[] => {
    const matched: PendingArgumentBlock[] = [];
    const remaining: PendingArgumentBlock[] = [];
    for (const pending of pendingArguments) {
      const matches = pending.itemId !== undefined
        ? itemId !== undefined && pending.itemId === itemId
        : outputIndex !== undefined && pending.outputIndex === outputIndex;
      (matches ? matched : remaining).push(pending);
    }
    pendingArguments = remaining;
    const retainedBytes = matched.reduce((total, pending) => total + pending.retainedBytes, 0);
    if (retainedBytes > 0) {
      budget?.releaseRetained(retainedBytes, { kind: "retained_collectors" });
      pendingArgumentBytes = Math.max(0, pendingArgumentBytes - retainedBytes);
    }
    return matched.map(pending => {
      if (pending.itemId !== undefined || itemId === undefined) return pending.block;
      const payload = sseDataPayload(pending.block);
      if (payload === null) return pending.block;
      try {
        const parsed: unknown = JSON.parse(payload);
        return isPlainObject(parsed)
          ? replaceSseDataPayload(pending.block, JSON.stringify({ ...parsed, item_id: itemId }))
          : pending.block;
      } catch {
        return pending.block;
      }
    });
  };

  const rewrite: SseBlockRewrite = (block: string): readonly string[] => {
    if (disposed) return [block];
    if (passthrough) return [block];
    const payload = sseDataPayload(block);
    if (payload === null || payload === "[DONE]") return [block];
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [block];
    }
    if (!isPlainObject(parsed)) return [block];

    const type = typeof parsed.type === "string" ? parsed.type : "";
    const outputIndex = typeof parsed.output_index === "number"
      && Number.isInteger(parsed.output_index)
      && parsed.output_index >= 0
      ? parsed.output_index
      : undefined;
    if (
      (type === "response.output_item.added" || type === "response.output_item.done")
      && isPlainObject(parsed.item)
      && parsed.item.type === "function_call"
      && typeof parsed.item.name === "string"
    ) {
      const itemId = typeof parsed.item.id === "string" ? parsed.item.id : undefined;
      const routed = names.has(parsed.item.name);
      if (itemId) {
        if (routed) {
          routedItemIds.add(itemId);
          ordinaryItemIds.delete(itemId);
        } else {
          ordinaryItemIds.add(itemId);
          routedItemIds.delete(itemId);
        }
      }
      const pending = takePending(itemId, outputIndex);
      const restored = routed ? restoreRoutedToolSearchCalls(parsed, names) : { value: parsed, changed: false };
      const restoredBlock = restored.changed
        ? replaceSseDataPayload(block, JSON.stringify(restored.value))
        : block;
      if (type === "response.output_item.done" && itemId) {
        routedItemIds.delete(itemId);
        ordinaryItemIds.delete(itemId);
      }
      return routed ? [restoredBlock] : [...pending, restoredBlock];
    }

    const itemId = typeof parsed.item_id === "string" ? parsed.item_id : undefined;
    const argumentEvent = type === "response.function_call_arguments.delta"
      || type === "response.function_call_arguments.done";
    if (argumentEvent && (!itemId || (!routedItemIds.has(itemId) && !ordinaryItemIds.has(itemId)))) {
      return retainPending(block, itemId, outputIndex) ?? [];
    }
    if (argumentEvent && itemId && routedItemIds.has(itemId)) return [];

    const terminal = type === "response.completed" || type === "response.failed" || type === "response.incomplete";
    if (!terminal) return [block];
    const restored = restoreRoutedToolSearchCalls(parsed, names);
    releaseAll();
    return restored.changed
      ? [replaceSseDataPayload(block, JSON.stringify(restored.value))]
      : [block];
  };
  rewrite.dispose = releaseAll;
  return rewrite;
}
