/**
 * External Cursor output quarantine (devlog 260826 gaps 10-11).
 *
 * Gap 10: flattened tool-result history can prime an external model to echo the
 * "[Tool Result]" envelope as its own reply.
 *
 * Gap 11: a model can invent a blocked native-tool attempt in visible commentary
 * even though the only real current-turn tool is the advertised Codex bridge.
 *
 * Both failures are observable only at the output boundary. The sniffers below
 * hold a bounded prefix until it either diverges or proves the failure, allowing
 * cursor.ts to retry before any invalid text reaches the client.
 */

const ECHO_MARKERS = ["[Tool Result]", "[Tool Error]", "[tool_result]"] as const;

function isEchoMarkerLine(line: string): boolean {
  return (ECHO_MARKERS as readonly string[]).includes(line.replace(/^[ \t]+/, ""));
}

/**
 * Drop echoed tool-result envelopes from assistant history before Cursor root replay.
 *
 * The prefix sniffer catches an echo that STARTS a turn, but grok-4.6 routinely writes a real
 * sentence first and pastes the envelope after it. That text has already reached the client and
 * is stored as assistant output, so replaying it verbatim re-primes the next turn with the very
 * envelope the model is copying.
 *
 * Scope starts AT the marker line and runs to the next blank line, rather than to the end of
 * the message. The echoed envelope has no terminator we can recognise — we build it as a marker
 * line plus arbitrary result text (protobuf-request.ts), and the observed copies are not
 * byte-exact, so matching against the replayed envelope is not available either. Truncating to
 * the end of the message was the alternative, and it discards a genuine answer whenever the
 * model resumes after the echo. A blank line is the one boundary the model reliably writes when
 * it goes back to prose.
 *
 * The tradeoff is explicit: an echoed envelope whose pasted result itself contains a blank line
 * leaves its remainder in replay. That is the safer direction to be wrong in — conversation
 * remint, not this filter, is the primary defence against a poisoned conversation, and this only
 * stops the transcript from feeding itself.
 *
 * Only whole-line markers count, so prose such as "the string [Tool Result] appeared" survives.
 */
export function stripAssistantEchoedToolEnvelope(text: string): string {
  if (!text || !ECHO_MARKERS.some(marker => text.includes(marker))) return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let dropped = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!isEchoMarkerLine(line)) {
      kept.push(line);
      index += 1;
      continue;
    }
    dropped = true;
    index += 1;
    // The envelope body is the contiguous non-blank run after the marker. The blank line that
    // ends it is left in place, so surviving prose on either side stays separated.
    while (index < lines.length && (lines[index] ?? "").trim() !== "") index += 1;
  }
  if (!dropped) return text;
  return kept.join(newline).trimEnd();
}

const MAX_SNIFF_BYTES = 40;
/** Mid-stream observer: max leading whitespace on a line before matching disarms. */
const MAX_MIDSTREAM_LINE_INDENT = 128;
/** Mid-stream observer: post-marker window watched for call-id corruption. */
const MIDSTREAM_CORRUPTION_WINDOW = 512;
/** Mid-stream observer: cumulative scan cap (UTF-16 code units, checked between feeds). */
export const MAX_MIDSTREAM_SCAN_LENGTH = 512 * 1024;
/** Mid-stream observer: findings retained per turn. */
const MAX_MIDSTREAM_FINDINGS = 8;
const MAX_ROUTING_COMMENTARY_BYTES = 512;
/** Aggregate quarantine cap: past this, flush and disarm. */
export const CURSOR_OUTPUT_GUARD_MAX_HOLD_BYTES = 8 * 1024;
const encoder = new TextEncoder();

export class CursorToolResultEchoError extends Error {
  readonly code = "cursor_tool_result_echo";
  constructor(marker: string) {
    super(
      "Cursor external model echoed the replayed tool-result envelope (\"" + marker
      + "\") instead of continuing the task.",
    );
    this.name = "CursorToolResultEchoError";
  }
}

