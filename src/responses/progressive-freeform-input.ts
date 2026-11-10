import { freeformFallbackKeys } from "./apply-patch-envelope";
import {
  JSON_ESCAPES,
  JSON_WHITESPACE,
  MAX_FREEFORM_WRAPPER_SCAN_CHARS,
  scanFreeformWrapper,
} from "./freeform-wrapper-scan";

/**
 * Whether a body could still grow into one complete outer Markdown fence.
 *
 * `stripMarkdownCodeFence` removes such a fence at completion for exactly the two tools that
 * own the grammar, so a fenced body's streamed bytes and its completed input disagree unless
 * the stream holds. A buffer that does not open with a fence can never acquire one, so
 * ordinary bodies are unaffected; a buffer that does keeps its preview suppressed for the
 * whole call, because a closing fence can still be followed by more text that withdraws it.
 */
function mayBecomeFencedBody(text: string, toolName: string): boolean {
  if (toolName !== "exec" && toolName !== "apply_patch") return false;
  const head = text.trimStart();
  if (head === "") return true;
  return head.startsWith("```") || "```".startsWith(head);
}

const LOW_SURROGATE_ESCAPE = /^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/;
const HEX_DIGIT = /^[0-9a-fA-F]$/;
const HEX_QUAD = /^[0-9a-fA-F]{4}$/;
const JSON_NUMBER_CHAR = /^[-+0-9.eE]$/;
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const JSON_LITERALS = ["true", "false", "null"] as const;
const CANONICAL_KEY = "input";
const STRING_END = Symbol("string end");

const ownsBodyRepair = (toolName: string): boolean => toolName === "exec" || toolName === "apply_patch";

type NestedState =
  | "start" | "keyOpen" | "key" | "colon" | "valueOpen" | "string"
  | "scalar" | "container" | "afterValue" | "trailing" | "never";

/**
 * Whether a decoded executable body can still grow into the one extra `{"input":string}`
 * wrapper that completion removes, answered one character at a time so a streamed body is walked
 * once rather than once per delta.
 *
 * Ordinary object-leading JavaScript such as `{ let x` or `({` fails within a few characters and
 * streams from there; only a prefix that is still a possible wrapper holds. A false answer never
 * turns true again as the body grows, so the held prefix is flushed once and streaming continues.
 *
 * Every member name must be `input`, because completion unwraps only a single-key object, and
 * duplicates are followed because `JSON.parse` keeps the last. A non-string value is skipped to its
 * end so a later duplicate can still replace it, and an object that closes on a non-string last
 * value is ruled out. Scalars are checked against the JSON grammar; containers are skipped by
 * bracket and string tracking alone. That skip is looser than `JSON.parse` but never unsound: it
 * finds the true end of every valid container, and any text it misreads is invalid JSON, which
 * completion would not unwrap either way.
 */
class NestedWrapperMatcher {
  scanned = 0;
  private state: NestedState = "start";
  private key = "";
  /** Pending escape inside the current string: "", a backslash, or `\\u` and the hex read so far. */
  private escape = "";
  private scalar = "";
  private readonly closers: string[] = [];
  private inContainerString = false;
  private containerEscape = false;
  private lastValueString = false;

  get possible(): boolean {
    return this.state !== "never";
  }

  feed(text: string): boolean {
    for (let i = 0; i < text.length && this.state !== "never"; i++) {
      this.scanned++;
      this.step(text[i]!);
    }
    return this.possible;
  }

