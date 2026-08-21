import {
  isTranslatorBudgetExceededError,
  TranslatorBudgetExceededError,
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
const MAX_CLASSIFIED_ITEM_IDS = 256;
const MAX_CLASSIFIED_ITEM_ID_BYTES = 256 * 1024;

class ClassifiedItemIdCountExceededError extends Error {
  readonly code = "translation_buffer_limit";
  readonly kind = "item_ids";
  readonly limitItems = MAX_CLASSIFIED_ITEM_IDS;

  constructor() {
    super(`translator item_ids count exceeded ${MAX_CLASSIFIED_ITEM_IDS} items`);
    this.name = "ClassifiedItemIdCountExceededError";
  }
}

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
  let classifiedItemIdBytes = 0;
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
    if (classifiedItemIdBytes > 0) {
      budget?.releaseRetained(classifiedItemIdBytes, { kind: "item_ids" });
    }
    classifiedItemIdBytes = 0;
    routedItemIds.clear();
    ordinaryItemIds.clear();
  };

  const clearOrdinaryItemIds = (): void => {
    let releasedBytes = 0;
    for (const itemId of ordinaryItemIds) {
      releasedBytes += Buffer.byteLength(JSON.stringify(itemId), "utf8");
    }
    ordinaryItemIds.clear();
    classifiedItemIdBytes = Math.max(0, classifiedItemIdBytes - releasedBytes);
    if (releasedBytes > 0) budget?.releaseRetained(releasedBytes, { kind: "item_ids" });
  };

  const classifyItemId = (itemId: string, routed: boolean): void => {
    const target = routed ? routedItemIds : ordinaryItemIds;
    const previous = routed ? ordinaryItemIds : routedItemIds;
    if (target.has(itemId)) return;
    if (previous.delete(itemId)) {
      target.add(itemId);
      return;
    }

    if (routedItemIds.size + ordinaryItemIds.size >= MAX_CLASSIFIED_ITEM_IDS) {
      throw new ClassifiedItemIdCountExceededError();
    }
    const retainedBytes = Buffer.byteLength(JSON.stringify(itemId), "utf8");
    if (classifiedItemIdBytes + retainedBytes > MAX_CLASSIFIED_ITEM_ID_BYTES) {
      throw new TranslatorBudgetExceededError("item_ids", MAX_CLASSIFIED_ITEM_ID_BYTES);
    }
    budget?.chargeRetained(retainedBytes, { kind: "item_ids" });
    target.add(itemId);
    classifiedItemIdBytes += retainedBytes;
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
      // Deliberately KEEP routedItemIds. Overflow means we stop buffering UNKNOWN frames, not
      // that we forget what we already classified: an item restored to `tool_search_call`
      // upstream of here would otherwise start emitting `function_call_arguments.*` again and
      // the client would see a mixed private/public lifecycle for one call.
      clearOrdinaryItemIds();
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
        // Same reasoning as the frame/byte overflow above: an already-restored routed item
        // must keep its frames suppressed even once buffering stops.
        clearOrdinaryItemIds();
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
    const payload = sseDataPayload(block);
    if (payload === null) return [block];
    if (payload === "[DONE]") {
      releaseAll();
      return [block];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [block];
    }
    if (!isPlainObject(parsed)) return [block];

    const type = typeof parsed.type === "string" ? parsed.type : "";
    const terminal = type === "response.completed" || type === "response.failed" || type === "response.incomplete";
    // After overflow we stop BUFFERING unknown frames, but an item already restored to
    // `tool_search_call` must keep its public argument frames suppressed — otherwise the client
    // receives a private item followed by `function_call_arguments.*` for the same id, which is
    // exactly the mixed lifecycle this rewrite exists to prevent. Everything else passes through.
    if (passthrough) {
      if (terminal) {
        releaseAll();
        return [block];
      }
      const passthroughItemId = typeof parsed.item_id === "string" ? parsed.item_id : undefined;
      const isArgumentEvent = type === "response.function_call_arguments.delta"
        || type === "response.function_call_arguments.done";
      if (isArgumentEvent && passthroughItemId && routedItemIds.has(passthroughItemId)) return [];
      return [block];
    }
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
      if (itemId) classifyItemId(itemId, routed);
      const pending = takePending(itemId, outputIndex);
      const restored = routed ? restoreRoutedToolSearchCalls(parsed, names) : { value: parsed, changed: false };
      const restoredBlock = restored.changed
        ? replaceSseDataPayload(block, JSON.stringify(restored.value))
        : block;
      // Classification is retained past `output_item.done` for BOTH kinds, until the terminal
      // event releases the bounded, budgeted state.
      //
      // `done` ends the item, not the id's relevance. Forgetting a ROUTED id let a trailing
      // `function_call_arguments.*` — which some upstreams emit after done — fall through to
      // the unknown-id branch and reach the client as a public frame for an item the client
      // was told is a private `tool_search_call`: the mixed lifecycle this rewrite exists to
      // prevent. Forgetting an ORDINARY id is not leak-shaped but is not free either, because
      // the same fall-through buffers its trailing frames as unknown and delays them until an
      // item that will never arrive. Neither id is dropped early.
      return routed ? [restoredBlock] : [...pending, restoredBlock];
    }

    const itemId = typeof parsed.item_id === "string" ? parsed.item_id : undefined;
    const argumentEvent = type === "response.function_call_arguments.delta"
      || type === "response.function_call_arguments.done";
    if (argumentEvent && (!itemId || (!routedItemIds.has(itemId) && !ordinaryItemIds.has(itemId)))) {
      return retainPending(block, itemId, outputIndex) ?? [];
    }
    if (argumentEvent && itemId && routedItemIds.has(itemId)) return [];

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
