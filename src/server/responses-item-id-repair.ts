import { randomUUID } from "node:crypto";
import type { ResponsesItemIdRepairConfig } from "../types";
import { encodeReasoningEnvelope } from "../responses/reasoning-envelope";
import { relaySseWithPayloadRewrite, type SsePayloadRewrite } from "./sse-payload-rewrite";
import type { TranslatorBudget } from "../lib/translator-budget";

type RepairableItemType = "message" | "reasoning";

interface ResponsesItemIdRepairState {
  readonly repairMissingTerminalIds: boolean;
  readonly rewriteNonCanonicalIds: boolean;
  readonly placeholders: Record<RepairableItemType, ReadonlySet<string>>;
  readonly outputIds: Record<RepairableItemType, Map<number, string>>;
  readonly rawToCanonical: Record<RepairableItemType, Map<string, string>>;
  readonly reasoningTextByOutputIndex: Map<number, string>;
  readonly responseIdMap: Map<string, string>;
  readonly scope: string;
  readonly budget?: TranslatorBudget;
  /** True once a terminal response event is observed (completed/failed/incomplete). */
  sawTerminal: boolean;
  sawDoneTrailer: boolean;
}

const REPAIRABLE_PREFIXES: Record<RepairableItemType, string> = {
  message: "msg_",
  reasoning: "rs_",
};

const ITEM_ID_EVENT_TYPES: Readonly<Record<string, RepairableItemType>> = {
  "response.content_part.added": "message",
  "response.content_part.done": "message",
  "response.output_text.annotation.added": "message",
  "response.output_text.delta": "message",
  "response.output_text.done": "message",
  "response.refusal.delta": "message",
  "response.refusal.done": "message",
  "response.reasoning_summary_part.added": "reasoning",
  "response.reasoning_summary_part.done": "reasoning",
  "response.reasoning_summary_text.delta": "reasoning",
  "response.reasoning_summary_text.done": "reasoning",
  "response.reasoning_text.delta": "reasoning",
  "response.reasoning_text.done": "reasoning",
};

const TERMINAL_RESPONSE_TYPES = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asOutputIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function repairableItemType(item: Record<string, unknown>): RepairableItemType | null {
  return item.type === "message" || item.type === "reasoning" ? item.type : null;
}

function mintCanonicalId(type: RepairableItemType, scope: string, outputIndex: number): string {
  return `${REPAIRABLE_PREFIXES[type]}ocx_${scope}_${outputIndex}`;
}

function isCanonicalItemId(type: RepairableItemType, id: string): boolean {
  return id.startsWith(REPAIRABLE_PREFIXES[type]);
}

function shouldRewriteRawId(
  state: ResponsesItemIdRepairState,
  type: RepairableItemType,
  rawId: string,
): boolean {
  if (state.placeholders[type].has(rawId)) return true;
  if (state.rewriteNonCanonicalIds && !isCanonicalItemId(type, rawId)) return true;
  return false;
}

function mapRawId(
  state: ResponsesItemIdRepairState,
  type: RepairableItemType,
  outputIndex: number,
  rawId: string | undefined,
): string | null {
  const existing = state.outputIds[type].get(outputIndex);
  if (existing) {
    if (rawId && shouldRewriteRawId(state, type, rawId) && !state.rawToCanonical[type].has(rawId)) {
      // Charge every newly retained raw alias, even when the output_index is already mapped.
      state.budget?.chargeRetained(
        new TextEncoder().encode(JSON.stringify([type, outputIndex, rawId, existing])).byteLength,
        { kind: "item_ids" },
      );
      state.rawToCanonical[type].set(rawId, existing);
    }
    return existing;
  }

  if (!rawId) {
    // When non-canonical rewrite is active, mint a request-local id even if the upstream
    // omitted the terminal id, so Codex lifecycle correlation stays stable.
    if (!state.repairMissingTerminalIds && !state.rewriteNonCanonicalIds) return null;
    const minted = mintCanonicalId(type, state.scope, outputIndex);
    state.budget?.chargeRetained(new TextEncoder().encode(JSON.stringify([outputIndex, minted])).byteLength, { kind: "item_ids" });
    state.outputIds[type].set(outputIndex, minted);
    return minted;
  }

  const mapped = shouldRewriteRawId(state, type, rawId)
    ? mintCanonicalId(type, state.scope, outputIndex)
    : state.repairMissingTerminalIds
      ? rawId
      : null;
  if (!mapped) return null;
  state.budget?.chargeRetained(new TextEncoder().encode(JSON.stringify([outputIndex, rawId, mapped])).byteLength, { kind: "item_ids" });
  state.outputIds[type].set(outputIndex, mapped);
  if (mapped !== rawId) state.rawToCanonical[type].set(rawId, mapped);
  return mapped;
}

