import { randomUUID } from "node:crypto";
import type { AdapterEvent } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";
import { validatesRestoredValue } from "./command-code-restored-schema";

/**
 * MiMo tool-call markup on the Command Code /alpha/generate stream.
 *
 * Xiaomi MiMo writes tool calls in its native chat-template grammar,
 * `<tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>`, with string
 * values raw, every other type as JSON, and a freeform tool's input as the raw body with no
 * parameter tags (MiMo-V2.6 chat template; the `mimo` tool parsers in vLLM and SGLang read the same
 * grammar). When Command Code's gateway cannot turn that markup into a call — Codex's freeform
 * `exec` body is raw JavaScript, which fails the gateway's JSON parse of the lowered `{input}`
 * schema — it forwards the markup as a `text-delta` block and then, in the observed case, a native
 * `tool-call` marked `invalid` carrying the same input. Relaying both put the call on screen as
 * assistant text (captured 2026-09-23 from `codex exec` on `xiaomi/mimo-v2.6-flash`).
 * The echo can also omit `</function>` entirely (`<tool_call><function=exec>RAW</parameter></tool_call>`,
 * captured the same day through the live proxy); a parameter-free body is read the same way then.
 * Parameter bodies keep the canonical close, which SGLang's and vLLM's MiMo parsers require too.
 *
 * A text block that opens with `<tool_call>` is therefore held instead of streamed. It is dropped
 * when a native call proves it is a duplicate, or restored on an eligible clean MiMo finish when
 * it names a declared tool with arguments that fit its schema. Other markup is released unchanged.
 * MiMo can also append the markup after ordinary prose inside one text block; the stream filter
 * splits such a delta at the marker and holds the markup part the same way (#5698; a marker split
 * across deltas after prose is still released as text).
 * A malformed envelope that still opens and closes around a declared function name, but that the
 * strict parser rejects, is dropped instead of released when the native call for that same function
 * arrives, and on the clean-finish path, so the echo never reaches the client.
 * Later text waits behind unresolved markup within the same byte bound.
 */

export const TOOL_CALL_MARKER = "<tool_call>";
/** A held block larger than this is released as text rather than buffered further. */
export const MAX_HELD_TOOL_TEXT_BYTES = 64 * 1024;

export interface CommandCodeDeclaredTool {
  freeform: boolean;
  schema: Record<string, unknown>;
}
export type CommandCodeDeclaredTools = ReadonlyMap<string, CommandCodeDeclaredTool>;

export type ToolCallMarkup =
  | { name: string; kind: "raw"; value: string }
  | { name: string; kind: "params"; values: Record<string, string> };

/** One wrapping newline on each side is template layout, not value (vLLM `_trim_wrapping_newlines`). */
function trimWrappingNewlines(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

const WRAPPER = /^<tool_call>\s*<function=([^>\s]+)>([\s\S]*)<\/tool_call>$/;
const FUNCTION_CLOSE = /<\/function>\s*$/;
const PARAMETER = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;

/** Parse one complete MiMo tool-call block, or undefined when the text is anything else. */
export function parseToolCallMarkup(text: string): ToolCallMarkup | undefined {
  const match = WRAPPER.exec(text.trim());
  if (!match) return undefined;
  const name = match[1]!;
  // A trailing </function> is always the close, so a body can keep a literal one only inside a closed block.
  const closed = FUNCTION_CLOSE.test(match[2]!);
  const body = closed ? match[2]!.replace(FUNCTION_CLOSE, "") : match[2]!;
  // A second </tool_call> means two blocks with text between them, never one call.
  if (body.includes(TOOL_CALL_MARKER) || body.includes("</tool_call>") || body.includes("<function=")) return undefined;
  if (!body.includes("<parameter=")) {
    // A parameter-free body is a freeform input. The gateway's echo can close it with a stray
    // `</parameter>` that has no opening tag; that tag is markup, not input.
    return { name, kind: "raw", value: trimWrappingNewlines(body.replace(/<\/parameter>\s*$/, "")) };
  }
  if (!closed) return undefined;
  const values: Record<string, string> = {};
  let consumed = "";
  for (const parameter of body.matchAll(PARAMETER)) {
    const key = parameter[1]!.trim();
    if (!key || Object.hasOwn(values, key)) return undefined;
    values[key] = trimWrappingNewlines(parameter[2]!);
    consumed += parameter[0];
  }
  // Complete means every byte of the body belongs to a parameter; anything left over is prose.
  if (body.replace(PARAMETER, "").trim() !== "" || consumed === "") return undefined;
  return { name, kind: "params", values };
}

function tryJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

/**
 * The declared function name of an envelope echo the strict parser rejected, or undefined when the
 * text is anything else: malformed parameter tags, a missing `</function>`, garbage inside the body.
 * Opening and closing as an envelope with a known function name is enough to keep it off the client
 * once the native duplicate call for that same name — which carries the canonical execution —
 * arrives; a native call for another tool says nothing about this envelope.
 */
function looseEnvelopeName(text: string, declared: CommandCodeDeclaredTools | undefined): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(TOOL_CALL_MARKER) || !trimmed.endsWith("</tool_call>")) return undefined;
  if (trimmed.slice(TOOL_CALL_MARKER.length).includes(TOOL_CALL_MARKER)) return undefined;
  const fn = /<function=([^>\s]+)>/.exec(trimmed);
  return fn !== null && (declared?.has(fn[1]!) ?? false) ? fn[1]! : undefined;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => Object.hasOwn(right, key)
    && deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/** Whether a parsed block encodes exactly the input of a native call. */
