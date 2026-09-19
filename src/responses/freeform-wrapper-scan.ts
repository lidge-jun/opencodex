// Bounded classification of a PARTIAL freeform tool-call wrapper.
//
// `unwrapFreeformToolInput` decides the completed input with `JSON.parse`, which does not care
// what order an object's properties arrive in or how their names are spelled. The streaming side
// has to reach the same answer from a prefix, and it used to do that by comparing the buffer
// against the literal `{"input":"`. Spellings `JSON.parse` calls identical therefore matched no
// wrapper at all, streamed as raw JSON, and then completed as the unwrapped body:
// `{"metadata":1,"input":"cmd"}` and `{"\u0069nput":"cmd"}` both previewed the whole object and
// completed as `cmd` (#5151). #5047 and #5129 closed the compact and whitespace spellings of the
// same disagreement; reordering and escaping are the two the literal matcher could never see,
// because RFC 8259 objects are unordered and their names are strings with escapes.
//
// So the prefix is scanned as JSON instead of matched as text. The scan answers one question —
// which wrapper, if any, the completed text will unwrap to — and it answers it three ways:
//
//   `input`  the canonical key is present with a string value, whatever preceded it and however
//            its name was spelled. Its value can be decoded progressively, because
//            `unwrapFreeformToolInput` gives an own `input` precedence over every other property.
//   `raw`    no wrapper can apply, because the text is not an object or because it is one that
//            `JSON.parse` will reject. Completion returns the buffer, so streaming it agrees.
//   `hold`   undecided. A key that has not arrived yet can still change the answer, so nothing
//            is published until the object parses and completion's own rule decides.
//
// The bound matters as much as the classification. A scan that walks the whole buffer on every
// delta is quadratic in the argument size, so classification gives up after
// `MAX_FREEFORM_WRAPPER_SCAN_CHARS` and holds. Giving up costs preview, never agreement: a held
// buffer is still resolved by the authoritative parse at completion.

/** The insignificant whitespace `JSON.parse` accepts between tokens. */
export const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/** The two-character escapes JSON defines, and nothing else. */
export const JSON_ESCAPES = new Map<string, string>([
  ['"', '"'], ["\\", "\\"], ["/", "/"],
  ["b", "\b"], ["f", "\f"], ["n", "\n"], ["r", "\r"], ["t", "\t"],
]);

/**
 * How far a classification scan walks before it gives up and holds.
 *
 * A wrapper's own structure — its property names and the small scalar siblings a model puts
 * beside the body — lives at the front of the object. A buffer still undecided after this much
 * scanning is one whose preceding values are large, and holding it is what the routed
 * restoration path already does for every unrecognized object.
 */
export const MAX_FREEFORM_WRAPPER_SCAN_CHARS = 4096;

const CANONICAL_KEY = "input";

/** The buffer ends inside a token: what follows can still change the answer. */
const HOLD = -1;
/** `JSON.parse` will reject this text no matter what is appended to it. */
const NEVER = -2;

export type FreeformWrapperScan =
  | { kind: "hold"; parse: boolean }
  | { kind: "raw" }
  | { kind: "input"; valueStart: number };

/** Index of the first non-whitespace character at or after `from`, or HOLD past the end. */
function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && JSON_WHITESPACE.has(text[i]!)) i++;
  return i < text.length ? i : HOLD;
}

/**
 * Index just past the complete JSON string opening at `from`, or HOLD / NEVER.
 *
 * This reports a BOUNDARY where `decodeJsonStringPrefix` reports a decoded PREFIX: one has to
 * fail on a truncated string and the other has to return what it decoded so far. They answer
 * different questions about the same bytes and share one escape table so they cannot disagree
 * about which escapes exist.
 */
function scanString(text: string, from: number): number {
  let i = from + 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') return i + 1;
    if (c === "\\") {
      const n = text[i + 1];
      if (n === undefined) return HOLD;
      if (n === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4) return HOLD;
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return NEVER;
        i += 6;
        continue;
      }
      if (!JSON_ESCAPES.has(n)) return NEVER;
      i += 2;
      continue;
    }
    // A literal control character is not legal inside a JSON string.
    if (c.charCodeAt(0) <= 0x1f) return NEVER;
    i++;
  }
  return HOLD;
}

const JSON_NUMBER_CHARS = /[-+0-9.eE]/;
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/** Index just past one complete scalar at `from`, or HOLD / NEVER. */
function scanScalar(text: string, from: number): number {
  const c = text[from]!;
  if (c === '"') return scanString(text, from);
  if (c === "t" || c === "f" || c === "n") {
    const literal = c === "t" ? "true" : c === "f" ? "false" : "null";
    if (text.startsWith(literal, from)) return from + literal.length;
    return literal.startsWith(text.slice(from)) ? HOLD : NEVER;
  }
  let end = from;
  while (end < text.length && JSON_NUMBER_CHARS.test(text[end]!)) end++;
  if (end === from) return NEVER;
  // A number running to the end of the buffer can still grow another digit or exponent.
  if (end >= text.length) return HOLD;
  return JSON_NUMBER.test(text.slice(from, end)) ? end : NEVER;
}

/** Index where the value of the member whose name opens at `from` begins, or HOLD / NEVER. */
function scanMemberKey(text: string, from: number): number {
  if (text[from] !== '"') return NEVER;
  const nameEnd = scanString(text, from);
  if (nameEnd < 0) return nameEnd;
  const colon = skipWhitespace(text, nameEnd);
  if (colon === HOLD) return HOLD;
  if (text[colon] !== ":") return NEVER;
  return skipWhitespace(text, colon + 1);
}

