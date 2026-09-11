/**
 * Source-preserving mutation for one plain block-map YAML fragment.
 *
 * Shared client settings are not ours to re-render. This scanner accepts only
 * the small, unambiguous source shape we can patch byte-for-byte around the
 * owned leaf. Every candidate is parsed again and compared with the complete
 * expected document; unsupported YAML fails closed and never falls back to a
 * whole-document serializer.
 */
import { renderYaml } from "./serialize";

interface SourceLine {
  start: number;
  end: number;
  body: string;
}

interface LocatedEntry {
  lines: readonly SourceLine[];
  index: number;
  indent: number;
  endIndex: number;
}

interface MissingEntry {
  lines: readonly SourceLine[];
  missingDepth: number;
  indent: number;
  insertAt: number;
}

interface ReplaceLineEntry {
  lines: readonly SourceLine[];
  index: number;
  indent: number;
  missingDepth: number;
}

type LocatedPath =
  | { kind: "existing"; entry: LocatedEntry }
  | { kind: "missing"; entry: MissingEntry }
  // `key: {}` — an empty inline map the block-key scanner cannot see (#4260).
  | { kind: "replace-line"; entry: ReplaceLineEntry }
  // A populated flow container. Still refused, but nameable as its own cause.
  | { kind: "unsupported-style" };

export type YamlFragmentMutation =
  | { kind: "upsert"; value: unknown }
  | { kind: "remove"; createdContainers: readonly string[] };

export type OmpYamlMutation =
  | { kind: "upsert"; value: unknown }
  | { kind: "remove"; removeEmptyProviders: boolean };

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const matcher = /[^\r\n]*(?:\r\n|\n|$)/gu;
  for (const match of text.matchAll(matcher)) {
    const raw = match[0];
    if (raw.length === 0) continue;
    const start = match.index;
    const body = raw.endsWith("\r\n")
      ? raw.slice(0, -2)
      : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    lines.push({ start, end: start + raw.length, body });
  }
  return lines;
}

