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

/** Finds complete bare blocks outside literal Markdown; ambiguous outer blocks stop the scan. */
function callsIn(text: string, context: TextContext = { fence: null, lineStart: true }): SerializedToolCall[] {
  const pattern = /<tool_call>\s*<function=([^>\r\n]+)>([\s\S]*?)(?:<\/parameter>)?\s*<\/function>\s*<\/tool_call>/y;
  const calls: SerializedToolCall[] = [];
  let offset = 0;
  while (offset < text.length) {
    const split = splitAtPossibleSerializedToolCall(text.slice(offset), context, true);
    offset += split.emit.length;
    if (!split.hasOpenTag) break;
    pattern.lastIndex = offset;
    const match = pattern.exec(text);
    if (!match) break; // An incomplete/ambiguous outer block cannot authorize an inner call.
    calls.push({
      name: match[1]!.trim(),
      body: match[2]!,
      start: match.index,
      end: match.index + match[0].length,
    });
    offset = pattern.lastIndex;
    context = { fence: null, lineStart: false };
  }
  return calls;
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

/** The `[start, end)` ranges of blocks whose function identity and freeform input match a dispatched call. */
function duplicatedSerializedToolCallRanges(
  text: string,
  structuredCalls: readonly StructuredToolCallReference[],
  context?: TextContext,
): { start: number; end: number }[] {
  if (structuredCalls.length === 0) return [];
  return callsIn(text, context).filter(call => {
    const body = call.body.trimEnd();
    return structuredCalls.some(structured =>
      structured.names.has(call.name) && inputFromArguments(structured.argumentsText)?.trimEnd() === body);
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

/**
 * One structured call as the reconciler sees it: both the wire name and its restored client name
 * identify it, and its arguments are repaired against the visible text the same response carried.
 */
export function reconcileStructuredToolCall(
  wireName: string,
  restoredName: string,
  argumentsText: string,
  serializedText: string,
): StructuredToolCallReference {
  const names = new Set([wireName, restoredName]);
  return { names, argumentsText: repairArgumentsDuplicatedBesideSerializedCall(argumentsText, names, serializedText) };
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
