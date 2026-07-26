/**
 * Pure, ownership-aware edits for Codex's native `[agents]` defaults.
 *
 * This intentionally does not parse and re-serialize the whole TOML document:
 * callers can write the returned content atomically while comments, ordering,
 * unknown keys, and line endings remain untouched. Every value and table that
 * this transform may later remove has its own immediately preceding marker.
 */

export const MANAGED_SUBAGENT_DEFAULT_MARKER = "# Managed by opencodex: native subagent default";
export const MANAGED_AGENTS_TABLE_MARKER = "# Managed by opencodex: native subagent defaults table";

export type ManagedSubagentDefaultKey =
  | "default_subagent_model"
  | "default_subagent_reasoning_effort";

export interface ManagedSubagentDefaults {
  model: string;
  reasoningEffort?: string;
}

export interface ManagedSubagentDefaultsConflict {
  key: ManagedSubagentDefaultKey;
  line: number;
  reason: "user-owned";
}

export type ManagedSubagentDefaultsTransformResult =
  | {
      ok: true;
      changed: boolean;
      content: string;
      conflicts: ManagedSubagentDefaultsConflict[];
    }
  | {
      ok: false;
      changed: false;
      content: string;
      conflicts: [];
      error: string;
    };

interface SourceLine {
  text: string;
  eol: "\r\n" | "\n" | "";
  /** False when this physical line began inside a TOML multiline string. */
  structural: boolean;
}

interface TargetDefinition {
  key: ManagedSubagentDefaultKey;
  index: number;
  owned: boolean;
}

interface TomlShape {
  agentsHeader: number | null;
  agentsEnd: number | null;
  tableOwned: boolean;
  definitions: Map<ManagedSubagentDefaultKey, TargetDefinition>;
}

const TARGET_KEYS: readonly ManagedSubagentDefaultKey[] = [
  "default_subagent_model",
  "default_subagent_reasoning_effort",
];

