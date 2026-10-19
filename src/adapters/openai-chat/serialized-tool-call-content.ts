import type { TranslatorBudget } from "../../lib/translator-budget";
import type { AdapterEvent } from "../../types";
import { repairFreeformToolInput } from "../../responses/apply-patch-envelope";
import { contextAfter, deferredContinuationBreak, splitAtPossibleSerializedToolCall, MAX_TAG_LENGTH, TAG_SUFFIX, type TextContext } from "./serialized-tool-call-markup";
export { splitAtPossibleSerializedToolCall } from "./serialized-tool-call-markup";

/**
 * Streaming bounds (ingestStreaming only; buffered reconciliation already knows its structured calls).
 * MAX_HELD_BYTES is a runaway guard on held text plus queued events, far below the translator budget,
 * so a large duplicated write inside the block is still reconciled. MAX_TRAILING_CHARS bounds the
 * latency case: a duplicated block is the tail of the content (#5548), so a closed block followed by
 * this much prose, with no block open after it, is treated as prose and released.
 */
const MAX_HELD_BYTES = 4 * 1024 * 1024;
const MAX_TRAILING_CHARS = 8 * 1024;
export const MAX_STANDALONE_CANDIDATES = 128;

export interface SerializedToolCall {
  name: string;
  body: string;
  start: number;
  end: number;
}

/** A freeform tool's declared identity. Echoes are matched against it, never against the wire alias. */
export interface FreeformToolIdentity {
  name: string;
  namespace?: string;
}

/** The request's freeform tools keyed by the wire name the provider sees for each of them. */
export function freeformToolsByWireName<T extends FreeformToolIdentity & { freeform?: boolean }>(
  tools: readonly T[] | undefined,
  wireName: (tool: T) => string,
): Map<string, FreeformToolIdentity> {
  return new Map(tools?.filter(tool => tool.freeform).map(tool => [wireName(tool), { name: tool.name, namespace: tool.namespace }] as const) ?? []);
}

export interface StructuredToolCallReference {
  names: ReadonlySet<string>;
  argumentsText: string;
  freeformTool?: FreeformToolIdentity;
  recoveredParameterWrapper?: boolean;
}

const BLOCK_HEADER = new RegExp(`<tool_call(${TAG_SUFFIX})>\\s*<function=([^>\\r\\n]+)>`, "y");
/** A separate bare block starts a line (see `splitAtPossibleSerializedToolCall`); a header mid-line is body text. */
const NEXT_BLOCK_HEADER = new RegExp(`\\n<tool_call${TAG_SUFFIX}>\\s*<function=[^>\\r\\n]+>`, "g");
const FUNCTION_CLOSE = "</function>";
const PARAMETER_CLOSE = "</parameter>";

function trimmedEnd(text: string, from: number, to: number): number {
  while (to > from && /\s/.test(text[to - 1]!)) to--;
  return to;
}

function endsWithAt(text: string, from: number, to: number, suffix: string): boolean {
  return to - suffix.length >= from && text.startsWith(suffix, to - suffix.length);
}

/**
 * The block starting at `offset`, read by delimiter scan so an unterminated block costs linear time.
 * MiMo's echo may close a freeform body with a stray `</parameter>` and may omit `</function>`
 * (#5724), the grammar the Command Code reader accepts too. The first `</tool_call>` preceded by
 * `</function>` closes the block, so a body can still carry a literal `</tool_call>` or header;
 * with none before the next line-start block header, the first `</tool_call>` does. That header only
 * bounds an unclosed candidate: with no close at all before it, it is body text, and a closed
 * `</function></tool_call>` after it still ends the block.
 */
function blockAt(text: string, offset: number, nextHeaderAt: (from: number) => number): SerializedToolCall | undefined {
  BLOCK_HEADER.lastIndex = offset;
  const header = BLOCK_HEADER.exec(text);
  if (!header) return undefined;
  const closeTag = `</tool_call${header[1]}>`;
  const bodyStart = offset + header[0].length;
  const limit = nextHeaderAt(bodyStart);
  let unclosed: SerializedToolCall | undefined;
  for (let close = text.indexOf(closeTag, bodyStart); close >= 0 && (close < limit || !unclosed);
    close = text.indexOf(closeTag, close + closeTag.length)) {
    let bodyEnd = trimmedEnd(text, bodyStart, close);
    const closed = endsWithAt(text, bodyStart, bodyEnd, FUNCTION_CLOSE);
    if (closed) bodyEnd = trimmedEnd(text, bodyStart, bodyEnd - FUNCTION_CLOSE.length);
    if (endsWithAt(text, bodyStart, bodyEnd, PARAMETER_CLOSE)) bodyEnd -= PARAMETER_CLOSE.length;
    const call = {
      name: header[2]!.trim(),
      body: text.slice(bodyStart, bodyEnd),
      start: offset,
      end: close + closeTag.length,
    };
    if (closed) return call;
    if (close < limit) unclosed ??= call;
  }
  return unclosed;
}

