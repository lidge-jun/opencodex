import {
  replaceSseDataPayload,
  sseDataPayload,
  type SseBlockRewrite,
} from "../server/sse-payload-rewrite";
import {
  GuardrailsDemaskCapacityError,
  MAX_GUARDRAILS_DEMASK_EXPANSION_BYTES,
  demaskGuardrailsText,
} from "./placeholders";
import type { GuardrailsDemaskBudget, GuardrailsPlaceholderState } from "./types";

type JsonRecord = Record<string, unknown>;

const MAX_PENDING_STREAM_FIELDS = 128;
const MAX_PENDING_STREAM_TEXT_LENGTH = 255;
const MAX_PENDING_STREAM_BYTES = 2 * 1024 * 1024;

export class GuardrailsSseDemaskCapacityError extends Error {
  constructor() {
    super("Guardrails SSE demask state exceeded its safe capacity");
    this.name = "GuardrailsSseDemaskCapacityError";
  }
}

interface PendingDelta {
  block: string;
  choicePosition?: number;
  field: "content" | "delta" | "refusal" | "text" | "thinking";
  key: string;
  pendingChoicePosition?: number;
  pendingPayload?: JsonRecord;
  payload: JsonRecord;
  text: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function streamKey(type: string, id: unknown, field: PendingDelta["field"]): string {
  return `${type}:${typeof id === "string" || typeof id === "number" ? String(id) : "default"}:${field}`;
}

function pendingSuffix(value: string, state: GuardrailsPlaceholderState): string {
  const maximum = Math.min(MAX_PENDING_STREAM_TEXT_LENGTH, value.length);
  for (let length = maximum; length > 0; length -= 1) {
    const suffix = value.slice(-length);
    if (!suffix.startsWith("<")) continue;
    let normalized = "<";
    let valid = true;
    for (const character of suffix.slice(1)) {
      if (/[A-Za-z0-9_]/.test(character)) normalized += character.toUpperCase();
      else if (character === "-") normalized += "_";
      else if (character === " " || character === "\t" || character === "\r" || character === "\n") continue;
      else {
        valid = false;
        break;
      }
    }
    if (valid && state.replacements.some(replacement =>
      normalized.length < replacement.placeholder.length
      && replacement.placeholder.startsWith(normalized))) {
      return suffix;
    }
  }
  return "";
}

function demaskStableText(
  value: string,
  state: GuardrailsPlaceholderState,
  budget: GuardrailsDemaskBudget,
): string {
  return demaskGuardrailsText(value, state, {
    allowNormalizedPlaceholderDrift: true,
    budget,
  });
}

function clonePayload(payload: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(payload)) as JsonRecord;
}

function updateTextField(
  payload: JsonRecord,
  field: PendingDelta["field"],
  value: string,
  choicePosition?: number,
): JsonRecord {
  if ((field === "content" || field === "refusal") && Array.isArray(payload.choices)) {
    const choices = payload.choices.map((choice, index) => {
      if (choicePosition !== undefined && index !== choicePosition) return choice;
      if (!isRecord(choice) || !isRecord(choice.delta)) return choice;
      return { ...choice, delta: { ...choice.delta, [field]: value } };
    });
    return { ...payload, choices };
  }
  if (field === "delta") return { ...payload, delta: value };
  if (field === "text") {
    return isRecord(payload.delta)
      ? { ...payload, delta: { ...payload.delta, text: value } }
      : { ...payload, text: value };
  }
  if (field === "thinking" && isRecord(payload.delta)) {
    return { ...payload, delta: { ...payload.delta, thinking: value } };
  }
  return payload;
}

function pendingFromResponses(payload: JsonRecord, block: string): PendingDelta | undefined {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type !== "response.output_text.delta" && type !== "response.refusal.delta") return undefined;
  if (typeof payload.delta !== "string") return undefined;
  return {
    key: streamKey(
      type,
      `${String(payload.item_id ?? "")}:${String(payload.output_index ?? "")}:${String(payload.content_index ?? "")}`,
      "delta",
    ),
    field: "delta",
    block,
    payload,
    text: payload.delta,
  };
}

