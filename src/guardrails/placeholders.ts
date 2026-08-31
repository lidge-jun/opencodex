import {
  GuardrailsScanCapacityError,
  resolveGuardrailsFindingConflicts,
} from "./scanner";
import type {
  GuardrailsDemaskOptions,
  GuardrailsFinding,
  GuardrailsMaskResult,
  GuardrailsPlaceholderReplacement,
  GuardrailsPlaceholderState,
} from "./types";

const MAX_PLACEHOLDER_TOKEN_LENGTH = 256;
export const MAX_GUARDRAILS_MAP_BYTES = 2 * 1024 * 1024;
export const MAX_GUARDRAILS_ORIGINAL_BYTES = 256 * 1024;
export const MAX_GUARDRAILS_DEMASK_EXPANSION_BYTES = 32 * 1024 * 1024;

export class GuardrailsDemaskCapacityError extends Error {
  constructor() {
    super("Guardrails demasking exceeded its safe expansion limit");
    this.name = "GuardrailsDemaskCapacityError";
  }
}

export interface GuardrailsPlaceholderTokenizerDiagnostics {
  candidateTokens: number;
  closingSearchCodeUnits: number;
  maxCandidateTokenLength: number;
  visitedCodeUnits: number;
}

interface PlaceholderIndexes {
  byOriginal: Map<string, GuardrailsPlaceholderReplacement>;
  byPlaceholder: Map<string, GuardrailsPlaceholderReplacement>;
  counters: Map<string, number>;
  reserved: Set<string>;
}

function isAsciiLetter(value: string): boolean {
  return (value >= "A" && value <= "Z") || (value >= "a" && value <= "z");
}

function isAsciiDigit(value: string): boolean {
  return value >= "0" && value <= "9";
}

function isAsciiAlphaNumeric(value: string): boolean {
  return isAsciiLetter(value) || isAsciiDigit(value);
}

function isWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\n" || value === "\r";
}

function normalizedSequence(value: string): string | null {
  if (value.length === 0 || [...value].some(character => !isAsciiDigit(character))) return null;
  const normalized = value.replace(/^0+/, "");
  return normalized.length === 0 ? "0" : normalized;
}

function canonicalPlaceholder(token: string, allowDrift: boolean): string | null {
  if (token.length < 5 || token.length > MAX_PLACEHOLDER_TOKEN_LENGTH || token[0] !== "<" || token.at(-1) !== ">") return null;
  let normalized = "";
  for (const character of token.slice(1, -1)) {
    if (isAsciiAlphaNumeric(character) || character === "_") {
      normalized += character.toUpperCase();
      continue;
    }
    if (allowDrift && isWhitespace(character)) continue;
    if (allowDrift && character === "-") {
      normalized += "_";
      continue;
    }
    return null;
  }
  const separator = normalized.lastIndexOf("_");
  if (separator <= 0) return null;
  const type = normalized.slice(0, separator);
  const sequence = normalizedSequence(normalized.slice(separator + 1));
  if (!sequence || !isValidPlaceholderType(type)) return null;
  return `<${type}_${sequence}>`;
}

function isValidPlaceholderType(value: string): boolean {
  if (value.length === 0 || !isAsciiLetter(value[0]!)) return false;
  return [...value].every(character => (character >= "A" && character <= "Z") || isAsciiDigit(character) || character === "_");
}

function nextClosingIndex(
  value: string,
  from: number,
  diagnostics?: GuardrailsPlaceholderTokenizerDiagnostics,
): number {
  const index = value.indexOf(">", from);
  if (diagnostics) {
    diagnostics.closingSearchCodeUnits += (index < 0 ? value.length : index + 1) - from;
  }
  return index;
}

function reservePlaceholderLiterals(value: string, reserved: Set<string>): void {
  let nextClosing = nextClosingIndex(value, 0);
  for (let start = value.indexOf("<"); start >= 0; start = value.indexOf("<", start + 1)) {
    while (nextClosing >= 0 && nextClosing < start) {
      nextClosing = nextClosingIndex(value, nextClosing + 1);
    }
    if (nextClosing < 0 || nextClosing - start + 1 > MAX_PLACEHOLDER_TOKEN_LENGTH) continue;
    const canonical = canonicalPlaceholder(value.slice(start, nextClosing + 1), true);
    if (canonical) reserved.add(canonical);
  }
}

