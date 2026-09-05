import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { RE2, WrappedRE2 } from "./re2-runtime";
import type { Re2Instance } from "./re2-runtime";
import { provenGuardrailsPrefilterKeywords } from "./prefilter";
import type {
  CompiledGuardrailsRule,
  GuardrailsCustomRule,
  GuardrailsDataType,
  GuardrailsGroup,
  GuardrailsRegistry,
  GuardrailsRegistryOptions,
  GuardrailsRule,
  GuardrailsValidator,
} from "./types";

const RULES_DIRECTORY = fileURLToPath(new URL("./rules/", import.meta.url));
const RULE_FILES = [
  ["guardrails_regex_rules.yaml", "manual"],
  ["guardrails_regex_rules.gitleaks.generated.yaml", "gitleaks"],
  ["guardrails_regex_rules.opencodex.yaml", "opencodex"],
] as const;

type RuleSource = (typeof RULE_FILES)[number][1];
type UnknownRecord = Record<string, unknown>;

let cachedBuiltin: Readonly<{ rules: readonly GuardrailsRule[]; groups: readonly GuardrailsGroup[] }> | null = null;
let cachedBuiltinCompiledRules: readonly CompiledGuardrailsRule[] | null = null;

interface DisposableCppVector<T> {
  delete(): void;
  get(index: number): T;
  size(): number;
}

interface DisposableCppMap<K, V> {
  delete(): void;
  get(key: K): V;
  keys(): DisposableCppVector<K>;
}

interface DisposableWrappedRE2 {
  capturingGroupNames(): DisposableCppMap<number, string>;
  delete(): void;
  error(): string;
  ok(): boolean;
}

export class GuardrailsRuleCompileError extends Error {
  constructor(
    readonly ruleId: string,
    readonly reason: "capture_group" | "disabled_rule" | "regex",
    detail: string,
  ) {
    super(`Guardrails rule ${ruleId} ${detail}`);
    this.name = "GuardrailsRuleCompileError";
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Guardrails rule ${key} must be a non-empty string`);
  return value;
}

function numberField(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Guardrails rule ${key} must be a finite number`);
  return value;
}

function dataType(value: number): GuardrailsDataType {
  if (!Number.isInteger(value) || value < 1 || value > 6) throw new Error("Guardrails rule data_type must be an integer from 1 to 6");
  return value as GuardrailsDataType;
}

function stringArray(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) throw new Error(`Guardrails rule ${key} must be a string array`);
  return value.map(entry => entry.toLowerCase());
}

function validatorArray(value: unknown): GuardrailsValidator[] {
  const values = stringArray(value, "validators");
  const known: ReadonlySet<string> = new Set([
    "luhn", "snils", "inn_person", "inn_org", "ogrn", "ogrnip", "iban_mod97", "email_ascii",
    "payment_card", "payment_card_no_luhn", "entropy", "banlist", "ip_v4", "ip_v6", "ip_public", "ip_private",
  ]);
  if (values.some(value => !known.has(value))) throw new Error("Guardrails rule contains an unsupported validator");
  return values as GuardrailsValidator[];
}

function maskingField(value: unknown): GuardrailsRule["masking"] {
  if (!isRecord(value)) throw new Error("Guardrails rule masking must be an object");
  const captureGroups = value.capture_groups === undefined
    ? []
    : Array.isArray(value.capture_groups) && value.capture_groups.every(index => typeof index === "number" && Number.isInteger(index) && index > 0)
      ? [...value.capture_groups] as number[]
      : (() => { throw new Error("Guardrails rule capture_groups must contain positive integers"); })();
  return { captureGroups, placeholderType: stringField(value, "placeholder") };
}

function parseRule(raw: unknown, group: GuardrailsGroup, source: RuleSource): GuardrailsRule {
  if (!isRecord(raw)) throw new Error("Guardrails rule must be an object");
  const minLength = raw.min_length === undefined ? undefined : numberField(raw, "min_length");
  const entropy = raw.entropy === undefined ? undefined : numberField(raw, "entropy");
  const banlist = stringArray(raw.banlist, "banlist");
  const validators = validatorArray(raw.validators);
  if ((minLength !== undefined && (!Number.isInteger(minLength) || minLength < 1)) || (entropy !== undefined && entropy < 0)) {
    throw new Error("Guardrails rule has an invalid numeric constraint");
  }
  if (entropy !== undefined && !validators.includes("entropy")) validators.push("entropy");
  if (banlist.length > 0 && !validators.includes("banlist")) validators.push("banlist");
  return {
    ruleId: stringField(raw, "rule_id"),
    name: stringField(raw, "name"),
    dataType: group.dataType,
    group: group.name,
    groupPriority: group.groupPriority,
    displayName: group.displayName,
    description: group.description,
    regex: stringField(raw, "regex"),
    minLength,
    keywords: stringArray(raw.keywords, "keywords"),
    entropy,
    banlist,
    validators,
    masking: maskingField(raw.masking),
    source,
  };
}

