import type { AdapterEvent } from "../../types";

/** Error code for a CodeBuddy turn whose output contains vendor agent scaffolding. */
export const CODEBUDDY_SCAFFOLD_ERROR_CODE = "vendor_scaffold_detected";

// The observed control protocols use FULLWIDTH VERTICAL LINE (U+FF5C). Detection stays
// deliberately narrower than the marker spelling: a calls control line must be followed by an
// invoke line with a non-empty tool name. That distinguishes an agent scaffold from prose quoting or
// discussing one tag.
interface ScaffoldGrammar {
  callsLine: string;
  invokePrefix: string;
}

const SCAFFOLD_GRAMMARS: readonly ScaffoldGrammar[] = [
  { callsLine: "<｜｜dsml｜｜ calls>", invokePrefix: "<｜｜dsml｜｜ invoke name=\"" },
  // DeepSeek's native tool markup (LOWER ONE EIGHTH BLOCK U+2581 joins the words), printed as
  // text when the CLI runs with no tool catalog (#8447).
  { callsLine: "<｜tool▁calls｜>", invokePrefix: "<｜tool▁invoke name=\"" },
];

export interface CodeBuddyScaffoldFilterResult {
  /** Bytes released from a suffix withheld by an earlier event on this channel. */
  releasedPending: string;
  /** Safe bytes belonging to the event currently being processed. */
  text: string;
  /** The earlier pending event still owns the extended candidate. */
  pendingContinues: boolean;
  fail: boolean;
}

/**
 * An open fenced code block (CommonMark): it closes only on a line whose fence run uses the same
 * character, is at least as long as the opener, and is followed by nothing but spaces or tabs.
 * `closing` tracks a candidate closing line whose remainder has not been seen yet: `run` while the
 * fence run may still grow, `space` once trailing whitespace started. A backtick opener's info
 * string may not contain a backtick (` ```a``` ` is an inline code span, not a fence).
 */
interface FenceState {
  char: "`" | "~";
  length: number;
  closing: "run" | "space" | null;
  /** A backtick opener whose info string is still being read; a backtick in it voids the fence. */
  opening: boolean;
}

interface FenceRunState {
  char: "`" | "~";
  length: number;
}

interface ScanResult {
  safe: string;
  held: string;
  fail: boolean;
  fence: FenceState | null;
  fenceRun: FenceRunState | null;
  lineStart: boolean;
}

