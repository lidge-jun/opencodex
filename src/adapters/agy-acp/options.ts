/**
 * ACP session config options for `agy acp`: model and thought-level selection, and the Gemini-only
 * model proof (plan 080, revision 4).
 *
 * Config options arrive as a complete state on session/new, on every session/set_config_option reply
 * and on every config_option_update; each replaces the previous state entirely, so a selector the old
 * state had is never kept. Select values may be flat or grouped, categories are optional metadata,
 * and a chosen option is always sent by its advertised `value` with its real `configId`.
 */

export interface AcpSelectValue { value: string; name: string }
export interface AcpConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: unknown;
  values: AcpSelectValue[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const MAX_OPTIONS = 64;
const MAX_VALUES = 256;

function flatSelectValues(raw: unknown[]): AcpSelectValue[] | undefined {
  if (raw.length > MAX_VALUES) return undefined;
  const out: AcpSelectValue[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || Array.isArray(entry.options) || typeof entry.value !== "string" || !entry.value) return undefined;
    out.push({ value: entry.value, name: typeof entry.name === "string" ? entry.name : entry.value });
  }
  return out;
}

function selectValues(raw: unknown): AcpSelectValue[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_VALUES) return undefined;
  if (!isRecord(raw[0]) || !Array.isArray(raw[0].options)) return flatSelectValues(raw);
  const out: AcpSelectValue[] = [];
  for (const group of raw) {
    if (!isRecord(group) || !Array.isArray(group.options)) return undefined;
    const values = flatSelectValues(group.options);
    if (!values || out.length + values.length > MAX_VALUES) return undefined;
    out.push(...values);
  }
  return out;
}

/** Parse a configOptions array; undefined when it is absent or malformed. Unknown types are kept for proof. */
export function parseConfigOptions(raw: unknown): AcpConfigOption[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_OPTIONS) return undefined;
  const out: AcpConfigOption[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || typeof entry.type !== "string") return undefined;
    ids.add(entry.id);
    const values = entry.type === "select" ? selectValues(entry.options) : [];
    if (!values) return undefined;
    out.push({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : entry.id,
      ...(typeof entry.category === "string" ? { category: entry.category } : {}),
      type: entry.type,
      currentValue: entry.currentValue,
      values,
    });
  }
  return out;
}

export type SelectorLookup = { ok: true; selector: AcpConfigOption } | { ok: false; reason: "missing" | "ambiguous" };

/** The one select option for a category, else the one whose id is the fallback id. */
export function findSelector(state: readonly AcpConfigOption[], category: "model" | "thought_level"): SelectorLookup {
  const select = state.filter(option => option.type === "select");
  const byCategory = select.filter(option => option.category === category);
  if (byCategory.length > 1) return { ok: false, reason: "ambiguous" };
  if (byCategory.length === 1) return { ok: true, selector: byCategory[0]! };
  const byId = select.filter(option => option.id === category);
  if (byId.length > 1) return { ok: false, reason: "ambiguous" };
  return byId.length === 1 ? { ok: true, selector: byId[0]! } : { ok: false, reason: "missing" };
}

/** Lower-case, trimmed, whitespace collapsed to hyphens. */
export const normalizeLabel = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, "-");

export type ValueMatch = { ok: true; value: AcpSelectValue } | { ok: false; reason: "none" | "ambiguous" };

/** Match wanted identifiers: an exact value first, then a normalized value or name. Never guesses. */
export function matchValue(values: readonly AcpSelectValue[], wanted: readonly string[]): ValueMatch {
  const exact = values.filter(v => wanted.includes(v.value));
  if (exact.length === 1) return { ok: true, value: exact[0]! };
  if (exact.length > 1) return { ok: false, reason: "ambiguous" };
  const normalized = wanted.map(normalizeLabel);
  const loose = values.filter(v => normalized.includes(normalizeLabel(v.value)) || normalized.includes(normalizeLabel(v.name)));
  if (loose.length === 1) return { ok: true, value: loose[0]! };
  return { ok: false, reason: loose.length > 1 ? "ambiguous" : "none" };
}