function createRepairState(config: ResponsesItemIdRepairConfig, budget?: TranslatorBudget): ResponsesItemIdRepairState {
  const state: ResponsesItemIdRepairState = {
    repairMissingTerminalIds: config.repairMissingTerminalIds === true,
    rewriteNonCanonicalIds: config.rewriteNonCanonicalIds === true,
    placeholders: {
      message: new Set(config.message ?? []),
      reasoning: new Set(config.reasoning ?? []),
    },
    outputIds: {
      message: new Map<number, string>(),
      reasoning: new Map<number, string>(),
    },
    rawToCanonical: {
      message: new Map<string, string>(),
      reasoning: new Map<string, string>(),
    },
    reasoningTextByOutputIndex: new Map<number, string>(),
    responseIdMap: new Map<string, string>(),
    scope: randomUUID().replace(/-/g, ""),
    budget,
    sawTerminal: false,
    sawDoneTrailer: false,
  };
  budget?.chargeRetained(new TextEncoder().encode(JSON.stringify({
    message: [...state.placeholders.message],
    reasoning: [...state.placeholders.reasoning],
    scope: state.scope,
    rewriteNonCanonicalIds: state.rewriteNonCanonicalIds,
  })).byteLength, { kind: "item_ids" });
  return state;
}

function rememberMappedId(
  state: ResponsesItemIdRepairState,
  outputIndex: number,
  item: Record<string, unknown>,
): string | null {
  const type = repairableItemType(item);
  if (!type) return null;
  const rawId = typeof item.id === "string" ? item.id : undefined;
  return mapRawId(state, type, outputIndex, rawId);
}

function mapResponseId(state: ResponsesItemIdRepairState, rawId: string | undefined): string | undefined {
  if (!rawId) return rawId;
  if (!state.rewriteNonCanonicalIds) return rawId;
  if (rawId.startsWith("resp_")) return rawId;
  const existing = state.responseIdMap.get(rawId);
  if (existing) return existing;
  // Keep each distinct upstream response id unique within the request-local scope.
  const minted = `resp_ocx_${state.scope}_${state.responseIdMap.size}`;
  state.budget?.chargeRetained(
    new TextEncoder().encode(JSON.stringify([rawId, minted])).byteLength,
    { kind: "item_ids" },
  );
  state.responseIdMap.set(rawId, minted);
  return minted;
}

function releaseReasoningText(state: ResponsesItemIdRepairState, outputIndex: number): void {
  const existing = state.reasoningTextByOutputIndex.get(outputIndex);
  if (existing === undefined) return;
  state.budget?.releaseRetained(new TextEncoder().encode(existing).byteLength, { kind: "reasoning" });
  state.reasoningTextByOutputIndex.delete(outputIndex);
}

function setReasoningText(
  state: ResponsesItemIdRepairState,
  outputIndex: number,
  text: string,
): void {
  const existing = state.reasoningTextByOutputIndex.get(outputIndex);
  if (existing === text) return;
  if (existing !== undefined) {
    state.budget?.releaseRetained(new TextEncoder().encode(existing).byteLength, { kind: "reasoning" });
  }
  if (!text) {
    state.reasoningTextByOutputIndex.delete(outputIndex);
    return;
  }
  state.budget?.chargeRetained(new TextEncoder().encode(text).byteLength, { kind: "reasoning" });
  state.reasoningTextByOutputIndex.set(outputIndex, text);
}

