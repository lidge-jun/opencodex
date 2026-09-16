import type { AdapterEvent } from "../../types";

/** Error code for a CodeBuddy turn whose output contains vendor agent scaffolding. */
export const CODEBUDDY_SCAFFOLD_ERROR_CODE = "vendor_scaffold_detected";

// The observed control protocol uses FULLWIDTH VERTICAL LINE (U+FF5C). Detection stays
// deliberately narrower than the marker spelling: a calls control line must be followed by an
// invoke line for a functions.* tool. That distinguishes an agent scaffold from prose quoting or
// discussing one tag.
const DSML_CALLS_LINE = "<｜｜dsml｜｜ calls>";
const DSML_INVOKE_PREFIX = "<｜｜dsml｜｜ invoke name=\"functions.";

export interface CodeBuddyScaffoldFilterResult {
  /** Bytes released from a suffix withheld by an earlier event on this channel. */
  releasedPending: string;
  /** Safe bytes belonging to the event currently being processed. */
  text: string;
  /** The earlier pending event still owns the extended candidate. */
  pendingContinues: boolean;
  fail: boolean;
}

interface ScanResult {
  safe: string;
  held: string;
  fail: boolean;
  fence: "`" | "~" | null;
  lineStart: boolean;
}

function prefixAtEnd(text: string, at: number, expected: string): boolean {
  const rest = text.slice(at).toLowerCase();
  return rest.length < expected.length && expected.startsWith(rest);
}

/**
 * Scan complete bytes and retain only a bounded suffix that can still become a control sequence.
 *
 * Control tags are recognized only at column zero and outside fenced Markdown. Inline code,
 * quoted strings, blockquotes, indented source, and prose all add syntax before the tag and are
 * therefore forwarded unchanged. A calls line alone is harmless; refusal requires the observed
 * two-line calls-plus-functions-invoke grammar.
 */
function scan(
  text: string,
  initialFence: "`" | "~" | null,
  initialLineStart: boolean,
): ScanResult {
  let fence = initialFence;
  let lineStart = initialLineStart;
  let index = 0;

  while (index < text.length) {
    if (lineStart) {
      const fenceMarkers = fence ? [fence.repeat(3)] : ["```", "~~~"];
      const completeFence = fenceMarkers.find(marker => text.startsWith(marker, index));
      if (completeFence) {
        fence = fence ? null : (completeFence[0] as "`" | "~");
        index += completeFence.length;
        lineStart = false;
        continue;
      }
      if (fenceMarkers.some(marker => prefixAtEnd(text, index, marker))) {
        return { safe: text.slice(0, index), held: text.slice(index), fail: false, fence, lineStart };
      }

      if (!fence) {
        const lowered = text.slice(index).toLowerCase();
        if (lowered.startsWith(DSML_CALLS_LINE)) {
          const afterCalls = index + DSML_CALLS_LINE.length;
          let invokeAt = -1;
          if (text[afterCalls] === "\n") invokeAt = afterCalls + 1;
          else if (text[afterCalls] === "\r" && text[afterCalls + 1] === "\n") invokeAt = afterCalls + 2;
          else if (afterCalls === text.length || (text[afterCalls] === "\r" && afterCalls + 1 === text.length)) {
            return { safe: text.slice(0, index), held: text.slice(index), fail: false, fence, lineStart };
          }

          if (invokeAt >= 0) {
            const invokeRest = text.slice(invokeAt).toLowerCase();
            if (invokeRest.startsWith(DSML_INVOKE_PREFIX)) {
              return { safe: text.slice(0, index), held: "", fail: true, fence, lineStart };
            }
            if (invokeRest.length === 0 || DSML_INVOKE_PREFIX.startsWith(invokeRest)) {
              return { safe: text.slice(0, index), held: text.slice(index), fail: false, fence, lineStart };
            }
          }
        } else if (prefixAtEnd(text, index, DSML_CALLS_LINE)) {
          return { safe: text.slice(0, index), held: text.slice(index), fail: false, fence, lineStart };
        }
      }
    }

    const char = text[index]!;
    index += 1;
    lineStart = char === "\n";
  }

  return { safe: text, held: "", fail: false, fence, lineStart };
}

/** Streaming DSML control-sequence filter for one text or reasoning channel. */
export class CodeBuddyScaffoldFilter {
  private pending = "";
  private failed = false;
  private fence: "`" | "~" | null = null;
  private lineStart = true;

  /** True while an earlier event owns an unresolved marker or fence prefix. */
  hasPending(): boolean {
    return this.pending.length > 0;
  }

