import { randomUUID } from "node:crypto";
import type { ResponsesItemIdRepairConfig } from "../types";

type RepairableItemType = "message" | "reasoning";

interface ResponsesItemIdRepairState {
  readonly repairMissingTerminalIds: boolean;
  readonly placeholders: Record<RepairableItemType, ReadonlySet<string>>;
  readonly outputIds: Record<RepairableItemType, Map<number, string>>;
  readonly scope: string;
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

function nextSseBlock(buffer: string): { block: string; delimiter: string; rest: string } | null {
  const match = buffer.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) return null;
  return {
    block: buffer.slice(0, match.index),
    delimiter: match[0],
    rest: buffer.slice(match.index + match[0].length),
  };
}

function sseDataPayload(block: string): string | null {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return data.length > 0 ? data.join("\n") : null;
}

function replaceSseDataPayload(block: string, payload: string): string {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const rewritten: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      rewritten.push(line);
      continue;
    }
    if (!replaced) {
      rewritten.push(`data: ${payload}`);
      replaced = true;
    }
  }
  return replaced ? rewritten.join(newline) : block;
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

function createRepairState(config: ResponsesItemIdRepairConfig): ResponsesItemIdRepairState {
  return {
    repairMissingTerminalIds: config.repairMissingTerminalIds === true,
    placeholders: {
      message: new Set(config.message ?? []),
      reasoning: new Set(config.reasoning ?? []),
    },
    outputIds: {
      message: new Map<number, string>(),
      reasoning: new Map<number, string>(),
    },
    scope: randomUUID().replace(/-/g, ""),
  };
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
    : state.repairMissingTerminalIds
      ? rawId
      : null;
  if (!mapped) return null;
  state.outputIds[type].set(outputIndex, mapped);
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
  const mapped = state.outputIds[eventType].get(outputIndex);
  if (!mapped) return { event, changed: false };
  const currentId = typeof event.item_id === "string" ? event.item_id : undefined;
  if (currentId === mapped) return { event, changed: false };
  if (currentId === undefined && !state.repairMissingTerminalIds) return { event, changed: false };
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
  return changed ? JSON.stringify(nextEvent) : payload;
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
export function relaySseWithResponsesItemIdRepair(
  body: ReadableStream<Uint8Array>,
  config: ResponsesItemIdRepairConfig,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = createRepairState(config);
  let buffer = "";

  const emitProcessedBlocks = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    flushFinal = false,
  ): void => {
    let next: { block: string; delimiter: string; rest: string } | null;
    while ((next = nextSseBlock(buffer))) {
      buffer = next.rest;
      const payload = sseDataPayload(next.block);
      const repairedPayload = payload ? repairEventPayload(payload, state) : undefined;
      const block = payload && repairedPayload !== undefined && repairedPayload !== payload
        ? replaceSseDataPayload(next.block, repairedPayload)
        : next.block;
      controller.enqueue(encoder.encode(block + next.delimiter));
    }
    if (flushFinal && buffer.length > 0) {
      const payload = sseDataPayload(buffer);
      const repairedPayload = payload ? repairEventPayload(payload, state) : undefined;
      const block = payload && repairedPayload !== undefined && repairedPayload !== payload
        ? replaceSseDataPayload(buffer, repairedPayload)
        : buffer;
      controller.enqueue(encoder.encode(block));
      buffer = "";
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        emitProcessedBlocks(controller, true);
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      emitProcessedBlocks(controller);
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

export function hasResponsesItemIdRepair(config: ResponsesItemIdRepairConfig | undefined): boolean {
  return config?.repairMissingTerminalIds === true
    || (config?.message?.length ?? 0) > 0
    || (config?.reasoning?.length ?? 0) > 0;
}
