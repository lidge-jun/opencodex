import {
  TRANSLATOR_MAX_TURN_BYTES,
  TranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../lib/translator-budget";
import { repairFunctionCalls, type FunctionCallRepairSchemas } from "../responses/function-call-compat";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";

type Identity = {
  itemId?: string;
  outputIndex?: number;
  item: Record<string, unknown>;
  bytes: number;
};
type PendingCompletion = {
  block: string;
  itemId?: string;
  outputIndex?: number;
  bytes: number;
};
const ENTRY_OVERHEAD_BYTES = 64;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function outputIndexOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Ordinary deltas remain upstream previews; only authoritative completions are repaired. */
export function createResponsesFunctionToolRepairBlockRewrite(
  schemas: FunctionCallRepairSchemas,
  budget?: TranslatorBudget,
): SseBlockRewrite {
  if (schemas.size === 0) return block => [block];
  const byId = new Map<string, Identity>();
  const byIndex = new Map<number, Identity>();
  let pending: PendingCompletion[] = [];
  let retainedBytes = 0;
  let disposed = false;

  const retain = (bytes: number): void => {
    if (retainedBytes + bytes > TRANSLATOR_MAX_TURN_BYTES) {
      throw new TranslatorBudgetExceededError("retained_collectors", TRANSLATOR_MAX_TURN_BYTES);
    }
    budget?.chargeRetained(bytes, { kind: "retained_collectors" });
    retainedBytes += bytes;
  };
  const release = (bytes: number): void => {
    budget?.releaseRetained(bytes, { kind: "retained_collectors" });
    retainedBytes -= bytes;
  };
  const releaseIdentity = (identity: Identity): void => {
    if (identity.itemId !== undefined) byId.delete(identity.itemId);
    if (identity.outputIndex !== undefined) byIndex.delete(identity.outputIndex);
    release(identity.bytes);
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    release(retainedBytes);
    byId.clear();
    byIndex.clear();
    pending = [];
  };
  const lookup = (itemId: string | undefined, index: number | undefined): Identity | undefined => {
    const identity = itemId === undefined ? undefined : byId.get(itemId);
    if (identity) return index === undefined || identity.outputIndex === undefined || identity.outputIndex === index ? identity : undefined;
    const indexed = index === undefined ? undefined : byIndex.get(index);
    return indexed && (itemId === undefined || indexed.itemId === undefined || indexed.itemId === itemId) ? indexed : undefined;
  };
  const register = (item: Record<string, unknown>, index: number | undefined): Identity | undefined => {
    const itemId = typeof item.id === "string" && item.id ? item.id : undefined;
    if (itemId === undefined && index === undefined) return undefined;
    // Repeated snapshots replace metadata; never retain provider argument bodies here.
    const previous = new Set<Identity>();
    if (itemId !== undefined && byId.has(itemId)) previous.add(byId.get(itemId)!);
    if (index !== undefined && byIndex.has(index)) previous.add(byIndex.get(index)!);
    for (const identity of previous) releaseIdentity(identity);
    const metadata = {
      type: item.type,
      name: item.name,
      ...("namespace" in item ? { namespace: item.namespace } : {}),
      ...(item.status !== undefined && item.status !== "in_progress" && item.status !== "completed" ? { status: item.status } : {}),
    };
    const bytes = ENTRY_OVERHEAD_BYTES + Buffer.byteLength(JSON.stringify([itemId, index, metadata]), "utf8");
    retain(bytes);
    const identity = { itemId, outputIndex: index, item: metadata, bytes };
    if (itemId !== undefined) byId.set(itemId, identity);
    if (index !== undefined) byIndex.set(index, identity);
    return identity;
  };
  const repairCompletion = (block: string, event: Record<string, unknown>, identity: Identity): string => {
    if (typeof event.arguments !== "string") return block;
    const resolved = (typeof event.item_id !== "string" || event.item_id === "") && identity.itemId !== undefined
      ? { ...event, item_id: identity.itemId }
      : event;
    const repaired = repairFunctionCalls({ ...identity.item, status: identity.item.status ?? "completed", arguments: event.arguments }, schemas);
    if (repaired.changed && isObject(repaired.value)) {
      return replaceSseDataPayload(block, JSON.stringify({ ...resolved, arguments: repaired.value.arguments }));
    }
    return resolved === event ? block : replaceSseDataPayload(block, JSON.stringify(resolved));
  };
  const flushPending = (identity: Identity): string[] => {
    const output: string[] = [];
    const remaining: PendingCompletion[] = [];
    for (const completion of pending) {
      const matches = completion.itemId !== undefined
        ? completion.itemId === identity.itemId
          && (completion.outputIndex === undefined || identity.outputIndex === undefined || completion.outputIndex === identity.outputIndex)
        : completion.outputIndex !== undefined && completion.outputIndex === identity.outputIndex;
      if (!matches) { remaining.push(completion); continue; }
      release(completion.bytes);
      const payload = sseDataPayload(completion.block);
      const event: unknown = payload === null ? undefined : JSON.parse(payload);
      output.push(isObject(event) ? repairCompletion(completion.block, event, identity) : completion.block);
    }
    pending = remaining;
    return output;
  };

  const rewrite: SseBlockRewrite = block => {
    if (disposed) return [block];
    const payload = sseDataPayload(block);
    if (payload === null) return [block];
    if (payload === "[DONE]") {
      const unfinished = pending.map(entry => entry.block);
      dispose();
      return [...unfinished, block];
    }
    let event: unknown;
    try { event = JSON.parse(payload); } catch { return [block]; }
    if (!isObject(event)) return [block];
    const index = outputIndexOf(event.output_index);
    const itemId = typeof event.item_id === "string" && event.item_id ? event.item_id : undefined;
    try {
      if ((event.type === "response.output_item.added" || event.type === "response.output_item.done") && isObject(event.item)) {
        const identity = register(event.item, index);
        const replayed = identity ? flushPending(identity) : [];
        const repaired = repairFunctionCalls(event, schemas);
        const output = repaired.changed ? replaceSseDataPayload(block, JSON.stringify(repaired.value)) : block;
        if (identity && (event.type === "response.output_item.done" || replayed.length > 0)) releaseIdentity(identity);
        return event.type === "response.output_item.added" ? [output, ...replayed] : [...replayed, output];
      }
      if (event.type === "response.function_call_arguments.done" && typeof event.arguments === "string") {
        const identity = lookup(itemId, index);
        if (identity) {
          const output = repairCompletion(block, event, identity);
          releaseIdentity(identity);
          return [output];
        }
        if (itemId !== undefined || index !== undefined) {
          const bytes = ENTRY_OVERHEAD_BYTES + Buffer.byteLength(block, "utf8");
          retain(bytes);
          pending.push({ block, itemId, outputIndex: index, bytes });
          return [];
        }
      }
      if (typeof event.type === "string" && ["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(event.type)) {
        const replayed: string[] = [];
        if (event.type === "response.completed" && isObject(event.response) && Array.isArray(event.response.output)
          && (event.response.status === undefined || event.response.status === "completed")) {
          for (const [slot, item] of event.response.output.entries()) {
            if (!isObject(item)) continue;
            const identity = register(item, slot);
            if (identity) replayed.push(...flushPending(identity));
          }
        }
        replayed.push(...pending.map(entry => entry.block));
        const repaired = repairFunctionCalls(event, schemas);
        dispose();
        return [...replayed, repaired.changed ? replaceSseDataPayload(block, JSON.stringify(repaired.value)) : block];
      }
      return [block];
    } catch (error) {
      dispose();
      throw error;
    }
  };
  rewrite.dispose = dispose;
  return rewrite;
}
