import type { AdapterEvent } from "../../types";

/** Error code for a CodeBuddy turn whose text channel contains vendor agent scaffolding. */
export const CODEBUDDY_SCAFFOLD_ERROR_CODE = "vendor_scaffold_detected";

// CodeBuddy's observed DSML tags use FULLWIDTH VERTICAL LINE (U+FF5C), not ASCII pipes.
// Keep the exact spelling narrow: a bare "DSML" match would reject legitimate discussion of
// the protocol, while the tag prefix identifies vendor control markup rather than prose.
const DSML_OPEN = "<｜｜dsml｜｜";
const DSML_CLOSE = "</｜｜dsml｜｜";
const MARKERS = [DSML_OPEN, DSML_CLOSE] as const;
const MAX_MARKER_LENGTH = Math.max(...MARKERS.map(marker => marker.length));

export interface CodeBuddyScaffoldFilterResult {
  /** Bytes released from the suffix withheld by an earlier event on this channel. */
  releasedPending: string;
  /** Safe bytes that belong to the event currently being processed. */
  text: string;
  /** The earlier pending slot still owns the newly extended marker prefix. */
  pendingContinues: boolean;
  fail: string | null;
}

/** Longest suffix that may become an observed DSML marker after another stream delta. */
function heldSuffixLength(text: string): number {
  const limit = Math.min(MAX_MARKER_LENGTH - 1, text.length);
  for (let length = limit; length > 0; length--) {
    const suffix = text.slice(text.length - length).toLowerCase();
    if (MARKERS.some(marker => marker.startsWith(suffix))) return length;
  }
  return 0;
}

/**
 * Streaming fail-closed filter for one CodeBuddy text or reasoning channel (#4596).
 *
 * The CLI is intentionally launched without tools, so DSML cannot be a usable tool call here.
 * Reconstructing it would turn assistant text into execution authority. A marker can be split
 * across deltas, therefore the possible prefix tail is withheld until the next delta or terminal.
 */
export class CodeBuddyScaffoldFilter {
  private pending = "";
  private failed = false;

  /** True while this channel owns a possible split-marker suffix. */
  hasPending(): boolean {
    return this.pending.length > 0;
  }

  push(chunk: string): CodeBuddyScaffoldFilterResult {
    if (this.failed) {
      return { releasedPending: "", text: "", pendingContinues: false, fail: null };
    }
    // Empty deltas carry no new ordering information. If this channel already owns a possible
    // marker suffix, keep that original event slot unresolved instead of replacing it after later
    // events in another channel.
    if (!chunk) {
      return {
        releasedPending: "",
        text: "",
        pendingContinues: this.hasPending(),
        fail: null,
      };
    }
    const priorPending = this.pending;
    const buffer = priorPending + chunk;
    this.pending = "";
    const lowered = buffer.toLowerCase();

    let earliest = -1;
    let marker = "";
    for (const candidate of MARKERS) {
      const at = lowered.indexOf(candidate);
      if (at >= 0 && (earliest < 0 || at < earliest)) {
        earliest = at;
        marker = candidate;
      }
    }

    if (earliest >= 0) {
      this.failed = true;
      // With an opener, text before the tag is a completed answer prefix. With only a closer,
      // that prefix may be the body of a tag whose opening arrived through another channel/frame.
      const safe = marker === DSML_OPEN ? buffer.slice(0, earliest) : "";
      const releasedLength = Math.min(priorPending.length, safe.length);
      return {
        releasedPending: safe.slice(0, releasedLength),
        text: safe.slice(releasedLength),
        pendingContinues: false,
        fail: "vendor DSML tool-call markup",
      };
    }

    const held = heldSuffixLength(buffer);
    const safe = held === 0 ? buffer : buffer.slice(0, buffer.length - held);
    if (held > 0) this.pending = buffer.slice(buffer.length - held);
    const releasedLength = Math.min(priorPending.length, safe.length);
    return {
      releasedPending: safe.slice(0, releasedLength),
      text: safe.slice(releasedLength),
      // A marker prefix extended without releasing any byte still belongs at the earlier event's
      // position. Once any prior byte is released, a newly held suffix belongs to this event.
      pendingContinues: priorPending.length > 0
        && safe.length === 0
        && this.pending.startsWith(priorPending),
      fail: null,
    };
  }

  /** Release a suffix proven harmless by the terminal boundary. */
  flush(): CodeBuddyScaffoldFilterResult {
    if (this.failed) {
      return { releasedPending: "", text: "", pendingContinues: false, fail: null };
    }
    const text = this.pending;
    this.pending = "";
    return { releasedPending: text, text: "", pendingContinues: false, fail: null };
  }
}

function codeBuddyScaffoldErrorMessage(): string {
  return "CodeBuddy CLI emitted vendor tool-call markup in an assistant output channel. This route"
    + " runs the CLI with its own tools and MCP servers disabled and Codex owns tool control, so"
    + " the turn was refused rather than forwarding or executing vendor agent scaffolding.";
}

/** Guard both streamed channels without changing the shared coding-agent protocol parser. */
export function guardCodeBuddyScaffolding(emit: (event: AdapterEvent) => void): (event: AdapterEvent) => void {
  const textFilter = new CodeBuddyScaffoldFilter();
  const thinkingFilter = new CodeBuddyScaffoldFilter();
  type PendingChannel = "text" | "thinking";
  type EventSlot = { resolved: boolean; event?: AdapterEvent };
  const eventQueue: EventSlot[] = [];
  const pendingSlots = new Map<PendingChannel, EventSlot>();
  let closed = false;

  const channelEvent = (channel: PendingChannel, text: string): AdapterEvent => (
    channel === "text"
      ? { type: "text_delta", text }
      : { type: "thinking_delta", thinking: text }
  );

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
    // A terminal refusal proves every other marker-like suffix harmless. Resolve queued slots by
    // their original positions before the error so no later safe event overtakes an older tail.
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
      if (hadPending && !cleaned.pendingContinues) {
        resolvePendingSlot(channel, cleaned.releasedPending);
      }
      if (cleaned.text) {
        enqueueResolved(event.type === "text_delta"
          ? { ...event, text: cleaned.text }
          : { ...event, thinking: cleaned.text });
      }
      if (filter.hasPending() && !cleaned.pendingContinues) {
        enqueuePendingSlot(channel);
      }
      if (cleaned.fail) refuse();
      return;
    }
    if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
      flushAllPending();
      closed = true;
      emit(event);
      return;
    }
    emit(event);
  };
}
