/**
 * Client-facing repair for GitHub Copilot's `vscode-chat` Responses stream.
 *
 * Copilot can rotate opaque response/item ids between lifecycle events, expose
 * provider-private reasoning ciphertext, and attach per-delta obfuscation
 * padding while the authoritative complete tool input arrives on `.done`.
 * Stock Responses clients cannot reconcile that dialect. This stateful block
 * rewrite emits one coherent Responses SSE stream while the inspection branch
 * keeps the raw upstream snapshot for provider replay.
 */
import {
  TranslatorBudgetExceededError,
  type TranslatorBudget,
} from "../lib/translator-budget";
import {
  replaceSseDataPayload,
  sseDataPayload,
  type SseBlockRewrite,
} from "./sse-payload-rewrite";

const MAX_TRACKED_ITEMS = 256;
const MAX_TRACKED_DEFERRED_CALLS = 256;
const RETAINED_STATE_LIMIT_BYTES = 256 * 1024;

type JsonRecord = Record<string, unknown>;

type TrackedItem = {
  id: string;
  type?: string;
  encryptedReasoning: boolean;
};

type DeferredCallKind = "function" | "custom";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outputIndexOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function blockNewline(block: string): "\r\n" | "\n" {
  return block.includes("\r\n") ? "\r\n" : "\n";
}

/** Keep a named SSE block's `event:` field aligned with its JSON `type`. */
function withEventName(block: string, eventName: string): string {
  const newline = blockNewline(block);
  const lines = block.split(/\r?\n/);
  let replaced = false;
  const rewritten = lines.flatMap((line) => {
    if (!line.startsWith("event:")) return [line];
    if (replaced) return [];
    replaced = true;
    return [`event: ${eventName}`];
  });
  if (!replaced) {
    const dataIndex = rewritten.findIndex(line => line.startsWith("data:"));
    rewritten.splice(dataIndex >= 0 ? dataIndex : 0, 0, `event: ${eventName}`);
  }
  return rewritten.join(newline);
}

function rewriteJsonBlock(block: string, event: JsonRecord): string {
  const type = typeof event.type === "string" ? event.type : "message";
  return withEventName(replaceSseDataPayload(block, JSON.stringify(event)), type);
}

function syntheticJsonBlock(template: string, event: JsonRecord): string {
  const newline = blockNewline(template);
  const type = typeof event.type === "string" ? event.type : "message";
  return `event: ${type}${newline}data: ${JSON.stringify(event)}`;
}

function callKindForDelta(type: unknown): DeferredCallKind | undefined {
  if (type === "response.function_call_arguments.delta") return "function";
  if (type === "response.custom_tool_call_input.delta") return "custom";
  return undefined;
}

function callKindForDone(type: unknown): DeferredCallKind | undefined {
  if (type === "response.function_call_arguments.done") return "function";
  if (type === "response.custom_tool_call_input.done") return "custom";
  return undefined;
}

function callKey(kind: DeferredCallKind, outputIndex: number): string {
  return `${kind}:${outputIndex}`;
}

function deltaTypeFor(kind: DeferredCallKind): string {
  return kind === "function"
    ? "response.function_call_arguments.delta"
    : "response.custom_tool_call_input.delta";
}

function completeValueFor(kind: DeferredCallKind, event: JsonRecord): string {
  const value = kind === "function" ? event.arguments : event.input;
  return typeof value === "string" ? value : "";
}

/**
 * Create one provider-scoped block rewrite per upstream response.
 *
 * Retained ids and pending-call markers are charged to the request translator
 * budget and hard-capped. `dispose` releases them on terminal, EOF, cancel, or
 * relay failure through the shared block-rewrite lifecycle.
 */
