import { OCX_SECTION_MARKER } from "../injected-marker";
import { encodeBasicString } from "./encoding";
import { TABLE_HEADER, ANY_DEV_INSTRUCTIONS, DEV_INSTRUCTIONS_KEY } from "./toml-read";

/** Line editing, not re-serialization: the user's comments and layout survive. */
function dominantEol(content: string): "\r\n" | "\n" {
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

function firstTableIndex(lines: string[]): number {
  const idx = lines.findIndex(l => TABLE_HEADER.test(l));
  return idx === -1 ? lines.length : idx;
}

/** Set a root-scope boolean, inserting above the first table when absent. */
export function setRootBool(content: string, key: string, value: boolean): string {
  const eol = dominantEol(content);
  const { bom, body } = splitBom(content);
  const lines = splitLines(body);
  const limit = firstTableIndex(lines);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^(\\s*${escaped}\\s*=\\s*)(?:true|false)(\\s*(?:#.*)?)$`);
  for (let i = 0; i < limit; i += 1) {
    const m = pattern.exec(lines[i]!);
    if (m) {
      lines[i] = `${m[1]}${value}${m[2]}`;
      return bom + joinLines(lines, eol);
    }
  }
  lines.splice(limit, 0, `${key} = ${value}`);
  return bom + joinLines(lines, eol);
}

/**
 * Set or REMOVE a root-scope basic string. `null` removes the key.
 *
 * Removal is what selecting the default variant does, and it has to be a real deletion
 * rather than an empty string: `model_instructions_file = ""` is a path Codex would try
 * to read, not an absent setting.
 */
export function setRootString(content: string, key: string, value: string | null): string {
  const eol = dominantEol(content);
  const { bom, body } = splitBom(content);
  const lines = splitLines(body);
  const limit = firstTableIndex(lines);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*=\\s*"[^"]*"\\s*(?:#.*)?$`);
  for (let i = 0; i < limit; i += 1) {
    if (!pattern.test(lines[i]!)) continue;
    if (value === null) lines.splice(i, 1);
    else lines[i] = `${key} = ${encodeBasicString(value)}`;
    return bom + joinLines(lines, eol);
  }
  if (value === null) return bom + joinLines(lines, eol);
  lines.splice(limit, 0, `${key} = ${encodeBasicString(value)}`);
  return bom + joinLines(lines, eol);
}

/** Set a boolean inside `[table]`, appending the table when absent. */
export function setTableBool(content: string, table: string, key: string, value: boolean): string {
  const eol = dominantEol(content);
  const { bom, body } = splitBom(content);
  const lines = splitLines(body);
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex(l => new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`).test(l));
  if (start === -1) {
    const tail = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    lines.splice(tail, 0, `[${table}]`, `${key} = ${value}`);
    return bom + joinLines(lines, eol);
  }
  const keyEscaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^(\\s*${keyEscaped}\\s*=\\s*)(?:true|false)(\\s*(?:#.*)?)$`);
  let end = start + 1;
  while (end < lines.length && !TABLE_HEADER.test(lines[end]!)) end += 1;
  for (let i = start + 1; i < end; i += 1) {
    const m = pattern.exec(lines[i]!);
    if (m) {
      lines[i] = `${m[1]}${value}${m[2]}`;
      return bom + joinLines(lines, eol);
    }
  }
  lines.splice(end, 0, `${key} = ${value}`);
  return bom + joinLines(lines, eol);
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
