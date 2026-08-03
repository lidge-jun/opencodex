import type { TranslatorBudget } from "../lib/translator-budget";
import {
  MAX_COMPLETED_OUTPUT_ITEMS,
  MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES,
} from "./relay";
import type { SsePayloadRewrite } from "./sse-payload-rewrite";

const RESPONSE_EVENT_STATUSES: Readonly<Record<string, string>> = {
  "response.created": "in_progress",
  "response.in_progress": "in_progress",
  "response.completed": "completed",
  "response.failed": "failed",
  "response.incomplete": "incomplete",
  "response.queued": "queued",
};

type RequestDefaults = {
  parallelToolCalls: boolean;
  toolChoice: unknown;
  tools: unknown[];
};

type RetainedOutputItem = {
  item: Record<string, unknown>;
  sourceBytes: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStructurallyValidToolChoice(value: unknown): boolean {
  return (typeof value === "string" && value.trim().length > 0)
    || (isPlainObject(value) && typeof value.type === "string" && value.type.trim().length > 0);
}

function requestDefaults(requestBody: unknown): RequestDefaults {
  const request = isPlainObject(requestBody) ? requestBody : {};
  return {
    parallelToolCalls: typeof request.parallel_tool_calls === "boolean"
      ? request.parallel_tool_calls
      : true,
    toolChoice: isStructurallyValidToolChoice(request.tool_choice) ? request.tool_choice : "auto",
    tools: Array.isArray(request.tools) ? request.tools : [],
  };
}

function repairOutputTextPart(part: Record<string, unknown>): Record<string, unknown> {
  if (part.type !== "output_text") return part;
  const needsText = typeof part.text !== "string";
  const needsAnnotations = !Array.isArray(part.annotations);
  if (!needsText && !needsAnnotations) return part;
  return {
    ...part,
    ...(needsText ? { text: "" } : {}),
    ...(needsAnnotations ? { annotations: [] } : {}),
  };
}

function repairSummaryPart(part: Record<string, unknown>): Record<string, unknown> {
  if (part.type !== "summary_text" || typeof part.text === "string") return part;
  return { ...part, text: "" };
}

function repairOutputItem(
  item: Record<string, unknown>,
  inferredStatus?: string,
): Record<string, unknown> {
  let repaired = item;
  let changed = false;

  if (item.type === "reasoning") {
    const rawSummary = item.summary;
    const summary = Array.isArray(rawSummary)
      ? rawSummary.map((part) => isPlainObject(part) ? repairSummaryPart(part) : part)
      : [];
    changed = !Array.isArray(rawSummary)
      || summary.some((part, index) => part !== rawSummary[index]);
    if (changed) repaired = { ...repaired, summary };
  } else if (item.type === "message") {
    const rawContent = item.content;
    const content = Array.isArray(rawContent)
      ? rawContent.map((part) => isPlainObject(part) ? repairOutputTextPart(part) : part)
      : [];
    changed = !Array.isArray(rawContent)
      || content.some((part, index) => part !== rawContent[index]);
    // Responses output-message roles are the literal "assistant"; input roles are invalid here.
    changed = changed || item.role !== "assistant";
    if (changed) repaired = { ...repaired, content, role: "assistant" };
  }

  if (inferredStatus && (typeof repaired.status !== "string" || repaired.status.trim().length === 0)) {
    repaired = { ...repaired, status: inferredStatus };
  }
  return repaired;
}

function repairResponseSnapshot(
  response: Record<string, unknown>,
  defaultStatus: string,
  defaults: RequestDefaults,
  reconstructedOutput?: Record<string, unknown>[],
): Record<string, unknown> {
  const repaired = { ...response };
  let changed = false;
  const outputStatus = defaultStatus === "completed" ? "completed" : undefined;

  if (reconstructedOutput) {
    repaired.output = reconstructedOutput;
    changed = true;
  } else if (Array.isArray(repaired.output)) {
    const output = repaired.output.map((item) => {
      if (!isPlainObject(item)) return item;
      const next = repairOutputItem(item, outputStatus);
      changed = changed || next !== item;
      return next;
    });
    if (changed) repaired.output = output;
  } else {
    repaired.output = [];
    changed = true;
  }
  if (typeof repaired.parallel_tool_calls !== "boolean") {
    repaired.parallel_tool_calls = defaults.parallelToolCalls;
    changed = true;
  }
  if (!isStructurallyValidToolChoice(repaired.tool_choice)) {
    repaired.tool_choice = defaults.toolChoice;
    changed = true;
  }
  if (!Array.isArray(repaired.tools)) {
    repaired.tools = defaults.tools;
    changed = true;
  }
  if (typeof repaired.status !== "string" || repaired.status.trim().length === 0) {
    repaired.status = defaultStatus;
    changed = true;
  }

  return changed ? repaired : response;
}

/**
 * Repair required fields omitted by a few Responses-compatible gateways across lifecycle events.
 * Existing upstream values remain authoritative; only absent or structurally invalid fields are
 * backfilled.
 */
export function createResponsesSnapshotPayloadRewrite(
  requestBody?: unknown,
  budget?: TranslatorBudget,
): SsePayloadRewrite {
  const defaults = requestDefaults(requestBody);
  const completedItems = new Map<number, RetainedOutputItem>();
  let aggregateItemBytes = 0;
  let reconstructionTainted = false;

  const clearCompletedItems = (): void => {
    if (aggregateItemBytes > 0) {
      budget?.releaseRetained(aggregateItemBytes, { kind: "retained_collectors" });
    }
    completedItems.clear();
    aggregateItemBytes = 0;
    reconstructionTainted = false;
  };

  const retainCompletedItem = (
    index: number,
    item: Record<string, unknown>,
    sourceBytes: number,
  ): void => {
    const previous = completedItems.get(index);
    if (sourceBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES) {
      if (previous) {
        completedItems.delete(index);
        aggregateItemBytes -= previous.sourceBytes;
        budget?.releaseRetained(previous.sourceBytes, { kind: "retained_collectors" });
      }
      reconstructionTainted = true;
      return;
    }
    const retainedDelta = sourceBytes - (previous?.sourceBytes ?? 0);
    if (retainedDelta > 0) {
      budget?.chargeRetained(retainedDelta, { kind: "retained_collectors" });
    } else if (retainedDelta < 0) {
      budget?.releaseRetained(-retainedDelta, { kind: "retained_collectors" });
    }
    completedItems.set(index, { item, sourceBytes });
    aggregateItemBytes += retainedDelta;
    while (completedItems.size > MAX_COMPLETED_OUTPUT_ITEMS
      || aggregateItemBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES) {
      let highestIndex = -1;
      for (const retainedIndex of completedItems.keys()) {
        if (retainedIndex > highestIndex) highestIndex = retainedIndex;
      }
      const evicted = completedItems.get(highestIndex);
      if (!evicted) break;
      completedItems.delete(highestIndex);
      aggregateItemBytes -= evicted.sourceBytes;
      budget?.releaseRetained(evicted.sourceBytes, { kind: "retained_collectors" });
      reconstructionTainted = true;
    }
  };

  return (payload: string): string => {
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return payload;
    }
    if (!isPlainObject(event)) return payload;
    const type = typeof event.type === "string" ? event.type : "";
    let nextEvent = event;
    let changed = false;

    if (type === "response.output_item.done" && !isPlainObject(event.item)) {
      reconstructionTainted = true;
    }

    if ((type === "response.output_item.added" || type === "response.output_item.done")
      && isPlainObject(event.item)) {
      const itemStatus = type === "response.output_item.done" ? "completed" : "in_progress";
      const item = repairOutputItem(event.item, itemStatus);
      if (item !== event.item) {
        nextEvent = { ...nextEvent, item };
        changed = true;
      }
      if (type === "response.output_item.done") {
        if (Number.isInteger(event.output_index)
          && (event.output_index as number) >= 0
          && typeof item.type === "string") {
          retainCompletedItem(
            event.output_index as number,
            item,
            Buffer.byteLength(JSON.stringify(item), "utf8"),
          );
        } else {
          reconstructionTainted = true;
        }
      }
    }

    const responseStatus = Object.prototype.hasOwnProperty.call(RESPONSE_EVENT_STATUSES, type)
      ? RESPONSE_EVENT_STATUSES[type]
      : undefined;
    if (responseStatus && isPlainObject(event.response)) {
      const hasAuthoritativeOutput = Array.isArray(event.response.output)
        && event.response.output.length > 0;
      let reconstructedOutput: Record<string, unknown>[] | undefined;
      if ((type === "response.completed" || type === "response.incomplete")
        && !hasAuthoritativeOutput
        && !reconstructionTainted
        && completedItems.size > 0) {
        const orderedItems = [...completedItems.entries()]
          .sort(([left], [right]) => left - right);
        if (orderedItems.every(([index], position) => index === position)) {
          reconstructedOutput = orderedItems.map(([, retained]) => retained.item);
        } else {
          // A gap means at least one completed item is missing. Never compact later indexes into a
          // shorter array that appears complete to persistence or the client.
          reconstructionTainted = true;
        }
      }
      const response = repairResponseSnapshot(
        event.response,
        responseStatus,
        defaults,
        reconstructedOutput,
      );
      if (response !== event.response) {
        nextEvent = { ...nextEvent, response };
        changed = true;
      }
    }

    const clearsCompletedItems = type === "response.completed"
      || type === "response.failed"
      || type === "response.incomplete";

    if ((type === "response.content_part.added" || type === "response.content_part.done")
      && isPlainObject(event.part)) {
      const part = repairOutputTextPart(event.part);
      if (part !== event.part) {
        nextEvent = { ...nextEvent, part };
        changed = true;
      }
    }

    if ((type === "response.reasoning_summary_part.added"
      || type === "response.reasoning_summary_part.done") && isPlainObject(event.part)) {
      const part = repairSummaryPart(event.part);
      if (part !== event.part) {
        nextEvent = { ...nextEvent, part };
        changed = true;
      }
    }

    if ((type === "response.output_text.delta" || type === "response.output_text.done")
      && !Array.isArray(event.logprobs)) {
      nextEvent = { ...nextEvent, logprobs: [] };
      changed = true;
    }
    if (type === "response.output_text.done" && typeof event.text !== "string") {
      nextEvent = { ...nextEvent, text: "" };
      changed = true;
    }

    const result = changed ? JSON.stringify(nextEvent) : payload;
    if (clearsCompletedItems) clearCompletedItems();
    return result;
  };
}

/** Repair a non-streaming Responses JSON object without changing raw inspection state. */
export function repairResponsesSnapshotJson(payload: string, requestBody?: unknown): string {
  let response: unknown;
  try {
    response = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!isPlainObject(response)) return payload;
  const repaired = repairResponseSnapshot(response, "completed", requestDefaults(requestBody));
  return repaired === response ? payload : JSON.stringify(repaired);
}

export function hasResponsesSnapshotRepair(enabled: boolean | undefined): enabled is true {
  return enabled === true;
}