  push(chunk: string): CodeBuddyScaffoldFilterResult {
    if (this.failed) {
      return { releasedPending: "", text: "", pendingContinues: false, fail: false };
    }
    if (!chunk) {
      return {
        releasedPending: "",
        text: "",
        pendingContinues: this.hasPending(),
        fail: false,
      };
    }

    const priorPending = this.pending;
    const result = scan(priorPending + chunk, this.fence, this.lineStart);
    this.pending = result.held;
    this.fence = result.fence;
    this.lineStart = result.lineStart;
    this.failed = result.fail;

    const releasedLength = Math.min(priorPending.length, result.safe.length);
    return {
      releasedPending: result.safe.slice(0, releasedLength),
      text: result.safe.slice(releasedLength),
      pendingContinues: priorPending.length > 0 && result.safe.length === 0 && result.held.length > 0,
      fail: result.fail,
    };
  }

  /** Release a suffix that never completed the two-line control grammar. */
  flush(): CodeBuddyScaffoldFilterResult {
    if (this.failed) {
      return { releasedPending: "", text: "", pendingContinues: false, fail: false };
    }
    const text = this.pending;
    this.pending = "";
    return { releasedPending: text, text: "", pendingContinues: false, fail: false };
  }
}

function codeBuddyScaffoldErrorMessage(): string {
  return "CodeBuddy CLI emitted vendor tool-call markup in an assistant output channel. This route"
    + " runs the CLI with its own tools and MCP servers disabled and Codex owns tool control, so"
    + " the turn was refused rather than forwarding or executing vendor agent scaffolding.";
}

/** Guard both streamed channels while preserving event order around withheld marker prefixes. */
export function guardCodeBuddyScaffolding(emit: (event: AdapterEvent) => void): (event: AdapterEvent) => void {
  const textFilter = new CodeBuddyScaffoldFilter();
  const thinkingFilter = new CodeBuddyScaffoldFilter();
  type PendingChannel = "text" | "thinking";
  type EventSlot = { resolved: boolean; event?: AdapterEvent };
  const eventQueue: EventSlot[] = [];
  const pendingSlots = new Map<PendingChannel, EventSlot>();
  let closed = false;

  const channelEvent = (channel: PendingChannel, text: string): AdapterEvent => channel === "text"
    ? { type: "text_delta", text }
    : { type: "thinking_delta", thinking: text };

  const drainResolved = (): void => {
    while (eventQueue[0]?.resolved) {
      const slot = eventQueue.shift()!;
      if (slot.event) emit(slot.event);
    }
  };

  const enqueueResolved = (event: AdapterEvent): void => {
    eventQueue.push({ resolved: true, event });
    drainResolved();
  };

  const resolvePendingSlot = (channel: PendingChannel, text: string): void => {
    const slot = pendingSlots.get(channel);
    if (!slot) return;
    slot.resolved = true;
    if (text) slot.event = channelEvent(channel, text);
    pendingSlots.delete(channel);
    drainResolved();
  };

  const enqueuePendingSlot = (channel: PendingChannel): void => {
    const slot: EventSlot = { resolved: false };
    eventQueue.push(slot);
    pendingSlots.set(channel, slot);
  };

  const flushAllPending = (): void => {
    for (const channel of ["text", "thinking"] as const) {
      if (!pendingSlots.has(channel)) continue;
      const filter = channel === "text" ? textFilter : thinkingFilter;
      resolvePendingSlot(channel, filter.flush().releasedPending);
    }
    drainResolved();
  };

  const refuse = (): void => {
    if (closed) return;
    flushAllPending();
    closed = true;
    emit({
      type: "error",
      message: codeBuddyScaffoldErrorMessage(),
      status: 502,
      errorType: "upstream_error",
      code: CODEBUDDY_SCAFFOLD_ERROR_CODE,
      retryable: false,
    });
  };

  return (event: AdapterEvent): void => {
    if (closed) return;
    if (event.type === "text_delta" || event.type === "thinking_delta") {
      const channel: PendingChannel = event.type === "text_delta" ? "text" : "thinking";
      const filter = channel === "text" ? textFilter : thinkingFilter;
      const hadPending = filter.hasPending();
      const cleaned = filter.push(event.type === "text_delta" ? event.text : event.thinking);
      if (hadPending && !cleaned.pendingContinues) resolvePendingSlot(channel, cleaned.releasedPending);
      if (cleaned.text) {
        enqueueResolved(event.type === "text_delta"
          ? { ...event, text: cleaned.text }
          : { ...event, thinking: cleaned.text });
      }
      if (filter.hasPending() && !cleaned.pendingContinues) enqueuePendingSlot(channel);
      if (cleaned.fail) refuse();
      return;
    }
    if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
      flushAllPending();
      closed = true;
      emit(event);
      return;
    }
    enqueueResolved(event);
  };
}
