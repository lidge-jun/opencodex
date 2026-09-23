import { randomUUID } from "node:crypto";
import type { AdapterEvent } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";

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
 *
 * A text block that opens with `<tool_call>` is therefore held instead of streamed. It is dropped
 * when a native call proves it is a duplicate, or restored on an eligible clean MiMo finish when
 * it names a declared tool with arguments that fit its schema. Other markup is released unchanged.
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

const WRAPPER = /^<tool_call>\s*<function=([^>\s]+)>([\s\S]*)<\/function>\s*<\/tool_call>$/;
const PARAMETER = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;

/** Parse one complete MiMo tool-call block, or undefined when the text is anything else. */
export function parseToolCallMarkup(text: string): ToolCallMarkup | undefined {
  const match = WRAPPER.exec(text.trim());
  if (!match) return undefined;
  const name = match[1]!;
  const body = match[2]!;
  if (body.includes(TOOL_CALL_MARKER) || body.includes("<function=")) return undefined;
  if (!body.includes("<parameter=")) {
    // A parameter-free body is a freeform input. The gateway's echo can close it with a stray
    // `</parameter>` that has no opening tag; that tag is markup, not input.
    return { name, kind: "raw", value: trimWrappingNewlines(body.replace(/<\/parameter>\s*$/, "")) };
  }
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
    const value = parsed === undefined ? raw : parsed;
    return satisfiesConstraints(value, schema) ? value : DECODE_FAILED;
  }
  // Non-string types first: MiMo writes them as JSON, and a string type would accept anything.
  const ordered = [...types.filter(type => type !== "string"), ...types.filter(type => type === "string")];
  for (const type of ordered) {
    const decoded = decodeTyped(raw, type);
    if (decoded !== DECODE_FAILED && satisfiesConstraints(decoded, schema)) return decoded;
  }
  return DECODE_FAILED;
}

/**
 * The supported value constraints a restored call must honour: types, `enum`, `const`, numeric
 * bounds, and complete anyOf/oneOf alternatives. Nested object properties are not walked.
 */
function satisfiesConstraints(value: unknown, schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return true;
  const record = schema as Record<string, unknown>;
  if (schemaTypes({ type: record.type })?.every(type => !matchesType(value, type))) return false;
  if (Array.isArray(record.enum) && !record.enum.some(option => deepEqual(option, value))) return false;
  if (Object.hasOwn(record, "const") && !deepEqual(record.const, value)) return false;
  if (typeof value === "number") {
    if (typeof record.minimum === "number" && value < record.minimum) return false;
    if (typeof record.maximum === "number" && value > record.maximum) return false;
    if (typeof record.exclusiveMinimum === "number" && value <= record.exclusiveMinimum) return false;
    if (typeof record.exclusiveMaximum === "number" && value >= record.exclusiveMaximum) return false;
  }
  if (Array.isArray(record.anyOf) && !record.anyOf.some(branch => satisfiesConstraints(value, branch))) return false;
  if (Array.isArray(record.oneOf) && record.oneOf.filter(branch => satisfiesConstraints(value, branch)).length !== 1) return false;
  return true;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    default: return false;
  }
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
    return JSON.stringify({ [keys.length === 1 ? keys[0]! : "input"]: markup.value });
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
  return JSON.stringify(output);
}

interface TextBlock {
  text: string;
  bytes: number;
  state: "probing" | "held" | "queued" | "dropped" | "streaming";
  ended: boolean;
  /** Tool inputs open when the block started; the native call that duplicates it is one of them. */
  candidates: Set<string>;
}

const DEFAULT_TEXT_ID = "\u0000default";
const encoder = new TextEncoder();

/** Stream-side state for one Command Code response. */
export class CommandCodeToolTextFilter {
  private readonly openInputs = new Map<string, string>();
  private readonly blocks = new Map<string, TextBlock>();
  /** Held blocks in arrival order, including ended ones awaiting a verdict. */
  private held: TextBlock[] = [];
  /** Held blocks and later text in wire order; bounded together by MAX_HELD_TOOL_TEXT_BYTES. */
  private pending: TextBlock[] = [];

  constructor(
    private readonly budget: TranslatorBudget,
    private readonly declared: CommandCodeDeclaredTools | undefined,
  ) {}

  toolInputStart(id: unknown, name: unknown): void {
    if (typeof id === "string" && typeof name === "string") this.openInputs.set(id, name);
  }

  textStart(id: unknown): AdapterEvent[] {
    const key = typeof id === "string" ? id : DEFAULT_TEXT_ID;
    const events = this.blocks.has(key) ? this.textEnd(key) : [];
    const block: TextBlock = { text: "", bytes: 0, state: "probing", ended: false, candidates: new Set(this.openInputs.keys()) };
    this.blocks.set(key, block);
    if (this.pending.length > 0) this.pending.push(block);
    return events;
  }