function parseRuleFile(file: string, source: RuleSource): { rules: GuardrailsRule[]; groups: GuardrailsGroup[] } {
  const parsed = parseYaml(readFileSync(`${RULES_DIRECTORY}${file}`, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.guardrails_regex_rules)) throw new Error(`Guardrails rules file ${file} has no guardrails_regex_rules array`);
  const rules: GuardrailsRule[] = [];
  const groups: GuardrailsGroup[] = [];
  for (const rawGroup of parsed.guardrails_regex_rules) {
    if (!isRecord(rawGroup) || !Array.isArray(rawGroup.rules)) throw new Error(`Guardrails rules file ${file} contains an invalid group`);
    const group: GuardrailsGroup = {
      dataType: dataType(numberField(rawGroup, "data_type")),
      groupPriority: numberField(rawGroup, "group_priority"),
      name: stringField(rawGroup, "name"),
      displayName: stringField(rawGroup, "display_name"),
      description: stringField(rawGroup, "description"),
      source,
    };
    groups.push(group);
    rules.push(...rawGroup.rules.map(rawRule => parseRule(rawRule, group, source)));
  }
  return { rules, groups };
}

function builtinDefinitions(): Readonly<{ rules: readonly GuardrailsRule[]; groups: readonly GuardrailsGroup[] }> {
  if (cachedBuiltin) return cachedBuiltin;
  const rules: GuardrailsRule[] = [];
  const groups: GuardrailsGroup[] = [];
  const ids = new Set<string>();
  for (const [file, source] of RULE_FILES) {
    const parsed = parseRuleFile(file, source);
    for (const rule of parsed.rules) {
      if (ids.has(rule.ruleId)) throw new Error(`Duplicate Guardrails rule ID ${rule.ruleId}`);
      ids.add(rule.ruleId);
      rules.push(rule);
    }
    groups.push(...parsed.groups);
  }
  cachedBuiltin = { rules, groups };
  return cachedBuiltin;
}

const RE2_ALPHA_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const RE2_HEX = "0123456789ABCDEF";

function isRe2Hexadecimal(character: string): boolean {
  return RE2_HEX.includes(character.toUpperCase());
}

function escapeRe2Pattern(pattern: string): string {
  const result: string[] = [];
  let precedingBackslashes = 0;
  for (const character of pattern) {
    if (character === "\\") {
      result.push(character);
      precedingBackslashes += 1;
      continue;
    }
    if (character === "/" && precedingBackslashes % 2 === 0) result.push("\\");
    result.push(character);
    precedingBackslashes = 0;
  }
  return result.join("");
}

// Modified/adapted by OpenCodex contributors from re2-wasm@1.0.2 src/re2.ts
// (Copyright 2021 Google LLC, Apache-2.0). Changes: strict typed preflight,
// malformed-escape rejection, and integration with the immutable registry.
// The dependency is exact-pinned because this preflight must compile the same
// source as the public RE2 constructor.
function translateRe2Pattern(pattern: string): string {
  const result: string[] = [];
  for (let index = 0; index < pattern.length;) {
    if (pattern[index] === "\\" && index + 1 < pattern.length) {
      switch (pattern[index + 1]) {
        case "\\":
          result.push("\\\\");
          index += 2;
          continue;
        case "c": {
          if (index + 2 < pattern.length) {
            const alphaIndex = RE2_ALPHA_UPPER.indexOf(pattern[index + 2]!) + 1;
            if (alphaIndex > 0) {
              result.push(
                "\\x",
                RE2_HEX[Math.floor(alphaIndex / 16)]!,
                RE2_HEX[alphaIndex % 16]!,
              );
              index += 3;
              continue;
            }
          }
          result.push("\\c");
          index += 2;
          continue;
        }
        case "u": {
          if (index + 2 < pattern.length) {
            const next = pattern[index + 2]!;
            if (isRe2Hexadecimal(next)) {
              result.push("\\x{", next);
              index += 3;
              for (
                let count = 0;
                count < 3 && index < pattern.length && isRe2Hexadecimal(pattern[index]!);
                count += 1, index += 1
              ) {
                result.push(pattern[index]!);
              }
              result.push("}");
              continue;
            }
            if (next === "{") {
              result.push("\\x");
              index += 2;
              continue;
            }
          }
          result.push("\\u");
          index += 2;
          continue;
        }
        default:
          result.push("\\", pattern[index + 1]!);
          index += 2;
          continue;
      }
    }
    if (pattern[index] === "/") {
      result.push("\\/");
      index += 1;
      continue;
    }
    if (
      pattern.startsWith("(?<", index)
      && pattern[index + 3] !== "="
      && pattern[index + 3] !== "!"
    ) {
      result.push("(?P<");
      index += 3;
      continue;
    }
    result.push(pattern[index]!);
    index += 1;
  }
  return result.join("");
}

