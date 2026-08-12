/**
 * Provider-opt-in repair for Responses-compatible gateways that return sparse
 * lifecycle snapshots (#893): field backfills for missing canonical fields,
 * AND lifecycle event injection so Codex clients actually commit the turn.
 *
 * Field-repair semantics (snapshot fields, item/part backfills, retention
 * bounds) are adopted from PR #928 (0xWinner98) with attribution. The
 * lifecycle-completion layer is new: #928's exact-issue test expects no
 * `output_item.done` and a terminal `output: []` — normalization without
 * commitment, which the canonical bridge contract (src/bridge.ts) shows is
 * not enough for Codex to commit the message.
 *
 * Design:
 * - One stateful tracker per stream. Existing upstream values are always
 *   authoritative; only absent or structurally invalid fields are backfilled.
 * - Event injection happens only for items PROVEN open at a terminal event
 *   (never for content the gateway closed itself).
 * - Ambiguous, gapped, malformed, oversized, or contradictory shapes taint
 *   the tracker: no injections and no output reconstruction afterwards
 *   (fail closed; explicit `output: []` from the gateway stays authoritative).
 */

import type { TranslatorBudget } from "../lib/translator-budget";
import {
  MAX_COMPLETED_OUTPUT_ITEMS,
  MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES,
} from "./relay";
import { sseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";

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
  const effectiveResponseStatus = typeof response.status === "string" && response.status.trim().length > 0
    ? response.status
    : defaultStatus;
  const outputStatus = effectiveResponseStatus === "completed" || effectiveResponseStatus === "incomplete"
    ? effectiveResponseStatus
    : undefined;

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

type OpenItem = {
  itemId: string;
  outputIndex: number;
  type: string;
  /** Message/reasoning items get lifecycle injections; other types never do. */
  injectable: boolean;
  /** The gateway opened a content part explicitly (or we injected one). */
  contentPartOpen: boolean;
  /** The gateway sent output_text.done for this item. */
  textDone: boolean;
  /** The gateway sent content_part.done for this item. */
  partDone: boolean;
  text: string;
  item: Record<string, unknown>;
};

/** Open-item retention bounds (#893 review): aggregate, not just per-item. */
const MAX_OPEN_ITEMS = MAX_COMPLETED_OUTPUT_ITEMS;
const MAX_OPEN_ITEM_AGGREGATE_TEXT_BYTES = MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES;

type RetainedOutputItem = {
  item: Record<string, unknown>;
  sourceBytes: number;
};

function jsonBlock(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}`;
}

/**
 * Stateful block rewrite: field backfills + lifecycle completion injection.
 * `budget` bounds retained completed items (reconstruction only).
 */
export function createResponsesSnapshotBlockRewrite(
  requestBody?: unknown,
  budget?: TranslatorBudget,
): SseBlockRewrite {
  const defaults = requestDefaults(requestBody);
  const openItems = new Map<number, OpenItem>();
  const completedItems = new Map<number, RetainedOutputItem>();
  let aggregateItemBytes = 0;
  let aggregateOpenTextBytes = 0;
  let tainted = false;

  const releaseRetained = (): void => {
    if (aggregateItemBytes > 0) {
      budget?.releaseRetained(aggregateItemBytes, { kind: "retained_collectors" });
    }
    completedItems.clear();
    openItems.clear();
    aggregateItemBytes = 0;
    aggregateOpenTextBytes = 0;
    tainted = false;
  };

  const taintAndRelease = (): void => {
    // Fail closed means stop RETAINING too: open state and charged collectors
    // are released immediately, and no further state accumulates (#893 review).
    if (aggregateItemBytes > 0) {
      budget?.releaseRetained(aggregateItemBytes, { kind: "retained_collectors" });
    }
    completedItems.clear();
    openItems.clear();
    aggregateItemBytes = 0;
    aggregateOpenTextBytes = 0;
    tainted = true;
  };

  /** Drop one open item and refund its accumulated text from the aggregate. */
  const closeOpenItem = (index: number): void => {
    const open = openItems.get(index);
    if (!open) return;
    aggregateOpenTextBytes -= Buffer.byteLength(open.text, "utf8");
    openItems.delete(index);
  };

  const retainCompletedItem = (index: number, item: Record<string, unknown>): void => {
    if (tainted) return; // fail closed means stop retaining (#893 review)
    const sourceBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    const previous = completedItems.get(index);
    if (sourceBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES) {
      if (previous) {
        completedItems.delete(index);
        aggregateItemBytes -= previous.sourceBytes;
        budget?.releaseRetained(previous.sourceBytes, { kind: "retained_collectors" });
      }
      taintAndRelease();
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
      taintAndRelease();
      return;
    }
  };

  const completedItemSnapshot = (open: OpenItem): Record<string, unknown> => {
    if (open.type === "message") {
      return repairOutputItem({
        ...open.item,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: open.text, annotations: [] }],
      }, "completed");
    }
    return repairOutputItem({ ...open.item, status: "completed" }, "completed");
  };

  const rewrite: SseBlockRewrite = (block: string): readonly string[] => {
    const payload = sseDataPayload(block);
    if (payload === null) return [block];
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return [block];
    }
    if (!isPlainObject(event)) return [block];
    const type = typeof event.type === "string" ? event.type : "";
    let nextEvent: Record<string, unknown> = event;
    let changed = false;
    const outputIndex = Number.isInteger(event.output_index) && (event.output_index as number) >= 0
      ? event.output_index as number
      : undefined;
    const itemId = typeof event.item_id === "string" ? event.item_id : undefined;

    // --- item lifecycle tracking + field backfills -------------------------
    if (type === "response.output_item.added" && isPlainObject(event.item)) {
      const itemType = typeof event.item.type === "string" ? event.item.type : "";
      const id = typeof event.item.id === "string" ? event.item.id : undefined;
      if (outputIndex === undefined || !id) {
        taintAndRelease();
      } else {
        if (openItems.has(outputIndex)) taintAndRelease(); // contradictory reuse of an open index
        if (openItems.size >= MAX_OPEN_ITEMS) taintAndRelease(); // aggregate retention bound
        // Unsupported types (function_call, …) reserve their index but are
        // never injected — a sparse gateway that leaves one open blocks only
        // the terminal reconstruction, not message repair (#893 review).
        const injectable = itemType === "message" || itemType === "reasoning";
        if (!tainted) {
        openItems.set(outputIndex, {
          itemId: id,
          outputIndex,
          type: itemType,
          injectable,
          contentPartOpen: false,
          textDone: false,
          partDone: false,
          text: "",
          item: event.item,
        });
        }
      }
      const item = repairOutputItem(event.item, "in_progress");
      if (item !== event.item) {
        nextEvent = { ...nextEvent, item };
        changed = true;
      }
    }

    if (type === "response.output_item.done" && !isPlainObject(event.item)) {
      taintAndRelease();
    }

    if (type === "response.output_item.done" && isPlainObject(event.item)) {
      const item = repairOutputItem(event.item, "completed");
      if (item !== event.item) {
        nextEvent = { ...nextEvent, item };
        changed = true;
      }
      // Identity correlation: a done event only closes the tracked item when
      // id AND type agree — a mismatched done is a contradictory stream and
      // must go fail-closed rather than close/reconstruct the wrong item.
      const tracked = outputIndex !== undefined ? openItems.get(outputIndex) : undefined;
      const doneId = typeof event.item.id === "string" ? event.item.id : undefined;
      const doneType = typeof event.item.type === "string" ? event.item.type : undefined;
      if (tracked && (doneId !== tracked.itemId || doneType !== tracked.type)) {
        taintAndRelease();
        return [changed ? jsonBlock(nextEvent) : block];
      }
      if (outputIndex !== undefined && typeof item.type === "string" && item.type.trim().length > 0) {
        closeOpenItem(outputIndex);
        retainCompletedItem(outputIndex, item);
      } else {
        taintAndRelease();
      }
    }

    if ((type === "response.content_part.added" || type === "response.content_part.done")
      && isPlainObject(event.part)) {
      if (outputIndex !== undefined) {
        const open = openItems.get(outputIndex);
        // A PRESENT-but-mismatched item_id is contradictory lifecycle evidence,
        // exactly like output_item.done and output_text.done: the stream is
        // telling us our identity model for this index is wrong. Merely
        // ignoring it left the item open and let the terminal fabricate a full
        // closure sequence (content_part.added → output_text.done →
        // content_part.done → output_item.done) on top of a stream we do not
        // understand. Go fail-closed instead. An OMITTED item_id stays
        // legitimate and is still correlated by output_index.
        if (open && itemId !== undefined && itemId !== open.itemId) {
          taintAndRelease();
          return [changed ? jsonBlock(nextEvent) : block];
        }
        // Correlate by item_id when present: a mismatched event must not
        // mutate (or suppress injections for) the tracked item (#893 review).
        if (open && (itemId === undefined || itemId === open.itemId)) {
          if (type === "response.content_part.added") open.contentPartOpen = true;
          else open.partDone = true;
        }
      }
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
    if (type === "response.output_text.delta" && typeof event.delta === "string" && outputIndex !== undefined) {
      const open = openItems.get(outputIndex);
      // Same identity contract as the *.done terminals: a present-but-foreign
      // item_id on a tracked index means our model of this index is wrong, and
      // reconstructing from the text we DID accept would ship a message the
      // upstream never assembled that way.
      if (open && itemId !== undefined && itemId !== open.itemId) {
        taintAndRelease();
        return [changed ? jsonBlock(nextEvent) : block];
      }
      if (open && (itemId === undefined || itemId === open.itemId)) {
        const deltaBytes = Buffer.byteLength(event.delta, "utf8");
        open.text += event.delta;
        aggregateOpenTextBytes += deltaBytes;
        // Unbounded text accumulation is a retention hole (#893 review):
        // overshoot per-item or aggregate caps and the stream goes fail-closed.
        if (Buffer.byteLength(open.text, "utf8") > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES
          || aggregateOpenTextBytes > MAX_OPEN_ITEM_AGGREGATE_TEXT_BYTES) {
          taintAndRelease();
        }
      }
    }
    if (type === "response.output_text.done") {
      if (outputIndex !== undefined) {
        const open = openItems.get(outputIndex);
        // Identity correlation, same contract as output_item.done above: a
        // text-done carrying a DIFFERENT item_id for a tracked index is a
        // contradictory stream. Silently ignoring it used to leave the item
        // open, so the terminal then synthesized a second output_text.done and
        // output_item.done — a double close built on a stream we do not
        // understand (#1025 review blocker 2). Go fail-closed instead: forward
        // the block untouched and stop injecting for the rest of the stream.
        if (open && itemId !== undefined && itemId !== open.itemId) {
          taintAndRelease();
          return [changed ? jsonBlock(nextEvent) : block];
        }
        if (open && (itemId === undefined || itemId === open.itemId)) {
          open.textDone = true;
          if (typeof event.text === "string") {
            // Replacement must keep the aggregate honest and bounded, the
            // same as delta accumulation (#893 review).
            const previousBytes = Buffer.byteLength(open.text, "utf8");
            const nextBytes = Buffer.byteLength(event.text, "utf8");
            open.text = event.text;
            aggregateOpenTextBytes += nextBytes - previousBytes;
            if (nextBytes > MAX_COMPLETED_OUTPUT_ITEM_SOURCE_BYTES
              || aggregateOpenTextBytes > MAX_OPEN_ITEM_AGGREGATE_TEXT_BYTES) {
              taintAndRelease();
            }
          }
        }
      }
      if (typeof event.text !== "string") {
        nextEvent = { ...nextEvent, text: "" };
        changed = true;
      }
    }

    // --- lifecycle response snapshots --------------------------------------
    const responseStatus = Object.prototype.hasOwnProperty.call(RESPONSE_EVENT_STATUSES, type)
      ? RESPONSE_EVENT_STATUSES[type]
      : undefined;
    const isTerminal = type === "response.completed"
      || type === "response.failed"
      || type === "response.incomplete";

    if (responseStatus && isPlainObject(event.response)) {
      // Terminal output reconstruction stays in the injection layer below;
      // here the snapshot only gets field backfills.
      const response = repairResponseSnapshot(event.response, responseStatus, defaults);
      if (response !== event.response) {
        nextEvent = { ...nextEvent, response };
        changed = true;
      }
    }

    // --- lifecycle completion injection ------------------------------------
    // Only response.completed justifies synthesized closing events: a failed
    // or incomplete terminal must never fabricate completed output (#893 review).
    const isCompletedTerminal = type === "response.completed";
    const out: string[] = [];
    if (!tainted) {
      // A text delta for an item whose content part was never opened needs the
      // opening event first, or Codex never binds the text to a committed part.
      if (type === "response.output_text.delta" && outputIndex !== undefined) {
        const open = openItems.get(outputIndex);
        if (open && open.type === "message" && !open.contentPartOpen) {
          out.push(jsonBlock({
            type: "response.content_part.added",
            item_id: open.itemId,
            output_index: open.outputIndex,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }));
          open.contentPartOpen = true;
        }
      }

      if (isCompletedTerminal && openItems.size > 0) {
        const closing = [...openItems.values()].sort((a, b) => a.outputIndex - b.outputIndex);
        for (const open of closing) {
          if (open.injectable && open.type === "message") {
            if (!open.contentPartOpen) {
              out.push(jsonBlock({
                type: "response.content_part.added",
                item_id: open.itemId,
                output_index: open.outputIndex,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              }));
              open.contentPartOpen = true;
            }
            if (!open.textDone) {
              out.push(jsonBlock({
                type: "response.output_text.done",
                item_id: open.itemId,
                output_index: open.outputIndex,
                content_index: 0,
                logprobs: [],
                text: open.text,
              }));
              open.textDone = true;
            }
            if (!open.partDone) {
              out.push(jsonBlock({
                type: "response.content_part.done",
                item_id: open.itemId,
                output_index: open.outputIndex,
                content_index: 0,
                part: { type: "output_text", text: open.text, annotations: [] },
              }));
              open.partDone = true;
            }
          }
          if (!open.injectable) continue; // never fabricate completions for other types
          const snapshot = completedItemSnapshot(open);
          out.push(jsonBlock({
            type: "response.output_item.done",
            output_index: open.outputIndex,
            item: snapshot,
          }));
          closeOpenItem(open.outputIndex);
          retainCompletedItem(open.outputIndex, snapshot);
        }
      }
    }

    // Terminal output reconstruction/canonical backfill: an explicit
    // `output: []` is authoritative; absent or malformed output on a
    // completed terminal becomes the retained items or the canonical empty
    // list (#893 review). Leftover non-injectable open items block
    // reconstruction only, not the message closing above.
    if (isCompletedTerminal && !tainted && isPlainObject(nextEvent.response)) {
      const response = nextEvent.response;
      const outputValue = (response as Record<string, unknown>).output;
      const outputExplicitArray = Array.isArray(outputValue);
      if (!outputExplicitArray) {
        const injectableOpen = [...openItems.values()].filter(open => open.injectable);
        const nonInjectableOpen = [...openItems.values()].filter(open => !open.injectable);
        if (completedItems.size > 0 && injectableOpen.length === 0 && nonInjectableOpen.length === 0) {
          const ordered = [...completedItems.entries()].sort(([left], [right]) => left - right);
          if (ordered.every(([index], position) => index === position)) {
            nextEvent = {
              ...nextEvent,
              response: { ...response, output: ordered.map(([, retained]) => retained.item) },
            };
            changed = true;
          } else {
            // A gap means at least one completed item is missing. Never compact
            // later indexes into a shorter array that only appears complete.
            tainted = true;
          }
        } else if (completedItems.size === 0 && openItems.size === 0) {
          nextEvent = { ...nextEvent, response: { ...response, output: [] } };
          changed = true;
        }
      }
    }

    out.push(changed ? jsonBlock(nextEvent) : block);
    if (isTerminal) releaseRetained();
    return out;
  };
  // Relays call this on every teardown path (terminal, EOF, cancel, error):
  // retained collectors and open-item state never outlive the stream.
  rewrite.dispose = releaseRetained;
  return rewrite;
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
  // Canonical output for non-stream completed responses: absent or malformed
  // output becomes the canonical empty list; explicit arrays stay authoritative.
  if (!Array.isArray(response.output)) {
    const repaired = repairResponseSnapshot({ ...response, output: [] }, "completed", requestDefaults(requestBody));
    return JSON.stringify(repaired);
  }
  const repaired = repairResponseSnapshot(response, "completed", requestDefaults(requestBody));
  return repaired === response ? payload : JSON.stringify(repaired);
}

export function hasResponsesSnapshotRepair(enabled: boolean | undefined): enabled is true {
  return enabled === true;
}
