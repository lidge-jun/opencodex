import type { TranslatorBudget } from "../../lib/translator-budget";
import type { AdapterEvent } from "../../types";

const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";
const FUNCTION_TAG = "<function=";
/**
 * Streaming bounds (ingestStreaming only; buffered reconciliation already knows its structured calls).
 * MAX_HELD_BYTES is a runaway guard on held text plus queued events, far below the translator budget,
 * so a large duplicated write inside the block is still reconciled. MAX_TRAILING_CHARS bounds the
 * latency case: a duplicated block is the tail of the content (#5548), so a closed block followed by
 * this much prose, with no block open after it, is treated as prose and released.
 */
const MAX_HELD_BYTES = 4 * 1024 * 1024;
const MAX_TRAILING_CHARS = 8 * 1024;

interface TextContext {
  fence: string | null;
  lineStart: boolean;
  inlineTicks?: number;
}

export interface SerializedToolCall {
  name: string;
  body: string;
  start: number;
  end: number;
}

export interface StructuredToolCallReference {
  names: ReadonlySet<string>;
  argumentsText: string;
}

const BLOCK_HEADER = /<tool_call>\s*<function=([^>\r\n]+)>/y;
/** A separate bare block starts a line (see `splitAtPossibleSerializedToolCall`); a header mid-line is body text. */
const NEXT_BLOCK_HEADER = /\n<tool_call>\s*<function=[^>\r\n]+>/g;
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
function blockAt(text: string, offset: number): SerializedToolCall | undefined {
  BLOCK_HEADER.lastIndex = offset;
  const header = BLOCK_HEADER.exec(text);
  if (!header) return undefined;
  const bodyStart = offset + header[0].length;
  NEXT_BLOCK_HEADER.lastIndex = bodyStart;
  const next = NEXT_BLOCK_HEADER.exec(text);
  const limit = next ? next.index + 1 : text.length;
  let unclosed: SerializedToolCall | undefined;
  for (let close = text.indexOf(CLOSE_TAG, bodyStart); close >= 0 && (close < limit || !unclosed);
    close = text.indexOf(CLOSE_TAG, close + CLOSE_TAG.length)) {
    let bodyEnd = trimmedEnd(text, bodyStart, close);
    const closed = endsWithAt(text, bodyStart, bodyEnd, FUNCTION_CLOSE);
    if (closed) bodyEnd = trimmedEnd(text, bodyStart, bodyEnd - FUNCTION_CLOSE.length);
    if (endsWithAt(text, bodyStart, bodyEnd, PARAMETER_CLOSE)) bodyEnd -= PARAMETER_CLOSE.length;
    const call = {
      name: header[1]!.trim(),
      body: text.slice(bodyStart, bodyEnd),
      start: offset,
      end: close + CLOSE_TAG.length,
    };
    if (closed) return call;
    if (close < limit) unclosed ??= call;
  }
  return unclosed;
}