export function markupMatchesInput(markup: ToolCallMarkup, input: unknown): boolean {
  const value = typeof input === "string" && markup.kind === "params" ? tryJson(input) : input;
  if (markup.kind === "raw") {
    if (typeof value === "string") return value.trim() === markup.value.trim();
    // A valid freeform call arrives as its lowered single-key object.
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value);
      return entries.length === 1 && typeof entries[0]![1] === "string"
        && (entries[0]![1] as string).trim() === markup.value.trim();
    }
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== Object.keys(markup.values).length) return false;
  return keys.every(key => {
    if (!Object.hasOwn(markup.values, key)) return false;
    const raw = markup.values[key]!;
    const expected = record[key];
    if (typeof expected === "string") return expected === raw;
    const decoded = tryJson(raw);
    return decoded !== undefined && deepEqual(decoded, expected);
  });
}

function schemaTypes(schema: unknown): string[] | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const record = schema as Record<string, unknown>;
  if (typeof record.type === "string") return [record.type];
  if (Array.isArray(record.type)) return record.type.filter((entry): entry is string => typeof entry === "string");
  const alternatives = Array.isArray(record.anyOf) ? record.anyOf : Array.isArray(record.oneOf) ? record.oneOf : undefined;
  if (!alternatives) return undefined;
  const types = alternatives.flatMap(entry => schemaTypes(entry) ?? []);
  return types.length > 0 ? types : undefined;
}

const DECODE_FAILED = Symbol("decode-failed");

