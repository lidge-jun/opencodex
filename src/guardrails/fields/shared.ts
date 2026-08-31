import {
  MAX_GUARDRAILS_DEMASK_EXPANSION_BYTES,
  createGuardrailsPlaceholderState,
  demaskGuardrailsText,
  maskGuardrailsText,
} from "../placeholders";
import {
  MAX_GUARDRAILS_FINDINGS,
  MAX_GUARDRAILS_SCANNABLE_LEAF_BYTES,
  MAX_GUARDRAILS_SCANNABLE_TEXT_BYTES,
  GuardrailsMatchAmbiguityError,
  GuardrailsScanCapacityError,
  createGuardrailsScanBudget,
  resolveGuardrailsFindingConflicts,
  scanGuardrailsText,
  type GuardrailsScanBudget,
} from "../scanner";
import type {
  GuardrailsDemaskBudget,
  GuardrailsFinding,
  GuardrailsPlaceholderState,
  GuardrailsRegistry,
} from "../types";

export const MAX_GUARDRAILS_WALK_DEPTH = 64;
export const MAX_GUARDRAILS_WALK_NODES = 100_000;
export const MAX_GUARDRAILS_PROPERTY_CONTEXT_BYTES = 128;

export type UnknownRecord = Record<string, unknown>;

export interface GuardrailsTextSlot {
  propertyName?: string;
  replace(value: string): void;
  value: string;
}

interface GuardrailsWalkBudget {
  nodes: number;
}

let activeWalkBudget: GuardrailsWalkBudget | undefined;

function assertGuardrailsWalkCapacity(root: unknown): void {
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: root }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_GUARDRAILS_WALK_NODES) {
      throw new GuardrailsScanCapacityError("Guardrails logical request contains too many protocol nodes");
    }
    if (current.depth > MAX_GUARDRAILS_WALK_DEPTH) {
      throw new GuardrailsScanCapacityError("Guardrails logical request exceeds the maximum nesting depth");
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ depth: current.depth + 1, value: current.value[index] });
      }
      continue;
    }
    if (isRecord(current.value)) {
      const values = Object.values(current.value);
      for (let index = values.length - 1; index >= 0; index -= 1) {
        pending.push({ depth: current.depth + 1, value: values[index] });
      }
    }
  }
}

export interface GuardrailsFieldMaskResult<T> {
  body: T;
  findings: readonly GuardrailsFinding[];
  scanBudget: GuardrailsScanBudget;
  scannedTextBytes: number;
  state: GuardrailsPlaceholderState;
}

function collectWithSharedBudget<T>(
  value: T,
  collectSlots: (copy: T) => GuardrailsTextSlot[],
): GuardrailsTextSlot[] {
  const previousBudget = activeWalkBudget;
  activeWalkBudget = { nodes: 0 };
  try {
    return collectSlots(value);
  } finally {
    activeWalkBudget = previousBudget;
  }
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringPropertySlot(record: UnknownRecord, key: string): GuardrailsTextSlot | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  return { value, replace(next) { record[key] = next; } };
}

function boundedPropertyName(value: string): string | undefined {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || Buffer.byteLength(normalized, "utf8") > MAX_GUARDRAILS_PROPERTY_CONTEXT_BYTES
  ) {
    return undefined;
  }
  for (const character of normalized) {
    const code = character.codePointAt(0)!;
    const asciiLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digit = code >= 48 && code <= 57;
    const separator = character === "_" || character === "-" || character === "." || character === " ";
    const unicodeLetter = character.toLowerCase() !== character.toUpperCase();
    if (!asciiLetter && !digit && !separator && !unicodeLetter) return undefined;
  }
  const contextual = normalized
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[. ]+/g, "_");
  return Buffer.byteLength(contextual, "utf8") <= MAX_GUARDRAILS_PROPERTY_CONTEXT_BYTES
    ? contextual
    : undefined;
}

