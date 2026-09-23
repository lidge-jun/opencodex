import { unwrapFreeformToolInput } from "./apply-patch-envelope";
import { JSON_ESCAPES, scanFreeformWrapper } from "./freeform-wrapper-scan";

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

/**
 * The decoded prefix of a JSON string body, stopping at the first byte it cannot resolve.
 *
 * Every stop is a hold rather than a guess, because `JSON.parse` decides the completed value
 * and anything invented here would be retracted. Three of them are not obvious:
 *
 * An escape JSON does not define makes the whole wrapper unparseable no matter what arrives
 * next, so completion falls back to the raw text. Returning `null` for that case stops the
 * preview rather than continuing to decode a value the completed item will never carry.
 * `\\b` and `\\f` are defined, and were previously decoded to the letters b and f.
 *
 * A lone high surrogate is not a character. Emitting one alone puts an unpaired code unit in a
 * delta the client has to decode by itself, so the pair is emitted together or not at all.
 */
function decodeJsonStringPrefix(body: string): string | null {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') break; // unescaped closing quote: value complete
    if (c !== "\\") {
      // A literal control character is not legal inside a JSON string, so `JSON.parse` will
      // reject this wrapper and completion will return the raw text. Emitting the decoded value
      // first is the disagreement this decoder exists to prevent, so stop instead.
      if (c!.charCodeAt(0) <= 0x1f) return null;
      out += c;
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) break; // escape split across chunks: wait for more
    if (n === "u") {
      const hex = body.slice(i + 2, i + 6);
      if (hex.length < 4) break; // split across chunks: wait for more
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null; // never parses
      const code = parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = body.slice(i + 6, i + 12);
        if (!LOW_SURROGATE_ESCAPE.test(low)) break;
        out += String.fromCharCode(code, parseInt(low.slice(2), 16));
        i += 11;
        continue;
      }
      out += String.fromCharCode(code);
      i += 5;
      continue;
    }
    const escaped = JSON_ESCAPES.get(n);
    if (escaped === undefined) return null; // never parses
    out += escaped;
    i += 1;
  }
  return out;
}

/**
 * The value to stream so far, or `null` to HOLD because nothing can be decided yet.
 *
 * `input` is decidable from its prefix: `unwrapFreeformToolInput` returns it whenever the
 * key is present, whatever else the object carries, so its value can be unescaped
 * progressively and never retracted.
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
 * A fallback key is not decidable. It only unwraps when it is the SINGLE string field, and a
 * second key can still arrive — so a value emitted early would have to be taken back. That is
 * the rewind this holds instead: stream nothing until the object closes, then publish the one
 * repaired body. The routed passthrough in `responses-custom-tool-repair.ts` already holds
 * any object prefix for the same reason (#5047).
 *
 * An object that has not reached a canonical key YET is in exactly that position, and used to
 * be treated as raw because it did not match the literal `{"input":"`. It holds now: `input`
 * can still arrive after other properties, or wearing an escaped spelling, and completion would
 * then unwrap a body whose wrapper syntax had already been published as deltas (#5151). The
 * cost of holding is preview on an object body that turns out not to be a wrapper; the cost of
 * not holding was publishing bytes the completed item removes.
 */
export function progressiveFreeformInput(args: string, toolName: string): string | null {
  const scan = scanFreeformWrapper(args);
  if (scan.kind === "input") {
    const decoded = decodeJsonStringPrefix(args.slice(scan.valueStart));
    if (decoded === null) return null;
    return mayBecomeFencedBody(decoded, toolName) ? null : decoded;
  }
  if (scan.kind === "raw") return mayBecomeFencedBody(args, toolName) ? null : args;

  // Undecided: some wrapper may still apply, and only the completed object says which one.
  // The parse runs exactly where the scan SAW the object close, so it reads a buffer the scan
  // already walked and its cost is bounded by the same clamp. A hold from either limit stays
  // held: an incomplete object has nothing to parse, and re-reading a budget-exhausted buffer
  // on every delta is quadratic work for a delta that would arrive in the same instant as the
  // authoritative completion behind it.
  if (!scan.parse) return null;
  try {
    JSON.parse(args);
  } catch {
    return null;
  }
  return unwrapFreeformToolInput(args, toolName);
}
