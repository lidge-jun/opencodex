/**
 * Source-preserving mutation for the one YAML fragment managed by OMP.
 *
 * The general integration writer operates on parsed documents. Re-rendering a
 * shared YAML file would preserve values but destroy comments and formatting
 * outside `providers.opencodex`. OMP is the only client whose ownership model
 * deliberately permits those unrelated source edits, so its writer replaces
 * or removes only the exact block-style mapping entry it owns.
 *
 * Unsupported or ambiguous YAML returns `null`. The caller treats that as an
 * unsafe refusal instead of falling back to whole-document serialization.
 */
import { renderYaml } from "./serialize";

interface SourceLine {
  start: number;
  end: number;
  body: string;
}

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

function isPlainBlockKey(line: string, indent: number, key: string): boolean {
  const spaces = leadingSpaces(line);
  if (spaces !== indent) return false;
  const rest = line.slice(indent);
  return new RegExp(`^${key}:[ ]*(?:#.*)?$`, "u").test(rest);
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
    // Blank lines and same-level comments are conservatively outside the
    // managed entry. Deeper comments would be destroyed by replacement, so
    // refuse rather than guessing whether the user meant to keep them.
    if (isBlank(body)) return index;
    if (isComment(body)) return spaces <= indent ? index : null;
    if (spaces <= indent) return index;
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
    return JSON.stringify(canonicalValue(parsed))
      === JSON.stringify(canonicalValue(expected));
  } catch {
    return false;
  }
}

function lineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function renderedEntry(value: unknown, indent: number, eol: "\n" | "\r\n"): string {
  return renderYaml({ opencodex: value }, indent).replaceAll("\n", eol);
}

/**
 * Patch `providers.opencodex` while preserving every byte outside that entry.
 * The returned text is parsed and compared with `expected` before it is
 * accepted, so a scanner mistake fails closed rather than writing bad YAML.
 */
export function patchOmpYamlSource(
  text: string,
  mutation: OmpYamlMutation,
  expected: unknown,
): string | null {
  const lines = sourceLines(text);
  const eol = lineEnding(text);
  const providerIndexes = lines
    .map((line, index) => isPlainBlockKey(line.body, 0, "providers") ? index : -1)
    .filter(index => index >= 0);

  if (providerIndexes.length === 0) {
    if (mutation.kind === "remove") return null;
    const separator = text.length === 0 || text.endsWith("\n") ? "" : eol;
    const patched = `${text}${separator}providers:${eol}${renderedEntry(mutation.value, 2, eol)}`;
    return semanticallyMatches(patched, expected) ? patched : null;
  }
  if (providerIndexes.length !== 1) return null;

  const providersIndex = providerIndexes[0]!;
  const providersEnd = containerEnd(lines, providersIndex, 0);
  if (providersEnd === null) return null;

  let inferredIndent: number | null = null;
  for (let index = providersIndex + 1; index < providersEnd; index += 1) {
    const body = lines[index]!.body;
    const spaces = leadingSpaces(body);
    if (spaces === null) return null;
    if (!isBlank(body) && !isComment(body) && spaces > 0) {
      inferredIndent = inferredIndent === null ? spaces : Math.min(inferredIndent, spaces);
    }
  }
  const childIndexes = inferredIndent === null
    ? []
    : lines.slice(providersIndex + 1, providersEnd)
      .map((line, offset) => (
        isPlainBlockKey(line.body, inferredIndent!, "opencodex")
          ? providersIndex + 1 + offset
          : -1
      ))
      .filter(index => index >= 0);
  if (childIndexes.length > 1) return null;

  const childIndex = childIndexes[0];
  if (childIndex === undefined) {
    if (mutation.kind === "remove") return null;
    const indent = inferredIndent ?? 2;
    const insertAt = providersEnd < lines.length ? lines[providersEnd]!.start : text.length;
    const prefix = insertAt > 0 && !text.slice(0, insertAt).endsWith("\n") ? eol : "";
    const patched = `${text.slice(0, insertAt)}${prefix}${renderedEntry(mutation.value, indent, eol)}${text.slice(insertAt)}`;
    return semanticallyMatches(patched, expected) ? patched : null;
  }

  const childIndent = leadingSpaces(lines[childIndex]!.body);
  if (childIndent === null || childIndent <= 0) return null;
  if (hasInlineComment(lines[childIndex]!.body)) return null;
  const endIndex = childEnd(lines, childIndex, providersEnd, childIndent);
  if (endIndex === null) return null;
  const startOffset = lines[childIndex]!.start;
  const endOffset = endIndex < lines.length ? lines[endIndex]!.start : text.length;

  if (mutation.kind === "upsert") {
    const patched = `${text.slice(0, startOffset)}${renderedEntry(mutation.value, childIndent, eol)}${text.slice(endOffset)}`;
    return semanticallyMatches(patched, expected) ? patched : null;
  }

  let patched = `${text.slice(0, startOffset)}${text.slice(endOffset)}`;
  if (mutation.removeEmptyProviders) {
    const remaining = Bun.YAML.parse(patched) as { providers?: unknown } | null;
    if (remaining && Object.hasOwn(remaining, "providers")) {
      const provider = remaining.providers;
      const empty = provider === null || (
        provider && typeof provider === "object" && !Array.isArray(provider)
        && Object.keys(provider as Record<string, unknown>).length === 0
      );
      if (!empty) return semanticallyMatches(patched, expected) ? patched : null;
      if (hasInlineComment(lines[providersIndex]!.body)) return null;

      const providerStart = lines[providersIndex]!.start;
      // Removing a container we created is safe only when nothing but our
      // entry occupied its source range. Comments or blank formatting make
      // that range user-owned and therefore ambiguous.
      for (let index = providersIndex + 1; index < providersEnd; index += 1) {
        if (index >= childIndex && index < endIndex) continue;
        if (lines[index]!.body.length > 0) return null;
      }
      patched = `${text.slice(0, providerStart)}${text.slice(endOffset)}`;
    }
  }
  return semanticallyMatches(patched, expected) ? patched : null;
}