/** Finds outer blocks outside literal Markdown, reporting an unresolved enclosing header. */
export function scanSerializedToolCalls(
  text: string, context: TextContext = { fence: null, lineStart: true }, allowMidLineBare = false,
  maxCandidates = allowMidLineBare ? MAX_STANDALONE_CANDIDATES : Infinity,
): { calls: SerializedToolCall[]; incomplete: boolean; overflow: boolean } {
  const calls: SerializedToolCall[] = [];
  // Adjacent same-line blocks share one forward-only newline-header search, including EOF.
  const headers = new RegExp(NEXT_BLOCK_HEADER.source, "g");
  let next = headers.exec(text);
  const nextHeaderAt = (from: number): number => {
    while (next && next.index + 1 < from) next = headers.exec(text);
    return next ? next.index + 1 : text.length;
  };
  let offset = 0;
  while (offset < text.length) {
    const split = splitAtPossibleSerializedToolCall(text.slice(offset), context, true, allowMidLineBare);
    offset += split.emit.length;
    if (!split.hasOpenTag) break;
    if (calls.length >= maxCandidates) return { calls, incomplete: false, overflow: true };
    const match = blockAt(text, offset, nextHeaderAt);
    if (!match) return { calls, incomplete: true, overflow: false }; // An unresolved outer block cannot authorize an inner call.
    calls.push(match);
    offset = match.end;
    context = { fence: null, lineStart: false };
  }
  return { calls, incomplete: false, overflow: false };
}

function callsIn(text: string, context?: TextContext, allowMidLineBare = false): SerializedToolCall[] {
  return scanSerializedToolCalls(text, context, allowMidLineBare).calls;
}

/** Standalone recovery is separate from identified-wrapper/empty-structured-input reconciliation. */
export function hasNestedSerializedToolCallHeader(body: string): boolean {
  return /<(?:tool_call(?:_[a-fA-F0-9]{1,64})?|function=[^>\r\n]+)>/.test(body);
}

export function recoverStandaloneBareBlocks(
  text: string,
  freeformTools: ReadonlyMap<string, FreeformToolIdentity>,
  context?: TextContext,
): { name: string; input: string; start: number; end: number }[] {
  if (freeformTools.size === 0) return [];
  const scan = scanSerializedToolCalls(text, context, true);
  if (scan.overflow) return [];
  const blocks = scan.calls;
  // A nested header makes delimiter ownership ambiguous; no later apparent sibling is safe.
  if (blocks.some(call => hasNestedSerializedToolCallHeader(call.body))) return [];
  return blocks.flatMap(call => {
    if (!text.startsWith("<tool_call>", call.start) || !freeformTools.has(call.name)) return [];
    const wrapped = freeformBody(call.body);
    const recoveredParameterWrapper = wrapped.startsWith("<parameter=");
    const input = recoveredParameterWrapper ? freeformBody(wrapped.slice("<parameter=".length)) : wrapped;
    if (!input.trim()
        || (recoveredParameterWrapper && /^<parameter=[A-Za-z_$][\w$.-]*>/.test(wrapped))
        || input.includes("<parameter=") || input.includes("</parameter>")) return [];
    return [{ name: call.name, input, start: call.start, end: call.end }];
  });
}

/**
 * The first block, and only when the text after it is exactly one repetition of that same block
 * (trailing whitespace allowed). The returned range covers the pair and any trailing whitespace.
 */
function repeatedCallIn(text: string, context?: TextContext): SerializedToolCall | undefined {
  const first = callsIn(text, context)[0];
  if (!first) return undefined;
  if (text.slice(first.end).trimEnd() !== text.slice(first.start, first.end).trimEnd()) return undefined;
  return { ...first, end: text.length };
}