function accumulateReasoningText(
  state: ResponsesItemIdRepairState,
  outputIndex: number,
  delta: string,
): void {
  if (!delta) return;
  // Charge only the newly retained delta bytes; release the whole entry when the stream ends.
  state.budget?.chargeRetained(new TextEncoder().encode(delta).byteLength, { kind: "reasoning" });
  state.reasoningTextByOutputIndex.set(
    outputIndex,
    (state.reasoningTextByOutputIndex.get(outputIndex) ?? "") + delta,
  );
}

function normalizeReasoningItem(
  state: ResponsesItemIdRepairState,
  outputIndex: number,
  item: Record<string, unknown>,
  terminal: boolean,
): Record<string, unknown> {
  const mapped = rememberMappedId(state, outputIndex, item) ?? item.id;
  const text = state.reasoningTextByOutputIndex.get(outputIndex)
    ?? (Array.isArray(item.content)
      ? item.content
        .filter((part): part is Record<string, unknown> => isPlainObject(part) && part.type === "reasoning_text" && typeof part.text === "string")
        .map(part => String(part.text))
        .join("")
      : "");
  if (text && !state.reasoningTextByOutputIndex.has(outputIndex)) {
    // Snapshot content-derived text into the budgeted map only when we still need it later.
    if (!terminal) setReasoningText(state, outputIndex, text);
  }
  const next: Record<string, unknown> = {
    type: "reasoning",
    id: mapped,
    summary: Array.isArray(item.summary) ? item.summary : [],
  };
  if (terminal || text) {
    // Codex consumes encrypted_content; DeepSeek tool-call continuations need plaintext
    // reasoning_text after sanitizeReasoningInputContent strips the proxy-only ocxr1 envelope.
    next.encrypted_content = encodeReasoningEnvelope({ txt: text || " " });
    if (text) {
      next.content = [{ type: "reasoning_text", text }];
    }
  }
  if (terminal) releaseReasoningText(state, outputIndex);
  return next;
}

function normalizeMessageItem(
  state: ResponsesItemIdRepairState,
  outputIndex: number,
  item: Record<string, unknown>,
): Record<string, unknown> {
  const mapped = rememberMappedId(state, outputIndex, item);
  const next: Record<string, unknown> = { ...item };
  if (mapped) next.id = mapped;
  if (Array.isArray(next.content)) {
    next.content = next.content.map(part => {
      if (!isPlainObject(part)) return part;
      if (part.type !== "output_text") return part;
      return {
        type: "output_text",
        text: typeof part.text === "string" ? part.text : "",
        annotations: Array.isArray(part.annotations) ? part.annotations : [],
      };
    });
  }
  return next;
}

function rewriteOutputItem(
  state: ResponsesItemIdRepairState,
  outputIndex: number,
  item: Record<string, unknown>,
  terminal = false,
): { item: Record<string, unknown>; changed: boolean } {
  if (state.rewriteNonCanonicalIds && item.type === "reasoning") {
    return { item: normalizeReasoningItem(state, outputIndex, item, terminal), changed: true };
  }
  if (state.rewriteNonCanonicalIds && item.type === "message") {
    return { item: normalizeMessageItem(state, outputIndex, item), changed: true };
  }
  const mapped = rememberMappedId(state, outputIndex, item);
  if (!mapped) return { item, changed: false };
  const currentId = typeof item.id === "string" ? item.id : undefined;
  if (currentId === mapped) return { item, changed: false };
  if (currentId === undefined && !state.repairMissingTerminalIds && !state.rewriteNonCanonicalIds) return { item, changed: false };
  return { item: { ...item, id: mapped }, changed: true };
}