function decodeTyped(raw: string, type: string): unknown {
  switch (type) {
    case "string": return raw;
    case "integer": {
      // An integer past 2^53 would serialize as a different number (or null once it overflows).
      const parsed = /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
      return Number.isSafeInteger(parsed) ? parsed : DECODE_FAILED;
    }
    case "number": {
      const trimmed = raw.trim();
      const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
      return Number.isFinite(parsed) ? parsed : DECODE_FAILED;
    }
    case "boolean": return raw.trim() === "true" ? true : raw.trim() === "false" ? false : DECODE_FAILED;
    case "null": return raw.trim() === "null" ? null : DECODE_FAILED;
    case "object": {
      const parsed = tryJson(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : DECODE_FAILED;
    }
    case "array": {
      const parsed = tryJson(raw);
      return Array.isArray(parsed) ? parsed : DECODE_FAILED;
    }
    default: return DECODE_FAILED;
  }
}

/** Decode one parameter by its declared schema; a value that fits no declared type fails. */
function decodeParameter(raw: string, schema: unknown): unknown {
  const types = schemaTypes(schema);
  if (!types) {
    const parsed = tryJson(raw);
    if (parsed !== undefined && validatesRestoredValue(parsed, schema)) return parsed;
    return validatesRestoredValue(raw, schema) ? raw : DECODE_FAILED;
  }
  // Non-string types first: MiMo writes them as JSON, and a string type would accept anything.
  const ordered = [...types.filter(type => type !== "string"), ...types.filter(type => type === "string")];
  for (const type of ordered) {
    const decoded = decodeTyped(raw, type);
    if (decoded !== DECODE_FAILED && validatesRestoredValue(decoded, schema)) return decoded;
  }
  return DECODE_FAILED;
}

/**
 * Arguments for a call restored from markup, or undefined when the markup does not fit the
 * declared tool. A freeform tool takes a parameter-free body as its single lowered string field; a
 * function tool takes parameters that include every required key, name only declared keys, and
 * decode to their declared types.
 */
export function salvagedArguments(markup: ToolCallMarkup, tool: CommandCodeDeclaredTool): string | undefined {
  const properties = tool.schema.properties && typeof tool.schema.properties === "object" && !Array.isArray(tool.schema.properties)
    ? tool.schema.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(tool.schema.required)
    ? tool.schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (tool.freeform) {
    if (markup.kind !== "raw") return undefined;
    const keys = Object.keys(properties);
    const output = { [keys.length === 1 ? keys[0]! : "input"]: markup.value };
    return validatesRestoredValue(output, tool.schema) ? JSON.stringify(output) : undefined;
  }
  if (markup.kind !== "params") return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(markup.values)) {
    if (!Object.hasOwn(properties, key)) return undefined;
    const decoded = decodeParameter(raw, properties[key]);
    if (decoded === DECODE_FAILED) return undefined;
    output[key] = decoded;
  }
  if (required.some(key => !Object.hasOwn(output, key))) return undefined;
  return validatesRestoredValue(output, tool.schema) ? JSON.stringify(output) : undefined;
}

interface TextBlock {
  id: string;
  markupParts: string[];
  probe: string;
  bytes: number;
  state: "probing" | "held" | "queued" | "dropped" | "streaming";
  ended: boolean;
  interrupted: boolean;
  /** Tool inputs open when the block started; the native call that duplicates it is one of them. */
  candidates: Set<string>;
}

interface TextChunk {
  kind: "chunk";
  block: TextBlock;
  parts: string[];
  bytes: number;
}

interface NativeCall {
  kind: "native";
  id: string;
  name: string;
  argumentsText: string;
  /** Retained only while an earlier text block blocks delivery. */
  bytes: number;
}

interface QueuedEvent {
  kind: "event";
  event: AdapterEvent;
  bytes: number;
}

interface Terminal { kind: "finish"; restore: boolean }
type Pending = TextChunk | NativeCall | QueuedEvent | Terminal;

const DEFAULT_TEXT_ID = "\u0000default";
const encoder = new TextEncoder();

/** Stream-side state for one Command Code response. */
export class CommandCodeToolTextFilter {
  private readonly openInputs = new Map<string, string>();
  private readonly blocks = new Map<string, TextBlock>();
  /**
   * Only blocks still deciding whether their text is markup (state "probing") need boundary visits;
   * a held block is deliberately absent, so no interleaved event can interrupt it.
   */
  private readonly activeProbes = new Map<string, TextBlock>();
  /** Held blocks in arrival order, including ended ones awaiting a verdict. */
  private held: TextBlock[] = [];
  /** Every output-bearing event shares this wire-order queue. */
  private pending: Pending[] = [];
  private head = 0;
  private queuedBytes = 0;
  private queueOperations = 0;

  constructor(
    private readonly budget: TranslatorBudget,
    private readonly declared: CommandCodeDeclaredTools | undefined,
  ) {}

  /** Counts queue item visits and appends for the bounded-work regression. */
  queueOperationsForTest(): number { return this.queueOperations; }
  openBlockCountForTest(): number { return this.blocks.size; }

  toolInputStart(id: unknown, name: unknown): AdapterEvent[] {
    const events = this.breakOpenBlocks();
    if (typeof id === "string" && typeof name === "string") this.openInputs.set(id, name);
    return events;
  }

  boundary(): AdapterEvent[] { return this.breakOpenBlocks(); }

