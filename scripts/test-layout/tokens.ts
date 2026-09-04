/**
 * A small TypeScript tokenizer, enough to tell a string literal in specifier position
 * (`from "x"`, `import("x")`, `require("x")`, `new URL("x", import.meta.url)`) from the same
 * text inside another string, a template literal, a comment, or a regex literal. The mover
 * rewrites only the former; a test that asserts on source text containing an import must keep
 * its expectation byte-for-byte.
 */

export type TokenKind = "code" | "string" | "template" | "comment" | "regex";

export interface Token {
  kind: TokenKind;
  start: number;
  end: number; // exclusive
}

const REGEX_PRECEDERS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^",
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else",
]);

function lastSignificant(source: string, before: number): string {
  let i = before - 1;
  while (i >= 0 && /\s/.test(source[i]!)) i -= 1;
  if (i < 0) return "";
  if (/[A-Za-z0-9_$]/.test(source[i]!)) {
    let j = i;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(source[j]!)) j -= 1;
    return source.slice(j + 1, i + 1);
  }
  return source[i]!;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let codeStart = 0;
  const flushCode = (end: number) => {
    if (end > codeStart) tokens.push({ kind: "code", start: codeStart, end });
  };
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      flushCode(i);
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      tokens.push({ kind: "comment", start: i, end: stop });
      i = codeStart = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      flushCode(i);
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      tokens.push({ kind: "comment", start: i, end: stop });
      i = codeStart = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      flushCode(i);
      let j = i + 1;
      while (j < n && source[j] !== ch && source[j] !== "\n") {
        if (source[j] === "\\") j += 1;
        j += 1;
      }
      const stop = Math.min(n, j + 1);
      tokens.push({ kind: "string", start: i, end: stop });
      i = codeStart = stop;
      continue;
    }
    if (ch === "`") {
      flushCode(i);
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        const c = source[j]!;
        if (c === "\\") { j += 2; continue; }
        if (depth === 0 && c === "`") break;
        if (c === "$" && source[j + 1] === "{") { depth += 1; j += 2; continue; }
        if (depth > 0 && c === "}") { depth -= 1; j += 1; continue; }
        if (depth > 0 && (c === '"' || c === "'")) {
          j += 1;
          while (j < n && source[j] !== c) { if (source[j] === "\\") j += 1; j += 1; }
        }
        j += 1;
      }
      const stop = Math.min(n, j + 1);
      tokens.push({ kind: "template", start: i, end: stop });
      i = codeStart = stop;
      continue;
    }
    if (ch === "/" && REGEX_PRECEDERS.has(lastSignificant(source, i))) {
      flushCode(i);
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== "\n") {
        const c = source[j]!;
        if (c === "\\") { j += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        j += 1;
      }
      j += 1;
      while (j < n && /[a-z]/.test(source[j]!)) j += 1;
      tokens.push({ kind: "regex", start: i, end: j });
      i = codeStart = j;
      continue;
    }
    i += 1;
  }
  flushCode(n);
  return tokens;
}

/** The source with every string, template, comment and regex body replaced by spaces (positions preserved). */
export function maskNonCode(source: string, tokens: Token[] = tokenize(source)): string {
  let out = "";
  for (const token of tokens) {
    const text = source.slice(token.start, token.end);
    out += token.kind === "code" ? text : text.replace(/[^\n]/g, " ");
  }
  return out;
}

export interface SpecifierSite {
  /** The string token holding the specifier. */
  token: Token;
  /** The specifier text without quotes. */
  spec: string;
  quote: string;
}

// `mock.module("x", ...)` (bun:test) names a module the same way an import does: the string must
// re-anchor with the file or the mock silently stops intercepting.
const SPECIFIER_LEAD = /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\(|\bimport\.meta\.resolve\s*\(|\bnew\s+URL\s*\(|\bmock\.module\s*\()\s*$/;

/** String tokens that sit in a module-specifier position. */
export function specifierSites(source: string, tokens: Token[] = tokenize(source)): SpecifierSite[] {
  const masked = maskNonCode(source, tokens);
  const sites: SpecifierSite[] = [];
  for (const token of tokens) {
    if (token.kind !== "string") continue;
    const lead = masked.slice(Math.max(0, token.start - 40), token.start);
    const m = SPECIFIER_LEAD.exec(lead);
    if (!m) continue;
    if (/new\s+URL/.test(m[0])) {
      const after = masked.slice(token.end, token.end + 40);
      if (!/^\s*,\s*import\.meta\.url/.test(after)) continue;
    }
    const quote = source[token.start]!;
    sites.push({ token, spec: source.slice(token.start + 1, token.end - 1), quote });
  }
  return sites;
}
