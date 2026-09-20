/**
 * JSONC parse used by OpenCode's launcher and Kilo's managed writer.
 *
 * Comments and trailing commas are stripped by escape-aware passes that are
 * identity on valid strict JSON, so no strict-parse probe is ever needed.
 */

/**
 * Strip `//` and block comments outside string literals. Escape-aware so a quote inside
 * an escaped sequence cannot flip string state and expose config text to the stripper.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      // Newlines are preserved so JSON.parse error positions stay meaningful.
      if (ch === "\n") out += ch;
      else if (ch === "*" && next === "/") {
        // Emit a separator, not nothing: a block comment between two digits is
        // two tokens and must not collapse into one, which would silently
        // change a malformed value into a different valid one. Whitespace is
        // legal wherever a comment was, so this is identity for valid JSONC.
        out += " ";
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const escaped = text[i + 1];
        if (escaped !== undefined) { out += escaped; i++; }
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; out += ch; continue; }
    if (ch === "/" && next === "/") { inLine = true; i++; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i++; continue; }
    out += ch;
  }
  /*
   * An unterminated block comment means the remainder of the document was
   * comment text. Returning it stripped would let a trailing `/*` delete an
   * arbitrary malformed tail, so the caller sees a parse failure instead.
   */
  if (inBlock) throw new SyntaxError("Unterminated block comment");
  return out;
}

/** Drop commas that sit directly before `}` or `]`, ignoring string contents. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const escaped = text[i + 1];
        if (escaped !== undefined) { out += escaped; i++; }
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; out += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Return JSON that `JSON.parse` will accept. Comments and trailing commas are
 * stripped unconditionally: never probed with a strict `JSON.parse` first,
 * because materializing a deeply nested document before the rewrite guard's
 * depth ceiling would bypass that guard's resource contract. The passes are
 * identity on valid strict JSON — `//`, `/*`, and a comma before `}` or `]`
 * can only appear inside strings there, which the strippers never touch.
 */
export function canonicalizeJsonc(text: string): string {
  return stripTrailingCommas(stripJsonComments(text));
}

/**
 * JSON with optional comments and trailing commas. Same stripping rules as
 * `canonicalizeJsonc`; throws on text that is still not JSON afterwards.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(canonicalizeJsonc(text));
}