/**
 * Holds possible duplicate text within the shared translator budget until the dispatch outcome is
 * known. While a block candidate is open, any other event (reasoning) is queued at its position in
 * the held text rather than overtaking it or forcing the block out early, and `drain` restores the
 * original order.
 */
export class SerializedToolCallContentBuffer {
  releasedAnswerText = false;
  private text = "";
  private bytes = 0;
  private hasOpenTag = false;
  private continuationBreak: RegExp | undefined;
  private delimiterSuffix = "";
  private sawCloser = false;
  private openAfterCloser = false;
  private trailingProseChars = 0;
  protected context: TextContext = { fence: null, lineStart: true };
  private queued: { offset: number; event: AdapterEvent }[] = [];

  constructor(private readonly budget: TranslatorBudget, private readonly allowMidLineBare = false) {}

  /** Optional recovery retains bounded candidates before prose is released, never the prose itself. */
  protected releaseBounded(): AdapterEvent[] { return this.drain([]); }

  /** Remembers visible text released before a later structured call can be reconciled. */
  private observeText(events: AdapterEvent[]): AdapterEvent[] {
    if (events.some(event => event.type === "text_delta" && event.text.trim() !== "")) this.releasedAnswerText = true;
    return events;
  }

  /** Measures an append exactly even when the runtime prices isolated UTF-16 surrogates differently. */
  private appendedByteLength(delta: string): number {
    let bytes = Buffer.byteLength(delta);
    if (this.text.length === 0 || delta.length === 0) return bytes;
    const tail = this.text[this.text.length - 1]!;
    const head = delta[0]!;
    const tailCode = tail.charCodeAt(0);
    const headCode = head.charCodeAt(0);
    if (tailCode >= 0xd800 && tailCode <= 0xdbff && headCode >= 0xdc00 && headCode <= 0xdfff) {
      bytes += Buffer.byteLength(tail + head) - Buffer.byteLength(tail) - Buffer.byteLength(head);
    }
    return bytes;
  }

  /** Reserves the replacement before releasing the old text, preserving it if the budget rejects growth. */
  private replace(next: string, hasOpenTag: boolean): void {
    const nextBytes = Buffer.byteLength(next);
    const reservation = this.budget.reserveTransient(nextBytes, { kind: "live_transient" });
    try {
      reservation.commitRetained();
      this.budget.releaseRetained(this.bytes, { kind: "live_transient" });
      this.text = next;
      this.bytes = nextBytes;
      this.hasOpenTag = hasOpenTag;
      this.continuationBreak = undefined;
      this.delimiterSuffix = "";
      this.sawCloser = false;
      this.openAfterCloser = false;
      this.trailingProseChars = 0;
      if (hasOpenTag) this.observeDelimiters(next);
    } catch (error) {
      reservation.release();
      throw error;
    }
  }

  /** Charges only the appended bytes, so holding an open block never needs twice its retained size. */
  private append(delta: string): void {
    const deltaBytes = this.appendedByteLength(delta);
    this.budget.reserveTransient(deltaBytes, { kind: "live_transient" }).commitRetained();
    if (this.hasOpenTag) this.observeDelimiters(delta);
    this.text += delta;
    this.bytes += deltaBytes;
  }

  /** Scan new text plus a fixed overlap, never the retained body (which may be a large rope). */
  private observeDelimiters(delta: string): void {
    const scan = this.delimiterSuffix + delta;
    const tags = scan.matchAll(new RegExp(`<(/?)tool_call${TAG_SUFFIX}>`, "g"));
    let afterCloser = -1;
    for (const tag of tags) {
      if (tag.index! + tag[0].length <= this.delimiterSuffix.length) continue;
      if (tag[1]) {
        this.sawCloser = true;
        this.openAfterCloser = false;
        this.trailingProseChars = 0;
        afterCloser = tag.index! + tag[0].length;
      } else {
        this.openAfterCloser = true;
      }
    }
    const tail = afterCloser >= 0 ? scan.slice(afterCloser) : delta;
    if (this.sawCloser) this.trailingProseChars += tail.replace(/\s+/g, "").length;
    this.delimiterSuffix = scan.slice(-(MAX_TAG_LENGTH - 1));
  }