function propertyNameCaseVariants(value: string): string[] {
  let casedIndex = 0;
  const alternating = [...value].map(character => {
    const lower = character.toLowerCase();
    const upper = character.toUpperCase();
    if (lower === upper) return character;
    const result = casedIndex % 2 === 0 ? upper : lower;
    casedIndex += 1;
    return result;
  }).join("");
  return [...new Set([value.toUpperCase(), value.toLowerCase(), alternating, value])]
    .filter(candidate =>
      Buffer.byteLength(candidate, "utf8") <= MAX_GUARDRAILS_PROPERTY_CONTEXT_BYTES
    );
}

function propertyAwareFindings(
  contextualRegistry: GuardrailsRegistry | undefined,
  slot: GuardrailsTextSlot,
  budget: GuardrailsScanBudget,
): GuardrailsFinding[] {
  const propertyName = slot.propertyName;
  if (!propertyName || !contextualRegistry) return [];
  const quote = !slot.value.includes("\"") && !slot.value.includes("\\") && !/[\r\n]/.test(slot.value)
    ? "\""
    : !slot.value.includes("'") && !slot.value.includes("\\") && !/[\r\n]/.test(slot.value)
      ? "'"
      : "";
  const leadingWhitespaceLength = slot.value.length - slot.value.trimStart().length;
  let ambiguity: GuardrailsMatchAmbiguityError | undefined;
  for (const propertyContext of propertyNameCaseVariants(propertyName)) {
    const prefix = `${propertyContext}=${quote}`;
    const contextualValue = `${prefix}${slot.value}${quote}`;
    if (Buffer.byteLength(contextualValue, "utf8") > MAX_GUARDRAILS_SCANNABLE_LEAF_BYTES) continue;
    const valueStart = prefix.length;
    const valueEnd = valueStart + slot.value.length;
    try {
      return scanGuardrailsText(contextualRegistry, contextualValue, budget)
        .filter(finding => finding.start >= valueStart && finding.end <= valueEnd)
        .map(finding => {
          if (
            finding.ruleId.endsWith(".assignment")
            && finding.start === valueStart + leadingWhitespaceLength
          ) {
            return {
              ...finding,
              start: 0,
              end: slot.value.length,
              value: slot.value,
            };
          }
          const start = finding.start - valueStart;
          const end = finding.end - valueStart;
          return {
            ...finding,
            start,
            end,
            value: slot.value.slice(start, end),
          };
        });
    } catch (error) {
      if (!(error instanceof GuardrailsMatchAmbiguityError)) throw error;
      ambiguity = error;
    }
  }
  if (ambiguity) throw ambiguity;
  return [];
}

export function maskGuardrailsTextSlots<T>(
  body: T,
  registry: GuardrailsRegistry,
  collectSlots: (copy: T) => GuardrailsTextSlot[],
  previousState?: GuardrailsPlaceholderState,
  scanBudget: GuardrailsScanBudget = createGuardrailsScanBudget(),
): GuardrailsFieldMaskResult<T> {
  assertGuardrailsWalkCapacity(body);
  const sourceSlots = collectWithSharedBudget(body, collectSlots);
  let totalBytes = 0;
  for (const slot of sourceSlots) {
    totalBytes += Buffer.byteLength(slot.value, "utf8");
    if (totalBytes > MAX_GUARDRAILS_SCANNABLE_TEXT_BYTES) {
      throw new GuardrailsScanCapacityError("Guardrails logical request exceeds the maximum scannable text size");
    }
  }
  if (sourceSlots.length > MAX_GUARDRAILS_WALK_NODES) {
    throw new GuardrailsScanCapacityError("Guardrails logical request contains too many text fields");
  }
  const copy = structuredClone(body);
  const slots = collectWithSharedBudget(copy, collectSlots);
  if (slots.length !== sourceSlots.length) {
    throw new GuardrailsScanCapacityError("Guardrails logical request changed during text-field admission");
  }
  const reserved = createGuardrailsPlaceholderState(slots.map(slot => slot.value));
  let state: GuardrailsPlaceholderState = previousState
    ? {
        replacements: previousState.replacements,
        reservedPlaceholders: [...new Set([...previousState.reservedPlaceholders, ...reserved.reservedPlaceholders])].sort(),
      }
    : reserved;
  const contextualRules = registry.rules.filter(rule => rule.source === "opencodex");
  const contextualRegistry: GuardrailsRegistry | undefined = contextualRules.length === 0
    ? undefined
    : {
        rules: contextualRules,
        groups: registry.groups,
        keywordPrefilterEnabled: registry.keywordPrefilterEnabled,
        dispose() {},
      };
  const findings: GuardrailsFinding[] = [];
  for (const slot of slots) {
    const current = slot.value;
    const currentFindings = resolveGuardrailsFindingConflicts(current, [
      ...scanGuardrailsText(registry, current, scanBudget),
      ...propertyAwareFindings(contextualRegistry, slot, scanBudget),
    ]);
    if (findings.length + currentFindings.length > MAX_GUARDRAILS_FINDINGS) {
      throw new GuardrailsScanCapacityError("Guardrails logical request exceeded the maximum findings limit");
    }
    const result = maskGuardrailsText(current, currentFindings, state);
    slot.replace(result.maskedText);
    state = result.state;
    findings.push(...currentFindings);
  }
  return { body: copy, state, findings, scanBudget, scannedTextBytes: totalBytes };
}