  private step(c: string): void {
    switch (this.state) {
      case "start":
        if (!JSON_WHITESPACE.has(c)) this.state = c === "{" ? "keyOpen" : "never";
        return;
      case "keyOpen":
        if (JSON_WHITESPACE.has(c)) return;
        this.state = c === '"' ? "key" : "never";
        this.key = "";
        this.escape = "";
        return;
      case "key": {
        const part = this.stringStep(c);
        if (part === null) this.state = "never";
        else if (part === STRING_END) this.state = this.key === CANONICAL_KEY ? "colon" : "never";
        else if (!CANONICAL_KEY.startsWith(this.key += part)) this.state = "never";
        return;
      }
      case "colon":
        if (!JSON_WHITESPACE.has(c)) this.state = c === ":" ? "valueOpen" : "never";
        return;
      case "valueOpen":
        if (JSON_WHITESPACE.has(c)) return;
        this.lastValueString = c === '"';
        this.escape = "";
        if (c === '"') this.state = "string";
        else this.startOtherValue(c);
        return;
      case "string": {
        const part = this.stringStep(c);
        if (part === null) this.state = "never";
        else if (part === STRING_END) this.state = "afterValue";
        return;
      }
      case "scalar":
        this.stepScalar(c);
        return;
      case "container":
        this.stepContainer(c);
        return;
      case "afterValue":
        if (JSON_WHITESPACE.has(c)) return;
        if (c === ",") this.state = "keyOpen";
        else this.state = c === "}" && this.lastValueString ? "trailing" : "never";
        return;
      case "trailing":
        if (!JSON_WHITESPACE.has(c)) this.state = "never";
        return;
      case "never":
        return;
    }
  }

  /**
   * One character of a JSON string: the text it decodes to ("" while an escape is pending),
   * `STRING_END` at the closing quote, or `null` when no continuation can parse. Only key
   * text needs the decoded value, so escapes other than `\\u` keep a marker.
   */
  private stringStep(c: string): string | typeof STRING_END | null {
    if (this.escape === "") {
      if (c === '"') return STRING_END;
      if (c.charCodeAt(0) <= 0x1f) return null;
      if (c !== "\\") return c;
      this.escape = "\\";
      return "";
    }
    if (this.escape === "\\") {
      if (c === "u") {
        this.escape = "\\u";
        return "";
      }
      if (!JSON_ESCAPES.has(c)) return null;
      this.escape = "";
      return "\\" + c;
    }
    if (!HEX_DIGIT.test(c)) return null;
    this.escape += c;
    if (this.escape.length < 6) return "";
    const code = parseInt(this.escape.slice(2), 16);
    this.escape = "";
    return String.fromCharCode(code);
  }

  private startOtherValue(c: string): void {
    if (c === "{" || c === "[") {
      this.closers.length = 0;
      this.closers.push(c === "{" ? "}" : "]");
      this.inContainerString = false;
      this.containerEscape = false;
      this.state = "container";
      return;
    }
    if (JSON_NUMBER_CHAR.test(c) || c === "t" || c === "f" || c === "n") {
      this.scalar = c;
      this.state = "scalar";
      return;
    }
    this.state = "never";
  }

  private stepScalar(c: string): void {
    if (JSON_WHITESPACE.has(c) || c === "," || c === "}") {
      const complete = (JSON_LITERALS as readonly string[]).includes(this.scalar) || JSON_NUMBER.test(this.scalar);
      if (!complete) {
        this.state = "never";
        return;
      }
      this.state = "afterValue";
      this.step(c);
      return;
    }
    this.scalar += c;
    const literal = JSON_LITERALS.find(word => word[0] === this.scalar[0]);
    const viable = literal ? literal.startsWith(this.scalar) : JSON_NUMBER_CHAR.test(c);
    if (!viable) this.state = "never";
  }

  private stepContainer(c: string): void {
    if (this.inContainerString) {
      if (this.containerEscape) this.containerEscape = false;
      else if (c === "\\") this.containerEscape = true;
      else if (c === '"') this.inContainerString = false;
      return;
    }
    if (c === '"') this.inContainerString = true;
    else if (c === "{" || c === "[") this.closers.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (this.closers.pop() !== c) this.state = "never";
      else if (this.closers.length === 0) this.state = "afterValue";
    }
  }
}

type DecodeStop = "open" | "closed" | "stalled" | "invalid";

/**
 * Decode the JSON string body in `text` from `from`, stopping at the first byte it cannot
 * resolve. `next` is where decoding resumes once more text arrives; `scanned` counts the characters
 * read, including a split escape that will be read again.
 *
 * Every stop is a hold rather than a guess, because `JSON.parse` decides the completed value
 * and anything invented here would be retracted. Three of them are not obvious:
 *
 * An escape JSON does not define makes the whole wrapper unparseable no matter what arrives
 * next, so completion falls back to the raw text. `invalid` stops the preview rather than
 * continuing to decode a value the completed item will never carry. `\\b` and `\\f` are defined,
 * and were previously decoded to the letters b and f. A literal control character is not legal
 * inside a JSON string either, and stops the same way.
 *
 * A lone high surrogate is not a character. Emitting one alone puts an unpaired code unit in a
 * delta the client has to decode by itself, so the pair is emitted together or not at all; a
 * complete escape that is not its low half leaves the preview `stalled` for the rest of the call.
 */