// Probe with ASCII-only case folding rather than toLowerCase(): Unicode lowercasing can expand
// a code point (İ, ŉ, ligatures), shifting folded-text offsets away from `text` positions and
// silently disabling detection. `expected` must already be lowercase.
function asciiFold(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

function startsWithFolded(text: string, index: number, expected: string): boolean {
  if (index + expected.length > text.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (asciiFold(text.charCodeAt(index + i)) !== expected.charCodeAt(i)) return false;
  }
  return true;
}

function prefixAtEnd(text: string, at: number, expected: string): boolean {
  const remaining = text.length - at;
  if (remaining > expected.length) return false;
  for (let i = 0; i < remaining; i++) {
    if (asciiFold(text.charCodeAt(at + i)) !== expected.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Classify a column-zero position against every known control grammar: a complete
 * calls-plus-named-invoke sequence fails the turn, and a suffix that may still become one is held.
 */
function matchControlSequence(text: string, index: number): "fail" | "hold" | null {
  let hold = false;
  for (const { callsLine, invokePrefix } of SCAFFOLD_GRAMMARS) {
    if (startsWithFolded(text, index, callsLine)) {
      const afterCalls = index + callsLine.length;
      let invokeAt = -1;
      if (text[afterCalls] === "\n") invokeAt = afterCalls + 1;
      else if (text[afterCalls] === "\r" && text[afterCalls + 1] === "\n") invokeAt = afterCalls + 2;
      else if (afterCalls === text.length || (text[afterCalls] === "\r" && afterCalls + 1 === text.length)) {
        hold = true;
        continue;
      }

      if (invokeAt >= 0) {
        const invokeNameStart = text[invokeAt + invokePrefix.length];
        if (startsWithFolded(text, invokeAt, invokePrefix) && invokeNameStart && !/[\s"]/.test(invokeNameStart)) {
          return "fail";
        }
        if (invokeAt === text.length || prefixAtEnd(text, invokeAt, invokePrefix)) hold = true;
      }
    } else if (prefixAtEnd(text, index, callsLine)) {
      hold = true;
    }
  }
  return hold ? "hold" : null;
}

/**
 * Scan complete bytes and retain only a bounded suffix that can still become a control sequence.
 *
 * Control tags are recognized only at column zero and outside fenced Markdown. Inline code,
 * quoted strings, blockquotes, indented source, and prose all add syntax before the tag and are
 * therefore forwarded unchanged. A calls line alone is harmless; refusal requires one of the
 * observed two-line calls-plus-named-invoke grammars.
 */
function scan(
  text: string,
  initialFence: FenceState | null,
  initialFenceRun: FenceRunState | null,
  initialLineStart: boolean,
): ScanResult {
  let fence = initialFence && { ...initialFence };
  let fenceRun = initialFenceRun && { ...initialFenceRun };
  let lineStart = initialLineStart;
  let index = 0;

  while (index < text.length) {
    if (fenceRun) {
      const char = text[index]!;
      if (char === fenceRun.char) {
        fenceRun.length += 1;
        index += 1;
        continue;
      }
      const run = fenceRun;
      fenceRun = null;
      if (!fence && run.length >= 3) {
        fence = { char: run.char, length: run.length, closing: null, opening: run.char === "`" };
        continue;
      }
      if (fence && run.char === fence.char && run.length >= fence.length) {
        fence.closing = "run";
        continue;
      }
    } else if (fence?.opening) {
      const char = text[index]!;
      if (char === "`") fence = null;
      else if (char === "\n" || char === "\r") fence.opening = false;
    } else if (fence?.closing) {
      const char = text[index]!;
      if (fence.closing === "run" && char === fence.char) {
        index += 1;
        continue;
      }
      if (char === " " || char === "\t") {
        fence.closing = "space";
        index += 1;
        continue;
      }
      // A line end confirms the close; any other text makes the line ordinary fenced content.
      if (char === "\n" || char === "\r") fence = null;
      else fence.closing = null;
    } else if (lineStart) {
      // A fence line may be indented by up to three spaces; control markers stay column-zero only.
      let runStart = index;
      while (runStart < text.length && runStart - index < 3 && text[runStart] === " ") runStart += 1;
      if (runStart === text.length) {
        return { safe: text.slice(0, index), held: text.slice(index), fail: false, fence, fenceRun, lineStart };
      }
      const runChar = text[runStart];
      if (runChar === "`" || runChar === "~") {
        let runEnd = runStart + 1;
        while (runEnd < text.length && text[runEnd] === runChar) runEnd += 1;
        const runLength = runEnd - runStart;
        // Track a chunk-ending fence run incrementally instead of holding its bytes in pending,
        // keeping buffering O(1) and avoiding cross-channel stalls on long backtick/tilde runs.
        if (runEnd === text.length && (!fence || (runChar === fence.char && runLength < fence.length))) {
          fenceRun = { char: runChar, length: runLength };
          index = runEnd;
          lineStart = false;
          continue;
        }
        if (!fence && runLength >= 3) {
          fence = { char: runChar, length: runLength, closing: null, opening: runChar === "`" };
          index = runEnd;
          lineStart = false;
          continue;
        }
        if (fence && runChar === fence.char && runLength >= fence.length) {
          fence.closing = "run";
          index = runEnd;
          lineStart = false;
          continue;
        }
        index = runEnd;
        lineStart = false;
        continue;
      }

      if (!fence) {
        const verdict = matchControlSequence(text, index);
        if (verdict === "fail") return { safe: text.slice(0, index), held: "", fail: true, fence, fenceRun, lineStart };
        if (verdict === "hold") {
          return { safe: text.slice(0, index), held: text.slice(index), fail: false, fence, fenceRun, lineStart };
        }
      }
    }

    const char = text[index]!;
    index += 1;
    lineStart = char === "\n";
  }

  return { safe: text, held: "", fail: false, fence, fenceRun, lineStart };
}

/** Streaming vendor control-sequence filter for one text or reasoning channel. */
export class CodeBuddyScaffoldFilter {
  private pending = "";
  private failed = false;
  private fence: FenceState | null = null;
  private fenceRun: FenceRunState | null = null;
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
    const result = scan(priorPending + chunk, this.fence, this.fenceRun, this.lineStart);
    this.pending = result.held;
    this.fence = result.fence;
    this.fenceRun = result.fenceRun;
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