  private breakOpenBlocks(exceptKey?: string): AdapterEvent[] {
    let changed = false;
    for (const [key, block] of this.activeProbes) {
      this.queueOperations++;
      if (key === exceptKey) continue;
      // Guard only: a held block is not tracked here (textDelta adds probing blocks and drops them
      // from the map on the transition to held). It must stay held until settle, in arrival order —
      // interrupting it on interleaved events (reasoning deltas, other blocks, the native call
      // itself) cleared complete and malformed envelopes alike and released the echoed call as text.
      // The queued-byte bound (makeRoom) still caps memory and wait, flushing everything as text if a
      // held envelope never resolves while the stream keeps producing.
      if (block.state !== "probing") continue;
      this.activeProbes.delete(key);
      block.interrupted = true;
      block.state = "queued";
      block.markupParts = [];
      changed = true;
    }
    if (changed) this.held = this.held.filter(block => block.state === "held");
    return changed ? this.drain() : [];
  }

  textStart(id: unknown): AdapterEvent[] {
    const key = typeof id === "string" ? id : DEFAULT_TEXT_ID;
    const events = this.blocks.has(key) ? this.textEnd(key) : [];
    events.push(...this.breakOpenBlocks(key));
    const block: TextBlock = { id: key, markupParts: [], probe: "", bytes: 0, state: "probing", ended: false, interrupted: false, candidates: new Set(this.openInputs.keys()) };
    this.blocks.set(key, block);
    return events;
  }

  textDelta(id: unknown, text: string): AdapterEvent[] {
    const key = typeof id === "string" ? id : DEFAULT_TEXT_ID;
    const boundaryEvents = this.breakOpenBlocks(key);
    let block = this.blocks.get(key);
    if (!block) {
      block = { id: key, markupParts: [], probe: "", bytes: 0, state: "probing", ended: false, interrupted: false, candidates: new Set(this.openInputs.keys()) };
      this.blocks.set(key, block);
    }
    // MiMo can append tool-call markup after ordinary prose inside one text block. The probe below
    // only recognizes a block that opens with the marker, so a marker arriving after prose would
    // reach the client (captured 2026-09-23 from xiaomi/mimo-v2.6-pro: prose, then
    // "<tool_call><function=exec>..." echoed by the gateway as one text delta). Split the delta at
    // the marker: prose keeps its queued or streamed path, the markup starts a fresh probe block
    // and follows the normal hold-and-restore route. A probing block that has consumed nothing but
    // whitespace keeps its probe instead, because that probe already holds the marker.
    if (block.state !== "held") {
      const markerIndex = text.indexOf(TOOL_CALL_MARKER);
      const whitespaceLead = markerIndex > 0 && block.state === "probing" && block.probe === ""
        && text.slice(0, markerIndex).trim() === "";
      // markerIndex === 0 on a probing block is the ordinary hold path; on any other state the
      // block is ordinary text and the marker must still start a fresh probe block.
      if (!whitespaceLead && (markerIndex > 0 || (markerIndex === 0 && block.state !== "probing"))) {
        const prose = markerIndex > 0 ? text.slice(0, markerIndex) : "";
        const marked = markerIndex > 0 ? text.slice(markerIndex) : text;
        let proseEvents: AdapterEvent[] = [];
        if (prose) {
          if (block.state === "streaming" && this.head === this.pending.length) {
            proseEvents = [{ type: "text_delta", text: prose }];
          } else {
            if (block.state === "dropped" || block.state === "streaming") {
              block = { id: key, markupParts: [], probe: "", bytes: 0, state: "queued", ended: false, interrupted: true, candidates: new Set() };
              this.blocks.set(key, block);
            }
            proseEvents = this.queueProseDelta(block, prose);
            this.probeBlockText(block, prose);
          }
        }
        if (block.state === "queued") block.state = "streaming";
        this.activeProbes.delete(key);
        const probeBlock: TextBlock = { id: key, markupParts: [], probe: "", bytes: 0, state: "probing", ended: false, interrupted: false, candidates: new Set(this.openInputs.keys()) };
        this.blocks.set(key, probeBlock);
        return [...boundaryEvents, ...proseEvents, ...this.textDelta(id, marked)];
      }
      if (markerIndex === -1 && block.state === "streaming" && this.head === this.pending.length) {
        return [...boundaryEvents, { type: "text_delta", text }];
      }
    }
    // Once a duplicate is dropped, later text is a new chunk at its own wire position.
    if (block.state === "dropped" || block.state === "streaming") {
      block = { id: key, markupParts: [], probe: "", bytes: 0, state: "queued", ended: false, interrupted: true, candidates: new Set() };
      this.blocks.set(key, block);
    }
    const preceding = this.makeRoom(encoder.encode(text).byteLength);
    this.retain(block, text);
    if (block.state === "probing") this.activeProbes.set(key, block);
    const bytes = encoder.encode(text).byteLength;
    const tail = this.pending.at(-1);
    if (tail?.kind === "chunk" && tail.block === block && this.head < this.pending.length) {
      tail.parts.push(text);
      tail.bytes += bytes;
      this.queueOperations++;
    } else {
      this.pending.push({ kind: "chunk", block, parts: [text], bytes });
      this.queueOperations++;
    }
    this.queuedBytes += bytes;
    this.probeBlockText(block, text);
    if (block.state !== "probing") this.activeProbes.delete(key);
    return [...boundaryEvents, ...preceding, ...this.limitPending()];
  }