function splitCanonicalPlaceholder(placeholder: string): { sequence: number; type: string } {
  const canonical = canonicalPlaceholder(placeholder, false);
  if (!canonical || canonical !== placeholder) throw new Error(`Invalid generated Guardrails placeholder ${placeholder}`);
  const content = canonical.slice(1, -1);
  const separator = content.lastIndexOf("_");
  const sequence = Number(content.slice(separator + 1));
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error(`Invalid generated Guardrails placeholder ${placeholder}`);
  return { type: content.slice(0, separator), sequence };
}

function buildIndexes(state: GuardrailsPlaceholderState): PlaceholderIndexes {
  assertPlaceholderStateCapacity(state);
  const byOriginal = new Map<string, GuardrailsPlaceholderReplacement>();
  const byPlaceholder = new Map<string, GuardrailsPlaceholderReplacement>();
  const counters = new Map<string, number>();
  const reserved = new Set<string>();

  for (const literal of state.reservedPlaceholders) {
    const canonical = canonicalPlaceholder(literal, true);
    if (!canonical) throw new Error(`Invalid reserved Guardrails placeholder ${literal}`);
    reserved.add(canonical);
  }
  for (const replacement of state.replacements) {
    const { sequence, type } = splitCanonicalPlaceholder(replacement.placeholder);
    if (byOriginal.has(replacement.original) || byPlaceholder.has(replacement.placeholder)) {
      throw new Error("Guardrails placeholder state contains duplicate mappings");
    }
    byOriginal.set(replacement.original, replacement);
    byPlaceholder.set(replacement.placeholder, replacement);
    counters.set(type, Math.max(counters.get(type) ?? 0, sequence));
  }
  return { byOriginal, byPlaceholder, counters, reserved };
}

function assertPlaceholderStateCapacity(state: GuardrailsPlaceholderState): void {
  for (const replacement of state.replacements) {
    if (Buffer.byteLength(replacement.original, "utf8") > MAX_GUARDRAILS_ORIGINAL_BYTES) {
      throw new GuardrailsScanCapacityError("Guardrails replacement original exceeds the safe size limit");
    }
  }
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(state), "utf8");
  } catch {
    throw new GuardrailsScanCapacityError("Guardrails placeholder map could not be measured safely");
  }
  if (bytes > MAX_GUARDRAILS_MAP_BYTES) {
    throw new GuardrailsScanCapacityError("Guardrails placeholder map exceeds the safe size limit");
  }
}

function validateFinding(input: string, finding: GuardrailsFinding): void {
  if (!Number.isInteger(finding.start) || !Number.isInteger(finding.end) || finding.start < 0 || finding.end <= finding.start || finding.end > input.length) {
    throw new Error(`Guardrails finding ${finding.ruleId} has an invalid UTF-16 range`);
  }
  if (input.slice(finding.start, finding.end) !== finding.value) {
    throw new Error(`Guardrails finding ${finding.ruleId} does not match its input range`);
  }
  if (!isValidPlaceholderType(finding.placeholderType)) {
    throw new Error(`Guardrails finding ${finding.ruleId} has an invalid placeholder type`);
  }
}

function nextPlaceholder(type: string, indexes: PlaceholderIndexes): string {
  let counter = indexes.counters.get(type) ?? 0;
  do {
    counter += 1;
    if (!Number.isSafeInteger(counter)) throw new Error(`Guardrails placeholder counter overflow for ${type}`);
  } while (indexes.reserved.has(`<${type}_${counter}>`) || indexes.byPlaceholder.has(`<${type}_${counter}>`));
  indexes.counters.set(type, counter);
  return `<${type}_${counter}>`;
}

function replacementForFinding(finding: GuardrailsFinding, indexes: PlaceholderIndexes): GuardrailsPlaceholderReplacement {
  const existing = indexes.byOriginal.get(finding.value);
  if (existing) return existing;
  const placeholder = nextPlaceholder(finding.placeholderType, indexes);
  const replacement: GuardrailsPlaceholderReplacement = {
    ruleId: finding.ruleId,
    dataType: finding.dataType,
    original: finding.value,
    placeholder,
    placeholderType: finding.placeholderType,
  };
  indexes.byOriginal.set(replacement.original, replacement);
  indexes.byPlaceholder.set(replacement.placeholder, replacement);
  return replacement;
}

