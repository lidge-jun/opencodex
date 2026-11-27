import { parseSegment } from "./merge";
import { fingerprint } from "./ownership";
import { quoteTomlKey, renderToml } from "./serialize";

interface LineToken {
  readonly text: string;
  eol: string;
}

/**
 * Write owned TOML tables into the user's file without re-rendering the rest of it (#9152).
 *
 * Re-rendering the whole document drops every comment and flattens `[[array]]` tables into one
 * inline array, so another tool that keeps its own block in the same file loses its markers. Here
 * each owned table is cut out by its `[header]` and the replacements go where the first one was,
 * or at the end. Containers the semantic removal pruned lose their header line too.
 *
 * The result must parse to `expected`, the document the whole-file writer would have produced.
 * A layout this cannot patch (an owned table written inline or with dotted keys, a header inside a
 * multi-line string, or a user comment inside an owned table) fails that check and returns null,
 * so the caller refuses instead of guessing.
 */
export function patchTomlTablesSource(
  before: string,
  remove: readonly (readonly string[])[],
  upsert: readonly { path: readonly string[]; value: unknown }[],
  expected: unknown,
  options: { restoreAbsentTrailingNewlineFingerprint?: string } = {},
): string | null {
  if ([...remove, ...upsert.map(item => item.path)].some(path => !path.every(isPlainKey))) return null;
  if (upsert.some(item => !isPlainRecord(item.value))) return null;
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(before);
  const headers = lines.map(line => tableHeaderPath(line.text));
  const owned = new Set([...remove, ...upsert.map(item => item.path)].map(pathKey));
  const prunedHeaders = prunedContainers(before, expected);
  const drop = new Set<number>();
  const retained: string[][] = [];
  let insertAt: number | undefined;
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]!;
    if (header === null || header === "array") continue;
    const key = pathKey(header);
    if (header.some((_, depth) => owned.has(pathKey(header.slice(0, depth + 1))))) {
      insertAt ??= index;
      if (!dropRange(lines, headers, index, true, drop)) return null;
    } else if (prunedHeaders.has(key)) {
      // A comment the user put on the header line keeps the table, now empty, rather than going
      // with it.
      if (hasTomlComment(lines[index]!.text)) retained.push(header);
      else dropRange(lines, headers, index, false, drop);
    }
  }
  const kept: LineToken[] = [];
  let insertKept: number | undefined;
  let droppedFirstSeparator = false;
  lines.forEach((line, index) => {
    if (index === insertAt) {
      insertKept = kept.length;
      droppedFirstSeparator = index > 0 && drop.has(index - 1) && lines[index - 1]!.text.trim() === "";
    }
    if (!drop.has(index)) kept.push({ text: line.text, eol: line.eol });
  });
  const blocks = upsert.map(item => renderTable(item.path, item.value as Record<string, unknown>, eol));
  let text: string;
  if (blocks.length === 0) {
    // Restore an absent EOF newline only when ownership provenance proves the remaining bytes are
    // identical to the original newline-less file we appended to.
    if (options.restoreAbsentTrailingNewlineFingerprint !== undefined
      && insertKept !== undefined && insertKept === kept.length
      && kept.length > 0 && kept[kept.length - 1]!.eol !== "") {
      const last = kept[kept.length - 1]!;
      const originalEol = last.eol;
      last.eol = "";
      if (fingerprint(joinLines(kept)) !== options.restoreAbsentTrailingNewlineFingerprint) {
        last.eol = originalEol;
      }
    }
    text = joinLines(kept);
  } else if (insertKept !== undefined) {
    const head = kept.slice(0, insertKept);
    const tail = kept.slice(insertKept);
    const headText = joinLines(head);
    const tailText = joinLines(tail);
    let lead = "";
    if (head.length > 0) {
      if (head[head.length - 1]!.eol === "") lead = eol;
      else if (droppedFirstSeparator) lead = eol;
    }
    text = `${headText}${lead}${blocks.join(eol)}${tailText}`;
  } else {
    const body = joinLines(kept);
    const separator = body.length === 0
      ? ""
      : kept[kept.length - 1]!.eol === "" ? `${eol}${eol}` : eol;
    text = `${body}${separator}${blocks.join(eol)}`;
  }
  try {
    const normalizedExpected = withEmptyTables(
      withoutImplicitEmptyAncestors(expected, remove, headers),
      retained,
    );
    return Bun.deepEquals(Bun.TOML.parse(text), normalizedExpected) ? text : null;
  } catch {
    return null;
  }
}

function splitLines(input: string): LineToken[] {
  if (input.length === 0) return [];
  const tokens: LineToken[] = [];
  let start = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "\r" && input[i + 1] === "\n") {
      tokens.push({ text: input.slice(start, i), eol: "\r\n" });
      i += 1;
      start = i + 1;
    } else if (ch === "\n") {
      tokens.push({ text: input.slice(start, i), eol: "\n" });
      start = i + 1;
    }
  }
  if (start < input.length) {
    tokens.push({ text: input.slice(start), eol: "" });
  }
  return tokens;
}

function joinLines(lines: readonly LineToken[]): string {
  return lines.map(line => line.text + line.eol).join("");
}