function preflightRe2Pattern(pattern: string): void {
  const normalized = escapeRe2Pattern(pattern.length === 0 ? "(?:)" : pattern);
  const wrapper = new WrappedRE2(
    translateRe2Pattern(normalized),
    false,
    false,
    false,
  ) as unknown as DisposableWrappedRE2;
  try {
    if (!wrapper.ok()) {
      throw new SyntaxError(`Invalid regular expression: /${normalized}/u: ${wrapper.error()}`);
    }
    const groupNames = wrapper.capturingGroupNames();
    try {
      const groupNumbers = groupNames.keys();
      try {
        const seen = new Set<string>();
        for (let index = 0; index < groupNumbers.size(); index += 1) {
          const name = groupNames.get(groupNumbers.get(index));
          if (seen.has(name)) {
            throw new SyntaxError(`Invalid regular expression: /${normalized}/u: Duplicate capture group name`);
          }
          seen.add(name);
        }
      } finally {
        groupNumbers.delete();
      }
    } finally {
      groupNames.delete();
    }
  } finally {
    wrapper.delete();
  }
}

function createRe2(pattern: string, flags: "gu" | "u", preflight: boolean): Re2Instance {
  if (preflight) preflightRe2Pattern(pattern);
  return new RE2(pattern, flags);
}

function disposeMatcher(matcher: Re2Instance): void {
  const internalMatcher = matcher as unknown as { wrapper?: { delete?: () => void } };
  internalMatcher.wrapper?.delete?.();
}

function captureGroupCount(regex: string, preflight: boolean): number {
  let probe: Re2Instance | undefined;
  try {
    // The empty alternative always matches while preserving every capture slot
    // from the original expression as `undefined`.
    probe = createRe2(`(?:${regex})|`, "u", preflight);
    return Math.max(0, (probe.exec("")?.length ?? 1) - 1);
  } finally {
    if (probe) disposeMatcher(probe);
  }
}

function compileRule(rule: GuardrailsRule): CompiledGuardrailsRule {
  let matcher: Re2Instance | undefined;
  try {
    const preflight = rule.source === "custom";
    matcher = createRe2(rule.regex, "gu", preflight);
    const emptyMatch = matcher.exec("");
    matcher.lastIndex = 0;
    if (emptyMatch?.[0] === "") {
      throw new GuardrailsRuleCompileError(rule.ruleId, "regex", "must not match an empty string");
    }
    const captures = captureGroupCount(rule.regex, preflight);
    const invalidCapture = rule.masking.captureGroups.find(index => index > captures);
    if (invalidCapture !== undefined) {
      throw new GuardrailsRuleCompileError(
        rule.ruleId,
        "capture_group",
        `references capture group ${invalidCapture}, but its regex defines only ${captures}`,
      );
    }
    return {
      ...rule,
      matcher,
      prefilterKeywords: rule.source === "custom"
        ? []
        : provenGuardrailsPrefilterKeywords(rule.regex, rule.keywords),
    };
  } catch (error) {
    if (matcher) disposeMatcher(matcher);
    if (error instanceof GuardrailsRuleCompileError) throw error;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new GuardrailsRuleCompileError(rule.ruleId, "regex", `is not RE2 compatible${detail}`);
  }
}

function compiledBuiltinRules(): readonly CompiledGuardrailsRule[] {
  if (cachedBuiltinCompiledRules) return cachedBuiltinCompiledRules;
  const compiled: CompiledGuardrailsRule[] = [];
  try {
    for (const rule of builtinDefinitions().rules) compiled.push(compileRule(rule));
    cachedBuiltinCompiledRules = compiled;
  } catch (error) {
    for (const rule of compiled) disposeMatcher(rule.matcher);
    throw error;
  }
  return cachedBuiltinCompiledRules;
}