const GEMINI_MODEL = /^gemini[-\s.]/i;
const CLAUDE_MODEL = /^claude[-\s.]/i;
const NON_ALLOWED_MODEL = /^(?:gpt|o[134]|grok|deepseek|qwen|llama|gemma|mistral|mixtral)(?:[-\s./]|$)/i;

type ModelFamily = "gemini" | "claude" | "other" | null;

function classifyModelFamily(raw: string): ModelFamily {
  const field = raw.trim();
  if (GEMINI_MODEL.test(field)) return "gemini";
  if (CLAUDE_MODEL.test(field)) return "claude";
  if (NON_ALLOWED_MODEL.test(field)) return "other";
  return null;
}

/** Either field can establish an allowed family (Gemini or Claude), unless the other contradicts it. */
export function isGeminiValue(value: AcpSelectValue): boolean {
  const vf = classifyModelFamily(value.value);
  const nf = classifyModelFamily(value.name);
  if (vf === "other" || nf === "other") return false;
  if (vf && nf && vf !== nf) return false;
  return vf === "gemini" || vf === "claude" || nf === "gemini" || nf === "claude";
}

/** The advertised value the selector currently holds, when it resolves to exactly one. */
export function currentSelection(selector: AcpConfigOption): AcpSelectValue | undefined {
  if (typeof selector.currentValue !== "string") return undefined;
  const matches = selector.values.filter(v => v.value === selector.currentValue);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Codex efforts and the thought-level labels each may select. */
const EFFORT_LABELS: Record<string, readonly string[]> = {
  minimal: ["minimal"],
  low: ["low"],
  medium: ["medium"],
  high: ["high"],
  xhigh: ["extra", "xhigh", "extra-high"],
  max: ["max"],
};

export function effortLabels(effort: string): readonly string[] | undefined {
  const key = effort.trim().toLowerCase();
  return Object.hasOwn(EFFORT_LABELS, key) ? EFFORT_LABELS[key] : undefined;
}

export type ModelPhase = "initial" | "pending" | "selected";
export type ModelProof =
  | { ok: true; selector: AcpConfigOption; target?: AcpSelectValue }
  | { ok: false; reason: "no_selector" | "ambiguous_selector" | "unknown_current" | "not_gemini" | "requested_not_offered" | "requested_ambiguous" | "not_requested" };

/**
 * Phase-aware Gemini proof (plan 080 R3-1).
 * - initial (after session/new): one selector with a resolvable current value; the requested model
 *   matches exactly one advertised Gemini option (the current value may still differ); without a
 *   request the current value itself must be Gemini.
 * - pending (a model setter is outstanding): the selector exists and its current value resolves.
 * - selected (after the setter, before and during the prompt): the current value is the requested
 *   option (or, without a request, a Gemini option).
 */
export function proveModel(state: readonly AcpConfigOption[], phase: ModelPhase, requested: string | undefined): ModelProof {
  const found = findSelector(state, "model");
  if (!found.ok) return { ok: false, reason: found.reason === "missing" ? "no_selector" : "ambiguous_selector" };
  const selector = found.selector;
  const current = currentSelection(selector);
  if (!current) return { ok: false, reason: "unknown_current" };
  if (phase === "pending") return { ok: true, selector };
  if (phase === "initial") {
    if (requested === undefined) return isGeminiValue(current) ? { ok: true, selector, target: current } : { ok: false, reason: "not_gemini" };
    const match = matchValue(selector.values.filter(isGeminiValue), [requested]);
    if (!match.ok) return { ok: false, reason: match.reason === "none" ? "requested_not_offered" : "requested_ambiguous" };
    return { ok: true, selector, target: match.value };
  }
  if (!isGeminiValue(current)) return { ok: false, reason: "not_gemini" };
  if (requested !== undefined) {
    const match = matchValue(selector.values.filter(isGeminiValue), [requested]);
    if (!match.ok || current.value !== match.value.value) return { ok: false, reason: "not_requested" };
  }
  return { ok: true, selector, target: current };
}
