/** Line-aware filter for echoed tool envelopes in incremental assistant text. */
const MARKERS = ["[Tool Result]", "[Tool Error]", "[tool_result]", "[Tool Call]", "[Tool call:"] as const;
const UNTERMINATED_MARKERS = ["[Tool Result", "[Tool Error", "[tool_result", "[Tool Call"] as const;
/** Lines that are an echoed envelope marker on their own (after trimming trailing whitespace). */
const WHOLE_LINE_MARKERS: readonly string[] = [...MARKERS, ...UNTERMINATED_MARKERS];
/**
 * The coding-agent call line "[Tool call: name (call_id: ...) with args: ...]" can wrap across lines
 * when its arguments do, so it is recognised by its prefix, as before; prose rarely opens that way.
 */
const TOOL_CALL_LINE = "[Tool call:";
const MAX_INDENT = 128;
// Markdown fenced code (CommonMark): an opener is a run of at least three backticks or tildes
// indented at most three spaces; only a run of the same character, at least as long and followed
// by nothing but whitespace, closes it. A backtick opener's info string may not contain a backtick.
const MAX_FENCE_INDENT = 3;
const MAX_FENCE_LINE = 1024;
const FENCE_LINE = /^(\x60{3,}|~{3,})(.*)$/s;
const FENCE_PREFIX = /^(\x60{1,2}|~{1,2})$/;
const FENCE_RUN = /^(\x60{3,}|~{3,})/;

/**
 * The envelope OpenCodex replays is a marker alone on its line ("[Tool Result]\n<payload>"). Only a
 * line that is exactly such a marker is an echo; prose that merely starts with one ("[Tool Result]
 * shows the build passed.") is an answer. The call line keeps its prefix rule (TOOL_CALL_LINE).
 */
export function isWholeLineEchoMarker(line: string): boolean {
  const trimmed = line.replace(/^[ \t]*/, "").trimEnd();
  return WHOLE_LINE_MARKERS.includes(trimmed) || trimmed.startsWith(TOOL_CALL_LINE);
}

interface FenceLine {
  char: string;
  length: number;
  rest: string;
}

/** A complete line (no newline) parsed as a CommonMark fence line, or null. */
function parseFenceLine(line: string): FenceLine | null {
  const probe = line.replace(/^[ \t]*/, "");
  if (line.length - probe.length > MAX_FENCE_INDENT) return null;
  const match = FENCE_LINE.exec(probe.replace(/\r?\n?$/, ""));
  if (!match) return null;
  return { char: match[1]![0]!, length: match[1]!.length, rest: match[2] ?? "" };
}

function opensFence(line: FenceLine): boolean {
  return !(line.char === "\x60" && line.rest.includes("\x60"));
}

function closesFence(line: FenceLine, open: { char: string; length: number }): boolean {
  return line.char === open.char && line.length >= open.length && line.rest.trim() === "";
}

/**
 * For complete text (assistant history): true for each line that is a fence line of, or sits
 * inside, a fenced block that is closed later in the same text. A block that never closes shields
 * nothing, matching the live filter, which drops a held tail when the turn ends inside a fence.
 */
export function closedFenceLines(lines: readonly string[]): boolean[] {
  const shielded = lines.map(() => false);
  let open: { char: string; length: number; start: number } | null = null;
  lines.forEach((text, index) => {
    const fence = parseFenceLine(text);
    if (!open) {
      if (fence && opensFence(fence)) open = { char: fence.char, length: fence.length, start: index };
      return;
    }
    if (fence && closesFence(fence, open)) {
      for (let line = open.start; line <= index; line++) shielded[line] = true;
      open = null;
    }
  });
  return shielded;
}

// A marker line inside a fence may be a quoted example or an echo pasted into a block that never
// closes. Output from that line is held: a matching closer releases it as code, the end of the turn
// drops it as an echo. The hold is bounded, so a long block cannot stall the stream.
const MAX_HELD_CHARS = 64 * 1024;

interface Fence {
  char: string;
  length: number;
  holdDisabled: boolean;
  /** Its hold overflowed, so its marker is unverified until the block closes. */
  overflowed?: boolean;
}

export class ToolEnvelopeEchoFilter {
  private pending = "";
  private safeLine = false;
  private fence: Fence | null = null;
  private held: string | null = null;
  matched = false;
  /** A fenced marker whose hold overflowed was released without proof that the block closes. */
  unverifiedMarker = false;

