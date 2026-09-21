/** Strict terminal reconstruction selected by the Grok compatibility marker. */
import type { TranslatorBudget } from "../lib/translator-budget";
import { MAX_COMPLETED_OUTPUT_ITEMS, MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES } from "./relay";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";
import { isPlainObject, jsonBlock, type RetainedOutputItem } from "./responses-snapshot-codec";
import {
  requestToolScope,
  type RequestToolScope,
  type RequestToolScopeCorrespondence,
} from "./responses-request-tool-scope";

type SparseTerminalOpenItem = {
  type: string;
  id?: string;
  sourceBytes: number;
};

type SparseTerminalCompletedItem = RetainedOutputItem & {
  visibleToGrok: boolean;
};

const MAX_GROK_OPEN_ITEM_IDENTITY_BYTES = MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES;

/** Terminal event this repair publishes when it refused to reconstruct a call faithfully. */
export const GROK_REFUSED_TERMINAL_EVENT_TYPE = "response.incomplete";

/** `incomplete_details.reason` carried by that terminal. */
export const GROK_FORBIDDEN_TOOL_CALL_REASON = "forbidden_tool_call";

/** An upstream-supplied name reaches the terminal message; keep it bounded. */
const MAX_REPORTED_TOOL_NAME_CHARS = 100;

export function forbiddenToolCallMessage(name: string): string {
  return `routed provider called "${name.slice(0, MAX_REPORTED_TOOL_NAME_CHARS)}", `
    + "which this request's tool selection excludes; the reconstructed output omits that call";
}

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
 * Publish the refusal on the terminal itself rather than as a silent omission.
 *
 * The ordinary reconstruction replaces only the data payload's `output`, so its event name still
 * describes the payload. A refusal does not: the turn no longer completed the way the upstream
 * said it did, so the event line moves with the status instead of leaving a client to read a
 * clean finish off an unchanged `event: response.completed`.
 */
function refusedTerminalBlock(
  block: string,
  parsed: Record<string, unknown>,
  response: Record<string, unknown>,
  output: readonly Record<string, unknown>[],
  refusedName: string | undefined,
): string {
  const payload = JSON.stringify({
    ...parsed,
    type: GROK_REFUSED_TERMINAL_EVENT_TYPE,
    response: {
      ...response,
      status: "incomplete",
      output,
      incomplete_details: {
        reason: GROK_FORBIDDEN_TOOL_CALL_REASON,
        ...(refusedName === undefined ? {} : { message: forbiddenToolCallMessage(refusedName) }),
      },
    },
  });
  const rewritten = replaceSseDataPayload(block, payload);
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  let eventRewritten = false;
  const lines = rewritten.split(/\r?\n/).map(line => {
    if (eventRewritten || !line.startsWith("event:")) return line;
    eventRewritten = true;
    return `event: ${GROK_REFUSED_TERMINAL_EVENT_TYPE}`;
  });
  return lines.join(newline);
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
 *
 * The terminal this publishes is one the upstream never sent, so it carries only what the final
 * outbound request still authorized. A client call outside that request's tool selection is left
 * out and the terminal says so explicitly. The declaration guard downstream answers the other
 * half of the question — whether a name was declared at all — and keeps policing the raw stream,
 * which this rewrite never edits.
 */
export function createGrokResponsesSparseTerminalBlockRewrite(
  budget?: TranslatorBudget,
  outboundRequestBody?: unknown,
  toolIdentityCorrespondence?: RequestToolScopeCorrespondence,
): SseBlockRewrite {
  const toolScope: RequestToolScope | undefined = requestToolScope(
    outboundRequestBody,
    toolIdentityCorrespondence,
  );
  const openItems = new Map<number, SparseTerminalOpenItem>();
  const completedItems = new Map<number, SparseTerminalCompletedItem>();
  const withheldIndices = new Set<number>();
  let withheldToolName: string | undefined;
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
    withheldIndices.clear();
    withheldToolName = undefined;
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
      || completedItems.size + withheldIndices.size >= MAX_COMPLETED_OUTPUT_ITEMS
      || aggregateItemBytes + sourceBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES) {
      taintAndRelease();
      return;
    }
    budget?.chargeRetained(sourceBytes, { kind: "retained_collectors" });
    completedItems.set(index, { item, sourceBytes, visibleToGrok });
    aggregateItemBytes += sourceBytes;
    hasVisibleOutput = hasVisibleOutput || visibleToGrok;
  };

  /**
   * Record the position of a call this request forbade without retaining the item.
   *
   * Only the offending item is dropped. Tainting here instead would discard the assistant text
   * that arrived in the same turn and leave the client the empty terminal this repair exists to
   * fix, which punishes the caller for the provider's overreach. The index is kept so the
   * contiguity proof below still covers the whole output.
   */
  const withholdForbiddenCall = (index: number, name: string): void => {
    if (tainted) return;
    if (completedItems.size + withheldIndices.size >= MAX_COMPLETED_OUTPUT_ITEMS) {
      taintAndRelease();
      return;
    }
    withheldIndices.add(index);
    withheldToolName ??= name.slice(0, MAX_REPORTED_TOOL_NAME_CHARS);
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
        || withheldIndices.has(outputIndex)
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
      if (outputIndex === undefined || !proof
        || completedItems.has(outputIndex) || withheldIndices.has(outputIndex)) {
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
      const forbidden = toolScope?.forbiddenClientToolCallName(item!);
      if (forbidden === undefined) {
        retainCompletedItem(outputIndex, item!, proof.visibleToGrok);
      } else {
        withholdForbiddenCall(outputIndex, forbidden);
      }
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
      // A withheld call is a reason to publish on its own: the refusal has to reach the client
      // even when nothing visible survived it, or the turn ends as an ordinary empty finish.
      const refused = withheldIndices.size > 0;
      if (!outputIsAuthoritative && outputIsSparse && terminalStatusConsistent
        && openItems.size === 0 && (hasVisibleOutput || refused)) {
        const ordered = [...completedItems.entries()].sort(([left], [right]) => left - right);
        const positions = [...completedItems.keys(), ...withheldIndices].sort((left, right) => left - right);
        if (positions.length > 0 && positions.every((index, position) => index === position)) {
          const rebuilt = ordered.map(([, retained]) => retained.item);
          out = refused
            ? refusedTerminalBlock(block, parsed, response, rebuilt, withheldToolName)
            : jsonBlock({ ...parsed, response: { ...response, output: rebuilt } });
        }
      }
    }
    reset();
    return [out];
  };

  rewrite.dispose = reset;
  return rewrite;
}
