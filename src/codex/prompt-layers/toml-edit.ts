import { OCX_SECTION_MARKER } from "../injected-marker";
import { encodeBasicString, lexicalLineStarts, matchKeyHead } from "./encoding";
import { TABLE_HEADER, ANY_DEV_INSTRUCTIONS, DEV_INSTRUCTIONS_KEY } from "./toml-read";

/** Line editing, not re-serialization: the user's comments and layout survive. */
export function dominantEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return "\n";
  const bareLf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf >= bareLf ? "\r\n" : "\n";
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

/**
 * A leading UTF-8 BOM, split off so line editing never steps over it.
 *
 * Codex reads config.toml with Rust `toml_edit`, which accepts a BOM at byte 0 and
 * nowhere else. Inserting the generated block at line index 0 pushed the BOM down
 * to byte 58, the write reported success because our own byte comparison matched
 * what we intended to write, and the next parse failed with
 * "Expected a key but found (0xEF)" — a config file the user could no longer load,
 * produced by a write that told them it worked.
 *
 * Editors on Windows write this byte routinely, so the file is not exotic.
 */
function splitBom(content: string): { bom: string; body: string } {
  return content.startsWith("\ufeff")
    ? { bom: "\ufeff", body: content.slice(1) }
    : { bom: "", body: content };
}

function joinLines(lines: string[], eol: "\r\n" | "\n"): string {
  const text = lines.join("\n");
  return eol === "\n" ? text : text.replace(/\n/g, "\r\n");
}

function firstTableIndex(lines: string[], starts?: readonly boolean[]): number {
  const idx = lines.findIndex((l, i) => (starts === undefined || starts[i] === true) && TABLE_HEADER.test(l));
  return idx === -1 ? lines.length : idx;
}

/**
 * Raised when a recognized `key =` line carries a value a line editor cannot
 * replace safely — a multi-line `"""…"""`/`'''…'''` span, an unterminated
 * quote, or trailing junk that is neither value nor comment. Callers refuse
 * BEFORE writing rather than splice over a span they cannot see the end of.
 */
export class UnsupportedTomlForm extends Error {
  constructor(readonly line: string) {
    super(`unsupported TOML value form: ${line.trim()}`);
    this.name = "UnsupportedTomlForm";
  }
}

/** Where `<key> =` ends and the value begins. `prefix` keeps indent and key quoting. */
interface AssignmentHead {
  prefix: string;
  rest: string;
}

/**
 * Lexical line scope for the editors below (see `lexicalLineStarts`). A span
 * that never closes means the scope of every later line is unknown, so the
 * whole edit refuses instead of guessing.
 */
function scopedLineStarts(lines: readonly string[]): boolean[] {
  const starts = lexicalLineStarts(lines);
  if (starts === null) throw new UnsupportedTomlForm("configuration contains an unterminated string or composite value");
  return starts;
}

/**
 * Split `rest` (everything after `key =`) into the value token and a trailing
 * `#…` comment — adjacent or whitespace-separated, both preserved.
 *
 * The scan is string-aware so a `#` inside a quoted value is never mistaken
 * for a comment opener: `"a#b" # note` parses as value `"a#b"` + comment
 * ` # note`, while `false# note` parses as `false` + `# note`. Anything the
 * token scan cannot classify — a multi-line string opener, an unterminated
 * quote, text after the value that is not a comment — throws
 * UnsupportedTomlForm so the caller refuses rather than guesses a span.
 */