export class CursorRoutingCommentaryError extends Error {
  readonly code = "cursor_routing_commentary_hallucination";
  constructor() {
    super("Cursor external model invented a blocked tool surface before any tool call occurred.");
    this.name = "CursorRoutingCommentaryError";
  }
}

export type EchoSnifferDecision =
  | { kind: "hold" }
  | { kind: "flush" }
  | { kind: "echo"; marker: string };

export interface MidstreamEchoFinding {
  marker: string;
  /** UTF-16 offset of the marker's line start within the turn's full text. */
  offset: number;
  callIdCorrupt: boolean;
}

/**
 * Diagnostic-only mid-stream envelope-echo observer (devlog 260828 F1/F2).
 *
 * The prefix sniffer only watches the first ~40 bytes of a turn, but live
 * probing caught grok-4.6 echoing "[Tool Result]" envelope blocks in the
 * MIDDLE of an agent message — after legitimate leading text — one of them
 * carrying a whitespace-spliced call-id ("fc_x mar-y" instead of "fc_x-y").
 * Deltas at that point have already reached the client, so this observer
 * never throws and never withholds output. It records findings so the adapter
 * can emit a structured diagnostic and remint the conversation for the next
 * turn at turn end. Only fixed marker
 * enums, numeric offsets, and corruption booleans are retained — never
 * content bytes.
 */
export class CursorMidstreamEchoObserver {
  private lineBuffer = "";
  private lineStartOffset = 0;
  private totalLength = 0;
  private disarmed = false;
  private lineDisarmed = false;
  private readonly corruptionWatches: Array<{
    finding: MidstreamEchoFinding;
    remaining: number;
    window: string;
  }> = [];
  private readonly recorded: MidstreamEchoFinding[] = [];

  feed(textDelta: string): void {
    if (this.disarmed && this.corruptionWatches.length === 0) return;
    let index = 0;
    while (index < textDelta.length) {
      const newline = textDelta.indexOf("\n", index);
      const segment = newline === -1 ? textDelta.slice(index) : textDelta.slice(index, newline);
      if (!this.disarmed && !this.lineDisarmed && segment.length > 0) {
        this.lineBuffer += segment;
        if (this.lineBuffer.length > MAX_MIDSTREAM_LINE_INDENT + 32) {
          // Bound per-line work: nothing beyond the indent cap + longest marker can match.
          this.lineDisarmed = !this.lineMatchesPrefixSoFar();
          this.lineBuffer = this.lineBuffer.slice(0, MAX_MIDSTREAM_LINE_INDENT + 32);
        }
        this.checkLine();
      }
      // Recognize the next marker before charging its line to a corruption window.
      // A call-id on the marker's own line belongs to the new finding as well.
      if (this.corruptionWatches.length > 0) {
        this.watchCorruption(segment + (newline === -1 ? "" : "\n"));
      }
      if (newline === -1) break;
      this.lineBuffer = "";
      this.lineDisarmed = false;
      this.lineStartOffset = this.totalLength + newline + 1;
      index = newline + 1;
    }
    this.totalLength += textDelta.length;
    if (this.totalLength > MAX_MIDSTREAM_SCAN_LENGTH) this.disarmed = true;
  }

  findings(): readonly MidstreamEchoFinding[] {
    while (this.corruptionWatches.length > 0) this.settleCorruption(0);
    return this.recorded;
  }

  private lineMatchesPrefixSoFar(): boolean {
    const probe = this.lineBuffer.replace(/^[ \t]*/, "");
    return ECHO_MARKERS.some(marker => probe.startsWith(marker) || marker.startsWith(probe));
  }

