import type { CompiledGuardrailsRule, GuardrailsFinding, GuardrailsRegistry } from "./types";
import { validateGuardrailsCandidate } from "./validators";

export const MAX_GUARDRAILS_SCANNABLE_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_GUARDRAILS_SCANNABLE_LEAF_BYTES = 128 * 1024;
export const MAX_GUARDRAILS_REGEX_INPUT_BYTES = 128 * 1024 * 1024;
export const MAX_GUARDRAILS_FINDINGS = 4_096;

export interface GuardrailsScanBudget {
  regexInputBytes: number;
}

export function createGuardrailsScanBudget(): GuardrailsScanBudget {
  return { regexInputBytes: 0 };
}

export class GuardrailsScanCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardrailsScanCapacityError";
  }
}

export class GuardrailsMatchAmbiguityError extends Error {
  constructor(readonly ruleId: string) {
    super(`Guardrails rule ${ruleId} produced an ambiguous capture-group offset`);
    this.name = "GuardrailsMatchAmbiguityError";
  }
}

function codePointToUtf16Offsets(value: string): Uint32Array | undefined {
  let hasSurrogatePair = false;
  for (let index = 0; index < value.length - 1; index += 1) {
    const first = value.charCodeAt(index);
    const second = value.charCodeAt(index + 1);
    if (first >= 0xD800 && first <= 0xDBFF && second >= 0xDC00 && second <= 0xDFFF) {
      hasSurrogatePair = true;
      break;
    }
  }
  if (!hasSurrogatePair) return undefined;

  const offsets = new Uint32Array(value.length + 1);
  let codePointIndex = 0;
  let utf16Index = 0;
  while (utf16Index < value.length) {
    offsets[codePointIndex] = utf16Index;
    const first = value.charCodeAt(utf16Index);
    const second = value.charCodeAt(utf16Index + 1);
    utf16Index += first >= 0xD800 && first <= 0xDBFF && second >= 0xDC00 && second <= 0xDFFF ? 2 : 1;
    codePointIndex += 1;
  }
  offsets[codePointIndex] = value.length;
  return offsets.subarray(0, codePointIndex + 1);
}

