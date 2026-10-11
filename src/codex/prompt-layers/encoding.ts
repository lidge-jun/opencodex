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

/** Decode externally authored TOML basic strings on the read-only fallback path. */
export function decodeTomlBasicString(literal: string): string | null {
  if (literal.length < 2 || !literal.startsWith('"') || !literal.endsWith('"')) return null;
  const inner = literal.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch !== "\\") {
      const code = inner.codePointAt(i)!;
      if (ch === '"' || (code < 0x20 && code !== 0x09) || code === 0x7f
        || (code >= 0xd800 && code <= 0xdfff)) return null;
      out += String.fromCodePoint(code);
      if (code > 0xffff) i += 1;
      continue;
    }
    const escape = inner[++i];
    switch (escape) {
      case "b": out += "\b"; break;
      case "t": out += "\t"; break;
      case "n": out += "\n"; break;
      case "f": out += "\f"; break;
      case "r": out += "\r"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "u":
      case "U": {
        const digits = escape === "u" ? 4 : 8;
        const hex = inner.slice(i + 1, i + 1 + digits);
        if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) return null;
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
        out += String.fromCodePoint(code);
        i += digits;
        break;
      }
      default: return null;
    }
  }
  return out;
}

/** Shared scalar assignment matching; quoted and escaped keys retain their spelling. */
export function matchKeyHead(line: string, key: string): { prefix: string; rest: string } | null {
  const m = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*/.exec(line);
  if (!m) return null;
  const token = m[1]!;
  const decoded = token.startsWith('"') ? decodeTomlBasicString(token)
    : token.startsWith("'") ? token.slice(1, -1) : token;
  return decoded === key ? { prefix: m[0], rest: line.slice(m[0].length) } : null;
}

/**
 * For each line, whether it begins outside every string and composite span, or
 * `null` when a span never closes and the scope of later lines is unknown.
 *
 * Line matchers for assignments and table headers must only look at lines that
 * start at top level: `"model_instructions_file" = "x"` written inside a
 * `"""…"""` value or a multi-line array is prose, not syntax. Readers and
 * editors share this so a write and the snapshot read back agree.
 */
export function lexicalLineStarts(lines: readonly string[]): boolean[] | null {
  const starts: boolean[] = [];
  let open: string | null = null;
  let depth = 0;
  for (const line of lines) {
    starts.push(open === null && depth === 0);
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i]!;
      if (open !== null) {
        if (char === "\\" && (open === '"' || open === '"""')) { i += 1; continue; }
        if (char !== open[0]) continue;
        if (open.length === 1) { open = null; continue; }
        let run = 0;
        while (line[i + run] === char) run += 1;
        // Up to two quotes may sit inside the value just before the closing three.
        if (run >= 3) open = null;
        i += run - 1;
      } else if (char === "#") break;
      else if (char === '"' || char === "'") {
        open = line.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
        i += open.length - 1;
      } else if (char === "[" || char === "{") depth += 1;
      else if (char === "]" || char === "}") { depth -= 1; if (depth < 0) return null; }
    }
    // Single-line strings cannot cross a newline.
    if (open !== null && open.length === 1) return null;
  }
  return open === null && depth === 0 ? starts : null;
}