  textDelta(id: unknown, text: string): AdapterEvent[] {
    const key = typeof id === "string" ? id : DEFAULT_TEXT_ID;
    let block = this.blocks.get(key);
    if (!block) {
      block = { text: "", bytes: 0, state: "probing", ended: false, candidates: new Set(this.openInputs.keys()) };
      this.blocks.set(key, block);
      if (this.pending.length > 0) this.pending.push(block);
    }
    if (block.state === "streaming") {
      if (this.pending.length === 0) return [{ type: "text_delta", text }];
      block.state = "queued";
      this.pending.push(block);
    }
    // A duplicate can be dropped behind an earlier held block. Its later text still belongs
    // at this position in the ordered queue and must be released once that barrier clears.
    if (block.state === "dropped") block.state = "queued";
    this.retain(block, text);
    if (block.state === "queued") return this.limitPending();
    const lead = block.text.trimStart();
    if (block.state === "probing") {
      if (lead.length > 0 && !lead.startsWith(TOOL_CALL_MARKER) && !TOOL_CALL_MARKER.startsWith(lead)) {
        if (this.pending.includes(block)) { block.state = "queued"; return this.limitPending(); }
        return this.stream(block);
      }
      if (lead.startsWith(TOOL_CALL_MARKER)) {
        block.state = "held";
        this.held.push(block);
        if (!this.pending.includes(block)) this.pending.push(block);
      }
    }
    return this.limitPending();
  }

  textEnd(id: unknown): AdapterEvent[] {
    const key = typeof id === "string" ? id : DEFAULT_TEXT_ID;
    const block = this.blocks.get(key);
    if (!block) return [];
    this.blocks.delete(key);
    block.ended = true;
    // A block that never committed to the marker (whitespace, or a marker prefix) is ordinary text.
    if (block.state === "probing") {
      if (this.pending.includes(block)) { block.state = "queued"; return this.drain(); }
      return this.release(block);
    }
    if (block.state === "queued") return this.drain();
    return [];
  }

  /** Called before a native call is relayed; returns text that must precede it. */
  toolCall(id: string, name: string, input: unknown): AdapterEvent[] {
    this.openInputs.delete(id);
    const remaining: TextBlock[] = [];
    for (const block of this.held) {
      const pairs = block.candidates.size === 0 || block.candidates.has(id);
      if (!pairs) {
        remaining.push(block);
        continue;
      }
      const markup = parseToolCallMarkup(block.text);
      if (markup && markup.name === name && markupMatchesInput(markup, input)) {
        this.drop(block);
        block.state = "dropped";
        continue;
      }
      block.candidates.delete(id);
      if (block.candidates.size === 0) {
        block.state = "queued";
      } else {
        remaining.push(block);
      }
    }
    this.held = remaining;
    return this.drain();
  }

  /** Release every held block as text, without restoring any call (used when the turn failed). */
  releaseAll(): AdapterEvent[] {
    const pending = [...this.pending, ...[...this.blocks.values()].filter(block => block.state === "probing" && !this.pending.includes(block))];
    this.held = [];
    this.pending = [];
    this.blocks.clear();
    return pending.flatMap(block => this.release(block));
  }

  /** Terminal verdict for every block still held: restore it as a call when it qualifies, else release it. */
  finish(): { events: AdapterEvent[]; salvaged: boolean } {
    const events: AdapterEvent[] = [];
    let salvaged = false;
    const pending = [...this.pending, ...[...this.blocks.values()].filter(block => block.state === "probing" && !this.pending.includes(block))];
    this.held = [];
    this.pending = [];
    this.blocks.clear();
    for (const block of pending) {
      const markup = block.state === "held" ? parseToolCallMarkup(block.text) : undefined;
      const tool = markup ? this.declared?.get(markup.name) : undefined;
      const args = markup && tool ? salvagedArguments(markup, tool) : undefined;
      if (markup && args !== undefined) {
        this.drop(block);
        const callId = `call_ocx_${randomUUID().replace(/-/g, "")}`;
        events.push({ type: "tool_call_start", id: callId, name: markup.name });
        this.budget.openCall(callId);
        try {
          const reservation = this.budget.reserveTransient(encoder.encode(args).byteLength, { kind: "tool_args", callId });
          reservation.commitRetained();
          events.push({ type: "tool_call_delta", arguments: args });
          events.push({ type: "tool_call_end" });
        } finally {
          this.budget.closeCall(callId);
        }
        salvaged = true;
        continue;
      }
      events.push(...this.release(block));
    }
    return { events, salvaged };
  }

  private retain(block: TextBlock, text: string): void {
    const bytes = encoder.encode(text).byteLength;
    const reservation = this.budget.reserveTransient(bytes, { kind: "live_transient" });
    reservation.commitRetained();
    block.text += text;
    block.bytes += bytes;
  }

  private drop(block: TextBlock): void {
    this.budget.releaseRetained(block.bytes, { kind: "live_transient" });
    block.bytes = 0;
    block.text = "";
  }

  private release(block: TextBlock): AdapterEvent[] {
    const text = block.text;
    this.drop(block);
    return text ? [{ type: "text_delta", text }] : [];
  }

  private stream(block: TextBlock): AdapterEvent[] {
    block.state = "streaming";
    return this.release(block);
  }

  private drain(): AdapterEvent[] {
    const events: AdapterEvent[] = [];
    while (this.pending.length > 0) {
      const block = this.pending[0]!;
      if (block.state === "held" || block.state === "probing") break;
      this.pending.shift();
      events.push(...this.stream(block));
    }
    return events;
  }

  private limitPending(): AdapterEvent[] {
    if (this.pending.reduce((sum, block) => sum + block.bytes, 0) <= MAX_HELD_TOOL_TEXT_BYTES) return [];
    // Drop restoration once the ordered queue fills, then release all text in arrival order.
    this.held = [];
    for (const block of this.pending) if (block.state === "held" || block.state === "probing") block.state = "queued";
    return this.drain();
  }
}