  textEnd(id: unknown): AdapterEvent[] {
    const key = typeof id === "string" ? id : DEFAULT_TEXT_ID;
    const block = this.blocks.get(key);
    if (!block) return [];
    this.blocks.delete(key);
    this.activeProbes.delete(key);
    block.ended = true;
    // A block that never committed to the marker (whitespace, or a marker prefix) is ordinary text.
    if (block.state === "probing") {
      block.state = "queued";
      block.markupParts = [];
      return this.drain();
    }
    if (block.state === "queued") return this.drain();
    return [];
  }

  /** Called before a native call is relayed; returns text that must precede it. */
  toolCall(id: string, name: string, input: unknown): AdapterEvent[] {
    this.matchNative(id, name, input);
    return this.drain();
  }

  /** Put the native call at its wire position, after matching any earlier held markup. */
  nativeCall(id: string, name: string, input: unknown): AdapterEvent[] {
    const boundaryEvents = this.breakOpenBlocks();
    this.matchNative(id, name, input);
    const argumentsText = typeof input === "string" ? input : JSON.stringify(input);
    const preceding = this.makeRoom(encoder.encode(argumentsText).byteLength);
    const bytes = this.head < this.pending.length ? encoder.encode(argumentsText).byteLength : 0;
    if (bytes > 0) this.retainQueued(bytes);
    this.pending.push({ kind: "native", id, name, argumentsText, bytes });
    this.queueOperations++;
    this.queuedBytes += bytes;
    return [...boundaryEvents, ...preceding, ...this.limitPending()];
  }

  /** Reasoning shares the same ordering barrier as text and native calls. */
  enqueueEvent(event: AdapterEvent, textValue: string): AdapterEvent[] {
    const boundaryEvents = this.breakOpenBlocks();
    const preceding = this.makeRoom(encoder.encode(textValue).byteLength);
    const bytes = this.head < this.pending.length ? encoder.encode(textValue).byteLength : 0;
    if (bytes > 0) this.retainQueued(bytes);
    this.pending.push({ kind: "event", event, bytes });
    this.queueOperations++;
    this.queuedBytes += bytes;
    return [...boundaryEvents, ...preceding, ...this.limitPending()];
  }

  private matchNative(id: string, name: string, input: unknown): void {
    this.openInputs.delete(id);
    const remaining: TextBlock[] = [];
    for (const block of this.held) {
      const pairs = block.candidates.size === 0 || block.candidates.has(id);
      if (!pairs) {
        remaining.push(block);
        continue;
      }
      const text = block.markupParts.join("");
      const markup = parseToolCallMarkup(text);
      if (markup && markup.name === name && markupMatchesInput(markup, input)) {
        this.drop(block);
        block.state = "dropped";
        this.activeProbes.delete(block.id);
        continue;
      }
      block.candidates.delete(id);
      if (block.candidates.size === 0) {
        // A malformed envelope cannot match a native input, but it is still an envelope: when the
        // native call is for the function it declares, that call carries the execution, so drop the
        // echo rather than releasing it as text. A native call for any other tool proves nothing
        // about this envelope, so it keeps the release-as-text path below.
        if (markup === undefined && looseEnvelopeName(text, this.declared) === name) {
          this.drop(block);
          block.state = "dropped";
          this.activeProbes.delete(block.id);
          continue;
        }
        block.state = "queued";
        block.markupParts = [];
        this.activeProbes.delete(block.id);
      } else {
        remaining.push(block);
      }
    }
    this.held = remaining;
  }