function customRuleDefinition(rule: GuardrailsCustomRule): GuardrailsRule {
  return {
    ...rule,
    groupPriority: rule.groupPriority ?? 0,
    keywords: rule.keywords.map(value => value.toLowerCase()),
    banlist: rule.banlist.map(value => value.toLowerCase()),
    source: "custom",
  };
}

export function createGuardrailsRegistry(options: GuardrailsRegistryOptions = {}): GuardrailsRegistry {
  const builtin = builtinDefinitions();
  const enabledDataTypes = new Set<GuardrailsDataType>(options.enabledDataTypes ?? [1, 2, 3, 4, 5, 6]);
  const disabledBuiltin = new Set(options.disabledBuiltinRuleIds ?? []);
  const builtinIds = new Set(builtin.rules.map(rule => rule.ruleId));
  for (const ruleId of disabledBuiltin) {
    if (!builtinIds.has(ruleId)) {
      throw new GuardrailsRuleCompileError(ruleId, "disabled_rule", "does not identify a built-in rule");
    }
  }
  const builtinRules = compiledBuiltinRules().filter(rule => enabledDataTypes.has(rule.dataType) && !disabledBuiltin.has(rule.ruleId));
  const customRules: CompiledGuardrailsRule[] = [];
  const rules = [...builtinRules];
  const ids = new Set(builtinIds);
  const placeholderTypes = new Set(builtin.rules.map(rule => rule.masking.placeholderType));
  try {
    for (const customRule of options.customRules ?? []) {
      const rule = customRuleDefinition(customRule);
      if (ids.has(rule.ruleId)) throw new GuardrailsRuleCompileError(rule.ruleId, "regex", "duplicates an existing rule ID");
      if (placeholderTypes.has(rule.masking.placeholderType)) {
        throw new GuardrailsRuleCompileError(rule.ruleId, "regex", `uses reserved placeholder type ${rule.masking.placeholderType}`);
      }
      ids.add(rule.ruleId);
      placeholderTypes.add(rule.masking.placeholderType);
      const compiled = compileRule(rule);
      if (!enabledDataTypes.has(rule.dataType)) {
        disposeMatcher(compiled.matcher);
        continue;
      }
      customRules.push(compiled);
      rules.push(compiled);
    }
  } catch (error) {
    for (const rule of customRules) disposeMatcher(rule.matcher);
    throw error;
  }
  return {
    rules,
    groups: builtin.groups,
    keywordPrefilterEnabled: options.keywordPrefilterEnabled === true,
    dispose() {
      for (const rule of customRules) disposeMatcher(rule.matcher);
    },
  };
}

export function validateGuardrailsCustomRulesCompatibility(
  customRules: readonly GuardrailsCustomRule[],
): void {
  const ids = new Set(builtinDefinitions().rules.map(rule => rule.ruleId));
  const placeholderTypes = new Set(builtinDefinitions().rules.map(rule => rule.masking.placeholderType));
  const compiled: CompiledGuardrailsRule[] = [];
  try {
    for (const customRule of customRules) {
      const rule = customRuleDefinition(customRule);
      if (ids.has(rule.ruleId)) {
        throw new GuardrailsRuleCompileError(rule.ruleId, "regex", "duplicates an existing rule ID");
      }
      if (placeholderTypes.has(rule.masking.placeholderType)) {
        throw new GuardrailsRuleCompileError(rule.ruleId, "regex", `uses reserved placeholder type ${rule.masking.placeholderType}`);
      }
      ids.add(rule.ruleId);
      placeholderTypes.add(rule.masking.placeholderType);
      compiled.push(compileRule(rule));
    }
  } finally {
    for (const rule of compiled) disposeMatcher(rule.matcher);
  }
}

export function createBuiltinGuardrailsRegistry(): GuardrailsRegistry {
  return createGuardrailsRegistry();
}

export interface GuardrailsBuiltinRuleCatalogEntry {
  dataType: GuardrailsDataType;
  description: string;
  displayName: string;
  group: string;
  ruleId: string;
  source: "gitleaks" | "manual" | "opencodex";
}

/** Read-only management catalog. It parses vendored YAML but never compiles RE2/WASM. */
export function guardrailsBuiltinRuleCatalog(): readonly GuardrailsBuiltinRuleCatalogEntry[] {
  return builtinDefinitions().rules.map(rule => ({
    ruleId: rule.ruleId,
    dataType: rule.dataType,
    group: rule.group,
    displayName: rule.displayName,
    description: rule.description,
    source: rule.source === "custom" ? "manual" : rule.source,
  }));
}