export function createGuardrailsPlaceholderState(texts: readonly string[] = []): GuardrailsPlaceholderState {
  const reserved = new Set<string>();
  for (const text of texts) reservePlaceholderLiterals(text, reserved);
  return { replacements: [], reservedPlaceholders: [...reserved].sort() };
}

export function maskGuardrailsText(
  input: string,
  findings: readonly GuardrailsFinding[],
  previousState: GuardrailsPlaceholderState = createGuardrailsPlaceholderState(),
): GuardrailsMaskResult {
  for (const finding of findings) validateFinding(input, finding);
  const indexes = buildIndexes(previousState);
  reservePlaceholderLiterals(input, indexes.reserved);
  const resolved = resolveGuardrailsFindingConflicts(input, findings);
  const parts: string[] = [];
  let position = 0;
  for (const finding of resolved) {
    if (finding.start < position) throw new Error("Guardrails findings overlap after conflict resolution");
    const replacement = replacementForFinding(finding, indexes);
    parts.push(input.slice(position, finding.start), replacement.placeholder);
    position = finding.end;
  }
  parts.push(input.slice(position));
  const state = {
    replacements: [...indexes.byOriginal.values()],
    reservedPlaceholders: [...indexes.reserved].sort(),
  };
  assertPlaceholderStateCapacity(state);
  return {
    maskedText: parts.join(""),
    state,
  };
}

function demaskGuardrailsTextInternal(
  input: string,
  state: GuardrailsPlaceholderState,
  options: GuardrailsDemaskOptions,
  diagnostics?: GuardrailsPlaceholderTokenizerDiagnostics,
): string {
  const indexes = buildIndexes(state);
  const parts: string[] = [];
  let nextClosing = nextClosingIndex(input, 0, diagnostics);
  for (let position = 0; position < input.length;) {
    if (diagnostics) diagnostics.visitedCodeUnits += 1;
    while (nextClosing >= 0 && nextClosing < position) {
      nextClosing = nextClosingIndex(input, nextClosing + 1, diagnostics);
    }
    if (input[position] === "<" && nextClosing >= position) {
      const tokenLength = nextClosing - position + 1;
      if (tokenLength <= MAX_PLACEHOLDER_TOKEN_LENGTH) {
        if (diagnostics) {
          diagnostics.candidateTokens += 1;
          diagnostics.maxCandidateTokenLength = Math.max(
            diagnostics.maxCandidateTokenLength,
            tokenLength,
          );
        }
        const token = input.slice(position, nextClosing + 1);
        const exact = indexes.byPlaceholder.get(token);
        const normalized = !exact && options.allowNormalizedPlaceholderDrift
          ? canonicalPlaceholder(token, true)
          : null;
        const replacement = exact ?? (normalized ? indexes.byPlaceholder.get(normalized) : undefined);
        if (!replacement) {
          parts.push(input[position]!);
          position += 1;
          continue;
        }
        if (options.budget) {
          const expansionBytes = Math.max(
            0,
            Buffer.byteLength(replacement.original, "utf8") - Buffer.byteLength(token, "utf8"),
          );
          if (expansionBytes > options.budget.remainingExpansionBytes) {
            throw new GuardrailsDemaskCapacityError();
          }
          options.budget.remainingExpansionBytes -= expansionBytes;
        }
        parts.push(replacement.original);
        position += token.length;
        continue;
      }
    }
    parts.push(input[position]!);
    position += 1;
  }
  return parts.join("");
}

export function demaskGuardrailsText(
  input: string,
  state: GuardrailsPlaceholderState,
  options: GuardrailsDemaskOptions = {},
): string {
  return demaskGuardrailsTextInternal(input, state, options);
}

export function demaskGuardrailsTextWithDiagnosticsForTests(
  input: string,
  state: GuardrailsPlaceholderState,
  options: GuardrailsDemaskOptions = {},
): Readonly<{ diagnostics: GuardrailsPlaceholderTokenizerDiagnostics; text: string }> {
  const diagnostics: GuardrailsPlaceholderTokenizerDiagnostics = {
    candidateTokens: 0,
    closingSearchCodeUnits: 0,
    maxCandidateTokenLength: 0,
    visitedCodeUnits: 0,
  };
  return {
    text: demaskGuardrailsTextInternal(input, state, options, diagnostics),
    diagnostics,
  };
}