  private checkLine(): void {
    const indentMatch = /^[ \t]*/.exec(this.lineBuffer);
    const indent = indentMatch ? indentMatch[0].length : 0;
    if (indent > MAX_MIDSTREAM_LINE_INDENT) {
      this.lineDisarmed = true;
      return;
    }
    const probe = this.lineBuffer.slice(indent);
    for (const marker of ECHO_MARKERS) {
      if (probe.startsWith(marker)) {
        // The prefix sniffer owns the very start of the turn; only offsets past
        // its window count as mid-stream.
        if (this.lineStartOffset === 0) {
          this.lineDisarmed = true;
          return;
        }
        // A new marker ends the previous marker's corruption window: the text
        // between two markers belongs to the earlier finding only. Without this,
        // every open watch consumed the same following text, so one corrupt
        // call-id after a second marker also marked the first, clean finding
        // corrupt (clean-then-corrupt cross-contamination).
        while (this.corruptionWatches.length > 0) this.settleCorruption(0);
        if (this.recorded.length + this.corruptionWatches.length < MAX_MIDSTREAM_FINDINGS) {
          const finding: MidstreamEchoFinding = {
            marker,
            offset: this.lineStartOffset,
            callIdCorrupt: false,
          };
          this.corruptionWatches.push({
            finding,
            remaining: MIDSTREAM_CORRUPTION_WINDOW,
            window: "",
          });
        }
        this.lineDisarmed = true;
        return;
      }
    }
    if (!ECHO_MARKERS.some(marker => marker.startsWith(probe)) && probe.length > 0) {
      this.lineDisarmed = true;
    }
  }

  private watchCorruption(text: string): void {
    for (const watch of this.corruptionWatches) {
      const take = Math.min(watch.remaining, text.length);
      watch.window += text.slice(0, take);
      watch.remaining -= take;
    }
    let index = 0;
    while (index < this.corruptionWatches.length) {
      if (this.corruptionWatches[index]!.remaining <= 0) this.settleCorruption(index);
      else index += 1;
    }
  }

  private settleCorruption(index: number): void {
    const watch = this.corruptionWatches[index];
    if (!watch) return;
    const window = watch.window;
    watch.finding.callIdCorrupt =
      /fc_[0-9a-f]+[ \t]+mar-/.test(window)
      || /call_id: \S+[ \t]+\S+_0\b/.test(window);
    this.recorded.push(watch.finding);
    // Window text is discarded here; only booleans/offsets survive.
    this.corruptionWatches.splice(index, 1);
  }
}

/**
 * Incremental envelope-prefix sniffer. Leading whitespace is tolerated so a
 * marker copied after a newline is still caught.
 */
export class CursorEnvelopeEchoSniffer {
  private buffered = "";
  private byteCount = 0;
  private done = false;

  get settled(): boolean {
    return this.done;
  }

  feed(textDelta: string): EchoSnifferDecision {
    if (this.done) return { kind: "flush" };
    this.buffered += textDelta;
    this.byteCount += encoder.encode(textDelta).byteLength;
    const probe = this.buffered.replace(/^\s+/, "");
    for (const marker of ECHO_MARKERS) {
      if (probe.startsWith(marker)) {
        this.done = true;
        return { kind: "echo", marker };
      }
    }
    const stillPrefix = ECHO_MARKERS.some(marker =>
      probe.length < marker.length && marker.startsWith(probe),
    );
    if (
      stillPrefix
      && this.byteCount <= MAX_SNIFF_BYTES
      && this.buffered.length < CURSOR_OUTPUT_GUARD_MAX_HOLD_BYTES
    ) {
      return { kind: "hold" };
    }
    this.done = true;
    return { kind: "flush" };
  }

  finish(): EchoSnifferDecision {
    if (this.done) return { kind: "flush" };
    this.done = true;
    return { kind: "flush" };
  }
}

export type RoutingCommentaryDecision =
  | { kind: "hold" }
  | { kind: "flush" }
  | { kind: "hallucination" };