function decodeJsonStringChunk(
  text: string,
  from: number,
): { chunk: string; next: number; stop: DecodeStop; scanned: number } {
  let chunk = "";
  let scanned = 0;
  let i = from;
  let stop: DecodeStop = "open";
  while (i < text.length) {
    const c = text[i]!;
    scanned++;
    if (c === '"') {
      stop = "closed";
      break;
    }
    if (c !== "\\") {
      if (c.charCodeAt(0) <= 0x1f) {
        stop = "invalid";
        break;
      }
      chunk += c;
      i++;
      continue;
    }
    const n = text[i + 1];
    if (n === undefined) break; // escape split across chunks: wait for more
    scanned++;
    if (n === "u") {
      const hex = text.slice(i + 2, i + 6);
      scanned += hex.length;
      if (hex.length < 4) break; // split across chunks: wait for more
      if (!HEX_QUAD.test(hex)) {
        stop = "invalid";
        break;
      }
      const code = parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.slice(i + 6, i + 12);
        scanned += low.length;
        if (!LOW_SURROGATE_ESCAPE.test(low)) {
          if (low.length === 6) stop = "stalled";
          break;
        }
        chunk += String.fromCharCode(code, parseInt(low.slice(2), 16));
        i += 12;
        continue;
      }
      chunk += String.fromCharCode(code);
      i += 6;
      continue;
    }
    const escaped = JSON_ESCAPES.get(n);
    if (escaped === undefined) {
      stop = "invalid";
      break;
    }
    chunk += escaped;
    i += 2;
  }
  return { chunk, next: i, stop, scanned };
}

/**
 * The value to stream so far for one call's growing arguments, or `null` to HOLD because nothing
 * can be decided yet.
 *
 * A reader belongs to one call and is fed that call's whole accumulated arguments on each delta.
 * They only grow, so it resumes where the previous delta stopped: the canonical value is decoded
 * and checked for a nested wrapper once overall, which keeps a long body streamed in small deltas
 * linear instead of quadratic. A shorter buffer or a different tool name starts over.
 *
 *
 * `input` is decidable from its prefix: `unwrapFreeformToolInput` returns it whenever the
 * key is present, whatever else the object carries, so its value can be unescaped
 * progressively and never retracted, except for executable bodies that may contain one
 * extra canonical wrapper. Such a body holds only while its prefix can still become that
 * wrapper (`mayBecomeNestedWrapper`); the first byte that rules it out flushes the held text.
 *
 * One case escapes that claim and is accepted rather than fixed: a duplicate `input` key.
 * `JSON.parse` keeps the last one, so `{"input":"a","input":"b"}` streams a and completes with
 * b. Closing it means holding every canonical wrapper until its object parses, which is the
 * progressive streaming this path exists to provide. The completed item stays authoritative,
 * and no model emits a duplicate key in practice.
 *
 * A wrapper that turns invalid AFTER streaming has committed has the same shape and the same
 * answer. `{"input":"a` followed by `\\qb"}` has already published a when the undefined escape
 * arrives, and completion returns the raw text because nothing parses. The preview stops
 * there: no rewind, and no decoded text the completed item does not contain. Bounding the
 * damage is what is available without giving up progressive streaming, and the args are
 * unusable in that case whichever representation wins.
 *
 * A fallback key decides only at the object's close. It unwraps as the SINGLE string field,
 * and a second key can still arrive while the object is open — so a value emitted early would
 * have to be taken back. The scan therefore keeps a member table and consults it at the
 * close, publishing the wrapped value (or the raw text) without ever reparsing the buffer.
 * The routed passthrough in `responses-custom-tool-repair.ts` already holds any object prefix
 * for the same reason (#5047).
 *
 * An object that has not reached a canonical key YET is in exactly that position, and used to
 * be treated as raw because it did not match the literal `{"input":"`. It holds now: `input`
 * can still arrive after other properties, or wearing an escaped spelling, and completion would
 * then unwrap a body whose wrapper syntax had already been published as deltas (#5151). The
 * cost of holding is preview on an object body that turns out not to be a wrapper; the cost of
 * not holding was publishing bytes the completed item removes.
 */