/** Finds complete bare blocks outside literal Markdown; ambiguous outer blocks stop the scan. */
function callsIn(text: string, context: TextContext = { fence: null, lineStart: true }): SerializedToolCall[] {
  const calls: SerializedToolCall[] = [];
  let offset = 0;
  while (offset < text.length) {
    const split = splitAtPossibleSerializedToolCall(text.slice(offset), context, true);
    offset += split.emit.length;
    if (!split.hasOpenTag) break;
    const match = blockAt(text, offset);
    if (!match) break; // An incomplete/ambiguous outer block cannot authorize an inner call.
    calls.push(match);
    offset = match.end;
    context = { fence: null, lineStart: false };
  }
  return calls;
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

/** Splits safe visible text from a possible control block while carrying Markdown context across chunks. */
export function splitAtPossibleSerializedToolCall(
  text: string,
  initialContext: TextContext = { fence: null, lineStart: true },
  final = false,
): {
  emit: string;
  defer: string;
  hasOpenTag: boolean;
  context: TextContext;
} {
  const context = { ...initialContext };
  const split = (at: number, hasOpenTag = false) => ({
    emit: text.slice(0, at), defer: text.slice(at), hasOpenTag, context,
  });
  for (let index = 0; index < text.length; index++) {
    if (context.lineStart) {
      const rest = text.slice(index);
      const fence = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(rest);
      if (!context.inlineTicks && fence && (!context.fence || (fence[1]![0] === context.fence[0]
          && fence[1]!.length >= context.fence.length && /^[ \t\r]*$/.test(fence[2]!)))) {
        if (!final && !rest.includes("\n")) return split(index);
        context.fence = context.fence ? null : fence[1]!;
        index += fence[0].length - 1;
        context.lineStart = false;
        continue;
      }
      if (!final && /^ {0,3}(`*|~*)$/.test(rest)) return split(index);
      // Only bare control markup qualifies. Prose, quotes, indented examples and
      // fenced code stay user-visible even when their body matches a real call.
      if (!context.fence && !context.inlineTicks) {
        if (rest.startsWith(OPEN_TAG)) {
          const header = rest.slice(OPEN_TAG.length).trimStart();
          if (/^<function=[^>\r\n]+>/.test(header)) return split(index, true);
          if (!final && (FUNCTION_TAG.startsWith(header)
              || (header.startsWith(FUNCTION_TAG) && !/[>\r\n]/.test(header.slice(FUNCTION_TAG.length))))) {
            return split(index);
          }
        } else if (!final && OPEN_TAG.startsWith(rest)) return split(index);
      }
    }
    if (!context.fence && text[index] === "`") {
      let end = index + 1;
      while (text[end] === "`") end++;
      if (!final && end === text.length) return split(index);
      const ticks = end - index;
      if (!context.inlineTicks) context.inlineTicks = ticks;
      else if (context.inlineTicks === ticks) context.inlineTicks = undefined;
      index = end - 1;
    }
    context.lineStart = text[index] === "\n";
  }
  return split(text.length);
}

/**
 * The line, fence and inline-code state after `text`. Serialized blocks are neutralised first so
 * the scan runs through the whole text instead of stopping at the first opening tag; a block ends
 * mid-line, which is exactly what the neutral spelling reports too.
 */
function contextAfter(text: string, context: TextContext): TextContext {
  if (text.length === 0) return context;
  return splitAtPossibleSerializedToolCall(text.replaceAll(OPEN_TAG, "<tool-call>"), context, true).context;
}

/**
 * Holds possible duplicate text within the shared translator budget until the dispatch outcome is
 * known. While a block candidate is open, any other event (reasoning) is queued at its position in
 * the held text rather than overtaking it or forcing the block out early, and `drain` restores the
 * original order.
 */
export class SerializedToolCallContentBuffer {
  private text = "";
  private bytes = 0;
  private hasOpenTag = false;
  private context: TextContext = { fence: null, lineStart: true };
  private queued: { offset: number; event: AdapterEvent }[] = [];

  constructor(private readonly budget: TranslatorBudget) {}

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
    } catch (error) {
      reservation.release();
      throw error;
    }
  }

  /** Charges only the appended bytes, so holding an open block never needs twice its retained size. */
  private append(delta: string): void {
    const deltaBytes = Buffer.byteLength(delta);
    this.budget.reserveTransient(deltaBytes, { kind: "live_transient" }).commitRetained();
    this.text += delta;
    this.bytes += deltaBytes;
  }

  /** Returns immediately safe text and retains only the suffix that still needs reconciliation. */
  ingest(delta: string): string {
    if (this.hasOpenTag) {
      this.append(delta);
      return "";
    }
    const split = splitAtPossibleSerializedToolCall(this.text + delta, this.context);
    this.replace(split.defer, split.hasOpenTag);
    this.context = split.context;
    return split.emit;
  }

  /**
   * Streaming ingest with bounded retention. Past either bound the stream prefers delivering text
   * over suppressing a possible duplicate: everything held is released in order, nothing is
   * suppressed (the behaviour before #5548 for that block), and scanning resumes from the carried
   * context. The size bound is checked before the delta is retained.
   */
  ingestStreaming(delta: string): AdapterEvent[] {
    const deltaBytes = Buffer.byteLength(delta);
    if (this.hasOpenTag && this.bytes + deltaBytes > MAX_HELD_BYTES) {
      const released = this.drain([]);
      // A delta that alone passes the bound is delivered as text rather than retained.
      if (deltaBytes > MAX_HELD_BYTES) {
        this.context = contextAfter(delta, this.context);
        return [...released, ...textEvents(delta)];
      }
      return [...released, ...textEvents(this.ingest(delta))];
    }
    const text = this.ingest(delta);
    // Checked after ingest too: one delta can open a block and already carry more than a bound.
    if (this.hasOpenTag && (this.bytes > MAX_HELD_BYTES || proseAfterClosedBlock(this.text) > MAX_TRAILING_CHARS)) {
      return [...textEvents(text), ...this.drain([])];
    }
    return textEvents(text);
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
    if (this.bytes + eventBytes > MAX_HELD_BYTES) return [...this.drain([]), event];
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
    const removed = duplicatedSerializedToolCallRanges(this.text, structuredCalls, this.context);
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
    // Later text continues after what was drained, so its line and fence state carry forward.
    this.context = contextAfter(this.text, this.context);
    this.queued = [];
    this.replace("", false);
    return out;
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
    this.queued = [];
  }
}

/** Reads only a string input from a JSON object; other argument shapes cannot prove duplication. */
function inputFromArguments(argumentsText: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const input = (parsed as Record<string, unknown>).input;
    return typeof input === "string" ? input : undefined;
  } catch {
    return undefined;
  }
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
  const input = structured.names.has(repeated.name) ? inputFromArguments(structured.argumentsText) : undefined;
  return input !== undefined && freeformBody(input) === freeformBody(repeated.body);
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
    // Without a single agreeing call the pair is ambiguous, so no shape of it is suppressed.
    const matching = structuredCalls.filter(structured => agreesWithRepeatedBlock(structured, repeated));
    return matching.length === 1 ? [{ start: repeated.start, end: repeated.end }] : [];
  }
  return callsIn(text, context).filter(call => {
    const body = freeformBody(call.body);
    return structuredCalls.some(structured => {
      const input = structured.names.has(call.name) ? inputFromArguments(structured.argumentsText) : undefined;
      return input !== undefined && freeformBody(input) === body;
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
}

/**
 * Repairs the arguments of every structured call in one response against the visible text that
 * response carried, and returns them in input order. The per-call prefix repair stands alone,
 * because the markup it proves is matched against that call's own repaired input. The
 * doubled-input reduction is applied only when exactly ONE call in the batch qualifies: it either
 * carries the doubled shape or already agrees with the repeated block body. It rewrites executable
 * arguments, and a second qualifying call leaves the block ambiguous, so the uniqueness proof has
 * to cover the whole batch rather than one call at a time.
 */
export function reconcileStructuredToolCalls(
  calls: readonly StructuredToolCallInput[],
  serializedText: string,
): StructuredToolCallReference[] {
  const references = calls.map(call => {
    const names = new Set([call.wireName, call.restoredName]);
    return { names, argumentsText: repairArgumentsDuplicatedBesideSerializedCall(call.argumentsText, names, serializedText) };
  });
  return reduceUnambiguousDoubledInput(references, serializedText);
}

/**
 * Applies the doubled-input reduction across the batch. The doubled shape is valid JSON, so the
 * prefix repair returns it untouched, and the reduction only ever rewrites a call the repair left
 * alone. A call whose input already equals the repeated body is a competing explanation, not a
 * bystander: both readings account for the pair and the response never picks one, so a batch with
 * two qualifying calls keeps every argument exactly as sent. The reduction then rewrites nothing,
 * and the markup is left to the range matcher, which suppresses the pair only when exactly one
 * call already agrees. A lone qualifying call is always the doubled one, because a call that
 * already agrees leaves nothing to reduce.
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
  }));
  if (candidates.filter(candidate => candidate.explains || candidate.reduction !== undefined).length !== 1) {
    return [...references];
  }
  return references.map((reference, index) => {
    const reduction = candidates[index]!.reduction;
    return reduction === undefined ? reference : { names: reference.names, argumentsText: reduction };
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

/** Non-whitespace characters after the last closed block, or 0 while a later block is still open. */
function proseAfterClosedBlock(text: string): number {
  const closer = text.lastIndexOf(CLOSE_TAG);
  if (closer < 0) return 0;
  const tail = text.slice(closer + CLOSE_TAG.length);
  if (tail.includes(OPEN_TAG)) return 0;
  return tail.replace(/\s+/g, "").length;
}