// The Korean alternative is deliberately asymmetric: it has a left boundary and no right one.
// Korean attaches particles directly to the noun, so the real sentences this detector exists to
// catch read "네이티브 셸이 차단되어..." and "네이티브 셸과 Read가...". A mirrored
// (?![\p{L}\p{M}\p{N}_]) lookahead would see the 이/과 particle as a letter and stop matching
// every one of them, which is why the negative cases below only probe the left side. Adding the
// right boundary looks like an obvious fix and disables the check; do not.
const ROUTING_NATIVE_TOOL_NAME = /\b(shell|read|grep|list|bash)\b|(?<![\p{L}\p{M}\p{N}_])네이티브\s*(?:셸|쉘)/giu;
const ROUTING_TOOL_HINT =
  /(?:\b(?:shell|read|grep|list|bash)\b|exec_command|shell_command|브리지|네이티브\s*(?:셸|쉘))/iu;
const ROUTING_FAILURE_CLAIM =
  /(?:blocked|unavailable|interrupted|차단|중단|막혀)/iu;
const ROUTING_REDIRECT_CLAIM =
  /(?:exec_command|shell_command|\bexec\b|브리지|redirected|fallback|switch(?:ed|ing)?|전환|우회|통과(?:되|하)|다른\s*(?:도구|경로)|경로로)/iu;

/**
 * Quarantines the first line of code-mode / bridge output long enough to reject
 * an impossible routing claim. It requires a failure claim plus either an
 * explicit redirect to another execution surface or two distinct unadvertised
 * native-tool names; a legitimate sentence such as "Shell is unavailable on
 * this OS" therefore passes.
 */
export class CursorRoutingCommentarySniffer {
  private buffered = "";
  private byteCount = 0;
  private done = false;

  get settled(): boolean {
    return this.done;
  }

  feed(textDelta: string): RoutingCommentaryDecision {
    if (this.done) return { kind: "flush" };
    this.buffered += textDelta;
    this.byteCount += encoder.encode(textDelta).byteLength;
    if (this.matchesHallucination()) {
      this.done = true;
      return { kind: "hallucination" };
    }
    const lineBreakCount = (this.buffered.match(/\n/gu) ?? []).length;
    const hasRoutingHint = ROUTING_TOOL_HINT.test(this.buffered) || ROUTING_FAILURE_CLAIM.test(this.buffered);
    const pendingFailureClaim =
      ROUTING_TOOL_HINT.test(this.buffered)
      && ROUTING_FAILURE_CLAIM.test(this.buffered)
      && lineBreakCount < 2;
    if (
      this.byteCount < MAX_ROUTING_COMMENTARY_BYTES
      && this.buffered.length < CURSOR_OUTPUT_GUARD_MAX_HOLD_BYTES
      && (lineBreakCount === 0 || pendingFailureClaim)
      && (hasRoutingHint || this.byteCount < 64)
    ) {
      return { kind: "hold" };
    }
    this.done = true;
    return { kind: "flush" };
  }

  finish(): RoutingCommentaryDecision {
    if (this.done) return { kind: "flush" };
    this.done = true;
    return this.matchesHallucination() ? { kind: "hallucination" } : { kind: "flush" };
  }

  private matchesHallucination(): boolean {
    if (!ROUTING_FAILURE_CLAIM.test(this.buffered)) return false;
    const nativeTools = new Set(
      [...this.buffered.matchAll(ROUTING_NATIVE_TOOL_NAME)].map(match => match[1]?.toLowerCase() ?? "shell"),
    );
    if (nativeTools.size === 0) return false;
    return ROUTING_REDIRECT_CLAIM.test(this.buffered) || nativeTools.size >= 2;
  }
}

export const CURSOR_ECHO_RETRY_CONTINUATION_TEXT =
  "Your previous reply copied an internal tool-output record verbatim and was rejected. Continue the original task now: issue the next required tool call, or answer in your own words if no tool is needed.";

export const CURSOR_ROUTING_COMMENTARY_RETRY_TEXT =
  "Your previous reply claimed an execution-surface failure that did not occur and was rejected. Use the current tool catalog as ground truth. Perform the requested operation through the advertised execution tool now, with no commentary before the tool call.";