export function restoreGuardrailsTextSlots<T>(
  body: T,
  state: GuardrailsPlaceholderState,
  collectSlots: (copy: T) => GuardrailsTextSlot[],
  budget: GuardrailsDemaskBudget = {
    remainingExpansionBytes: MAX_GUARDRAILS_DEMASK_EXPANSION_BYTES,
  },
): T {
  const copy = structuredClone(body);
  const slots = collectWithSharedBudget(copy, collectSlots);
  for (const slot of slots) {
    slot.replace(demaskGuardrailsText(slot.value, state, { budget }));
  }
  return copy;
}

/** Collect nested strings only from an explicitly allowed sub-object such as tool_use.input. */
export function nestedStringSlots(root: unknown): GuardrailsTextSlot[] {
  const result: GuardrailsTextSlot[] = [];
  const pending: Array<{
    depth: number;
    parent: UnknownRecord | unknown[];
    propertyName?: string;
    key: string | number;
    value: unknown;
  }> = [];
  const localBudget = activeWalkBudget ?? { nodes: 0 };
  const enqueue = (
    depth: number,
    parent: UnknownRecord | unknown[],
    key: string | number,
    value: unknown,
    propertyName?: string,
  ): void => {
    if (depth > MAX_GUARDRAILS_WALK_DEPTH) {
      throw new GuardrailsScanCapacityError("Guardrails nested text walk exceeded its capacity limit");
    }
    localBudget.nodes += 1;
    if (localBudget.nodes > MAX_GUARDRAILS_WALK_NODES) {
      throw new GuardrailsScanCapacityError("Guardrails nested text walk exceeded its capacity limit");
    }
    pending.push({ depth, parent, propertyName, key, value });
  };
  if (Array.isArray(root)) {
    root.forEach((value, index) => enqueue(0, root, index, value));
  } else if (isRecord(root)) {
    for (const [key, value] of Object.entries(root)) {
      enqueue(0, root, key, value, boundedPropertyName(key));
    }
  }
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (typeof node.value === "string") {
      result.push({
        propertyName: node.propertyName,
        value: node.value,
        replace(next) {
          if (Array.isArray(node.parent)) {
            node.parent[node.key as number] = next;
          } else {
            node.parent[node.key as string] = next;
          }
        },
      });
      continue;
    }
    if (Array.isArray(node.value)) {
      node.value.forEach((value, index) => {
        enqueue(node.depth + 1, node.value as unknown[], index, value, node.propertyName);
      });
      continue;
    }
    if (isRecord(node.value)) {
      for (const [key, value] of Object.entries(node.value)) {
        enqueue(node.depth + 1, node.value, key, value, boundedPropertyName(key));
      }
    }
  }
  return result;
}
