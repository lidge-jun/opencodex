/** Lossless physical TOML lines with lexical structural boundaries. */
export interface SourceLine {
  text: string;
  eol: "\r\n" | "\n" | "";
  /** False when this physical line began inside a multiline string or collection. */
  structural: boolean;
}


export function splitSourceLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let offset = 0;
  while (offset < content.length) {
    const lf = content.indexOf("\n", offset);
    if (lf === -1) {
      lines.push({ text: content.slice(offset), eol: "", structural: true });
      break;
    }
    const crlf = lf > offset && content[lf - 1] === "\r";
    lines.push({
      text: content.slice(offset, crlf ? lf - 1 : lf),
      eol: crlf ? "\r\n" : "\n",
      structural: true,
    });
    offset = lf + 1;
  }
  markStructuralLines(lines);
  return lines;
}

/** Root boundaries exclude headers and assignments that are merely multiline/array data. */
export function rootSourceLines(content: string): { bom: string; lines: SourceLine[]; rootEnd: number } {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const lines = splitSourceLines(content.slice(bom.length));
  const firstTable = lines.findIndex(line => line.structural && /^\s*\[/.test(line.text));
  return { bom, lines, rootEnd: firstTable === -1 ? lines.length : firstTable };
}

export function sourceText(lines: readonly SourceLine[]): string {
  return lines.map(line => line.text + line.eol).join("");
}

const assignmentKeyToken = /^[ \t]*([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')[ \t]*=/;

/** Decode only a single key token, without parsing unrelated values or dotted paths. */
export function rootAssignmentKey(text: string): string | null {
  const match = assignmentKeyToken.exec(text);
  if (!match) return null;
  try {
    return Object.keys(Bun.TOML.parse(`${match[1]} = true\n`))[0] ?? null;
  } catch {
    return null;
  }
}

interface AssignmentSpan { key: string; start: number; end: number; text: string }

function lexicalAssignmentSpan(lines: readonly SourceLine[], start: number, limit: number): AssignmentSpan | null {
  const line = lines[start];
  if (!line?.structural) return null;
  const key = rootAssignmentKey(line.text);
  if (key === null) return null;
  let end = start + 1;
  while (end < limit && !lines[end]!.structural) end += 1;
  // Store the original assignment bytes, excluding only its final document separator.
  const text = sourceText(lines.slice(start, end)).replace(/\r?\n$/, "");
  return { key, start, end, text };
}

/** A complete assignment whose value can be decoded without losing precision. */
export function sourceAssignment(lines: readonly SourceLine[], start: number, limit = lines.length):
  (AssignmentSpan & { value: unknown }) | null {
  const span = lexicalAssignmentSpan(lines, start, limit);
  if (!span) return null;
  try {
    const parsed = Bun.TOML.parse(span.text) as Record<string, unknown>;
    return Object.keys(parsed).length === 1 && Object.hasOwn(parsed, span.key)
      ? { ...span, value: parsed[span.key] } : null;
  } catch { return null; }
}

/** Validate complete syntax for removal/capture without requiring a JavaScript value. */
export function sourceAssignmentSpan(lines: readonly SourceLine[], start: number, limit = lines.length): AssignmentSpan | null {
  const decoded = sourceAssignment(lines, start, limit);
  if (decoded) return decoded;
  const span = lexicalAssignmentSpan(lines, start, limit);
  if (!span) return null;
  // Bun rejects valid TOML integers outside the JS safe-integer range, as scalars and
  // inside arrays or inline tables alike. Validate a copy in which each such integer that
  // fits signed 64 bits reads `0`; the parser stays responsible for every other piece of
  // grammar, and the returned span keeps the original bytes untouched.
  const masked = maskWideIntegers(span.text);
  if (masked === null) return null;
  try {
    const parsed = Bun.TOML.parse(masked);
    return Object.keys(parsed).length === 1 && Object.hasOwn(parsed, span.key) ? span : null;
  } catch { return null; }
}

const integerToken = /^(?:[+-]?(?:0|[1-9](?:_?[0-9])*)|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$/;
const bareToken = /[A-Za-z0-9_+.:-]/;

/**
 * The assignment with every integer outside the JS safe range replaced by `0`, skipping
 * strings and comments. Null when an integer does not fit signed 64 bits (TOML requires a
 * reader to reject it) or when nothing needed masking, so the original parse failure stands.
 */
function maskWideIntegers(text: string): string | null {
  let out = "";
  let masked = false;
  let index = 0;
  const copyUntil = (end: number) => { out += text.slice(index, end); index = end; };
  while (index < text.length) {
    const char = text[index]!;
    if (text.startsWith('"""', index) || text.startsWith("'''", index)) {
      const delimiter = text.slice(index, index + 3);
      let cursor = index + 3;
      while (cursor < text.length && !text.startsWith(delimiter, cursor)) cursor += delimiter === '"""' && text[cursor] === "\\" ? 2 : 1;
      cursor = Math.min(text.length, cursor + 3);
      // A closing delimiter may carry up to two more quote characters of content.
      for (let extra = 0; extra < 2 && text[cursor] === delimiter[0]; extra += 1) cursor += 1;
      copyUntil(cursor);
    } else if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < text.length && text[cursor] !== char && text[cursor] !== "\n") cursor += char === '"' && text[cursor] === "\\" ? 2 : 1;
      copyUntil(Math.min(text.length, cursor + 1));
    } else if (char === "#") {
      const newline = text.indexOf("\n", index);
      copyUntil(newline === -1 ? text.length : newline);
    } else if (bareToken.test(char)) {
      let cursor = index + 1;
      while (cursor < text.length && bareToken.test(text[cursor]!)) cursor += 1;
      const token = text.slice(index, cursor);
      // A digit-only bare key (`{ 9223372036854775808 = 1 }`) is a name, not a number.
      const isKey = /^[ \t]*[=.]/.test(text.slice(cursor));
      if (!isKey && integerToken.test(token)) {
        const integer = BigInt(token.replaceAll("_", ""));
        if (integer < -(1n << 63n) || integer >= (1n << 63n)) return null;
        if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < -BigInt(Number.MAX_SAFE_INTEGER)) {
          out += "0";
          index = cursor;
          masked = true;
          continue;
        }
      }
      copyUntil(cursor);
    } else {
      copyUntil(index + 1);
    }
  }
  return masked ? out : null;
}

/** Cosmetic document whitespace only; opaque value lines retain every byte. */
export function normalizeStructuralWhitespace(content: string): string {
  const { bom, lines } = rootSourceLines(content);
  const out: SourceLine[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.structural && line.text === "") {
      blankRun += 1;
      if (blankRun > 1) continue;
    } else {
      blankRun = 0;
    }
    out.push(line);
  }
  while (out.at(-1)?.structural && out.at(-1)!.text.trim() === "") out.pop();
  const text = bom + sourceText(out);
  const eol = lines.find(line => line.eol)?.eol || "\n";
  return text.endsWith("\n") ? text : text + eol;
}