function pendingFromAnthropic(payload: JsonRecord, block: string): PendingDelta | undefined {
  if (payload.type !== "content_block_delta" || !isRecord(payload.delta)) return undefined;
  if (payload.delta.type === "text_delta" && typeof payload.delta.text === "string") {
    return {
      key: streamKey("anthropic:text", payload.index, "text"),
      field: "text",
      block,
      payload,
      text: payload.delta.text,
    };
  }
  return undefined;
}

function pendingFromChat(payload: JsonRecord, block: string): PendingDelta[] {
  if (!Array.isArray(payload.choices)) return [];
  const deltas: PendingDelta[] = [];
  for (let position = 0; position < payload.choices.length; position += 1) {
    const choice = payload.choices[position];
    if (!isRecord(choice) || !isRecord(choice.delta)) continue;
    for (const field of ["content", "refusal"] as const) {
      if (typeof choice.delta[field] !== "string") continue;
      const isolatedChoice: JsonRecord = {
        delta: { [field]: choice.delta[field] },
      };
      if (Object.prototype.hasOwnProperty.call(choice, "index")) isolatedChoice.index = choice.index;
      const pendingPayload = {
        ...payload,
        choices: [isolatedChoice],
      };
      deltas.push({
        key: streamKey("chat", choice.index ?? position, field),
        field,
        block: replaceSseDataPayload(block, JSON.stringify(pendingPayload)),
        choicePosition: position,
        pendingChoicePosition: 0,
        pendingPayload,
        payload,
        text: choice.delta[field],
      });
    }
  }
  return deltas;
}

function isTerminalPayload(payload: JsonRecord): boolean {
  return payload.type === "response.completed"
    || payload.type === "response.failed"
    || payload.type === "response.incomplete"
    || payload.type === "message_stop";
}

function isBoundaryPayload(payload: JsonRecord): boolean {
  if (typeof payload.type === "string") {
    if (payload.type.endsWith(".done") || payload.type === "content_block_stop") return true;
  }
  if (!Array.isArray(payload.choices)) return false;
  return payload.choices.some(choice =>
    isRecord(choice) && choice.finish_reason !== undefined && choice.finish_reason !== null);
}

function finishedChatStreamKeys(payload: JsonRecord): Set<string> | undefined {
  if (!Array.isArray(payload.choices)) return undefined;
  const keys = new Set<string>();
  for (let position = 0; position < payload.choices.length; position += 1) {
    const choice = payload.choices[position];
    if (!isRecord(choice) || choice.finish_reason === undefined || choice.finish_reason === null) continue;
    const id = choice.index ?? position;
    keys.add(streamKey("chat", id, "content"));
    keys.add(streamKey("chat", id, "refusal"));
  }
  return keys.size > 0 ? keys : undefined;
}

/**
 * Resolve exact placeholders even when a provider splits one token over adjacent text deltas.
 * State is bounded by field count and token length; tool-call argument deltas are never considered.
 */