  /** Release every held block as text, without restoring any call (used when the turn failed). */
  releaseAll(): AdapterEvent[] {
    return this.settle(false).events;
  }

  /** Terminal verdict for every block still held: restore it as a call when it qualifies, else release it. */
  finish(): { events: AdapterEvent[]; salvaged: boolean } {
    return this.settle(true);
  }

  private settle(restore: boolean): { events: AdapterEvent[]; salvaged: boolean } {
    const events: AdapterEvent[] = [];
    let salvaged = false;
    let lastTextBlock: TextBlock | undefined;
    this.pending.push({ kind: "finish", restore });
    const pending = this.pending.slice(this.head);
    this.queueOperations += pending.length;
    this.held = [];
    this.pending = [];
    this.head = 0;
    this.queuedBytes = 0;
    this.blocks.clear();
    this.activeProbes.clear();
    for (const item of pending) {
      this.queueOperations++;
      if (item.kind === "finish") break;
      if (item.kind === "native") { events.push(...this.emitNative(item)); lastTextBlock = undefined; continue; }
      if (item.kind === "event") { this.releaseQueued(item.bytes); events.push(item.event); lastTextBlock = undefined; continue; }
      const block = item.block;
      if (block.state === "held") {
        const markup = restore && !block.interrupted ? parseToolCallMarkup(block.markupParts.join("")) : undefined;
        const tool = markup ? this.declared?.get(markup.name) : undefined;
        const args = markup && tool ? salvagedArguments(markup, tool) : undefined;
        if (markup && args !== undefined) {
          this.drop(block);
          block.state = "dropped";
          const callId = `call_ocx_${randomUUID().replace(/-/g, "")}`;
          events.push({ type: "tool_call_start", id: callId, name: markup.name });
          events.push({ type: "tool_call_delta", arguments: args });
          events.push({ type: "tool_call_end" });
          salvaged = true;
          lastTextBlock = undefined;
        } else if (restore && !block.interrupted && markup === undefined
          && looseEnvelopeName(block.markupParts.join(""), this.declared) !== undefined) {
          // A malformed envelope is still an envelope: the native duplicate (observed in every
          // capture) carries the call, so the echo is dropped rather than rendered as text.
          // Releasing it would put the raw markup back on screen; restoring it could execute a
          // second time alongside the native call. The parser must have rejected the text, so an
          // envelope that parses but does not fit its schema keeps the release-as-text contract.
          this.drop(block);
          block.state = "dropped";
          lastTextBlock = undefined;
        } else {
          block.state = "queued";
          block.markupParts = [];
        }
      } else if (block.state === "probing") {
        block.state = "queued";
        block.markupParts = [];
      }
      if (block.state === "dropped") {
        lastTextBlock = undefined;
        continue;
      }
      const emitted = this.releaseChunk(item);
      if (emitted && lastTextBlock === block && events.at(-1)?.type === "text_delta") {
        (events.at(-1) as { type: "text_delta"; text: string }).text += emitted.text;
      } else if (emitted) events.push(emitted);
      lastTextBlock = block;
    }
    return { events, salvaged };
  }

  private retain(block: TextBlock, text: string): void {
    const bytes = encoder.encode(text).byteLength;
    const reservation = this.budget.reserveTransient(bytes, { kind: "live_transient" });
    reservation.commitRetained();
    if (block.state === "probing" || block.state === "held") block.markupParts.push(text);
    block.bytes += bytes;
  }

  /** The incremental open-of-block probe: decide whether the block's text is tool-call markup. */
  private probeBlockText(block: TextBlock, text: string): void {
    if (block.state !== "probing") return;
    for (const char of text) {
      if (!block.probe && char.trim() === "") continue;
      block.probe += char;
      if (!TOOL_CALL_MARKER.startsWith(block.probe)) {
        block.state = "queued";
        block.markupParts = [];
        break;
      }
      if (block.probe === TOOL_CALL_MARKER) {
        block.state = "held";
        block.probe = "";
        this.held.push(block);
        break;
      }
    }
  }