type MultilineStringKind = "basic" | "literal" | null;

/** Length of a closing multiline delimiter: TOML allows a run of three to five quotes. */
function quoteRunLength(text: string, index: number, quote: string): number {
  let end = index;
  while (end < text.length && text[end] === quote && end - index < 5) end += 1;
  return end - index;
}

/**
 * TOML table-looking text inside a multiline string is data, not syntax. Keep
 * a deliberately small lexical state machine so the format-preserving editor
 * never treats those physical lines as headers, keys, or ownership markers.
 */
function markStructuralLines(lines: SourceLine[]): void {
  let multiline: MultilineStringKind = null;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (const line of lines) {
    line.structural = multiline === null && squareDepth === 0 && curlyDepth === 0;
    let single: "basic" | "literal" | null = null;

    for (let index = 0; index < line.text.length;) {
      if (multiline === "basic") {
        if (line.text.startsWith('"""', index)) {
          // A closing delimiter may carry up to two content quotes before it.
          multiline = null;
          index += quoteRunLength(line.text, index, '"');
        } else if (line.text[index] === "\\") {
          index += 2;
        } else {
          index += 1;
        }
        continue;
      }
      if (multiline === "literal") {
        if (line.text.startsWith("'''", index)) {
          multiline = null;
          index += quoteRunLength(line.text, index, "'");
        } else {
          index += 1;
        }
        continue;
      }
      if (single === "basic") {
        if (line.text[index] === "\\") index += 2;
        else if (line.text[index] === '"') {
          single = null;
          index += 1;
        } else index += 1;
        continue;
      }
      if (single === "literal") {
        if (line.text[index] === "'") single = null;
        index += 1;
        continue;
      }

      if (line.text[index] === "#") break;
      if (line.text.startsWith('"""', index)) {
        multiline = "basic";
        index += 3;
      } else if (line.text.startsWith("'''", index)) {
        multiline = "literal";
        index += 3;
      } else if (line.text[index] === '"') {
        single = "basic";
        index += 1;
      } else if (line.text[index] === "'") {
        single = "literal";
        index += 1;
      } else if (line.text[index] === "[") {
        squareDepth += 1;
        index += 1;
      } else if (line.text[index] === "]") {
        squareDepth = Math.max(0, squareDepth - 1);
        index += 1;
      } else if (line.text[index] === "{") {
        curlyDepth += 1;
        index += 1;
      } else if (line.text[index] === "}") {
        curlyDepth = Math.max(0, curlyDepth - 1);
        index += 1;
      } else {
        index += 1;
      }
    }
  }
}