function splitSourceLines(content: string): SourceLine[] {
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

type MultilineStringKind = "basic" | "literal" | null;

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
          multiline = null;
          index += 3;
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
          index += 3;
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

function joinSourceLines(lines: readonly SourceLine[]): string {
  return lines.map(line => `${line.text}${line.eol}`).join("");
}

function dominantEol(lines: readonly SourceLine[]): "\r\n" | "\n" {
  let crlf = 0;
  let lf = 0;
  for (const line of lines) {
    if (line.eol === "\r\n") crlf += 1;
    else if (line.eol === "\n") lf += 1;
  }
  return crlf > 0 && crlf >= lf ? "\r\n" : "\n";
}

/** Decode a TOML basic-string key body, including Unicode escapes. */
function decodeTomlBasicKey(body: string): string {
  return body.replace(
    /\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g,
    (whole, escape: string) => {
      if (escape[0] === "x") return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
      if (escape[0] === "u") return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
      if (escape[0] === "U") {
        const codePoint = Number.parseInt(escape.slice(1), 16);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : whole;
      }
      switch (escape) {
        case "b": return "\b";
        case "t": return "\t";
        case "n": return "\n";
        case "f": return "\f";
        case "r": return "\r";
        case '"': return '"';
        case "\\": return "\\";
        default: return whole;
      }
    },
  );
}

function canonicalKeySegment(raw: string): string {
  if (raw.startsWith('"')) return decodeTomlBasicKey(raw.slice(1, -1));
  if (raw.startsWith("'")) return raw.slice(1, -1);
  return raw;
}

const KEY_SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const EXACT_TABLE_HEADER = new RegExp(`^\\s*\\[\\s*(${KEY_SEGMENT})\\s*\\]\\s*(?:#.*)?$`);
const ARRAY_TABLE_HEADER = new RegExp(`^\\s*\\[\\[\\s*(${KEY_SEGMENT})\\s*\\]\\]\\s*(?:#.*)?$`);
const DOTTED_TABLE_HEADER = new RegExp(`^\\s*\\[\\[?\\s*(${KEY_SEGMENT})\\s*\\.\\s*(${KEY_SEGMENT})(?:\\s*\\.|\\s*\\]\\]?)`);
const KEY_ASSIGNMENT = new RegExp(`^\\s*(${KEY_SEGMENT})\\s*=`);
const DOTTED_ASSIGNMENT = new RegExp(`^\\s*(${KEY_SEGMENT})\\s*\\.\\s*(${KEY_SEGMENT})(?:\\s*\\.|\\s*=)`);
const ANY_TABLE_HEADER = /^\s*\[{1,2}/;

function exactAgentsHeader(line: SourceLine | undefined): boolean {
  if (!line?.structural) return false;
  const match = line.text.match(EXACT_TABLE_HEADER);
  return match !== null && canonicalKeySegment(match[1]!) === "agents";
}

function arrayAgentsHeader(line: SourceLine): boolean {
  if (!line.structural) return false;
  const match = line.text.match(ARRAY_TABLE_HEADER);
  return match !== null && canonicalKeySegment(match[1]!) === "agents";
}

function dottedAgentsHeader(line: SourceLine): { second: string } | null {
  if (!line.structural) return null;
  const match = line.text.match(DOTTED_TABLE_HEADER);
  if (!match || canonicalKeySegment(match[1]!) !== "agents") return null;
  return { second: canonicalKeySegment(match[2]!) };
}

function isAnyTableHeader(line: SourceLine): boolean {
  return line.structural && ANY_TABLE_HEADER.test(line.text);
}

function assignmentKeyAt(line: SourceLine): string | null {
  if (!line.structural) return null;
  const match = line.text.match(KEY_ASSIGNMENT);
  return match ? canonicalKeySegment(match[1]!) : null;
}

function markerLine(line: SourceLine | undefined, marker: string): boolean {
  return line?.structural === true && line.text.trim() === marker;
}

function targetKeyAt(line: SourceLine | undefined): ManagedSubagentDefaultKey | null {
  if (!line) return null;
  const key = assignmentKeyAt(line);
  return TARGET_KEYS.includes(key as ManagedSubagentDefaultKey)
    ? key as ManagedSubagentDefaultKey
    : null;
}

function dottedAssignmentAt(line: SourceLine): { first: string; second: string } | null {
  if (!line.structural) return null;
  const match = line.text.match(DOTTED_ASSIGNMENT);
  if (!match) return null;
  return {
    first: canonicalKeySegment(match[1]!),
    second: canonicalKeySegment(match[2]!),
  };
}

function dottedTargetAt(line: SourceLine): ManagedSubagentDefaultKey | null {
  const dotted = dottedAssignmentAt(line);
  if (!dotted) return null;
  return TARGET_KEYS.includes(dotted.first as ManagedSubagentDefaultKey)
    ? dotted.first as ManagedSubagentDefaultKey
    : null;
}

function analyzeToml(lines: readonly SourceLine[]): { shape: TomlShape } | { error: string } {
  const exactHeaders: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (exactAgentsHeader(line)) exactHeaders.push(index);
    else if (arrayAgentsHeader(line)) {
      return { error: "array [[agents]] tables are not supported for managed subagent defaults" };
    } else if (TARGET_KEYS.includes(dottedAgentsHeader(line)?.second as ManagedSubagentDefaultKey)) {
      return { error: "agents default keys cannot be represented as nested tables" };
    }
  }
  if (exactHeaders.length > 1) {
    return { error: "duplicate [agents] tables cannot be updated safely" };
  }

  const firstTable = lines.findIndex(isAnyTableHeader);
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  for (let index = 0; index < rootEnd; index += 1) {
    const line = lines[index]!;
    const dotted = dottedAssignmentAt(line);
    if (dotted?.first === "agents"
      && TARGET_KEYS.includes(dotted.second as ManagedSubagentDefaultKey)) {
      return { error: "dotted agents default keys are not supported for managed subagent defaults" };
    }
    if (assignmentKeyAt(line) === "agents") {
      return { error: "inline agents definitions cannot be updated safely" };
    }
  }

  const agentsHeader = exactHeaders[0] ?? null;
  let agentsEnd: number | null = null;
  const definitions = new Map<ManagedSubagentDefaultKey, TargetDefinition>();
  if (agentsHeader !== null) {
    agentsEnd = lines.length;
    for (let index = agentsHeader + 1; index < lines.length; index += 1) {
      if (isAnyTableHeader(lines[index]!)) {
        agentsEnd = index;
        break;
      }
      const dotted = dottedTargetAt(lines[index]!);
      if (dotted) {
        return { error: `dotted agents.${dotted} fields are not supported` };
      }
      const key = targetKeyAt(lines[index]);
      if (!key) continue;
      if (definitions.has(key)) {
        return { error: `duplicate agents.${key} definitions cannot be updated safely` };
      }
      definitions.set(key, {
        key,
        index,
        owned: markerLine(lines[index - 1], MANAGED_SUBAGENT_DEFAULT_MARKER),
      });
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (markerLine(lines[index], MANAGED_SUBAGENT_DEFAULT_MARKER)) {
      const nextKey = targetKeyAt(lines[index + 1]);
      const insideAgents = agentsHeader !== null
        && agentsEnd !== null
        && index > agentsHeader
        && index + 1 < agentsEnd;
      if (!nextKey || !insideAgents) {
        return { error: "orphaned managed subagent default marker cannot be updated safely" };
      }
    }
    if (markerLine(lines[index], MANAGED_AGENTS_TABLE_MARKER)) {
      if (index + 1 !== agentsHeader) {
        return { error: "orphaned managed agents table marker cannot be updated safely" };
      }
    }
  }

  return {
    shape: {
      agentsHeader,
      agentsEnd,
      tableOwned: agentsHeader !== null && markerLine(lines[agentsHeader - 1], MANAGED_AGENTS_TABLE_MARKER),
      definitions,
    },
  };
}

function quotedTomlString(value: string): string {
  // JSON basic strings are valid TOML basic strings and cover quotes,
  // backslashes, control characters, and newlines. JSON leaves DEL literal,
  // while TOML requires it escaped.
  return JSON.stringify(value).replace(/\u007f/g, "\\u007F");
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function replaceManagedString(line: string, key: ManagedSubagentDefaultKey, value: string): string | null {
  const stringValue = `(?:"(?:\\\\.|[^"\\\\])*"|'[^']*')`;
  const match = line.match(new RegExp(`^(\\s*)(${KEY_SEGMENT})(\\s*=\\s*)(${stringValue})(\\s*(?:#.*)?)$`));
  if (!match || canonicalKeySegment(match[2]!) !== key) return null;
  const quoted = quotedTomlString(value);
  if (match[4] === quoted) return line;
  return `${match[1]}${match[2]}${match[3]}${quoted}${match[5]}`;
}

function insertedLines(
  key: ManagedSubagentDefaultKey,
  value: string,
  eol: "\r\n" | "\n",
): SourceLine[] {
  return [
    { text: MANAGED_SUBAGENT_DEFAULT_MARKER, eol, structural: true },
    { text: `${key} = ${quotedTomlString(value)}`, eol, structural: true },
  ];
}

function invalidInput(content: string, error: string): ManagedSubagentDefaultsTransformResult {
  return { ok: false, changed: false, content, conflicts: [], error };
}

/**
 * Add/update opencodex-owned native subagent defaults, or remove them with
 * `defaults = null`. Unmarked target keys are user-owned: they are retained and
 * returned as conflicts rather than overwritten. Ambiguous TOML is rejected
 * byte-for-byte so callers never have to guess what was changed.
 */
export function transformManagedSubagentDefaults(
  content: string,
  defaults: ManagedSubagentDefaults | null,
): ManagedSubagentDefaultsTransformResult {
  if (defaults !== null) {
    if (typeof defaults.model !== "string" || defaults.model.length === 0) {
      return invalidInput(content, "managed subagent model must be a non-empty string");
    }
    if (containsLoneSurrogate(defaults.model)) {
      return invalidInput(content, "managed subagent model must contain valid Unicode scalar values");
    }
    if (defaults.reasoningEffort !== undefined
      && (typeof defaults.reasoningEffort !== "string" || defaults.reasoningEffort.length === 0)) {
      return invalidInput(content, "managed subagent reasoning effort must be a non-empty string when supplied");
    }
    if (defaults.reasoningEffort !== undefined && containsLoneSurrogate(defaults.reasoningEffort)) {
      return invalidInput(content, "managed subagent reasoning effort must contain valid Unicode scalar values");
    }
  }

  const lines = splitSourceLines(content);
  if (defaults === null && !lines.some(line =>
    markerLine(line, MANAGED_SUBAGENT_DEFAULT_MARKER)
      || markerLine(line, MANAGED_AGENTS_TABLE_MARKER))) {
    return { ok: true, changed: false, content, conflicts: [] };
  }
  const analysis = analyzeToml(lines);
  if ("error" in analysis) return invalidInput(content, analysis.error);
  const { shape } = analysis;
  const eol = dominantEol(lines);
  const desired = new Map<ManagedSubagentDefaultKey, string>();
  if (defaults !== null) {
    desired.set("default_subagent_model", defaults.model);
    if (defaults.reasoningEffort !== undefined) {
      desired.set("default_subagent_reasoning_effort", defaults.reasoningEffort);
    }
  }

  const conflicts: ManagedSubagentDefaultsConflict[] = [];
  const missing: Array<[ManagedSubagentDefaultKey, string]> = [];
  const removals: number[] = [];

  if (defaults !== null) {
    for (const key of TARGET_KEYS) {
      const definition = shape.definitions.get(key);
      if (definition && !definition.owned) {
        conflicts.push({ key, line: definition.index + 1, reason: "user-owned" });
      }
    }
    // Model and effort are one effective native-default pair. A partial write
    // could apply a newly managed effort to a user's model (or vice versa), so
    // any desired-key ownership conflict makes the whole enable/update a no-op.
    if (conflicts.length > 0) {
      return { ok: true, changed: false, content, conflicts };
    }
  }

  for (const key of TARGET_KEYS) {
    const definition = shape.definitions.get(key);
    const value = desired.get(key);
    if (!definition) {
      if (value !== undefined) missing.push([key, value]);
      continue;
    }
    if (!definition.owned) {
      continue;
    }
    if (replaceManagedString(lines[definition.index]!.text, key, value ?? "__opencodex_validation__") === null) {
      return invalidInput(content, `managed agents.${key} is not a supported single-line TOML string`);
    }
    if (value === undefined) {
      removals.push(definition.index - 1, definition.index);
      continue;
    }
    const replacement = replaceManagedString(lines[definition.index]!.text, key, value);
    if (replacement === null) {
      return invalidInput(content, `managed agents.${key} is not a supported single-line TOML string`);
    }
    lines[definition.index]!.text = replacement;
  }

  removals.sort((a, b) => b - a);
  for (const index of removals) lines.splice(index, 1);

  if (missing.length > 0) {
    const pairs = missing.flatMap(([key, value]) => insertedLines(key, value, eol));
    const currentHeader = lines.findIndex(exactAgentsHeader);
    if (currentHeader !== -1) {
      if (lines[currentHeader]!.eol === "") lines[currentHeader]!.eol = eol;
      lines.splice(currentHeader + 1, 0, ...pairs);
    } else {
      const table = [
        { text: MANAGED_AGENTS_TABLE_MARKER, eol, structural: true },
        { text: "[agents]", eol, structural: true },
        ...pairs,
      ];
      const nestedHeader = lines.findIndex(line => dottedAgentsHeader(line) !== null);
      if (nestedHeader !== -1) {
        lines.splice(nestedHeader, 0, ...table);
      } else {
        if (lines.length > 0 && lines[lines.length - 1]!.eol === "") lines[lines.length - 1]!.eol = eol;
        lines.push(...table);
      }
    }
  }

  // A table created by this transform is removable only after every body line
  // is blank. Comments or unknown keys make it user-extended and preserve it.
  if (shape.tableOwned) {
    const currentHeader = lines.findIndex(exactAgentsHeader);
    if (currentHeader !== -1 && markerLine(lines[currentHeader - 1], MANAGED_AGENTS_TABLE_MARKER)) {
      let currentEnd = lines.length;
      for (let index = currentHeader + 1; index < lines.length; index += 1) {
        if (isAnyTableHeader(lines[index]!)) {
          currentEnd = index;
          break;
        }
      }
      if (lines.slice(currentHeader + 1, currentEnd).every(line => line.text.trim() === "")) {
        lines.splice(currentHeader - 1, currentEnd - currentHeader + 1);
      } else if (defaults === null) {
        // The table outlived the defaults because a user added content. Drop
        // only our ownership claim; the surviving table and extensions are now
        // wholly user-owned.
        lines.splice(currentHeader - 1, 1);
      }
    }
  }

  const output = joinSourceLines(lines);
  return { ok: true, changed: output !== content, content: output, conflicts };
}