  feed(delta: string): string {
    if (this.matched) return "";
    let output = "";
    for (const char of delta) {
      if (this.matched) break;
      if (this.safeLine) {
        output += this.emit(char);
        if (char === "\n") this.safeLine = false;
        continue;
      }
      this.pending += char;
      if (char === "\n") {
        output += this.completeLine();
        continue;
      }
      const probe = this.pending.replace(/^[ \t]*/, "");
      const indent = this.pending.length - probe.length;
      if (indent <= MAX_INDENT && probe === TOOL_CALL_LINE) {
        if (!this.fence) {
          this.pending = "";
          this.matched = true;
          break;
        }
        this.startHold();
        this.flushLineStart();
        output += this.emit(this.takePending());
        continue;
      }
      // A marker is decided when its line completes (completeLine): until then a line that is a
      // marker so far or a marker plus trailing whitespace stays pending. Anything else on the
      // line makes it prose and releases it.
      const fenceCandidate = indent <= MAX_FENCE_INDENT
        && this.pending.length <= MAX_FENCE_LINE
        && (FENCE_PREFIX.test(probe) || FENCE_RUN.test(probe));
      const markerCandidate = indent <= MAX_INDENT
        && (probe === ""
          || MARKERS.some(marker => marker.startsWith(probe))
          || WHOLE_LINE_MARKERS.includes(probe.trimEnd()));
      if (fenceCandidate || markerCandidate) continue;
      this.flushLineStart();
      output += this.emit(this.takePending());
    }
    return output;
  }

  /**
   * At normal end, a held fence tail, a last line that is a whole marker (or a bare unterminated
   * marker such as "[Tool Result") or a "[Tool call:" line is an echo; other text, including a
   * line that merely starts with a result or error marker, is prose.
   */
  finish(): string {
    if (this.matched) return "";
    // A closing fence may end the stream without a trailing newline; settle it before the hold.
    const settled = this.pending !== "" && parseFenceLine(this.pending) ? this.completeLine() : "";
    const pending = this.takePending();
    if (this.held !== null) {
      this.held = null;
      this.matched = true;
      return "";
    }
    const probe = pending.replace(/^[ \t]*/, "");
    if (isWholeLineEchoMarker(probe)) {
      this.matched = true;
      return settled;
    }
    return settled + pending;
  }

  private completeLine(): string {
    const raw = this.takePending();
    const probe = raw.replace(/^[ \t]*/, "");
    const indent = raw.length - probe.length;
    const line = probe.replace(/\r?\n$/, "");
    const fenceLine = parseFenceLine(raw);
    if (fenceLine) {
      if (!this.fence) {
        if (opensFence(fenceLine)) {
          this.fence = { char: fenceLine.char, length: fenceLine.length, holdDisabled: false };
        }
        return this.emit(raw);
      }
      if (closesFence(fenceLine, this.fence)) {
        const out = this.emit(raw);
        // Only one block is open at a time, so closing the overflowed one settles the doubt. This
        // runs after the closer is emitted, because the closer itself can be what overflows the hold.
        if (this.fence.overflowed) this.unverifiedMarker = false;
        const released = this.held ?? "";
        this.held = null;
        this.fence = null;
        return out + released;
      }
      return this.emit(raw);
    }
    const trimmed = line.trimEnd();
    const markerLine = indent <= MAX_INDENT && isWholeLineEchoMarker(trimmed);
    if (markerLine) {
      if (!this.fence) {
        this.matched = true;
        return "";
      }
      this.startHold();
    }
    return this.emit(raw);
  }

  private startHold(): void {
    if (this.fence && !this.fence.holdDisabled && this.held === null) this.held = "";
  }

  private flushLineStart(): void {
    this.safeLine = true;
  }

  private takePending(): string {
    const pending = this.pending;
    this.pending = "";
    return pending;
  }

  /** Route text to the client, or into the fence hold while one is open. */
  private emit(text: string): string {
    if (this.held === null) return text;
    this.held += text;
    if (this.held.length <= MAX_HELD_CHARS) return "";
    const released = this.held;
    this.held = null;
    this.unverifiedMarker = true;
    if (this.fence) {
      this.fence.holdDisabled = true;
      this.fence.overflowed = true;
    }
    return released;
  }
}

export function stripToolEnvelopeEcho(text: string): string {
  const filter = new ToolEnvelopeEchoFilter();
  return filter.feed(text) + filter.finish();
}
