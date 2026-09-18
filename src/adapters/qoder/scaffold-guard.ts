/**
 * Vendor-scaffolding guard for the qoder route (#4190).
 *
 * The qoder route is contractually a text and reasoning surface: the CLI is spawned with
 * `--tools "" --strict-mcp-config --setting-sources ""`, and Codex keeps tool ownership.
 * The vendor CLI does not always honour that. It has been observed emitting its own agent
 * layer into the assistant text channel — an MCP lazy-loading `<system-reminder>` block
 * listing the local machine's configured MCP servers, and framework tool-call markup with a
 * mismatched closer. Both reached the client verbatim, because the shared stream-json parser
 * forwards a text delta without inspecting it.
 *
 * Two shapes, two answers. A complete `<system-reminder>` block is recognizable and
 * self-delimiting, so it is removed and the surrounding answer survives. Anything else that
 * carries a scaffolding signature is not repairable by guesswork — a partial tool-call block
 * has no reliable end, and the text around it may already be the vendor's own agent
 * narration rather than the model's answer — so the turn fails closed instead.
 *
 * The filter is a stream, not a regex over a finished string: a marker can be split across
 * deltas, so a tail that is still a possible marker prefix is held back rather than emitted.
 * Callers must therefore `flush()` before forwarding a terminal event, or a legitimate
 * answer ending in "<" would lose its last character.
 */

/** Error code for a turn refused because vendor scaffolding reached the text channel. */
export const QODER_SCAFFOLD_ERROR_CODE = "vendor_scaffold_detected";

const REMINDER_OPEN = "<system-reminder";
const REMINDER_CLOSE = "</system-reminder>";

/**
 * Scaffolding signatures that are never repaired.
 *
 * `<functions.` and the invoke pair are the vendor runtime's tool-call markup. The reported
 * leak carried `<functions.exec>` opened and `</invoke>` closed — mismatched, which is what
 * a model emitting remembered markup looks like, and exactly why reconstructing the intended
 * text is not possible. A stray `</system-reminder>` with no opener is in the same class:
 * the block it belonged to was already partly forwarded, or never existed.
 */
const UNREPAIRABLE_MARKERS = ["<functions.", "<invoke name=", "<invoke>", "</invoke>", REMINDER_CLOSE] as const;

/** Markers that end a block rather than start one; their prefix is never an answer. */
const CLOSING_MARKERS = new Set<string>(["</invoke>", REMINDER_CLOSE]);

/** Every marker the scanner must be able to recognize mid-split. */
const ALL_MARKERS = [REMINDER_OPEN, ...UNREPAIRABLE_MARKERS] as const;

const MAX_MARKER_LENGTH = Math.max(...ALL_MARKERS.map(marker => marker.length));

/**
 * True when `<system-reminder` at `at` is the tag rather than the start of a longer word.
 *
 * The opener is matched without its `>` so a truncated or self-closed tag still suppresses,
 * which means `<system-reminders>` in an ordinary answer would otherwise open a block and
 * refuse the turn. A stem running to the end of the buffer still counts: more text may be
 * arriving, and reading it as prose is the one reading that could release the block body.
 */
function reminderOpensHere(lowered: string, at: number): boolean {
  const after = lowered[at + REMINDER_OPEN.length];
  return after === undefined || /[\s/>]/.test(after);
}

/**
 * Ceiling on a suppressed block before it is treated as unterminated.
 *
 * The block itself is discarded as it arrives, so this is not a memory bound — only the
 * trailing bytes needed to spot a split closer are retained. It bounds how much of a turn a
 * single unclosed reminder is allowed to swallow silently before the turn is refused.
 */
const MAX_SUPPRESSED_CHARS = 64 * 1024;

/** Result of feeding one chunk: the text safe to forward, and a refusal reason once tripped. */
export interface ScaffoldFilterResult {
  /** Text cleared for the client. Empty when everything in the chunk was held or dropped. */
  text: string;
  /** Non-null exactly once, on the chunk that trips the guard. */
  fail: string | null;
}

/** Longest suffix of `text` that could still grow into one of the markers. */
function heldSuffixLength(text: string): number {
  const limit = Math.min(MAX_MARKER_LENGTH - 1, text.length);
  for (let length = limit; length > 0; length--) {
    const suffix = text.slice(text.length - length).toLowerCase();
    for (const marker of ALL_MARKERS) {
      if (marker.length > length && marker.startsWith(suffix)) return length;
    }
  }
  return 0;
}

/**
 * Streaming scaffolding filter for one channel (text or reasoning).
 *
 * One instance per channel: the two never share suppression state, so a reminder block
 * opened in reasoning cannot swallow the answer text.
 */
export class QoderScaffoldFilter {
  private mode: "pass" | "suppress" = "pass";
  private pending = "";
  private suppressedTail = "";
  private suppressedChars = 0;
  private failed = false;
  /** True once a reminder block has been suppressed on this channel. */
  private suppressedBlock = false;
  /** Open reminder blocks; only the closer that unwinds the last one ends suppression. */
  private suppressDepth = 0;