function splitValueComment(head: AssignmentHead, line: string): { value: string; comment: string } {
  const { rest } = head;
  if (rest.startsWith('"""') || rest.startsWith("'''")) throw new UnsupportedTomlForm(line);
  let value: string;
  const first = rest[0];
  if (first === '"') {
    // Basic string: an escaped quote does not close, an unterminated one refuses.
    let i = 1;
    while (i < rest.length && rest[i] !== '"') i += rest[i] === "\\" ? 2 : 1;
    if (i >= rest.length) throw new UnsupportedTomlForm(line);
    value = rest.slice(0, i + 1);
  } else if (first === "'") {
    // Literal string: no escapes, the next ' closes it.
    const end = rest.indexOf("'", 1);
    if (end === -1) throw new UnsupportedTomlForm(line);
    value = rest.slice(0, end + 1);
  } else {
    // Composite values may continue onto another line. This scalar editor
    // refuses them instead of replacing only their opener and orphaning the tail.
    if (first === "[" || first === "{") throw new UnsupportedTomlForm(line);
    const m = /^[^\s#]+/.exec(rest);
    if (!m) throw new UnsupportedTomlForm(line);
    value = m[0];
  }
  const tail = rest.slice(value.length);
  if (tail !== "" && !/^\s*(?:#|$)/.test(tail)) throw new UnsupportedTomlForm(line);
  return { value, comment: tail };
}

/**
 * The shape of `key`'s root-scope assignment, or "absent". "unsupported" means
 * a `key =` line was found but its value is a form the line editor refuses —
 * multiline strings and the like — so a caller can fail BEFORE touching disk
 * instead of inside the transaction.
 */
export function rootKeyValueForm(content: string, key: string): "absent" | "simple" | "unsupported" {
  const { body } = splitBom(content);
  const lines = splitLines(body);
  let starts: boolean[];
  try { starts = scopedLineStarts(lines); } catch { return "unsupported"; }
  const limit = firstTableIndex(lines, starts);
  for (let i = 0; i < limit; i += 1) {
    if (!starts[i]) continue;
    const head = matchKeyHead(lines[i]!, key);
    if (!head) continue;
    try {
      splitValueComment(head, lines[i]!);
      return "simple";
    } catch {
      return "unsupported";
    }
  }
  return "absent";
}

/**
 * Replace or remove one matched line. The line's own indentation, key quoting,
 * and trailing comment are preserved; `null` removes the assignment but keeps
 * a comment behind so a `# note` written beside the key survives a reset.
 */
function applyLineEdit(lines: string[], i: number, key: string, replacement: string | null): void {
  const head = matchKeyHead(lines[i]!, key)!;
  const { comment } = splitValueComment(head, lines[i]!);
  if (replacement === null) {
    if (comment.trim()) lines[i] = comment.trim();
    else lines.splice(i, 1);
  } else {
    lines[i] = `${head.prefix}${replacement}${comment}`;
  }
}

type EditMode = "inplace" | "appended" | "noop";
interface LineEdit { text: string; mode: EditMode }

/**
 * Set a root-scope boolean, inserting above the first table when absent.
 *
 * `null` REMOVES the key rather than writing a value, which is what restoring a
 * documented default means: `include_permissions_instructions = true` and an
 * absent key are different facts about the same file, and only the absent one
 * lets a changed upstream default ever take effect again.
 *
 * The value slot is classified, not just skipped over: any value form the line
 * editor cannot see the end of — a multi-line string span, an unterminated
 * quote — throws UnsupportedTomlForm so the write is refused instead of
 * appending a second assignment TOML would reject as a duplicate key. A value
 * that is not a boolean is a bad fact about the same key, so it is REPLACED,
 * and a trailing comment survives a write or a removal whether or not a space
 * precedes the `#`.
 */
function setRootBoolLines(content: string, key: string, value: boolean | null): LineEdit {
  const eol = dominantEol(content);
  const { bom, body } = splitBom(content);
  const lines = splitLines(body);
  const starts = scopedLineStarts(lines);
  const limit = firstTableIndex(lines, starts);
  for (let i = 0; i < limit; i += 1) {
    if (!starts[i] || !matchKeyHead(lines[i]!, key)) continue;
    applyLineEdit(lines, i, key, value === null ? null : String(value));
    return { text: bom + joinLines(lines, eol), mode: "inplace" };
  }
  if (value === null) return { text: bom + joinLines(lines, eol), mode: "noop" };
  lines.splice(limit, 0, `${key} = ${value}`);
  return { text: bom + joinLines(lines, eol), mode: "appended" };
}

/**
 * Set or REMOVE a root-scope basic string. `null` removes the key.
 *
 * Removal is what selecting the default variant does, and it has to be a real deletion
 * rather than an empty string: `model_instructions_file = ""` is a path Codex would try
 * to read, not an absent setting.
 */
function setRootStringLines(content: string, key: string, value: string | null): LineEdit {
  const eol = dominantEol(content);
  const { bom, body } = splitBom(content);
  const lines = splitLines(body);
  const starts = scopedLineStarts(lines);
  const limit = firstTableIndex(lines, starts);
  for (let i = 0; i < limit; i += 1) {
    if (!starts[i] || !matchKeyHead(lines[i]!, key)) continue;
    applyLineEdit(lines, i, key, value === null ? null : encodeBasicString(value));
    return { text: bom + joinLines(lines, eol), mode: "inplace" };
  }
  if (value === null) return { text: bom + joinLines(lines, eol), mode: "noop" };
  lines.splice(limit, 0, `${key} = ${encodeBasicString(value)}`);
  return { text: bom + joinLines(lines, eol), mode: "appended" };
}

/**
 * Set a boolean inside `[table]`, appending the table when absent.
 *
 * `null` removes the key line but leaves the table header: an empty `[skills]`
 * is valid TOML, and deleting the header would also orphan any comments the
 * user wrote inside the table.
 */
function setTableBoolLines(content: string, table: string, key: string, value: boolean | null): LineEdit {
  const eol = dominantEol(content);
  const { bom, body } = splitBom(content);
  const lines = splitLines(body);
  const starts = scopedLineStarts(lines);
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`);
  const start = lines.findIndex((l, i) => starts[i] === true && header.test(l));
  if (start === -1) {
    if (value === null) return { text: bom + joinLines(lines, eol), mode: "noop" };
    const tail = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    lines.splice(tail, 0, `[${table}]`, `${key} = ${value}`);
    return { text: bom + joinLines(lines, eol), mode: "appended" };
  }
  let end = start + 1;
  while (end < lines.length && !(starts[end] && TABLE_HEADER.test(lines[end]!))) end += 1;
  for (let i = start + 1; i < end; i += 1) {
    if (!starts[i] || !matchKeyHead(lines[i]!, key)) continue;
    applyLineEdit(lines, i, key, value === null ? null : String(value));
    return { text: bom + joinLines(lines, eol), mode: "inplace" };
  }
  if (value === null) return { text: bom + joinLines(lines, eol), mode: "noop" };
  lines.splice(end, 0, `${key} = ${value}`);
  return { text: bom + joinLines(lines, eol), mode: "appended" };
}


/**
 * Replace, insert, or remove the generated two-line block. Canonical form is
 * marker + assignment at the top of the document; replacement is "find the
 * marker, replace the next line" rather than a span search.
 */
export function setProjection(content: string | null, projection: string | null): string {
  const base = content ?? "";
  const eol = dominantEol(base);
  // The BOM is held aside for the whole edit. This is the function that produced
  // the corruption: the insert below is at index 0, which put the marker line
  // ahead of a byte that is only legal at byte 0.
  const { bom, body } = splitBom(base);
  const lines = splitLines(body);
  const limit = firstTableIndex(lines);

  let markerAt = -1;
  for (let i = 0; i < limit; i += 1) {
    if (i > 0 && lines[i - 1]!.includes(OCX_SECTION_MARKER) && ANY_DEV_INSTRUCTIONS.test(lines[i]!)) {
      markerAt = i - 1;
      break;
    }
  }

  if (markerAt !== -1) {
    if (projection === null) lines.splice(markerAt, 2);
    else lines[markerAt + 1] = `${DEV_INSTRUCTIONS_KEY} = ${encodeBasicString(projection)}`;
    return bom + joinLines(lines, eol);
  }

  if (projection === null) return bom + joinLines(lines, eol);
  lines.splice(0, 0, OCX_SECTION_MARKER, `${DEV_INSTRUCTIONS_KEY} = ${encodeBasicString(projection)}`);
  return bom + joinLines(lines, eol);
}


/** Remove an unowned or reshaped `developer_instructions` from the root scope. */
export function removeUnownedProjection(content: string): string {
  const eol = dominantEol(content);
  const lines = splitLines(content);
  const limit = firstTableIndex(lines);
  for (let i = 0; i < limit; i += 1) {
    if (!ANY_DEV_INSTRUCTIONS.test(lines[i]!)) continue;
    const marked = i > 0 && lines[i - 1]!.includes(OCX_SECTION_MARKER);
    lines.splice(marked ? i - 1 : i, marked ? 2 : 1);
    return joinLines(lines, eol);
  }
  return joinLines(lines, eol);
}

/**
 * Refuse, before any write, an edit that does not do exactly what it was asked.
 *
 * The line editors above address bare table headers and bare or quoted keys. A
 * quoted, spaced, inline or dotted spelling of the same table makes them append a
 * duplicate header (a file Codex cannot load) or, for restore-default, leave the
 * override in place while the caller reports success. Both are caught by parsing
 * the before and after images: the parsed result must equal the parsed input with
 * only the intended path set or removed. When Bun cannot parse the input (its
 * parser has documented gaps a valid Codex config can hit, such as i64 extremes),
 * only an in-place replacement of a key the editor located is trusted; an append
 * or a no-op restore cannot be verified and is refused. A target value with
 * control characters is checked for presence and type only, for the same reason.
 */
function checkedEdit(before: string, edit: LineEdit, path: readonly string[], value: string | boolean | null): string {
  const after = edit.text;
  let parsedBefore: Record<string, unknown>;
  try { parsedBefore = Bun.TOML.parse(before.replace(/^\ufeff/, "")) as Record<string, unknown>; } catch {
    if (edit.mode === "inplace") return after;
    throw new UnsupportedTomlForm("config.toml uses syntax this editor cannot verify; edit it by hand");
  }
  let parsedAfter: Record<string, unknown>;
  try { parsedAfter = Bun.TOML.parse(after.replace(/^\ufeff/, "")) as Record<string, unknown>; } catch {
    throw new UnsupportedTomlForm("edit would leave config.toml unparseable");
  }
  try {
    const expected = tomlClone(parsedBefore) as Record<string, unknown>;
    let parent: Record<string, unknown> | null = expected;
    let afterParent: unknown = parsedAfter;
    for (const segment of path.slice(0, -1)) {
      const next: unknown = parent?.[segment];
      afterParent = isPlainTable(afterParent) ? afterParent[segment] : undefined;
      if (next === undefined) {
        if (value === null) { parent = null; break; }
        parent![segment] = {};
        parent = parent![segment] as Record<string, unknown>;
        continue;
      }
      if (!isPlainTable(next)) throw new UnsupportedTomlForm("edit target is not a plain table");
      parent = next;
    }
    const key = path[path.length - 1]!;
    if (parent !== null) {
      if (value === null) delete parent[key];
      else if (typeof value === "string" && /[\u0000-\u001f\u007f]/.test(value)) {
        const landed = isPlainTable(afterParent) ? afterParent[key] : undefined;
        if (typeof landed !== "string") throw new UnsupportedTomlForm("edit did not land on the intended key");
        parent[key] = landed;
      } else parent[key] = value;
    }
    if (!tomlEqual(parsedAfter, expected)) throw new UnsupportedTomlForm("edit did not land on the intended key");
  } catch (error) {
    if (error instanceof UnsupportedTomlForm) throw error;
    throw new UnsupportedTomlForm("edit could not be verified");
  }
  return after;
}

function isPlainTable(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Arrays and plain tables are copied; TOML date/time values are immutable and shared. */
function tomlClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tomlClone);
  if (isPlainTable(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tomlClone(v)]));
  return value;
}

function tomlEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => tomlEqual(v, b[i]));
  }
  if (isPlainTable(a) || isPlainTable(b)) {
    if (!isPlainTable(a) || !isPlainTable(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && tomlEqual(a[k], b[k]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    return Object.getPrototypeOf(a) === Object.getPrototypeOf(b) && String(a) === String(b);
  }
  return false;
}

export function setRootBool(content: string, key: string, value: boolean | null): string {
  return checkedEdit(content, setRootBoolLines(content, key, value), [key], value);
}

export function setRootString(content: string, key: string, value: string | null): string {
  return checkedEdit(content, setRootStringLines(content, key, value), [key], value);
}

export function setTableBool(content: string, table: string, key: string, value: boolean | null): string {
  return checkedEdit(content, setTableBoolLines(content, table, key, value), [...table.split("."), key], value);
}
