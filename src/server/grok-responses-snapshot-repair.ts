/** Strict terminal reconstruction selected by the Grok compatibility marker. */
import type { TranslatorBudget } from "../lib/translator-budget";
import { MAX_COMPLETED_OUTPUT_ITEMS, MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES } from "./relay";
import { sseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";
import { isPlainObject, jsonBlock, type RetainedOutputItem } from "./responses-snapshot-codec";

type SparseTerminalOpenItem = {
  type: string;
  id?: string;
  sourceBytes: number;
};

type SparseTerminalCompletedItem = RetainedOutputItem & {
  visibleToGrok: boolean;
};

const MAX_GROK_OPEN_ITEM_IDENTITY_BYTES = MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES;

const GROK_TERMINAL_OUTPUT_ITEM_TYPES = new Set([
  "message",
  "reasoning",
  "function_call",
  "custom_tool_call",
  "web_search_call",
  "code_interpreter_call",
  "mcp_call",
]);

function hasValidOptionalId(item: Record<string, unknown>): boolean {
  return !("id" in item)
    || (typeof item.id === "string" && item.id.trim().length > 0);
}

function hasCompletedStatusWhenPresent(item: Record<string, unknown>): boolean {
  return !("status" in item) || item.status === "completed";
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isValidOutputMessagePart(part: unknown): boolean {
  if (!isPlainObject(part)) return false;
  if (part.type === "output_text") {
    return typeof part.text === "string"
      && (!("annotations" in part) || Array.isArray(part.annotations))
      && (!("logprobs" in part) || part.logprobs === null || Array.isArray(part.logprobs));
  }
  return part.type === "refusal" && typeof part.refusal === "string";
}

function isValidReasoningPart(part: unknown, type: "summary_text" | "reasoning_text"): boolean {
  return isPlainObject(part) && part.type === type && typeof part.text === "string";
}

function isValidWebSearchAction(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.type === "search") {
    return typeof value.query === "string"
      && (!("sources" in value) || value.sources === null || (Array.isArray(value.sources)
        && value.sources.every(source => isPlainObject(source)
          && typeof source.type === "string" && typeof source.url === "string")));
  }
  if (value.type === "open_page") {
    return !("url" in value) || isNullableString(value.url);
  }
  if (value.type === "find" || value.type === "find_in_page") {
    return typeof value.url === "string" && typeof value.pattern === "string";
  }
  return false;
}

function isValidCodeInterpreterOutput(value: unknown): boolean {
  return isPlainObject(value)
    && ((value.type === "logs" && typeof value.logs === "string")
      || (value.type === "image" && typeof value.url === "string"));
}

/**
 * Validate the pre-field-backfill item carried by a real output_item.done.
 * Missing ids, message status, and output-text annotations are allowed because
 * the always-on field backfill safely supplies only those schema defaults.
 * Contradictory values and semantic content repairs are never accepted as
 * proof that an empty terminal snapshot was sparse.
 */
function trustedGrokCompletedItem(
  item: Record<string, unknown>,
): { visibleToGrok: boolean } | null {
  if (!hasValidOptionalId(item) || !hasCompletedStatusWhenPresent(item)) return null;

  if (item.type === "message") {
    if (item.role !== "assistant" || !Array.isArray(item.content)) return null;
    if (!(item.content as unknown[]).every(isValidOutputMessagePart)) return null;
    if ("phase" in item && item.phase !== "commentary" && item.phase !== "final_answer") return null;
    return {
      // grok-build currently turns only output_text parts into final Assistant
      // content; refusal parts do not satisfy its visible-content gate.
      visibleToGrok: item.content.some(part => isPlainObject(part)
        && part.type === "output_text" && typeof part.text === "string" && part.text.length > 0),
    };
  }

  if (item.type === "reasoning") {
    if (!Array.isArray(item.summary)
      || !item.summary.every(part => isValidReasoningPart(part, "summary_text"))) return null;
    if ("content" in item && item.content !== null
      && (!Array.isArray(item.content)
        || !item.content.every(part => isValidReasoningPart(part, "reasoning_text")))) return null;
    if ("encrypted_content" in item && !isNullableString(item.encrypted_content)) return null;
    return { visibleToGrok: false };
  }

  if (item.type === "function_call") {
    if (typeof item.call_id !== "string" || item.call_id.trim().length === 0
      || typeof item.name !== "string" || item.name.trim().length === 0
      || typeof item.arguments !== "string") return null;
    return { visibleToGrok: true };
  }

  if (item.type === "custom_tool_call") {
    if (typeof item.call_id !== "string" || item.call_id.trim().length === 0
      || typeof item.name !== "string" || item.name.trim().length === 0
      || typeof item.input !== "string") return null;
    return { visibleToGrok: false };
  }

  if (item.type === "web_search_call") {
    if (item.status !== "completed" || !isValidWebSearchAction(item.action)) return null;
    return { visibleToGrok: false };
  }

  if (item.type === "code_interpreter_call") {
    if (item.status !== "completed"
      || typeof item.container_id !== "string" || item.container_id.trim().length === 0
      || ("code" in item && !isNullableString(item.code))
      || ("outputs" in item && item.outputs !== null
        && (!Array.isArray(item.outputs) || !item.outputs.every(isValidCodeInterpreterOutput)))) return null;
    return { visibleToGrok: false };
  }

  if (item.type === "mcp_call") {
    if (typeof item.arguments !== "string"
      || typeof item.name !== "string" || item.name.trim().length === 0
      || typeof item.server_label !== "string" || item.server_label.trim().length === 0
      || ("approval_request_id" in item && !isNullableString(item.approval_request_id))
      || ("error" in item && !isNullableString(item.error))
      || ("output" in item && !isNullableString(item.output))) return null;
    return { visibleToGrok: false };
  }

  return null;
}

function plausibleGrokOpenItem(
  item: Record<string, unknown>,
): Omit<SparseTerminalOpenItem, "sourceBytes"> | null {
  const type = typeof item.type === "string" ? item.type : "";
  if (!GROK_TERMINAL_OUTPUT_ITEM_TYPES.has(type) || !hasValidOptionalId(item)) return null;
  if ("status" in item && item.status !== "in_progress") return null;
  if (type === "message") {
    if ("role" in item && item.role !== "assistant") return null;
    if ("content" in item && !Array.isArray(item.content)) return null;
  }
  return {
    type,
    ...(typeof item.id === "string" ? { id: item.id } : {}),
  };
}

/**
 * Narrow client repair for grok-build's Responses consumer.
 *
 * grok-build streams text deltas but builds its durable Assistant item only
 * from response.completed.response.output. Some native Responses streams put
 * the durable items in output_item.done and finish with a missing or explicit
 * empty output. Reconstruct only from real, unique, contiguous, bounded done
 * events whose raw semantics are already valid. Any ambiguity stays byte-level
 * fail-closed; the provider-opt-in snapshot repair above is unchanged.
 */
export function createGrokResponsesSparseTerminalBlockRewrite(
  budget?: TranslatorBudget,
): SseBlockRewrite {
  const openItems = new Map<number, SparseTerminalOpenItem>();
  const completedItems = new Map<number, SparseTerminalCompletedItem>();
  let aggregateItemBytes = 0;
  let aggregateOpenItemBytes = 0;
  let tainted = false;
  let hasVisibleOutput = false;

  const clearRetained = (): void => {
    const retainedBytes = aggregateItemBytes + aggregateOpenItemBytes;
    if (retainedBytes > 0) {
      budget?.releaseRetained(retainedBytes, { kind: "retained_collectors" });
    }
    openItems.clear();
    completedItems.clear();
    aggregateItemBytes = 0;
    aggregateOpenItemBytes = 0;
    hasVisibleOutput = false;
  };

  const reset = (): void => {
    clearRetained();
    tainted = false;
  };

  const taintAndRelease = (): void => {
    clearRetained();
    tainted = true;
  };

  const retainCompletedItem = (
    index: number,
    item: Record<string, unknown>,
    visibleToGrok: boolean,
  ): void => {
    if (tainted) return;
    const sourceBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (sourceBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES
      || completedItems.size >= MAX_COMPLETED_OUTPUT_ITEMS
      || aggregateItemBytes + sourceBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES) {
      taintAndRelease();
      return;
    }
    budget?.chargeRetained(sourceBytes, { kind: "retained_collectors" });
    completedItems.set(index, { item, sourceBytes, visibleToGrok });
    aggregateItemBytes += sourceBytes;
    hasVisibleOutput = hasVisibleOutput || visibleToGrok;
  };

  const closeOpenItem = (index: number): void => {
    const open = openItems.get(index);
    if (!open) return;
    openItems.delete(index);
    aggregateOpenItemBytes -= open.sourceBytes;
    budget?.releaseRetained(open.sourceBytes, { kind: "retained_collectors" });
  };

  const rewrite: SseBlockRewrite = (block: string): readonly string[] => {
    const payload = sseDataPayload(block);
    if (payload === null) return [block];
    if (payload === "[DONE]") {
      reset();
      return [block];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      taintAndRelease();
      return [block];
    }
    if (!isPlainObject(parsed) || typeof parsed.type !== "string") {
      taintAndRelease();
      return [block];
    }

    const type = parsed.type;
    const outputIndex = Number.isInteger(parsed.output_index) && (parsed.output_index as number) >= 0
      ? parsed.output_index as number
      : undefined;

    if (type === "response.output_item.added") {
      const open = isPlainObject(parsed.item) ? plausibleGrokOpenItem(parsed.item) : null;
      if (outputIndex === undefined || !open
        || openItems.has(outputIndex) || completedItems.has(outputIndex)
        || openItems.size >= MAX_COMPLETED_OUTPUT_ITEMS) {
        taintAndRelease();
      } else if (!tainted) {
        const sourceBytes = Buffer.byteLength(JSON.stringify(open), "utf8");
        if (sourceBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES
          || aggregateOpenItemBytes + sourceBytes > MAX_GROK_OPEN_ITEM_IDENTITY_BYTES) {
          taintAndRelease();
        } else {
          budget?.chargeRetained(sourceBytes, { kind: "retained_collectors" });
          openItems.set(outputIndex, { ...open, sourceBytes });
          aggregateOpenItemBytes += sourceBytes;
        }
      }
      return [block];
    }

    if (type === "response.output_item.done") {
      const item = isPlainObject(parsed.item) ? parsed.item : null;
      const proof = item ? trustedGrokCompletedItem(item) : null;
      if (outputIndex === undefined || !proof || completedItems.has(outputIndex)) {
        taintAndRelease();
        return [block];
      }
      const open = openItems.get(outputIndex);
      const doneId = typeof item!.id === "string" ? item!.id : undefined;
      if (open && (open.type !== item!.type || open.id !== doneId)) {
        taintAndRelease();
        return [block];
      }
      closeOpenItem(outputIndex);
      retainCompletedItem(outputIndex, item!, proof.visibleToGrok);
      return [block];
    }

    const isTerminal = type === "response.completed"
      || type === "response.failed"
      || type === "response.incomplete";
    if (!isTerminal) return [block];

    let out = block;
    if (type === "response.completed" && !tainted && isPlainObject(parsed.response)) {
      const response = parsed.response;
      const output = response.output;
      const terminalStatusConsistent = !("status" in response) || response.status === "completed";
      const outputIsAuthoritative = Array.isArray(output) && output.length > 0;
      const outputIsSparse = !("output" in response)
        || (Array.isArray(output) && output.length === 0);
      if (!outputIsAuthoritative && outputIsSparse && terminalStatusConsistent
        && completedItems.size > 0 && openItems.size === 0 && hasVisibleOutput) {
        const ordered = [...completedItems.entries()].sort(([left], [right]) => left - right);
        if (ordered.every(([index], position) => index === position)) {
          out = jsonBlock({
            ...parsed,
            response: { ...response, output: ordered.map(([, retained]) => retained.item) },
          });
        }
      }
    }
    reset();
    return [out];
  };

  rewrite.dispose = reset;
  return rewrite;
}

