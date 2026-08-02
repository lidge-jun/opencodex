import type { SsePayloadRewrite } from "./sse-payload-rewrite";

const RESPONSE_EVENT_STATUSES: Readonly<Record<string, string>> = {
  "response.created": "in_progress",
  "response.in_progress": "in_progress",
  "response.completed": "completed",
  "response.failed": "failed",
  "response.incomplete": "incomplete",
  "response.queued": "queued",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function repairOutputTextPart(part: Record<string, unknown>): Record<string, unknown> {
  if (part.type !== "output_text" || Array.isArray(part.annotations)) return part;
  return { ...part, annotations: [] };
}

function repairSummaryPart(part: Record<string, unknown>): Record<string, unknown> {
  if (part.type !== "summary_text" || typeof part.text === "string") return part;
  return { ...part, text: "" };
}

function repairOutputItem(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type === "reasoning") {
    return Array.isArray(item.summary) ? item : { ...item, summary: [] };
  }
  if (item.type !== "message") return item;

  let changed = false;
  const content = Array.isArray(item.content)
    ? item.content.map((part) => {
      if (!isPlainObject(part)) return part;
      const repaired = repairOutputTextPart(part);
      changed = changed || repaired !== part;
      return repaired;
    })
    : [];
  changed = changed || !Array.isArray(item.content);
  const role = item.role === "assistant" ? item.role : "assistant";
  changed = changed || role !== item.role;
  return changed ? { ...item, content, role } : item;
}

function repairResponseSnapshot(
  response: Record<string, unknown>,
  defaultStatus: string,
): Record<string, unknown> {
  const repaired = { ...response };
  let changed = false;

  if (Array.isArray(repaired.output)) {
    const output = repaired.output.map((item) => {
      if (!isPlainObject(item)) return item;
      const next = repairOutputItem(item);
      changed = changed || next !== item;
      return next;
    });
    if (changed) repaired.output = output;
  } else {
    repaired.output = [];
    changed = true;
  }
  if (typeof repaired.parallel_tool_calls !== "boolean") {
    repaired.parallel_tool_calls = true;
    changed = true;
  }
  if (repaired.tool_choice === undefined || repaired.tool_choice === null) {
    repaired.tool_choice = "auto";
    changed = true;
  }
  if (!Array.isArray(repaired.tools)) {
    repaired.tools = [];
    changed = true;
  }
  if (typeof repaired.status !== "string") {
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
export function createResponsesSnapshotPayloadRewrite(): SsePayloadRewrite {
  return (payload) => {
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

    const responseStatus = RESPONSE_EVENT_STATUSES[type];
    if (responseStatus && isPlainObject(event.response)) {
      const response = repairResponseSnapshot(event.response, responseStatus);
      if (response !== event.response) {
        nextEvent = { ...nextEvent, response };
        changed = true;
      }
    }

    if ((type === "response.output_item.added" || type === "response.output_item.done")
      && isPlainObject(event.item)) {
      const item = repairOutputItem(event.item);
      if (item !== event.item) {
        nextEvent = { ...nextEvent, item };
        changed = true;
      }
    }

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

    return changed ? JSON.stringify(nextEvent) : payload;
  };
}

export function hasResponsesSnapshotRepair(enabled: boolean | undefined): enabled is true {
  return enabled === true;
}