/** True when a TOML line carries a `#` comment outside single- or double-quoted strings. */
function hasTomlComment(line: string): boolean {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inDouble) {
      if (ch === "\\") { i += 1; continue; }
      if (ch === "\"") inDouble = false;
    } else if (inSingle) {
      if (ch === "'") inSingle = false;
    } else {
      if (ch === "\"") inDouble = true;
      else if (ch === "'") inSingle = true;
      else if (ch === "#") return true;
    }
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainKey(segment: string): boolean {
  return parseSegment(segment).kind === "key";
}

function pathKey(path: readonly string[]): string {
  return path.join("\u0000");
}

/** The table a `[header]` line opens, "array" for `[[header]]`, or null for any other line. */
function tableHeaderPath(line: string): string[] | "array" | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(trimmed);
  } catch {
    return null;
  }
  if (trimmed.startsWith("[[")) return "array";
  const path: string[] = [];
  let node = parsed;
  while (isPlainRecord(node)) {
    const keys = Object.keys(node);
    if (keys.length === 0) break;
    if (keys.length !== 1) return null;
    path.push(keys[0]!);
    node = node[keys[0]!];
  }
  return path.length > 0 ? path : null;
}

/**
 * Mark a table for removal: its header, the blank line above it, and with `body` its key lines up
 * to the next header. Comments and blank lines at the end of the body stay, since they usually
 * introduce whatever follows. Returns false if an owned table header or body carries a user
 * comment that dropping the range would silently lose.
 */
function dropRange(
  lines: readonly LineToken[],
  headers: readonly (string[] | "array" | null)[],
  start: number,
  body: boolean,
  drop: Set<number>,
): boolean {
  let end = start + 1;
  if (body) {
    while (end < lines.length && headers[end] === null) end += 1;
    while (end > start + 1 && /^\s*(#.*)?$/.test(lines[end - 1]!.text)) end -= 1;
    for (let index = start; index < end; index += 1) {
      if (hasTomlComment(lines[index]!.text)) return false;
    }
  }
  for (let index = start; index < end; index += 1) drop.add(index);
  if (start > 0 && lines[start - 1]!.text.trim() === "" && !drop.has(start - 1)) drop.add(start - 1);
  return true;
}

/** Table paths the file declares that the expected document no longer has. */
function prunedContainers(before: string, expected: unknown): Set<string> {
  const pruned = new Set<string>();
  let current: unknown;
  try {
    current = Bun.TOML.parse(before);
  } catch {
    return pruned;
  }
  const walk = (node: unknown, target: unknown, path: string[]): void => {
    if (!isPlainRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (!isPlainRecord(child)) continue;
      const next = [...path, key];
      const counterpart = isPlainRecord(target) ? target[key] : undefined;
      if (counterpart === undefined) pruned.add(pathKey(next));
      walk(child, counterpart, next);
    }
  };
  walk(current, expected, []);
  return pruned;
}

function withoutImplicitEmptyAncestors(
  document: unknown,
  removedPaths: readonly (readonly string[])[],
  headers: readonly (string[] | "array" | null)[],
): unknown {
  if (removedPaths.length === 0 || !isPlainRecord(document)) return document;
  const explicitHeaders = new Set<string>();
  for (const header of headers) {
    if (header !== null && header !== "array") explicitHeaders.add(pathKey(header));
  }
  const ancestors: string[][] = [];
  const seen = new Set<string>();
  for (const path of removedPaths) {
    for (let depth = path.length - 1; depth >= 1; depth -= 1) {
      const ancestor = path.slice(0, depth);
      const key = pathKey(ancestor);
      if (!seen.has(key) && !explicitHeaders.has(key)) {
        seen.add(key);
        ancestors.push(ancestor);
      }
    }
  }
  if (ancestors.length === 0) return document;
  ancestors.sort((a, b) => b.length - a.length);
  const copy = structuredClone(document);
  for (const ancestor of ancestors) {
    let parent: Record<string, unknown> = copy;
    let reachable = true;
    for (let i = 0; i < ancestor.length - 1; i += 1) {
      const next = parent[ancestor[i]!];
      if (!isPlainRecord(next)) { reachable = false; break; }
      parent = next;
    }
    if (!reachable) continue;
    const leafKey = ancestor[ancestor.length - 1]!;
    const target = parent[leafKey];
    if (isPlainRecord(target) && Object.keys(target).length === 0) {
      delete parent[leafKey];
    }
  }
  return copy;
}

function withEmptyTables(document: unknown, paths: readonly string[][]): unknown {
  if (paths.length === 0 || !isPlainRecord(document)) return document;
  const copy = structuredClone(document);
  for (const path of paths) {
    let node: Record<string, unknown> = copy;
    for (const key of path) {
      if (!isPlainRecord(node[key])) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
  }
  return copy;
}

function renderTable(path: readonly string[], value: Record<string, unknown>, eol: string): string {
  const header = path.map(quoteTomlKey).join(".");
  const rendered = `[${header}]\n${renderToml(value, header)}`;
  return eol === "\n" ? rendered : rendered.replace(/\n/g, eol);
}