  /** Returns immediately safe text and retains only the suffix that still needs reconciliation. */
  ingest(delta: string): string {
    if (this.hasOpenTag || (this.continuationBreak && !this.continuationBreak.test(delta))) {
      this.append(delta);
      return "";
    }
    const split = splitAtPossibleSerializedToolCall(this.text + delta, this.context, false, this.allowMidLineBare);
    this.replace(split.defer, split.hasOpenTag);
    this.context = split.context;
    if (!split.hasOpenTag) this.continuationBreak = deferredContinuationBreak(split.defer, split.context);
    return split.emit;
  }

  /**
   * Streaming ingest with bounded retention. Past either bound the stream prefers delivering text
   * over suppressing a possible duplicate: everything held is released in order, nothing is
   * suppressed (the behaviour before #5548 for that block), and scanning resumes from the carried
   * context. The size bound is checked before the delta is retained.
   */
  ingestStreaming(delta: string): AdapterEvent[] {
    const deltaBytes = this.appendedByteLength(delta);
    if (this.hasOpenTag && this.bytes + deltaBytes > MAX_HELD_BYTES) {
      const released = this.releaseBounded();
      // A delta that alone passes the bound is delivered as text rather than retained.
      if (Buffer.byteLength(delta) > MAX_HELD_BYTES) {
        this.context = contextAfter(delta, this.context);
        return this.observeText([...released, ...textEvents(delta)]);
      }
      return this.observeText([...released, ...textEvents(this.ingest(delta))]);
    }
    const text = this.ingest(delta);
    // Checked after ingest too: one delta can open a block and already carry more than a bound.
    if (this.hasOpenTag && (this.bytes > MAX_HELD_BYTES || (this.sawCloser && !this.openAfterCloser && this.trailingProseChars > MAX_TRAILING_CHARS))) {
      return this.observeText([...textEvents(text), ...this.releaseBounded()]);
    }
    return this.observeText(textEvents(text));
  }

  /** Exposes held text as evidence for narrowly repairing duplicated argument prefixes. */
  current(): string {
    return this.text;
  }

  /**
   * Passes a non-text event through, in order. With an open block candidate held, the event is
   * queued behind the held text and a heartbeat stands in for it; with only a partial prefix held (no complete opening tag yet),
   * that prefix cannot be a whole duplicate and is released ahead of the event.
   */
  hold(event: AdapterEvent): AdapterEvent[] {
    if (!this.hasOpenTag) return [...this.drain([]), event];
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    // Queued events count toward the same runaway bound as held text.
    if (this.bytes + eventBytes > MAX_HELD_BYTES) return [...this.releaseBounded(), event];
    this.budget.reserveTransient(eventBytes, { kind: "live_transient" }).commitRetained();
    this.bytes += eventBytes;
    this.queued.push({ offset: this.text.length, event });
    // The consumer still sees activity, so a stall watchdog never mistakes a held turn for a dead one.
    return [{ type: "heartbeat" }];
  }

  /**
   * Drains held text and queued events in their original order, suppressing only blocks that
   * duplicate a dispatched call; pass an empty list on failure to preserve everything.
   */
  drain(structuredCalls: readonly StructuredToolCallReference[]): AdapterEvent[] {
    return this.drainRanges(duplicatedSerializedToolCallRanges(this.text, structuredCalls, this.context));
  }

  /** Standalone recovery supplies only its own accepted bare ranges, never identified wrappers. */
  protected drainRanges(removed: readonly { start: number; end: number }[]): AdapterEvent[] {
    const kept = (from: number, to: number): string => {
      let piece = "";
      let cursor = from;
      for (const range of removed) {
        if (range.end <= cursor || range.start >= to) continue;
        piece += this.text.slice(cursor, Math.max(cursor, range.start));
        cursor = Math.min(to, range.end);
      }
      return piece + this.text.slice(cursor, to);
    };
    const out: AdapterEvent[] = [];
    let cursor = 0;
    for (const boundary of [...this.queued, { offset: this.text.length, event: undefined }]) {
      const text = kept(cursor, boundary.offset);
      if (text.length > 0) out.push({ type: "text_delta", text });
      if (boundary.event) out.push(boundary.event);
      cursor = boundary.offset;
    }
    // Control bodies are opaque on every provider, regardless of standalone recovery eligibility.
    // Context still traverses the whole released text when recovery hit its candidate limit.
    const last = scanSerializedToolCalls(this.text, this.context, this.allowMidLineBare, Infinity).calls.at(-1);
    this.context = last ? contextAfter(this.text.slice(last.end), { fence: null, lineStart: false })
      : contextAfter(this.text, this.context);
    this.queued = [];
    this.replace("", false);
    return this.observeText(out);
  }