export function guardrailsSseDemaskRewrite(
  state: GuardrailsPlaceholderState,
  rewritePayload: (payload: string) => string,
  onWarning?: () => void,
  sharedBudget?: GuardrailsDemaskBudget,
  isCapacityError?: (error: unknown) => boolean,
): SseBlockRewrite {
  const pending = new Map<string, PendingDelta>();
  const demaskBudget = sharedBudget ?? {
    remainingExpansionBytes: MAX_GUARDRAILS_DEMASK_EXPANSION_BYTES,
  };
  let pendingBytes = 0;
  let disabled = false;

  const pendingEntryBytes = (entry: PendingDelta): number =>
    Buffer.byteLength(entry.block, "utf8") + Buffer.byteLength(entry.text, "utf8");

  const flush = (keys?: ReadonlySet<string>): string[] => {
    const blocks: string[] = [];
    for (const [key, entry] of pending) {
      if (keys && !keys.has(key)) continue;
      const payload = updateTextField(clonePayload(entry.payload), entry.field, entry.text, entry.choicePosition);
      blocks.push(replaceSseDataPayload(entry.block, JSON.stringify(payload)));
      pending.delete(key);
      pendingBytes = Math.max(0, pendingBytes - pendingEntryBytes(entry));
    }
    return blocks;
  };

  const processBlock = (block: string): readonly string[] => {
    if (disabled) return [block];
    const rawPayload = sseDataPayload(block);
    if (rawPayload === null) return [block];
    if (rawPayload.trim() === "[DONE]") return [...flush(), block];
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawPayload);
    } catch {
      return [...flush(), block];
    }
    if (!isRecord(parsed)) return [...flush(), block];
    if (isTerminalPayload(parsed)) {
      return [...flush(), replaceSseDataPayload(block, rewritePayload(rawPayload))];
    }
    const protocolDelta = pendingFromResponses(parsed, block) ?? pendingFromAnthropic(parsed, block);
    const deltas = protocolDelta ? [protocolDelta] : pendingFromChat(parsed, block);
    if (deltas.length === 0) {
      const rewritten = rewritePayload(rawPayload);
      const current = rewritten === rawPayload ? block : replaceSseDataPayload(block, rewritten);
      const finishedKeys = finishedChatStreamKeys(parsed);
      if (finishedKeys) return [...flush(finishedKeys), current];
      return isBoundaryPayload(parsed) ? [...flush(), current] : [current];
    }
    const stagedPending = new Map(pending);
    let stagedPendingBytes = pendingBytes;
    const stagedBudget: GuardrailsDemaskBudget = {
      remainingExpansionBytes: demaskBudget.remainingExpansionBytes,
    };
    const removeStagedPending = (key: string): void => {
      const prior = stagedPending.get(key);
      if (!prior) return;
      stagedPendingBytes = Math.max(0, stagedPendingBytes - pendingEntryBytes(prior));
      stagedPending.delete(key);
    };
    const setStagedPending = (entry: PendingDelta): boolean => {
      const prior = stagedPending.get(entry.key);
      const bytes = pendingEntryBytes(entry);
      const nextSize = stagedPending.size + (prior ? 0 : 1);
      const nextBytes = stagedPendingBytes - (prior ? pendingEntryBytes(prior) : 0) + bytes;
      if (nextSize > MAX_PENDING_STREAM_FIELDS || nextBytes > MAX_PENDING_STREAM_BYTES) return false;
      removeStagedPending(entry.key);
      stagedPending.set(entry.key, entry);
      stagedPendingBytes += bytes;
      return true;
    };
    let payload = parsed;
    for (const delta of deltas) {
      const previous = stagedPending.get(delta.key)?.text ?? "";
      const combined = `${previous}${delta.text}`;
      const suffix = pendingSuffix(combined, state);
      const stable = suffix ? combined.slice(0, -suffix.length) : combined;
      payload = updateTextField(
        payload,
        delta.field,
        demaskStableText(stable, state, stagedBudget),
        delta.choicePosition,
      );
      if (suffix) {
        const pendingChoicePosition = delta.pendingChoicePosition ?? delta.choicePosition;
        const pendingPayload = updateTextField(
          clonePayload(delta.pendingPayload ?? delta.payload),
          delta.field,
          suffix,
          pendingChoicePosition,
        );
        const accepted = setStagedPending({
          ...delta,
          payload: pendingPayload,
          choicePosition: pendingChoicePosition,
          text: suffix,
          block: replaceSseDataPayload(delta.block, JSON.stringify(pendingPayload)),
        });
        if (!accepted) {
          onWarning?.();
          disabled = true;
          return [...flush(), block];
        }
      } else {
        removeStagedPending(delta.key);
      }
    }
    pending.clear();
    for (const [key, entry] of stagedPending) pending.set(key, entry);
    pendingBytes = stagedPendingBytes;
    demaskBudget.remainingExpansionBytes = stagedBudget.remainingExpansionBytes;
    const current = replaceSseDataPayload(block, JSON.stringify(payload));
    const finishedKeys = finishedChatStreamKeys(parsed);
    return finishedKeys ? [...flush(finishedKeys), current] : [current];
  };
  const rewrite: SseBlockRewrite = (block: string): readonly string[] => {
    try {
      return processBlock(block);
    } catch (error) {
      if (!(error instanceof GuardrailsDemaskCapacityError || isCapacityError?.(error) === true)) throw error;
      onWarning?.();
      disabled = true;
      return [...flush(), block];
    }
  };
  rewrite.flush = flush;
  rewrite.dispose = () => {
    pending.clear();
    pendingBytes = 0;
  };
  return rewrite;
}