  push(chunk: string): ScaffoldFilterResult {
    if (this.failed || !chunk) return { text: "", fail: null };
    let cleared = "";
    let buffer = this.mode === "pass" ? this.pending + chunk : chunk;
    this.pending = "";

    for (;;) {
      if (this.mode === "suppress") {
        const scan = this.suppressedTail + buffer;
        const scanned = scan.toLowerCase();
        // Unwind nesting rather than ending at the first closer. A reminder containing another
        // reminder would otherwise hand the outer block's remaining body — the MCP server list
        // in the reported leak — to the client as the model's answer, with a successful
        // terminal and nothing to signal that anything had gone wrong.
        let cursor = 0;
        let close = -1;
        for (;;) {
          const nextClose = scanned.indexOf(REMINDER_CLOSE, cursor);
          if (nextClose < 0) break;
          let nextOpen = scanned.indexOf(REMINDER_OPEN, cursor);
          while (nextOpen >= 0 && !reminderOpensHere(scanned, nextOpen)) {
            nextOpen = scanned.indexOf(REMINDER_OPEN, nextOpen + 1);
          }
          if (nextOpen >= 0 && nextOpen < nextClose) {
            this.suppressDepth += 1;
            cursor = nextOpen + REMINDER_OPEN.length;
            continue;
          }
          this.suppressDepth -= 1;
          cursor = nextClose + REMINDER_CLOSE.length;
          if (this.suppressDepth === 0) {
            close = nextClose;
            break;
          }
        }
        if (close < 0) {
          this.suppressedChars += buffer.length;
          if (this.suppressedChars > MAX_SUPPRESSED_CHARS) {
            return this.fail(cleared, `an unterminated ${REMINDER_OPEN}> block`);
          }
          // The block is discarded as it arrives; only enough tail to spot a split closer is kept.
          // The tail must cover a split opener too, now that nesting is counted.
          this.suppressedTail = scan.slice(Math.max(0, scan.length - (MAX_MARKER_LENGTH - 1)));
          return { text: cleared, fail: null };
        }
        buffer = scan.slice(close + REMINDER_CLOSE.length);
        this.mode = "pass";
        this.suppressedTail = "";
        this.suppressedChars = 0;
        continue;
      }

      let earliest = -1;
      let found = "";
      const lowered = buffer.toLowerCase();
      for (const marker of ALL_MARKERS) {
        let at = lowered.indexOf(marker);
        while (at >= 0 && marker === REMINDER_OPEN && !reminderOpensHere(lowered, at)) {
          at = lowered.indexOf(marker, at + 1);
        }
        if (at < 0) continue;
        // A closer sitting exactly where an opener starts cannot happen, so ties are impossible.
        if (earliest < 0 || at < earliest) {
          earliest = at;
          found = marker;
        }
      }

      if (earliest < 0) {
        const held = heldSuffixLength(buffer);
        cleared += held > 0 ? buffer.slice(0, buffer.length - held) : buffer;
        this.pending = held > 0 ? buffer.slice(buffer.length - held) : "";
        return { text: cleared, fail: null };
      }

      // Text produced before the scaffolding is the model's own answer, and it is kept — but
      // only while this channel has not already suppressed a block. Once it has, the text
      // between that block and an unrepairable marker is not an answer that happens to
      // precede a leak; it is the region the vendor was narrating in, and in the reported
      // case it carries the MCP server list. Forwarding it on the way to a refusal would
      // publish exactly what the refusal exists to contain.
      // A closer with no opener never keeps its prefix either: the block it belonged to was
      // already partly forwarded or never existed, so the text ahead of it is that body.
      if (!CLOSING_MARKERS.has(found) && (found === REMINDER_OPEN || !this.suppressedBlock)) {
        cleared += buffer.slice(0, earliest);
      }
      if (found !== REMINDER_OPEN) return this.fail(cleared, `vendor tool-call markup (${found})`);
      this.suppressedBlock = true;
      this.mode = "suppress";
      this.suppressDepth = 1;
      this.suppressedTail = "";
      this.suppressedChars = 0;
      buffer = buffer.slice(earliest + REMINDER_OPEN.length);
    }
  }

  /** Release the held tail. Call before forwarding a terminal event, never mid-stream. */
  flush(): ScaffoldFilterResult {
    if (this.failed) return { text: "", fail: null };
    if (this.mode === "suppress") return this.fail("", `an unterminated ${REMINDER_OPEN}> block`);
    const text = this.pending;
    this.pending = "";
    return { text, fail: null };
  }

  private fail(cleared: string, reason: string): ScaffoldFilterResult {
    this.failed = true;
    this.pending = "";
    this.suppressedTail = "";
    return { text: cleared, fail: reason };
  }
}

/**
 * Message for a refused turn.
 *
 * It names the marker class and nothing else. The leaked reminder in the report enumerated
 * the operator's own MCP servers, so echoing the offending text back — into an error the
 * client renders, and that a user may paste into an issue — would publish the thing this
 * guard exists to contain.
 */
export function qoderScaffoldErrorMessage(reason: string): string {
  return `Qoder CLI emitted ${reason} in the assistant text channel. This route runs the CLI with`
    + " its own tools and MCP servers disabled and Codex owns tool control, so the turn was refused"
    + " rather than forwarding vendor agent scaffolding to the client.";
}