function rewriteItemIdField(
  state: ResponsesItemIdRepairState,
  event: Record<string, unknown>,
  outputIndex: number,
): { event: Record<string, unknown>; changed: boolean } {
  const currentId = typeof event.item_id === "string" ? event.item_id : undefined;
  const eventType = typeof event.type === "string" ? ITEM_ID_EVENT_TYPES[event.type] : undefined;
  if (!eventType) return { event, changed: false };

  // Alias lookup is type-scoped so a shared placeholder cannot rewrite reasoning -> msg_*.
  if (currentId) {
    const reverseMapped = state.rawToCanonical[eventType].get(currentId);
    if (reverseMapped && reverseMapped !== currentId) {
      const next: Record<string, unknown> = { ...event, item_id: reverseMapped };
      if (state.rewriteNonCanonicalIds && "logprobs" in next) delete next.logprobs;
      return { event: next, changed: true };
    }
  }

  let mapped: string | null | undefined;
  if (eventType === "message" && (
    event.type === "response.content_part.added"
    || event.type === "response.content_part.done"
  )) {
    // content_part events can belong to either a message or a reasoning item at the
    // same output_index; prefer the already-mapped type without inventing a cross-type alias.
    mapped = state.outputIds.message.get(outputIndex)
      ?? state.outputIds.reasoning.get(outputIndex)
      ?? null;
  } else {
    mapped = state.outputIds[eventType].get(outputIndex);
    if (!mapped && currentId && state.rewriteNonCanonicalIds) {
      mapped = mapRawId(state, eventType, outputIndex, currentId);
    }
  }
  if (!mapped) return { event, changed: false };
  if (currentId === mapped) return { event, changed: false };
  if (currentId === undefined && !state.repairMissingTerminalIds && !state.rewriteNonCanonicalIds) return { event, changed: false };
  const next: Record<string, unknown> = { ...event, item_id: mapped };
  if (state.rewriteNonCanonicalIds && "logprobs" in next) delete next.logprobs;
  return { event: next, changed: true };
}

function rewriteResponseSnapshot(
  state: ResponsesItemIdRepairState,
  response: Record<string, unknown>,
): { response: Record<string, unknown>; changed: boolean } {
  let changed = false;
  let next = response;
  if (typeof response.id === "string") {
    const mapped = mapResponseId(state, response.id);
    if (mapped && mapped !== response.id) {
      next = { ...next, id: mapped };
      changed = true;
    }
  }
  if (!Array.isArray(response.output)) return { response: next, changed };
  const output = response.output.map((item, outputIndex) => {
    if (!isPlainObject(item)) return item;
    const rewritten = rewriteOutputItem(state, outputIndex, item, true);
    changed = changed || rewritten.changed;
    return rewritten.item;
  });
  return changed ? { response: { ...next, output }, changed: true } : { response: next, changed };
}