export function createGithubCopilotResponsesBlockRewrite(
  budget?: TranslatorBudget,
): SseBlockRewrite {
  const items = new Map<number, TrackedItem>();
  const deferredCalls = new Map<string, number>();
  let responseId: string | undefined;
  let itemStateBytes = 0;
  let callStateBytes = 0;
  let nextSequenceNumber = 0;
  let itemTrackingTainted = false;
  let disposed = false;

  const ensureStateLimit = (nextBytes: number): void => {
    if (itemStateBytes + callStateBytes + nextBytes > RETAINED_STATE_LIMIT_BYTES) {
      throw new TranslatorBudgetExceededError("item_ids", RETAINED_STATE_LIMIT_BYTES);
    }
  };

  const chargeItemState = (bytes: number): void => {
    ensureStateLimit(bytes);
    budget?.chargeRetained(bytes, { kind: "item_ids" });
    itemStateBytes += bytes;
  };

  const chargeCallState = (bytes: number): void => {
    ensureStateLimit(bytes);
    budget?.chargeRetained(bytes, { kind: "retained_collectors" });
    callStateBytes += bytes;
  };

  const releaseDeferredCall = (key: string): boolean => {
    const bytes = deferredCalls.get(key);
    if (bytes === undefined) return false;
    deferredCalls.delete(key);
    callStateBytes -= bytes;
    budget?.releaseRetained(bytes, { kind: "retained_collectors" });
    return true;
  };

  const rememberResponseId = (candidate: string): string => {
    if (responseId !== undefined) return responseId;
    const bytes = byteLength(candidate);
    chargeItemState(bytes);
    responseId = candidate;
    return candidate;
  };

  const rememberItem = (
    outputIndex: number,
    candidateId: string,
    itemType?: string,
    encryptedReasoning = false,
  ): TrackedItem => {
    const existing = items.get(outputIndex);
    if (existing) {
      if (existing.type === undefined && itemType !== undefined) {
        const extra = byteLength(itemType);
        chargeItemState(extra);
        existing.type = itemType;
      }
      existing.encryptedReasoning ||= encryptedReasoning;
      return existing;
    }
    if (itemTrackingTainted || items.size >= MAX_TRACKED_ITEMS) {
      // Keep relaying client-visible events after the count cap, but stop
      // retaining new output-index mappings. The current event still receives
      // the provider id, while earlier retained mappings remain available for
      // stable ids. Byte-budget failures stay hard failures.
      itemTrackingTainted = true;
      return { id: candidateId, type: itemType, encryptedReasoning };
    }
    chargeItemState(byteLength([outputIndex, candidateId, itemType ?? null]));
    const tracked = { id: candidateId, type: itemType, encryptedReasoning };
    items.set(outputIndex, tracked);
    return tracked;
  };

  const rememberDeferredCall = (key: string): void => {
    if (deferredCalls.has(key)) return;
    if (deferredCalls.size >= MAX_TRACKED_DEFERRED_CALLS) {
      throw new TranslatorBudgetExceededError("retained_collectors", RETAINED_STATE_LIMIT_BYTES);
    }
    const bytes = byteLength(key);
    chargeCallState(bytes);
    deferredCalls.set(key, bytes);
  };

  const sanitizeReasoningItem = (
    item: JsonRecord,
    tracked: TrackedItem,
  ): void => {
    if (item.type !== "reasoning") return;
    const encrypted = typeof item.encrypted_content === "string";
    tracked.encryptedReasoning ||= encrypted;
    if (encrypted) delete item.encrypted_content;
    if (tracked.encryptedReasoning) {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const hasPlaintextSummary = summary.some(part =>
        isRecord(part)
        && part.type === "summary_text"
        && typeof part.text === "string"
        && part.text.length > 0);
      if (!hasPlaintextSummary) item.summary = [{ type: "summary_text", text: "" }];
      if (!Array.isArray(item.content)) item.content = [];
    }
  };

  const normalizeNestedItem = (item: JsonRecord, outputIndex: number): void => {
    const candidateId = typeof item.id === "string" ? item.id : undefined;
    if (candidateId === undefined) return;
    const itemType = typeof item.type === "string" ? item.type : undefined;
    const tracked = rememberItem(
      outputIndex,
      candidateId,
      itemType,
      itemType === "reasoning" && typeof item.encrypted_content === "string",
    );
    item.id = tracked.id;
    sanitizeReasoningItem(item, tracked);
  };

  const normalizeSequence = (event: JsonRecord): void => {
    if (typeof event.sequence_number !== "number" || !Number.isFinite(event.sequence_number)) return;
    event.sequence_number = nextSequenceNumber++;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (itemStateBytes > 0) budget?.releaseRetained(itemStateBytes, { kind: "item_ids" });
    if (callStateBytes > 0) budget?.releaseRetained(callStateBytes, { kind: "retained_collectors" });
    items.clear();
    deferredCalls.clear();
    responseId = undefined;
    itemStateBytes = 0;
    callStateBytes = 0;
    itemTrackingTainted = false;
  };

  const rewrite: SseBlockRewrite = (block) => {
    const payload = sseDataPayload(block);
    if (payload === null || payload === "[DONE]") return [block];

    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return [block];
    }
    if (!isRecord(event)) return [block];

    if (typeof event.obfuscation === "string") delete event.obfuscation;

    const type = event.type;
    const outputIndex = outputIndexOf(event.output_index);
    const deltaKind = callKindForDelta(type);
    const deferToolDelta = deltaKind !== undefined
      && outputIndex !== undefined;

    if (isRecord(event.response) && typeof event.response.id === "string") {
      event.response.id = rememberResponseId(event.response.id);
    }

    if (outputIndex !== undefined && isRecord(event.item)) {
      normalizeNestedItem(event.item, outputIndex);
    }
    // A deferred delta is not client-visible, so it must not establish the
    // public item id if a malformed provider sends it before output_item.added.
    if (!deferToolDelta && outputIndex !== undefined && typeof event.item_id === "string") {
      const tracked = rememberItem(outputIndex, event.item_id);
      event.item_id = tracked.id;
    }

    if (type === "response.completed" && isRecord(event.response) && Array.isArray(event.response.output)) {
      event.response.output.forEach((item, index) => {
        if (isRecord(item)) normalizeNestedItem(item, index);
      });
    }

    if (typeof type === "string" && type.startsWith("response.reasoning")) {
      if (typeof event.encrypted_content === "string") delete event.encrypted_content;
      // `encrypted_content` is opaque replay state; summary delta/text fields
      // are a separate, potentially readable part of the public Responses
      // contract and must survive when Copilot provides them.
    }

    if (deferToolDelta) {
      rememberDeferredCall(callKey(deltaKind, outputIndex));
      // The OpenAI `obfuscation` field is padding, not a decryption key. Defer
      // every Copilot tool fragment anyway: mixed padded/unpadded fragments and
      // rotating ids cannot then produce duplicate or irreconcilable input.
      // `.done` carries the authoritative complete value, which is emitted as
      // one canonical delta immediately before the original `.done` event.
      return [];
    }

    const emitted: Array<{ event: JsonRecord; synthetic: boolean }> = [];
    const doneKind = callKindForDone(type);
    if (doneKind !== undefined && outputIndex !== undefined) {
      const key = callKey(doneKind, outputIndex);
      if (releaseDeferredCall(key)) {
        emitted.push({
          synthetic: true,
          event: {
            type: deltaTypeFor(doneKind),
            output_index: outputIndex,
            ...(typeof event.item_id === "string" ? { item_id: event.item_id } : {}),
            ...(typeof event.sequence_number === "number" ? { sequence_number: event.sequence_number } : {}),
            delta: completeValueFor(doneKind, event),
          },
        });
      }
    }
    emitted.push({ event, synthetic: false });

    for (const entry of emitted) normalizeSequence(entry.event);
    return emitted.map(entry => entry.synthetic
      ? syntheticJsonBlock(block, entry.event)
      : rewriteJsonBlock(block, entry.event));
  };
  rewrite.dispose = dispose;
  return rewrite;
}
