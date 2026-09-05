// ---------------------------------------------------------------------------
// Character policy — see the header. Defined over Unicode SCALAR VALUES, not
// UTF-16 code units, because a lone surrogate is not a scalar value and UTF-8
// encoding would silently substitute U+FFFD.
// ---------------------------------------------------------------------------

export interface CharacterFinding {
  /** code-point index, consistent across module, route and editor */
  position: number;
  reason: "control" | "unpaired-surrogate";
  codePoint: number;
}

/** Tab to four spaces, CRLF and lone CR to LF. Applied BEFORE validation. */
export function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
}

/** First offending scalar, or null. Run AFTER normalizeBody. */
export function findInvalidCharacter(body: string): CharacterFinding | null {
  let position = 0;
  for (let i = 0; i < body.length; ) {
    const code = body.codePointAt(i)!;
    const unit = body.charCodeAt(i);
    const isHighSurrogate = unit >= 0xd800 && unit <= 0xdbff;
    const isLowSurrogate = unit >= 0xdc00 && unit <= 0xdfff;
    // codePointAt only combines a well-formed pair, so a surviving surrogate
    // code point here is unpaired by construction.
    if ((isHighSurrogate || isLowSurrogate) && code === unit) {
      return { position, reason: "unpaired-surrogate", codePoint: code };
    }
    const isNewline = code === 0x0a;
    const isC0 = code < 0x20 && !isNewline;
    const isDel = code === 0x7f;
    const isC1 = code >= 0x80 && code <= 0x9f;
    if (isC0 || isDel || isC1) {
      return { position, reason: "control", codePoint: code };
    }
    i += code > 0xffff ? 2 : 1;
    position += 1;
  }
  return null;
}

/**
 * TOML basic-string encoding, total over the accepted set: three rules, none of
 * them in the range where `Bun.TOML.parse` misbehaves. `\r` cannot appear
 * because normalizeBody removed it; control characters cannot appear because
 * findInvalidCharacter rejected them.
 */
export function encodeBasicString(body: string): string {
  return `"${body.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/**
 * Inverse of `encodeBasicString`, deliberately narrow: it accepts ONLY the three
 * escapes we emit. `\t`, `\f`, `\b`, `\r` and `\uXXXX` are refused rather than
 * guessed — decoding them correctly is exactly the ambiguity the restricted set
 * exists to avoid.
 */
export function decodeBasicString(literal: string): string | null {
  if (literal.length < 2 || !literal.startsWith('"') || !literal.endsWith('"')) return null;
  const inner = literal.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch !== "\\") {
      if (ch === '"') return null; // unescaped quote: not a single literal
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === "\\") out += "\\";
    else if (next === '"') out += '"';
    else if (next === "n") out += "\n";
    else return null; // any other escape is outside what we will decode
    i += 1;
  }
  return out;
}
