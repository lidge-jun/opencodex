import { OCX_SECTION_MARKER } from "../injected-marker";
import { decodeBasicString } from "./encoding";

/**
 * Decoded string entries of a root-scope TOML array.
 *
 * Parsed, not pattern-matched. Three successive review rounds each found another
 * valid spelling a hand-rolled reader missed — multi-line arrays, a comment after the
 * opening bracket, a quoted key — and every miss was a rendered document whose edits
 * moved no admission key. The pattern was the defect: TOML is not a line format, so
 * no regex over lines can enumerate what a parser accepts.
 *
 * The module header's warning about JS TOML parsers does apply here, and a review
 * round proved it against an earlier version of this comment that claimed otherwise.
 * Bun rejects an entire document containing an integer outside JavaScript's safe
 * range, such as `model_context_window = 9223372036854775807`, which Rust accepts as
 * an ordinary `i64`. A whole-document parse turned that into BOTH arrays disappearing
 * — a worse failure than any single missed spelling, and one the old regex did not
 * have.
 *
 * So the parse is the preferred reader, not the only one. When it fails, the scan
 * below runs, and it is deliberately loose: it accepts any spelling it recognises and
 * over-reports rather than under-reports, because an extra hashed filename costs one
 * redundant probe while a missing one costs stale text.
 */
export function rootArrayEntries(configBytes: string | null, key: string): string[] {
  const value = rootValue(configBytes, key);
  if (value === PARSE_FAILED) return scanRootArrayEntries(configBytes, key);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Distinguishes "the parser could not read this file" from "the key is absent".
 * Collapsing the two is what made an unrelated large integer silently empty the
 * project-document set.
 */
const PARSE_FAILED = Symbol("toml-parse-failed");

/** A root-scope value, `undefined` when the key is absent, `PARSE_FAILED` when the file will not parse. */
function rootValue(configBytes: string | null, key: string): unknown {
  if (configBytes === null) return undefined;
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(configBytes);
  } catch {
    return PARSE_FAILED;
  }
  if (typeof parsed !== "object" || parsed === null) return PARSE_FAILED;
  return (parsed as Record<string, unknown>)[key];
}

/**
 * Fallback reader for a config this parser will not accept but Codex will.
 *
 * Not a second attempt at being a TOML parser — that approach failed three review
 * rounds. It is a deliberately over-eager scan: it takes the first bracketed group for
 * the key under either spelling, spans lines, strips comments, and keeps anything that
 * decodes. Over-reporting is the safe direction here.
 */
function scanRootArrayEntries(configBytes: string | null, key: string): string[] {
  const lines = rootLines(configBytes ?? "");
  const opener = new RegExp(`^\\s*"?${key}"?\\s*=\\s*\\[(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const m = opener.exec(lines[i]!);
    if (!m) continue;
    let body = m[1]!.replace(/#.*$/, "");
    for (let j = i; !body.includes("]"); ) {
      j += 1;
      if (j >= lines.length) return [];
      body += lines[j]!.replace(/#.*$/, "");
    }
    const out: string[] = [];
    for (const raw of body.slice(0, body.indexOf("]")).split(",")) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      const decoded = trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2
        ? trimmed.slice(1, -1)
        : decodeBasicString(trimmed);
      if (decoded !== null) out.push(decoded);
    }
    return out;
  }
  return [];
}

/**
 * Whether a root-scope key is present at all, regardless of what it holds.
 *
 * A parse failure is not an answer, so it falls through to the scan rather than
 * counting as present: reading `PARSE_FAILED` as "present" would report an empty
 * marker list and disable root detection on a config Codex reads fine.
 */
export function hasRootKey(configBytes: string | null, key: string): boolean {
  const value = rootValue(configBytes, key);
  if (value === PARSE_FAILED) return scanHasRootKey(configBytes, key);
  return value !== undefined;
}

/** Textual presence check, used only when the parser cannot read the file. */
function scanHasRootKey(configBytes: string | null, key: string): boolean {
  const probe = new RegExp(`^\\s*"?${key}"?\\s*=`);
  return rootLines(configBytes ?? "").some(line => probe.test(line));
}

// ---------------------------------------------------------------------------
// Scoped TOML scanning. Line-based like `features.ts:80-93`: booleans need no
// escaping, and line editing preserves the user's comments and formatting
// exactly where a re-serialize would not.
// ---------------------------------------------------------------------------

export const TABLE_HEADER = /^\s*\[/;

/** Lines of the root scope: everything before the first `[table]` header. */
export function rootLines(content: string): string[] {
  const lines = content.split("\n");
  const first = lines.findIndex(l => TABLE_HEADER.test(l));
  return first === -1 ? lines : lines.slice(0, first);
}

/** Lines of `[header]`'s body, up to the next table header. */
export function tableLines(content: string, header: string): string[] | null {
  const lines = content.split("\n");
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex(l => new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`).test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => TABLE_HEADER.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

export function boolInLines(lines: string[], key: string): boolean | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*=\\s*(true|false)\\s*(?:#.*)?$`);
  for (const line of lines) {
    const m = pattern.exec(line);
    if (m) return m[1] === "true";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ownership of the generated projection.
//
// Canonical physical form, always exactly two lines at the top of the document:
//
//     # Auto-injected by opencodex
//     developer_instructions = "<single-line basic string>"
//
// Replacement is "find the marker, replace the next line" — never a span search.
// Adjacency mirrors `injected-marker.ts:53-60`, tightened by a shape check.
// ---------------------------------------------------------------------------

export const DEV_INSTRUCTIONS_KEY = "developer_instructions";
const CANONICAL_LINE = /^developer_instructions = "(?:[^"\\]|\\.)*"$/;
export const ANY_DEV_INSTRUCTIONS = /^\s*(?:developer_instructions|"developer_instructions"|'developer_instructions')\s*=/;

export type Ownership =
  /** no such key anywhere in the root scope */
  | { state: "absent" }
  /** marker-adjacent and canonically shaped: ours to rewrite */
  | { state: "owned"; line: number; literal: string }
  /** marker-adjacent but reshaped: refuse, offer repair */
  | { state: "owned-malformed"; line: number; raw: string }
  /** no marker: externally authored, refuse and offer adoption */
  | { state: "external"; line: number; raw: string };

export function inspectOwnership(configBytes: string | null): Ownership {
  if (configBytes === null) return { state: "absent" };
  const lines = rootLines(configBytes);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (!ANY_DEV_INSTRUCTIONS.test(raw)) continue;
    const marked = i > 0 && lines[i - 1]!.includes(OCX_SECTION_MARKER);
    if (!marked) return { state: "external", line: i + 1, raw };
    if (!CANONICAL_LINE.test(raw)) return { state: "owned-malformed", line: i + 1, raw };
    const literal = raw.slice(`${DEV_INSTRUCTIONS_KEY} = `.length);
    return { state: "owned", line: i + 1, literal };
  }
  return { state: "absent" };
}