  /** Text-only drain for callers that never queued an event. */
  flush(structuredCalls: readonly StructuredToolCallReference[]): string {
    return this.drain(structuredCalls)
      .map(event => (event.type === "text_delta" ? event.text : ""))
      .join("");
  }

  /** Releases retained bytes when the stream ends or its consumer cancels iteration. */
  dispose(): void {
    this.budget.releaseRetained(this.bytes, { kind: "live_transient" });
    this.text = "";
    this.bytes = 0;
    this.hasOpenTag = false;
    this.continuationBreak = undefined;
    this.queued = [];
  }
}

/** Reads a wrapped input or raw arguments from a declared freeform tool; neither path rewrites them. */
function inputFromArguments(
  argumentsText: string,
  freeformTool?: FreeformToolIdentity,
): string | undefined {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    const input = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).input
      : undefined;
    if (typeof input === "string") return input;
  } catch {
    // Chat gateways can send custom-tool input as raw text.
  }
  if (!freeformTool) return undefined;
  // Match raw input only when the Responses bridge dispatches these same bytes. It can unwrap
  // alternate fields or repair freeform input using the declared tool's name and namespace.
  return repairFreeformToolInput(argumentsText, freeformTool.name, freeformTool.namespace) === argumentsText
    ? argumentsText : undefined;
}

/** One wrapping newline after the function header is template layout, not input (vLLM `_trim_wrapping_newlines`). */
function freeformBody(value: string): string {
  return value.replace(/^\r?\n/, "").trimEnd();
}

/**
 * Whether a structured call's freeform input already equals the body of `repeated`. Such a call
 * explains the repeated pair on its own, which is what competes with a doubled call in the same
 * batch: both readings account for the two blocks, and the response never says which one it meant.
 */
function agreesWithRepeatedBlock(
  structured: StructuredToolCallReference,
  repeated: SerializedToolCall,
): boolean {
  const input = structured.names.has(repeated.name) ? inputFromArguments(structured.argumentsText, structured.freeformTool) : undefined;
  return input !== undefined && freeformBody(input) === freeformBody(repeated.body);
}

/** A second call can explain a repeated pair even when its arguments cannot safely be rewritten. */
function hasDoubledInput(structured: StructuredToolCallReference, repeated: SerializedToolCall): boolean {
  if (!structured.names.has(repeated.name)) return false;
  const input = inputFromArguments(structured.argumentsText, structured.freeformTool);
  if (input === undefined) return false;
  const body = freeformBody(repeated.body);
  const normalized = freeformBody(input);
  return normalized === body + body || normalized === body + "\n" + body;
}

/** The `[start, end)` ranges of blocks whose function identity and freeform input match a dispatched call. */
function duplicatedSerializedToolCallRanges(
  text: string,
  structuredCalls: readonly StructuredToolCallReference[],
  context?: TextContext,
): { start: number; end: number }[] {
  if (structuredCalls.length === 0) return [];
  const repeated = repeatedCallIn(text, context);
  if (repeated) {
    // A doubled call beside an agreeing call leaves the pair ambiguous. If reduction was
    // refused, keep the markup too: otherwise the visible text and executable call disagree.
    const matching = structuredCalls.filter(structured => agreesWithRepeatedBlock(structured, repeated));
    const doubled = structuredCalls.some(structured => structured !== matching[0] && hasDoubledInput(structured, repeated));
    return matching.length === 1 && !doubled ? [{ start: repeated.start, end: repeated.end }] : [];
  }
  return callsIn(text, context).filter(call => {
    const body = freeformBody(call.body);
    return structuredCalls.some(structured => {
      const input = structured.names.has(call.name) ? inputFromArguments(structured.argumentsText, structured.freeformTool) : undefined;
      if (input === undefined) return false;
      const normalized = freeformBody(input);
      return normalized === body || (structured.recoveredParameterWrapper === true
        && body.startsWith("<parameter=") && normalized === freeformBody(body.slice("<parameter=".length)));
    });
  });
}