/**
 * Index just past one complete JSON value at `from`, or HOLD / NEVER.
 *
 * Containers are walked with an explicit stack rather than recursion: the value being skipped
 * is provider-controlled, and a deeply nested one must not be able to exhaust the call stack.
 */
function scanValue(text: string, from: number): number {
  const closers: string[] = [];
  let i = from;
  for (;;) {
    const c = text[i]!;
    if (c === "{" || c === "[") {
      const closer = c === "{" ? "}" : "]";
      closers.push(closer);
      const first = skipWhitespace(text, i + 1);
      if (first === HOLD) return HOLD;
      if (text[first] === closer) {
        closers.pop();
        i = first + 1;
      } else if (closer === "}") {
        const value = scanMemberKey(text, first);
        if (value < 0) return value;
        i = value;
        continue;
      } else {
        i = first;
        continue;
      }
    } else {
      const end = scanScalar(text, i);
      if (end < 0) return end;
      i = end;
    }

    // One value is complete: close whatever it finished and find the next value, if any.
    for (;;) {
      if (closers.length === 0) return i;
      const at = skipWhitespace(text, i);
      if (at === HOLD) return HOLD;
      const closer = closers[closers.length - 1]!;
      if (text[at] === closer) {
        closers.pop();
        i = at + 1;
        continue;
      }
      if (text[at] !== ",") return NEVER;
      const next = skipWhitespace(text, at + 1);
      if (next === HOLD) return HOLD;
      if (closer === "}") {
        const value = scanMemberKey(text, next);
        if (value < 0) return value;
        i = value;
      } else {
        i = next;
      }
      break;
    }
  }
}

/**
 * Which wrapper the completed text will unwrap to, as far as this prefix can say.
 *
 * Fallback keys are deliberately not recognized here. They only unwrap when exactly one of them
 * carries a string, and a second one can still arrive, so no prefix decides them — which makes
 * them indistinguishable from any other undecided object and lets one HOLD cover both.
 */
export function scanFreeformWrapper(text: string): FreeformWrapperScan {
  // One clamp rather than a budget threaded through every helper. Every helper already holds
  // when it runs off the end of what it can see, so a buffer whose classification needs more
  // than this holds for exactly the right reason, and no scan can cost more than this many
  // characters however large the arguments grow. Indices into the clamp are indices into the
  // full text, because the clamp is a prefix of it.
  const bounded = text.length > MAX_FREEFORM_WRAPPER_SCAN_CHARS
    ? text.slice(0, MAX_FREEFORM_WRAPPER_SCAN_CHARS)
    : text;
  // `parse` is true only where this scan actually SAW the object close. Every other hold ran
  // out of buffer or out of budget, and in both cases asking `JSON.parse` is work with no
  // possible payoff: the first is provably incomplete, and the second would re-read a growing
  // buffer on every delta that happens to end in a brace — repeated braces inside a long
  // unterminated string are enough to make that quadratic. Holding a budget-exhausted prefix
  // costs nothing that matters, because the value it would release arrives in the same instant
  // as the authoritative completion that follows it.
  const hold = (): FreeformWrapperScan => ({ kind: "hold", parse: false });
  const open = skipWhitespace(bounded, 0);
  if (open === HOLD) return hold();
  // Not an object, so no wrapper rule reaches it: arrays, scalars and ordinary bodies all
  // complete as themselves.
  if (bounded[open] !== "{") return { kind: "raw" };

  let i = open + 1;
  for (;;) {
    const at = skipWhitespace(bounded, i);
    if (at === HOLD) return hold();
    if (bounded[at] === "}") return afterTopLevelClose(bounded, at + 1);
    if (bounded[at] !== '"') return { kind: "raw" };

    const nameEnd = scanString(bounded, at);
    if (nameEnd === HOLD) return hold();
    if (nameEnd === NEVER) return { kind: "raw" };
    let name: string;
    try {
      // The authoritative decoder for the name, so `{"\u0069nput":...}` resolves to the same
      // key completion sees. Decoding it by hand here is the second implementation that would
      // drift from `JSON.parse`, which is how this defect existed in the first place.
      name = JSON.parse(bounded.slice(at, nameEnd)) as string;
    } catch {
      return { kind: "raw" };
    }

    const colon = skipWhitespace(bounded, nameEnd);
    if (colon === HOLD) return hold();
    if (bounded[colon] !== ":") return { kind: "raw" };
    const valueAt = skipWhitespace(bounded, colon + 1);
    if (valueAt === HOLD) return hold();

    if (name === CANONICAL_KEY) {
      // An own `input` wins over everything else in the object, so this is decidable now. A
      // non-string value is decidable too, in the other direction: completion hands back the
      // argument text unchanged rather than unwrapping a value it cannot use.
      return bounded[valueAt] === '"'
        ? { kind: "input", valueStart: valueAt + 1 }
        : { kind: "raw" };
    }

    const valueEnd = scanValue(bounded, valueAt);
    if (valueEnd === HOLD) return hold();
    if (valueEnd === NEVER) return { kind: "raw" };

    const next = skipWhitespace(bounded, valueEnd);
    if (next === HOLD) return hold();
    if (bounded[next] === ",") {
      i = next + 1;
      continue;
    }
    if (bounded[next] === "}") return afterTopLevelClose(bounded, next + 1);
    return { kind: "raw" };
  }
}

/**
 * The object closed without a canonical key. Only whitespace may follow one that parses, so
 * anything else makes the text raw; otherwise the completed parse decides between a fallback
 * wrapper and no wrapper at all.
 */
function afterTopLevelClose(text: string, from: number): FreeformWrapperScan {
  return skipWhitespace(text, from) === HOLD ? { kind: "hold", parse: true } : { kind: "raw" };
}