function repairEventPayload(
  payload: string,
  state: ResponsesItemIdRepairState,
): string | null {
  if (payload.trim() === "[DONE]") {
    state.sawDoneTrailer = true;
    return payload;
  }

  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!isPlainObject(event)) return payload;

  const type = typeof event.type === "string" ? event.type : undefined;
  const outputIndex = asOutputIndex(event.output_index);

  if (state.rewriteNonCanonicalIds) {
    if (type === "response.in_progress") return null;
    if (type === "response.reasoning_text.delta") {
      if (outputIndex !== null && typeof event.delta === "string") {
        accumulateReasoningText(state, outputIndex, event.delta);
      }
      return null;
    }
    if (type === "response.reasoning_text.done") {
      if (outputIndex !== null && typeof event.text === "string") {
        setReasoningText(state, outputIndex, event.text);
      }
      return null;
    }
    if (
      (type === "response.content_part.added" || type === "response.content_part.done")
      && isPlainObject(event.part)
      && event.part.type === "reasoning_text"
    ) {
      if (outputIndex !== null && typeof event.part.text === "string" && event.part.text) {
        setReasoningText(state, outputIndex, event.part.text);
      }
      return null;
    }
  }

  let changed = false;
  let nextEvent = event;

  if (outputIndex !== null && isPlainObject(event.item)) {
    const terminal = type === "response.output_item.done";
    const rewritten = rewriteOutputItem(state, outputIndex, event.item, terminal);
    if (rewritten.changed) {
      nextEvent = { ...nextEvent, item: rewritten.item };
      changed = true;
    }
  }
  if (outputIndex !== null) {
    const rewritten = rewriteItemIdField(state, nextEvent, outputIndex);
    if (rewritten.changed) {
      nextEvent = rewritten.event;
      changed = true;
    }
  }
  if (isPlainObject(event.response)) {
    const rewritten = rewriteResponseSnapshot(state, event.response);
    if (rewritten.changed) {
      nextEvent = { ...nextEvent, response: rewritten.response };
      changed = true;
    }
  }

  if (type && TERMINAL_RESPONSE_TYPES.has(type)) state.sawTerminal = true;

  if (state.rewriteNonCanonicalIds && isPlainObject(nextEvent.part) && nextEvent.part.type === "output_text") {
    nextEvent = {
      ...nextEvent,
      part: {
        type: "output_text",
        text: typeof nextEvent.part.text === "string" ? nextEvent.part.text : "",
        annotations: Array.isArray(nextEvent.part.annotations) ? nextEvent.part.annotations : [],
      },
    };
    changed = true;
  }
  if (state.rewriteNonCanonicalIds && "logprobs" in nextEvent) {
    const { logprobs: _lp, ...rest } = nextEvent;
    nextEvent = rest;
    changed = true;
  }

  if (!changed) return payload;
  const rewritten = JSON.stringify(nextEvent);
  const bytes = new TextEncoder().encode(rewritten).byteLength;
  const reservation = state.budget?.reserveTransient(bytes, { kind: "item_ids" });
  reservation?.commitRetained();
  if (state.budget) queueMicrotask(() => state.budget?.releaseRetained(bytes, { kind: "item_ids" }));
  return rewritten;
}

/**
 * Opt-in client-facing SSE repair for openai-responses gateways.
 * rewriteNonCanonicalIds rewrites DeepSeek-style UUID item/response ids, converts
 * reasoning_text streams into Codex-friendly encrypted_content reasoning items, and
 * ensures a terminal [DONE] trailer so CLI/TUI turns finish.
 *
 * The rewrite and trailer share one request-local state object via closure so
 * composition cannot lose the trailer state.
 */
export interface ResponsesItemIdRepairHandlers {
  rewrite: SsePayloadRewrite;
  trailer: () => string | undefined;
  /**
   * Map a provider-raw response id to the client-visible id emitted on the repaired
   * stream. Used to alias local previous_response_id continuation state.
   */
  clientResponseId: (rawId: string | undefined) => string | undefined;
}

export function createResponsesItemIdRepairHandlers(
  config: ResponsesItemIdRepairConfig,
  budget?: TranslatorBudget,
): ResponsesItemIdRepairHandlers {
  const state = createRepairState(config, budget);
  return {
    rewrite: (payload) => repairEventPayload(payload, state),
    trailer: () => {
      if (state.sawTerminal && !state.sawDoneTrailer) return "data: [DONE]\n\n";
      return undefined;
    },
    clientResponseId: (rawId) => mapResponseId(state, rawId),
  };
}

/** Backward-compatible helper used by existing tests and callers. */
export function createResponsesItemIdPayloadRewrite(
  config: ResponsesItemIdRepairConfig,
  budget?: TranslatorBudget,
): SsePayloadRewrite {
  return createResponsesItemIdRepairHandlers(config, budget).rewrite;
}

export function relaySseWithResponsesItemIdRepair(
  body: ReadableStream<Uint8Array>,
  config: ResponsesItemIdRepairConfig,
  budget: TranslatorBudget,
): ReadableStream<Uint8Array> {
  const handlers = createResponsesItemIdRepairHandlers(config, budget);
  return relaySseWithPayloadRewrite(body, handlers.rewrite, budget, {
    trailer: handlers.trailer,
  });
}

export function hasResponsesItemIdRepair(config: ResponsesItemIdRepairConfig | undefined): boolean {
  return config?.repairMissingTerminalIds === true
    || config?.rewriteNonCanonicalIds === true
    || (config?.message?.length ?? 0) > 0
    || (config?.reasoning?.length ?? 0) > 0;
}