export class ProgressiveFreeformInputReader {
  private toolName: string | undefined;
  private seen = 0;
  private mode: "scan" | "raw" | "hold" | "input" = "scan";
  private next = 0;
  private decoded = "";
  private stop: DecodeStop = "open";
  private nested: NestedWrapperMatcher | null = null;
  private fenceRuledOut = false;
  private decodeScanned = 0;

  /** Characters this reader has walked so far; a test seam for the linear-work bound. */
  get scannedChars(): number {
    return this.decodeScanned + (this.nested?.scanned ?? 0);
  }

  update(args: string, toolName: string): string | null {
    if (toolName !== this.toolName || args.length < this.seen) this.reset(toolName);
    this.seen = args.length;
    if (this.mode === "scan") {
      const scan = scanFreeformWrapper(args, freeformFallbackKeys(toolName));
      if (scan.kind === "raw") {
        // Prefix-decided: no extension of this text becomes a wrapper again.
        this.mode = "raw";
      } else if (scan.kind === "hold") {
        // Past the bound the scan only ever sees the same clamped prefix, so it holds for good.
        if (args.length > MAX_FREEFORM_WRAPPER_SCAN_CHARS) this.mode = "hold";
        return null;
      } else if (scan.canonical) {
        this.mode = "input";
        this.next = scan.valueStart;
        this.nested = ownsBodyRepair(toolName) ? new NestedWrapperMatcher() : null;
      } else {
        // A closed fallback wrapper can still be withdrawn by trailing text, so it is decided
        // afresh on each delta. Its object fits inside the scan bound, which bounds this too.
        return this.closedFallbackValue(args, scan.valueStart, toolName);
      }
    }
    if (this.mode === "hold") return null;
    if (this.mode === "raw") return this.mayBecomeFenced(args) ? null : args;
    return this.canonicalValue(args);
  }

  private reset(toolName: string): void {
    this.toolName = toolName;
    this.seen = 0;
    this.mode = "scan";
    this.next = 0;
    this.decoded = "";
    this.stop = "open";
    this.nested = null;
    this.fenceRuledOut = false;
  }

  private canonicalValue(args: string): string | null {
    if (this.stop === "open") {
      const step = decodeJsonStringChunk(args, this.next);
      this.decodeScanned += step.scanned;
      this.next = step.next;
      this.stop = step.stop;
      this.decoded += step.chunk;
      if (this.nested?.possible) this.nested.feed(step.chunk);
    }
    if (this.stop === "invalid") return null;
    // Completion may remove one extra {input:string} body wrapper, so hold while it can.
    if (this.nested?.possible) return null;
    return this.mayBecomeFenced(this.decoded) ? null : this.decoded;
  }

  private closedFallbackValue(args: string, valueStart: number, toolName: string): string | null {
    const step = decodeJsonStringChunk(args, valueStart);
    this.decodeScanned += step.scanned;
    if (step.stop === "invalid") return null;
    if (ownsBodyRepair(toolName)) {
      const nested = new NestedWrapperMatcher();
      const possible = nested.feed(step.chunk);
      this.decodeScanned += nested.scanned;
      if (possible) return null;
    }
    return mayBecomeFencedBody(step.chunk, toolName) ? null : step.chunk;
  }

  /** `mayBecomeFencedBody`, remembering a false answer: a ruled-out fence never returns. */
  private mayBecomeFenced(text: string): boolean {
    if (this.fenceRuledOut) return false;
    if (mayBecomeFencedBody(text, this.toolName ?? "")) return true;
    this.fenceRuledOut = true;
    return false;
  }
}

/** One-shot form of `ProgressiveFreeformInputReader` for a buffer read once. */
export function progressiveFreeformInput(args: string, toolName: string): string | null {
  return new ProgressiveFreeformInputReader().update(args, toolName);
}