/** Removes eligible blocks only when both the function identity and freeform input match a dispatched call. */
export function stripDuplicatedSerializedToolCalls(
  text: string,
  structuredCalls: readonly StructuredToolCallReference[],
  context?: TextContext,
): string {
  let result = "";
  let cursor = 0;
  for (const range of duplicatedSerializedToolCallRanges(text, structuredCalls, context)) {
    result += text.slice(cursor, range.start);
    cursor = range.end;
  }
  return result + text.slice(cursor);
}

/**
 * The reduced arguments when the freeform body of the repeated block is written twice in the
 * single string "input" field, or undefined for any other shape. Only the batch reconciler may
 * apply it: the reduction rewrites executable arguments, so it needs a uniqueness proof.
 */
function doubledInputReduction(
  argumentsText: string,
  functionNames: ReadonlySet<string>,
  repeated: SerializedToolCall,
): string | undefined {
  if (!functionNames.has(repeated.name)) return undefined;
  const body = freeformBody(repeated.body);
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        && Object.keys(parsed).length === 1
        && ((parsed as Record<string, unknown>).input === body + body
          || (parsed as Record<string, unknown>).input === body + "\n" + body)) {
      return JSON.stringify({ input: body });
    }
  } catch {
    // A malformed concatenation is handled by the prefix repair instead.
  }
  return undefined;
}

/** Removes a malformed argument prefix only when a bare block and the JSON suffix prove identical input. */
export function repairArgumentsDuplicatedBesideSerializedCall(
  argumentsText: string,
  functionNames: ReadonlySet<string>,
  serializedText: string,
): string {
  try {
    JSON.parse(argumentsText);
    return argumentsText;
  } catch {
    // Continue only for the exact duplication shape emitted by some Chat gateways.
  }

  const bodies = callsIn(serializedText)
    .filter(call => functionNames.has(call.name))
    .map(call => call.body.trimEnd());
  if (bodies.length === 0) return argumentsText;

  for (const body of bodies) {
    if (!argumentsText.startsWith(body)) continue;
    let start = body.length;
    while (start < argumentsText.length && /\s/.test(argumentsText[start]!)) start += 1;
    const candidate = argumentsText.slice(start);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const input = (parsed as Record<string, unknown>).input;
    if (typeof input !== "string") continue;
    if (body !== input.trimEnd()) continue;
    return candidate;
  }
  return argumentsText;
}

/** One structured call as the reconciler sees it, before its arguments meet the visible text. */
export interface StructuredToolCallInput {
  wireName: string;
  restoredName: string;
  argumentsText: string;
  freeformTool?: FreeformToolIdentity;
}

/**
 * Repairs the arguments of every structured call in one response against the visible text that
 * response carried, and returns them in input order. The per-call prefix repair stands alone,
 * because the markup it proves is matched against that call's own repaired input. The
 * doubled-input reduction is applied only when exactly one call in the batch explains the repeated
 * pair, including doubled shapes that cannot themselves be rewritten. It rewrites executable
 * arguments, so a second explanatory call leaves the pair ambiguous.
 */
export function reconcileStructuredToolCalls(
  calls: readonly StructuredToolCallInput[],
  serializedText: string,
  recoverEmptyMiMoFreeformInput = false,
): StructuredToolCallReference[] {
  const references: StructuredToolCallReference[] = calls.map(call => {
    const names = new Set([call.wireName, call.restoredName]);
    return { names, freeformTool: call.freeformTool, argumentsText: repairArgumentsDuplicatedBesideSerializedCall(call.argumentsText, names, serializedText) };
  });
  if (recoverEmptyMiMoFreeformInput && calls.length === 1 && calls[0]!.freeformTool
      && emptyObjectArguments(references[0]!.argumentsText)) {
    // A standalone MiMo block and one empty call to the exact wire tool provide the only
    // unambiguous recovery shape. Prose before/after it or another call keeps text inert.
    const blocks = callsIn(serializedText);
    if (blocks.length === 1 && serializedText.slice(0, blocks[0]!.start).trim() === ""
        && serializedText.slice(blocks[0]!.end).trim() === "") {
      const block = blocks[0]!;
      const wrappedBody = freeformBody(block.body);
      // MiMo can put the freeform input after a malformed `<parameter=` opener.
      const hasParameterOpener = wrappedBody.startsWith("<parameter=");
      const body = hasParameterOpener
        ? freeformBody(wrappedBody.slice("<parameter=".length)) : wrappedBody;
      if (block.name === calls[0]!.wireName && body.trim() !== ""
          && !new RegExp(`(?:^|\\n)<tool_call${TAG_SUFFIX}>\\s*<function=[^>\\r\\n]+>`).test(block.body)
          && !(hasParameterOpener && /^<parameter=[A-Za-z_$][\w$.-]*>/.test(wrappedBody))
          && !body.includes("<parameter=") && !body.includes("</parameter>")) {
        references[0] = { ...references[0]!, argumentsText: JSON.stringify({ input: body }),
          recoveredParameterWrapper: hasParameterOpener };
      }
    }
  }
  return reduceUnambiguousDoubledInput(references, serializedText);
}

