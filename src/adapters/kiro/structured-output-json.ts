/**
 * Lexeme-preserving JSON reading and exact decimal arithmetic for Kiro strict structured output.
 *
 * Strict validation has to judge the bytes it relays. `JSON.parse` rounds every number to a double,
 * so `9007199254740993` would compare equal to a `const` of `9007199254740992` and
 * `10.0000000000000001` would pass `maximum: 10`, while the client receives the original text.
 * This reader keeps each number's lexeme, and the decimal helpers compare and divide those lexemes
 * exactly, without converting them to doubles.
 */

/** One parsed JSON value with its byte span in the source text. */
export type KiroJsonValue = { start: number; end: number } & (
  | { kind: "null" }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; lexeme: string }
  | { kind: "string"; value: string }
  | { kind: "array"; items: KiroJsonValue[] }
  | { kind: "object"; entries: Map<string, KiroJsonValue> }
);

/** A parsed document and how many values it holds, which sizes the validation budget. */
export interface KiroJsonDocument {
  value: KiroJsonValue;
  nodes: number;
}

/** Deepest array/object nesting the reader accepts; deeper values are reported as non-conforming. */
export const KIRO_JSON_MAX_NESTING = 512;

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Read `text` into a lexeme-preserving tree, or undefined when it is not JSON or nests deeper than
 * {@link KIRO_JSON_MAX_NESTING}. Duplicate object keys keep the last value, as `JSON.parse` does.
 */
export function readKiroJson(text: string): KiroJsonDocument | undefined {
  let pos = 0;
  let nodes = 0;
  const skip = (): void => {
    while (pos < text.length && WHITESPACE.has(text[pos]!)) pos++;
  };
  const readString = (): string => {
    const start = pos;
    pos++;
    while (pos < text.length && text[pos] !== '"') pos += text[pos] === "\\" ? 2 : 1;
    if (pos >= text.length) throw new SyntaxError("unterminated string");
    pos++;
    return JSON.parse(text.slice(start, pos)) as string;
  };
  const read = (depth: number): KiroJsonValue => {
    if (depth > KIRO_JSON_MAX_NESTING) throw new RangeError("nesting");
    skip();
    nodes++;
    const start = pos;
    const ch = text[pos];
    if (ch === '"') {
      const value = readString();
      return { kind: "string", value, start, end: pos };
    }
    if (ch === "[" || ch === "{") {
      pos++;
      skip();
      const close = ch === "[" ? "]" : "}";
      const items: KiroJsonValue[] = [];
      const entries = new Map<string, KiroJsonValue>();
      if (text[pos] === close) pos++;
      else {
        for (;;) {
          if (ch === "[") items.push(read(depth + 1));
          else {
            if (text[pos] !== '"') throw new SyntaxError("expected a key");
            const key = readString();
            skip();
            if (text[pos++] !== ":") throw new SyntaxError("expected a colon");
            entries.set(key, read(depth + 1));
          }
          skip();
          const next = text[pos++];
          if (next === close) break;
          if (next !== ",") throw new SyntaxError("expected a comma");
          skip();
        }
      }
      return ch === "["
        ? { kind: "array", items, start, end: pos }
        : { kind: "object", entries, start, end: pos };
    }
    for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, pos)) {
        pos += word.length;
        return value === null ? { kind: "null", start, end: pos } : { kind: "boolean", value, start, end: pos };
      }
    }
    NUMBER.lastIndex = pos;
    const match = NUMBER.exec(text);
    if (!match) throw new SyntaxError("unexpected token");
    pos += match[0].length;
    return { kind: "number", lexeme: match[0], start, end: pos };
  };
  try {
    const value = read(0);
    skip();
    return pos === text.length ? { value, nodes } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An exact decimal: `sign × 0.digits × 10^exponent`, with `digits` free of leading and trailing
 * zeros. Zero has sign 0 and empty digits. The exponent is a bigint because a lexeme such as
 * `1e99999999999999999999` is valid JSON.
 */
export interface KiroDecimal {
  sign: -1 | 0 | 1;
  digits: string;
  exponent: bigint;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * Largest exponent magnitude kept exactly. A model-written exponent can be millions of digits long,
 * and converting it to a bigint costs more than linear time, so a longer one saturates here. No
 * lexeme within the answer size limits has as many digits, so a saturated value still compares,
 * and tests as an integer, exactly as its true value would against any schema bound.
 */
const EXPONENT_LIMIT = 10n ** 15n;

/** The exponent text as a bigint, saturated at {@link EXPONENT_LIMIT}; linear in its length. */
function boundedExponent(exp: string): bigint {
  const negative = exp.startsWith("-");
  let start = exp.startsWith("-") || exp.startsWith("+") ? 1 : 0;
  while (start < exp.length - 1 && exp.charCodeAt(start) === 48) start += 1;
  const magnitude = exp.length - start > 15 ? EXPONENT_LIMIT : BigInt(exp.slice(start));
  return negative ? -magnitude : magnitude;
}

/** The exact value of a JSON number lexeme (or of `String(n)` for a finite double). */
export function kiroDecimal(lexeme: string): KiroDecimal {
  const match = DECIMAL.exec(lexeme);
  if (!match) throw new Error(`not a JSON number: ${lexeme}`);
  const [, minus, whole = "", fraction = "", exp = "0"] = match;
  const all = whole + fraction;
  const lead = all.search(/[1-9]/);
  if (lead < 0) return { sign: 0, digits: "", exponent: 0n };
  // One backward scan for trailing zeros: `/0+$/` retries a long zero run at every position.
  let end = all.length;
  while (end > lead && all.charCodeAt(end - 1) === 48) end -= 1;
  return {
    sign: minus ? -1 : 1,
    digits: all.slice(lead, end),
    exponent: BigInt(whole.length - lead) + boundedExponent(exp),
  };
}

/** -1, 0 or 1 as `a` is below, equal to or above `b`. */
export function compareKiroDecimal(a: KiroDecimal, b: KiroDecimal): number {
  if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1;
  if (a.sign === 0) return 0;
  let magnitude = 0;
  if (a.exponent !== b.exponent) magnitude = a.exponent < b.exponent ? -1 : 1;
  // Without trailing zeros, digit strings order as their fractions do: "12" < "123" < "13".
  else if (a.digits !== b.digits) magnitude = a.digits < b.digits ? -1 : 1;
  return magnitude * a.sign;
}

/** Whether the decimal is a whole number. */
export function isKiroDecimalInteger(value: KiroDecimal): boolean {
  return value.sign === 0 || BigInt(value.digits.length) <= value.exponent;
}

/** `base^power mod modulus` by square-and-multiply, so a huge exponent costs only its bit length. */
function modPow(base: bigint, power: bigint, modulus: bigint): bigint {
  let result = 1n % modulus;
  let factor = base % modulus;
  for (let rest = power; rest > 0n; rest >>= 1n) {
    if (rest & 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
  }
  return result;
}

/** Whether the decimal is an integer multiple of the positive integer `divisor`. */
export function isKiroDecimalMultipleOf(value: KiroDecimal, divisor: bigint): boolean {
  if (value.sign === 0) return true;
  if (!isKiroDecimalInteger(value)) return false;
  const zeros = value.exponent - BigInt(value.digits.length);
  return (BigInt(value.digits) % divisor) * modPow(10n, zeros, divisor) % divisor === 0n;
}