  /** Route ordinary prose through the queued wire path (shared by the mid-stream marker split). */
  private queueProseDelta(block: TextBlock, prose: string): AdapterEvent[] {
    const preceding = this.makeRoom(encoder.encode(prose).byteLength);
    this.retain(block, prose);
    const bytes = encoder.encode(prose).byteLength;
    const tail = this.pending.at(-1);
    if (tail?.kind === "chunk" && tail.block === block && this.head < this.pending.length) {
      tail.parts.push(prose);
      tail.bytes += bytes;
      this.queueOperations++;
    } else {
      this.pending.push({ kind: "chunk", block, parts: [prose], bytes });
      this.queueOperations++;
    }
    this.queuedBytes += bytes;
    return preceding;
  }

  private drop(block: TextBlock): void {
    this.budget.releaseRetained(block.bytes, { kind: "live_transient" });
    this.queuedBytes = Math.max(0, this.queuedBytes - block.bytes);
    block.bytes = 0;
    block.markupParts = [];
  }

  private releaseChunk(chunk: TextChunk): { type: "text_delta"; text: string } | undefined {
    if (chunk.block.state === "dropped") return undefined;
    this.budget.releaseRetained(chunk.bytes, { kind: "live_transient" });
    this.queuedBytes = Math.max(0, this.queuedBytes - chunk.bytes);
    chunk.block.bytes = Math.max(0, chunk.block.bytes - chunk.bytes);
    const text = chunk.parts.join("");
    return text ? { type: "text_delta", text } : undefined;
  }

  private retainQueued(bytes: number): void {
    this.budget.reserveTransient(bytes, { kind: "live_transient" }).commitRetained();
  }

  private releaseQueued(bytes: number): void {
    if (bytes > 0) {
      this.budget.releaseRetained(bytes, { kind: "live_transient" });
      this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
    }
  }

  private emitNative(call: NativeCall): AdapterEvent[] {
    this.releaseQueued(call.bytes);
    return [
      { type: "tool_call_start", id: call.id, name: call.name },
      { type: "tool_call_delta", arguments: call.argumentsText },
      { type: "tool_call_end" },
    ];
  }

  private drain(): AdapterEvent[] {
    const events: AdapterEvent[] = [];
    let lastTextBlock: TextBlock | undefined;
    while (this.head < this.pending.length) {
      const item = this.pending[this.head]!;
      this.queueOperations++;
      if (item.kind === "finish" || (item.kind === "chunk" && (item.block.state === "held" || item.block.state === "probing"))) break;
      this.head++;
      if (item.kind === "chunk") {
        const emitted = this.releaseChunk(item);
        if (emitted && lastTextBlock === item.block && events.at(-1)?.type === "text_delta") {
          (events.at(-1) as { type: "text_delta"; text: string }).text += emitted.text;
        } else if (emitted) events.push(emitted);
        if (item.block.state === "queued" && item.block.bytes === 0 && !item.block.ended) item.block.state = "streaming";
        lastTextBlock = item.block.state === "dropped" ? undefined : item.block;
      } else if (item.kind === "native") { events.push(...this.emitNative(item)); lastTextBlock = undefined; }
      else { this.releaseQueued(item.bytes); events.push(item.event); lastTextBlock = undefined; }
    }
    if (this.head === this.pending.length) { this.pending = []; this.head = 0; }
    else if (this.head >= 1024 && this.head * 2 >= this.pending.length) {
      this.queueOperations += this.pending.length - this.head;
      this.pending = this.pending.slice(this.head);
      this.head = 0;
    }
    return events;
  }

  private limitPending(): AdapterEvent[] {
    if (this.queuedBytes <= MAX_HELD_TOOL_TEXT_BYTES) return this.drain();
    return this.flushPendingAsText();
  }

  private makeRoom(additionalBytes: number): AdapterEvent[] {
    return this.queuedBytes + additionalBytes > MAX_HELD_TOOL_TEXT_BYTES ? this.flushPendingAsText() : [];
  }

  private flushPendingAsText(): AdapterEvent[] {
    // Drop restoration once the ordered queue fills, then release all text in arrival order.
    this.held = [];
    this.activeProbes.clear();
    for (let index = this.head; index < this.pending.length; index++) {
      const item = this.pending[index]!;
      this.queueOperations++;
      if (item.kind !== "chunk" || (item.block.state !== "held" && item.block.state !== "probing")) continue;
      item.block.state = "queued";
      item.block.markupParts = [];
    }
    return this.drain();
  }
}