/** An empty JSON object means the structured freeform call supplied no input. */
function emptyObjectArguments(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

/**
 * Applies the doubled-input reduction across the batch. The doubled shape is valid JSON, so the
 * prefix repair returns it untouched, and the reduction only ever rewrites a call the repair left
 * alone. A call whose input already equals the repeated body is a competing explanation, not a
 * bystander: both readings account for the pair and the response never picks one, so a batch with
 * two qualifying calls keeps every argument exactly as sent. The reduction then rewrites nothing,
 * and the range matcher keeps the markup when a doubled call competes with an agreeing call.
 * An already-agreeing call leaves nothing to reduce.
 */
function reduceUnambiguousDoubledInput(
  references: readonly StructuredToolCallReference[],
  serializedText: string,
): StructuredToolCallReference[] {
  const repeated = repeatedCallIn(serializedText);
  if (!repeated) return [...references];
  const candidates = references.map(reference => ({
    reduction: doubledInputReduction(reference.argumentsText, reference.names, repeated),
    explains: agreesWithRepeatedBlock(reference, repeated),
    doubled: hasDoubledInput(reference, repeated),
  }));
  if (candidates.filter(candidate => candidate.explains || candidate.doubled).length !== 1) {
    return [...references];
  }
  return references.map((reference, index) => {
    const reduction = candidates[index]!.reduction;
    return reduction === undefined ? reference : { ...reference, argumentsText: reduction };
  });
}

/**
 * One structured call as the reconciler sees it: both the wire name and its restored client name
 * identify it, and its arguments are repaired against the visible text the same response carried.
 * A single call is its own batch, so the doubled-input reduction still applies here; a caller
 * holding several calls of one response must pass them together to
 * `reconcileStructuredToolCalls` so the reduction sees all of them.
 */
export function reconcileStructuredToolCall(
  wireName: string,
  restoredName: string,
  argumentsText: string,
  serializedText: string,
): StructuredToolCallReference {
  return reconcileStructuredToolCalls([{ wireName, restoredName, argumentsText }], serializedText)[0]!;
}

/**
 * Buffered-response counterpart of the streaming path, applied in place to the content events in
 * `events[start, end)`. It replays them through the same buffer the stream uses, so both paths
 * share one rule set: text carries its line and fence context across events (the inline-think
 * splitter may cut one answer into several), any other event keeps its place relative to held
 * text, and only text still held at the end is matched against the structured calls.
 */
export function reconcileSerializedToolCallEvents(
  events: AdapterEvent[],
  start: number,
  end: number,
  structuredCalls: readonly StructuredToolCallReference[],
  budget: TranslatorBudget,
): void {
  if (structuredCalls.length === 0) return;
  const buffer = new SerializedToolCallContentBuffer(budget);
  const reconciled: AdapterEvent[] = [];
  try {
    for (const event of events.slice(start, end)) {
      if (event.type !== "text_delta") { reconciled.push(...buffer.hold(event).filter(held => held.type !== "heartbeat")); continue; }
      const text = buffer.ingest(event.text);
      if (text.length > 0) reconciled.push({ type: "text_delta", text });
    }
    reconciled.push(...buffer.drain(structuredCalls));
  } finally {
    buffer.dispose();
  }
  events.splice(start, end - start, ...reconciled);
}

function textEvents(text: string): AdapterEvent[] {
  return text.length > 0 ? [{ type: "text_delta", text }] : [];
}
