import { randomUUID } from "node:crypto";
import type { ResponsesItemIdRepairConfig } from "../types";
import { relaySseWithPayloadRewrite, type SsePayloadRewrite } from "./sse-payload-rewrite";
import type { TranslatorBudget } from "../lib/translator-budget";

type RepairableItemType = "message" | "reasoning";

interface ResponsesItemIdRepairState {
  readonly repairMissingTerminalIds: boolean;
  readonly repairInvalidIds: boolean;
  readonly placeholders: Record<RepairableItemType, ReadonlySet<string>>;
  readonly outputIds: Record<RepairableItemType, Map<number, string>>;
  /** JSON [outputIndex, rawId] -> canonical id, for exact item_id rewrites on part/delta events. */
  readonly rawIds: Map<string, string>;
  readonly scope: string;
  readonly budget?: TranslatorBudget;
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

function createRepairState(config: ResponsesItemIdRepairConfig, budget?: TranslatorBudget): ResponsesItemIdRepairState {
  const state = {
    repairMissingTerminalIds: config.repairMissingTerminalIds === true,
    repairInvalidIds: config.repairInvalidIds === true,
    placeholders: {
      message: new Set(config.message ?? []),
      reasoning: new Set(config.reasoning ?? []),
    },
    outputIds: {
      message: new Map<number, string>(),
      reasoning: new Map<number, string>(),
    },
    rawIds: new Map<string, string>(),
    scope: randomUUID().replace(/-/g, ""),
    budget,
  };
  budget?.chargeRetained(new TextEncoder().encode(JSON.stringify({
    message: [...state.placeholders.message],
    reasoning: [...state.placeholders.reasoning],
    scope: state.scope,
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
  const existing = state.outputIds[type].get(outputIndex);
  if (existing) return existing;
  const rawId = typeof item.id === "string" ? item.id : undefined;
  if (!rawId) return null;
  const mapped = state.placeholders[type].has(rawId)
    ? mintCanonicalId(type, state.scope, outputIndex)
    : state.repairInvalidIds && !rawId.startsWith(REPAIRABLE_PREFIXES[type])
      // An existing id without the canonical msg_/rs_ prefix (bare UUIDs from
      // DeepSeek's Responses route) leaves Codex stuck on Thinking (#938).
      ? mintCanonicalId(type, state.scope, outputIndex)
      : state.repairMissingTerminalIds
        ? rawId
        : null;
  if (!mapped) return null;
  state.budget?.chargeRetained(new TextEncoder().encode(JSON.stringify([outputIndex, rawId, mapped])).byteLength, { kind: "item_ids" });
  state.outputIds[type].set(outputIndex, mapped);
  // Keyed by (index, rawId): an upstream that reuses one placeholder id across
  // several items must not collapse them into the last item's canonical id.
  if (rawId !== mapped) state.rawIds.set(JSON.stringify([outputIndex, rawId]), mapped);
  return mapped;
}

function rewriteOutputItem(
  state: ResponsesItemIdRepairState,
  outputIndex: number,
  item: Record<string, unknown>,
): { item: Record<string, unknown>; changed: boolean } {
  const mapped = rememberMappedId(state, outputIndex, item);
  if (!mapped) return { item, changed: false };
  const currentId = typeof item.id === "string" ? item.id : undefined;
  if (currentId === mapped) return { item, changed: false };
  if (currentId === undefined && !state.repairMissingTerminalIds) return { item, changed: false };
  return { item: { ...item, id: mapped }, changed: true };
}

function rewriteItemIdField(
  state: ResponsesItemIdRepairState,
  event: Record<string, unknown>,
  outputIndex: number,
): { event: Record<string, unknown>; changed: boolean } {
  const eventType = typeof event.type === "string" ? ITEM_ID_EVENT_TYPES[event.type] : undefined;
  if (!eventType) return { event, changed: false };
  const currentId = typeof event.item_id === "string" ? event.item_id : undefined;
  // content_part.* events are shared between message and reasoning items (DeepSeek's
  // streamed reasoning wraps its text in content parts), so the static event-type map
  // can point at the wrong id table. The rewrite is therefore exact-only when the
  // event carries an item_id: it fires when (output_index, item_id) names an id the
  // item stream already repaired, and otherwise leaves the event alone — an unknown
  // id belongs to an item this repair never touched (function_call, already-canonical
  // ids), and guessing by index could borrow a sibling item's identity. The index
  // table serves only events with NO item_id, where repairMissingTerminalIds
  // explicitly opts into the positional guess (the pre-existing contract).
  if (currentId !== undefined) {
    const mapped = state.rawIds.get(JSON.stringify([outputIndex, currentId]));
    if (!mapped || currentId === mapped) return { event, changed: false };
    return { event: { ...event, item_id: mapped }, changed: true };
  }
  if (!state.repairMissingTerminalIds) return { event, changed: false };
  const mapped = state.outputIds[eventType].get(outputIndex);
  if (!mapped) return { event, changed: false };
  return { event: { ...event, item_id: mapped }, changed: true };
}

function rewriteResponseSnapshot(
  state: ResponsesItemIdRepairState,
  response: Record<string, unknown>,
): { response: Record<string, unknown>; changed: boolean } {
  if (!Array.isArray(response.output)) return { response, changed: false };
  let changed = false;
  const output = response.output.map((item, outputIndex) => {
    if (!isPlainObject(item)) return item;
    const rewritten = rewriteOutputItem(state, outputIndex, item);
    changed = changed || rewritten.changed;
    return rewritten.item;
  });
  return changed ? { response: { ...response, output }, changed: true } : { response, changed: false };
}

function repairEventPayload(
  payload: string,
  state: ResponsesItemIdRepairState,
): string {
  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!isPlainObject(event)) return payload;

  let changed = false;
  let nextEvent = event;
  const outputIndex = asOutputIndex(event.output_index);
  if (outputIndex !== null && isPlainObject(event.item)) {
    const rewritten = rewriteOutputItem(state, outputIndex, event.item);
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
  if (!changed) return payload;
  const rewritten = JSON.stringify(nextEvent);
  const bytes = new TextEncoder().encode(rewritten).byteLength;
  const reservation = state.budget?.reserveTransient(bytes, { kind: "item_ids" });
  reservation?.commitRetained();
  if (state.budget) queueMicrotask(() => state.budget?.releaseRetained(bytes, { kind: "item_ids" }));
  return rewritten;
}

/**
 * [Decision Log]
 * - 목적과 의도: 일부 openai-responses 호환 게이트웨이가 재사용/누락하는 message·reasoning item id를
 *   downstream SSE에서만 선택적으로 보정해 Codex Desktop 카드 상관관계를 안정화한다.
 * - 기존 구현 및 제약 조건: 기본 passthrough는 바이트 단위 그대로 relay되고, local replay 상태는 raw
 *   upstream 응답을 기억한다. function_call id / call_id는 upstream 의미가 있으므로 절대 바꾸면 안 된다.
 * - 검토한 주요 대안: 모든 passthrough SSE를 항상 재작성하기, raw inspect 분기까지 함께 재작성하기,
 *   function_call 포함 전체 item id를 정규화하기.
 * - 선택한 방식: provider-local opt-in 설정이 있을 때만 client-facing SSE 분기에 한정해 exact
 *   message/reasoning placeholder id와 missing terminal id를 item type + output_index 기준으로 보정하고,
 *   event-level item_id는 명시적인 message/reasoning lifecycle allowlist에서만 바꾼다.
 * - 다른 대안 대신 이 방식을 선택한 이유: disabled-by-default byte-for-byte passthrough를 유지하면서,
 *   previous_response_id replay는 raw upstream snapshot을 계속 사용해 synthetic id가 upstream으로
 *   역류하지 않게 막을 수 있다.
 * - 장점, 단점 및 영향: 기본 경로는 변하지 않는다. malformed stream이 output_index를 다른 item
 *   type에 재사용해도 function_call id/call_id는 보존된다. opt-in 게이트웨이는 sequential streams에서도
 *   고유한 canonical id를 얻지만, 보정이 필요한 경우에만 JS stream 재작성 비용을 지불한다.
 */
/** Stateful payload rewrite for composition with other client-facing SSE transforms. */
export function createResponsesItemIdPayloadRewrite(
  config: ResponsesItemIdRepairConfig,
  budget?: TranslatorBudget,
): SsePayloadRewrite {
  const state = createRepairState(config, budget);
  return (payload) => repairEventPayload(payload, state);
}

export function relaySseWithResponsesItemIdRepair(
  body: ReadableStream<Uint8Array>,
  config: ResponsesItemIdRepairConfig,
  budget: TranslatorBudget,
): ReadableStream<Uint8Array> {
  return relaySseWithPayloadRewrite(body, createResponsesItemIdPayloadRewrite(config, budget), budget);
}

export function hasResponsesItemIdRepair(config: ResponsesItemIdRepairConfig | undefined): boolean {
  return config?.repairMissingTerminalIds === true
    || config?.repairInvalidIds === true
    || (config?.message?.length ?? 0) > 0
    || (config?.reasoning?.length ?? 0) > 0;
}

/**
 * Client-facing id normalization for a WHOLE bounded-JSON Responses object.
 *
 * The bounded-JSON policy (#875) answers a streaming client by synthesizing SSE
 * from a completed JSON body, and reframes the same body into events for WS
 * turns. Neither path goes through the SSE relay, so neither picks up the SSE
 * item-id rewrite — a provider that needs id repair would get it on a streaming
 * response and silently lose it the moment the reliability policy switched the
 * upstream to bounded JSON. This applies the same rewrite to the object so all
 * three paths agree. Raw recorded state is untouched: recording happens before
 * any normalization.
 */
export function repairResponsesJsonItemIds(
  response: Record<string, unknown>,
  config: ResponsesItemIdRepairConfig,
  budget?: TranslatorBudget,
): Record<string, unknown> {
  const state = createRepairState(config, budget);
  const rewritten = rewriteResponseSnapshot(state, response);
  return rewritten.changed ? rewritten.response : response;
}