function utf16Offset(offsets: Uint32Array | undefined, codePointIndex: number, fallback: number): number {
  if (!offsets) return codePointIndex;
  return codePointIndex < offsets.length ? offsets[codePointIndex]! : fallback;
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

function keywordAllows(rule: CompiledGuardrailsRule, foldedValue: string): boolean {
  if (rule.prefilterKeywords.length === 0) return true;
  return rule.prefilterKeywords.some(keyword => foldedValue.includes(keyword));
}

function selectedCandidate(
  rule: CompiledGuardrailsRule,
  match: readonly (string | undefined)[],
): string | undefined {
  if (rule.masking.captureGroups.length === 0) return match[0];
  for (const index of rule.masking.captureGroups) {
    const candidate = match[index];
    if (candidate !== undefined && candidate.length > 0) return candidate;
  }
  return undefined;
}

function candidateStart(
  rule: CompiledGuardrailsRule,
  fullMatch: string,
  candidate: string,
  matchStart: number,
): number | null {
  const relativeStart = fullMatch.indexOf(candidate);
  if (relativeStart < 0) return null;
  if (fullMatch.indexOf(candidate, relativeStart + 1) >= 0) {
    throw new GuardrailsMatchAmbiguityError(rule.ruleId);
  }
  return matchStart + relativeStart;
}

function validCandidate(rule: CompiledGuardrailsRule, candidate: string): boolean {
  if (rule.minLength !== undefined && Buffer.byteLength(candidate, "utf8") < rule.minLength) return false;
  return validateGuardrailsCandidate(candidate, rule.validators, {
    entropy: rule.entropy,
    banlist: rule.banlist,
  });
}

function compareFindings(left: GuardrailsFinding, right: GuardrailsFinding): number {
  if (left.start !== right.start) return left.start - right.start;
  if (left.end !== right.end) return right.end - left.end;
  return left.ruleId.localeCompare(right.ruleId);
}

function preferredFinding(left: GuardrailsFinding, right: GuardrailsFinding): GuardrailsFinding {
  const leftLength = left.end - left.start;
  const rightLength = right.end - right.start;
  if (leftLength !== rightLength) return leftLength > rightLength ? left : right;
  if (left.start !== right.start) return left.start < right.start ? left : right;
  return left.ruleId.localeCompare(right.ruleId) <= 0 ? left : right;
}

/**
 * Coalesce intersecting findings into their full union. Selecting only one side
 * of a partial overlap would expose the other side of a detected secret.
 */
export function resolveGuardrailsFindingConflicts(value: string, findings: readonly GuardrailsFinding[]): GuardrailsFinding[] {
  if (findings.length < 2) return [...findings];
  const sorted = [...findings].sort(compareFindings);
  const resolved: GuardrailsFinding[] = [];
  let run = [sorted[0]!];
  let runEnd = sorted[0]!.end;

  const flush = (): void => {
    const first = run[0]!;
    if (run.length === 1) {
      resolved.push(first);
      return;
    }
    const primary = run.reduce(preferredFinding, first);
    resolved.push({ ...primary, start: first.start, end: runEnd, value: value.slice(first.start, runEnd) });
  };

  for (const finding of sorted.slice(1)) {
    if (finding.start < runEnd) {
      run.push(finding);
      runEnd = Math.max(runEnd, finding.end);
      continue;
    }
    flush();
    run = [finding];
    runEnd = finding.end;
  }
  flush();
  return resolved;
}

export function scanGuardrailsText(
  registry: GuardrailsRegistry,
  value: string,
  budget: GuardrailsScanBudget = createGuardrailsScanBudget(),
): GuardrailsFinding[] {
  const inputBytes = Buffer.byteLength(value, "utf8");
  if (inputBytes > MAX_GUARDRAILS_SCANNABLE_LEAF_BYTES) {
    throw new GuardrailsScanCapacityError("Guardrails text field exceeds the maximum scannable leaf size");
  }
  const findings: GuardrailsFinding[] = [];
  const seen = new Set<string>();
  const codePointOffsets = codePointToUtf16Offsets(value);
  const foldedValue = registry.keywordPrefilterEnabled
    && registry.rules.some(rule => rule.prefilterKeywords.length > 0)
    ? value.toLowerCase()
    : value;
  const executableRuleCount = registry.keywordPrefilterEnabled
    ? registry.rules.reduce(
        (count, rule) => count + (keywordAllows(rule, foldedValue) ? 1 : 0),
        0,
      )
    : registry.rules.length;
  const regexInputBytes = inputBytes * executableRuleCount;
  if (budget.regexInputBytes + regexInputBytes > MAX_GUARDRAILS_REGEX_INPUT_BYTES) {
    throw new GuardrailsScanCapacityError("Guardrails logical turn exceeded the maximum regex work budget");
  }
  budget.regexInputBytes += regexInputBytes;
  for (const rule of registry.rules) {
    if (registry.keywordPrefilterEnabled && !keywordAllows(rule, foldedValue)) continue;
    rule.matcher.lastIndex = 0;
    for (;;) {
      const match = rule.matcher.exec(value);
      if (!match) break;
      const fullMatch = match[0] ?? "";
      if (fullMatch.length === 0) break;
      // re2-wasm exposes match.index in Unicode code points but advances its global
      // lastIndex with UTF-16 string length. Correct it before the next exec.
      rule.matcher.lastIndex = match.index + codePointLength(fullMatch);
      const candidate = selectedCandidate(rule, match);
      if (!candidate || !validCandidate(rule, candidate)) continue;
      const matchStart = utf16Offset(codePointOffsets, match.index, value.length);
      const start = candidateStart(rule, fullMatch, candidate, matchStart);
      if (start === null) continue;
      const end = start + candidate.length;
      const key = `${rule.ruleId}:${start}:${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        ruleId: rule.ruleId,
        dataType: rule.dataType,
        placeholderType: rule.masking.placeholderType,
        start,
        end,
        value: candidate,
      });
      if (findings.length > MAX_GUARDRAILS_FINDINGS) {
        throw new GuardrailsScanCapacityError("Guardrails scan exceeded the maximum findings limit");
      }
    }
  }
  return resolveGuardrailsFindingConflicts(value, findings);
}