function leadingSpaces(line: string): number | null {
  const leading = line.match(/^[ \t]*/u)?.[0] ?? "";
  return leading.includes("\t") ? null : leading.length;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function isComment(line: string): boolean {
  return line.trimStart().startsWith("#");
}

function hasInlineComment(line: string): boolean {
  return line.includes("#");
}

function regexpEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isPlainBlockKey(line: string, indent: number, key: string): boolean {
  const spaces = leadingSpaces(line);
  if (spaces !== indent) return false;
  const rest = line.slice(indent);
  return new RegExp(`^${regexpEscape(key)}:[ ]*(?:#.*)?$`, "u").test(rest);
}

/** The inline value written after `key:` on this line, or null if the key is not here. */
function inlineValueAfterKey(line: string, indent: number, key: string): string | null {
  const spaces = leadingSpaces(line);
  if (spaces !== indent) return null;
  const rest = line.slice(indent);
  const head = `${key}:`;
  // Compared as text, not as a pattern: a path segment is arbitrary user data,
  // and brace escaping inside a `u`-flag regex is its own hazard.
  if (!rest.startsWith(head)) return null;
  return rest.slice(head.length).trim();
}

/** Exactly `key: {}` (any inner spacing) — an empty inline map, no inline comment. */
function isEmptyInlineMapKey(line: string, indent: number, key: string): boolean {
  const value = inlineValueAfterKey(line, indent, key);
  if (value === null) return false;
  return value.startsWith("{") && value.endsWith("}") && value.slice(1, -1).trim().length === 0;
}

/** `key: { ... }` or `key: [ ... ]` on one line: content we would have to re-render. */
function isPopulatedInlineFlowKey(line: string, indent: number, key: string): boolean {
  const value = inlineValueAfterKey(line, indent, key);
  if (value === null) return false;
  if (!value.startsWith("{") && !value.startsWith("[")) return false;
  return !isEmptyInlineMapKey(line, indent, key);
}

/**
 * A plain block key whose first child opens a flow collection:
 *
 *     providers:
 *       { native: { ... } }
 *
 * DSH writes this shape itself. The walk passes straight through it — the key
 * line is a plain block key and `containerEnd` does not stop at `}` — so the
 * refusal used to surface only as a failed re-parse at the very end and got
 * reported as a comment or formatting problem that was not there (#4260).
 */
function firstChildOpensFlow(
  lines: readonly SourceLine[],
  start: number,
  end: number,
  parentIndent: number,
): boolean {
  for (let index = start + 1; index < end; index += 1) {
    const body = lines[index]!.body;
    if (isBlank(body) || isComment(body)) continue;
    const spaces = leadingSpaces(body);
    if (spaces === null || spaces <= parentIndent) continue;
    const trimmed = body.trimStart();
    return trimmed.startsWith("{") || trimmed.startsWith("[");
  }
  return false;
}

function containerEnd(lines: readonly SourceLine[], start: number, indent: number): number | null {
  for (let index = start + 1; index < lines.length; index += 1) {
    const body = lines[index]!.body;
    const spaces = leadingSpaces(body);
    if (spaces === null) return null;
    if (isBlank(body)) continue;
    if (isComment(body)) {
      if (spaces <= indent) return index;
      continue;
    }
    if (spaces <= indent) return index;
  }
  return lines.length;
}

function childEnd(
  lines: readonly SourceLine[],
  start: number,
  parentEnd: number,
  indent: number,
): number | null {
  for (let index = start + 1; index < parentEnd; index += 1) {
    const body = lines[index]!.body;
    const spaces = leadingSpaces(body);
    if (spaces === null) return null;
    // Blank lines and same-level comments remain outside our replacement.
    // Deeper comments belong to the leaf and would be destroyed, so refuse.
    if (isBlank(body)) return index;
    if (isComment(body)) return spaces <= indent ? index : null;
    if (spaces <= indent) return index;
    if (hasInlineComment(body)) return null;
  }
  return parentEnd;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function semanticallyMatches(text: string, expected: unknown): boolean {
  try {
    const parsed = text.trim().length === 0 ? {} : Bun.YAML.parse(text);
    return JSON.stringify(canonicalValue(parsed)) === JSON.stringify(canonicalValue(expected));
  } catch {
    return false;
  }
}

function lineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function readPath(doc: unknown, path: readonly string[]): unknown {
  let cursor = doc;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function immediateIndent(
  lines: readonly SourceLine[],
  start: number,
  end: number,
  parentIndent: number,
): number | null {
  let indent: number | null = null;
  for (let index = start; index < end; index += 1) {
    const body = lines[index]!.body;
    const spaces = leadingSpaces(body);
    if (spaces === null) return null;
    if (isBlank(body) || isComment(body) || spaces <= parentIndent) continue;
    indent = indent === null ? spaces : Math.min(indent, spaces);
  }
  return indent ?? parentIndent + 2;
}

/** Locate a path only when every present segment is a plain block-map key. */
function locatePath(text: string, parsed: unknown, path: readonly string[]): LocatedPath | null {
  if (path.length === 0 || !isPlainRecord(parsed)) return null;
  const lines = sourceLines(text);
  if (lines.some(line => leadingSpaces(line.body) === null)) return null;

  let rangeStart = 0;
  let rangeEnd = lines.length;
  let parentIndent = -2;
  const prefix: string[] = [];
  for (let depth = 0; depth < path.length; depth += 1) {
    const indent = depth === 0 ? 0 : immediateIndent(lines, rangeStart, rangeEnd, parentIndent);
    if (indent === null) return null;
    const matches: number[] = [];
    for (let index = rangeStart; index < rangeEnd; index += 1) {
      if (isPlainBlockKey(lines[index]!.body, indent, path[depth]!)) matches.push(index);
    }
    if (matches.length > 1) return null;
    prefix.push(path[depth]!);
    if (matches.length === 0) {
      const seen = readPath(parsed, prefix);
      // An empty inline map is the one flow shape we can adopt: rewriting that
      // single line into block form adds our subtree and re-renders nothing the
      // user wrote, because there is nothing in it (#4260).
      const inline: number[] = [];
      const populatedFlow: number[] = [];
      for (let index = rangeStart; index < rangeEnd; index += 1) {
        const body = lines[index]!.body;
        if (isEmptyInlineMapKey(body, indent, path[depth]!)) inline.push(index);
        else if (isPopulatedInlineFlowKey(body, indent, path[depth]!)) populatedFlow.push(index);
      }
      if (inline.length === 1 && isPlainRecord(seen) && Object.keys(seen).length === 0) {
        return { kind: "replace-line", entry: { lines, index: inline[0]!, indent, missingDepth: depth } };
      }
      if (populatedFlow.length === 1 && seen !== undefined) return { kind: "unsupported-style" };
      // The parser saw this key through syntax we do not patch (quoted/flow,
      // merge aliases, or an ambiguous indentation shape).
      if (seen !== undefined) return null;
      const insertAt = rangeEnd < lines.length ? lines[rangeEnd]!.start : text.length;
      return { kind: "missing", entry: { lines, missingDepth: depth, indent, insertAt } };
    }

    const index = matches[0]!;
    const end = containerEnd(lines, index, indent);
    if (end === null) return null;
    if (depth === path.length - 1) {
      if (hasInlineComment(lines[index]!.body)) return null;
      const leafEnd = childEnd(lines, index, end, indent);
      if (leafEnd === null) return null;
      return { kind: "existing", entry: { lines, index, indent, endIndex: leafEnd } };
    }
    const container = readPath(parsed, prefix);
    // `key:` with no children parses as null. The key line matched, so the
    // missing-key branch above never runs, and `isPlainRecord(null)` is false —
    // so an empty container used to refuse the whole document (#4260). Insert
    // our subtree as its first child instead.
    if (container === null) {
      const insertAt = end < lines.length ? lines[end]!.start : text.length;
      return {
        kind: "missing",
        entry: { lines, missingDepth: depth + 1, indent: indent + 2, insertAt },
      };
    }
    if (!isPlainRecord(container)) return null;
    if (firstChildOpensFlow(lines, index, end, indent)) return { kind: "unsupported-style" };
    rangeStart = index + 1;
    rangeEnd = end;
    parentIndent = indent;
  }
  return null;
}

function nestedValue(path: readonly string[], value: unknown): Record<string, unknown> {
  let nested: unknown = value;
  for (let index = path.length - 1; index >= 0; index -= 1) nested = { [path[index]!]: nested };
  return nested as Record<string, unknown>;
}

function rendered(value: unknown, indent: number, eol: "\n" | "\r\n"): string {
  return renderYaml(value as Record<string, unknown>, indent).replaceAll("\n", eol);
}

function preserveFinalNewline(candidate: string, original: string, eol: "\n" | "\r\n"): string {
  if (original.length > 0 && !original.endsWith("\n") && candidate.endsWith(eol)) {
    return candidate.slice(0, -eol.length);
  }
  return candidate;
}

function upsertSource(
  text: string,
  parsed: unknown,
  path: readonly string[],
  value: unknown,
): string | null {
  const located = locatePath(text, parsed, path);
  if (located === null || located.kind === "unsupported-style") return null;
  const eol = lineEnding(text);
  if (located.kind === "existing") {
    const { lines, index, indent, endIndex } = located.entry;
    const startOffset = lines[index]!.start;
    const endOffset = endIndex < lines.length ? lines[endIndex]!.start : text.length;
    const candidate = `${text.slice(0, startOffset)}${rendered({ [path[path.length - 1]!]: value }, indent, eol)}${text.slice(endOffset)}`;
    return preserveFinalNewline(candidate, text, eol);
  }
  if (located.kind === "replace-line") {
    const { lines, index, indent, missingDepth } = located.entry;
    const startOffset = lines[index]!.start;
    const endOffset = index + 1 < lines.length ? lines[index + 1]!.start : text.length;
    const insertion = rendered(nestedValue(path.slice(missingDepth), value), indent, eol);
    return preserveFinalNewline(`${text.slice(0, startOffset)}${insertion}${text.slice(endOffset)}`, text, eol);
  }

  const { missingDepth, indent, insertAt } = located.entry;
  const prefix = insertAt > 0 && !text.slice(0, insertAt).endsWith("\n") ? eol : "";
  const insertion = rendered(nestedValue(path.slice(missingDepth), value), indent, eol);
  const candidate = `${text.slice(0, insertAt)}${prefix}${insertion}${text.slice(insertAt)}`;
  return preserveFinalNewline(candidate, text, eol);
}

function removeExactPath(text: string, path: readonly string[], requireEmpty: boolean): string | null {
  let parsed: unknown;
  try {
    parsed = text.trim().length === 0 ? {} : Bun.YAML.parse(text);
  } catch {
    return null;
  }
  const located = locatePath(text, parsed, path);
  if (located === null || located.kind !== "existing") return null;
  const { lines, index, endIndex } = located.entry;
  const startOffset = lines[index]!.start;
  const endOffset = endIndex < lines.length ? lines[endIndex]!.start : text.length;
  if (requireEmpty) {
    const sourceBody = text.slice(lines[index]!.end, endOffset);
    if (sourceBody.trim().length > 0) return null;
  }
  return `${text.slice(0, startOffset)}${text.slice(endOffset)}`;
}

function planSourceRemoval(
  text: string,
  path: readonly string[],
  createdContainers: readonly string[],
): { text: string; prunedContainers: string[] } | null {
  let next = removeExactPath(text, path, false);
  if (next === null) return null;
  const created = new Set(createdContainers);
  const prunedContainers: string[] = [];
  for (let depth = path.length - 1; depth >= 1; depth -= 1) {
    const containerPath = path.slice(0, depth);
    const encoded = containerPath.join("\u0000");
    if (!created.has(encoded)) continue;
    const pruned = removeExactPath(next, containerPath, true);
    // A user-added sibling/comment makes this ancestor source-owned now. Keep
    // it (and every parent) while still removing our leaf.
    if (pruned === null) break;
    next = pruned;
    prunedContainers.push(encoded);
  }
  return { text: next, prunedContainers };
}

/** Containers whose source ranges are still empty and safe to prune. */
export function sourcePrunableYamlContainers(
  text: string,
  path: readonly string[],
  createdContainers: readonly string[],
): readonly string[] | null {
  return planSourceRemoval(text, path, createdContainers)?.prunedContainers ?? null;
}

function removeSource(
  text: string,
  path: readonly string[],
  createdContainers: readonly string[],
): string | null {
  return planSourceRemoval(text, path, createdContainers)?.text ?? null;
}

/**
 * Patch one arbitrary plain block-map path, preserving every other byte.
 */
export function patchYamlFragmentSource(
  text: string,
  path: readonly string[],
  mutation: YamlFragmentMutation,
  expected: unknown,
): string | null {
  let parsed: unknown;
  try {
    parsed = text.trim().length === 0 ? {} : Bun.YAML.parse(text);
  } catch {
    return null;
  }
  const patched = mutation.kind === "upsert"
    ? upsertSource(text, parsed, path, mutation.value)
    : removeSource(text, path, mutation.createdContainers);
  return patched !== null && semanticallyMatches(patched, expected) ? patched : null;
}

/**
 * True when a refusal on this path is caused by a flow-style container rather
 * than by comments or formatting we would have to re-render. DSH writes that
 * shape itself, so naming it is the difference between an actionable message
 * and one that sends the user hunting for a comment that is not there (#4260).
 */
export function yamlFragmentUnsupportedStyle(text: string, path: readonly string[]): boolean {
  let parsed: unknown;
  try {
    parsed = text.trim().length === 0 ? {} : Bun.YAML.parse(text);
  } catch {
    return false;
  }
  return locatePath(text, parsed, path)?.kind === "unsupported-style";
}

/** Backward-compatible OMP wrapper around the generic path patcher. */
export function patchOmpYamlSource(
  text: string,
  mutation: OmpYamlMutation,
  expected: unknown,
): string | null {
  return patchYamlFragmentSource(
    text,
    ["providers", "opencodex"],
    mutation.kind === "upsert"
      ? mutation
      : {
          kind: "remove",
          createdContainers: mutation.removeEmptyProviders ? ["providers"] : [],
        },
    expected,
  );
}
