import type { RE2 } from "re2-wasm";

export type GuardrailsDataType = 1 | 2 | 3 | 4 | 5 | 6;

export type GuardrailsValidator =
  | "luhn"
  | "snils"
  | "inn_person"
  | "inn_org"
  | "ogrn"
  | "ogrnip"
  | "iban_mod97"
  | "email_ascii"
  | "payment_card"
  | "payment_card_no_luhn"
  | "entropy"
  | "banlist"
  | "ip_v4"
  | "ip_v6"
  | "ip_public"
  | "ip_private";

export interface GuardrailsMasking {
  captureGroups: readonly number[];
  placeholderType: string;
}

export interface GuardrailsRule {
  ruleId: string;
  name: string;
  dataType: GuardrailsDataType;
  group: string;
  groupPriority: number;
  displayName: string;
  description: string;
  regex: string;
  minLength?: number;
  keywords: readonly string[];
  entropy?: number;
  banlist: readonly string[];
  validators: readonly GuardrailsValidator[];
  masking: GuardrailsMasking;
  source: "manual" | "gitleaks" | "opencodex" | "custom";
}

export interface GuardrailsCustomRule extends Omit<GuardrailsRule, "source" | "groupPriority"> {
  groupPriority?: number;
}

export interface CompiledGuardrailsRule extends GuardrailsRule {
  matcher: RE2;
  /** Empty means the rule is always scanned, even when the prefilter is enabled. */
  prefilterKeywords: readonly string[];
}

export interface GuardrailsGroup {
  dataType: GuardrailsDataType;
  groupPriority: number;
  name: string;
  displayName: string;
  description: string;
  source: "manual" | "gitleaks" | "opencodex";
}

export interface GuardrailsRegistry {
  rules: readonly CompiledGuardrailsRule[];
  groups: readonly GuardrailsGroup[];
  keywordPrefilterEnabled: boolean;
  dispose(): void;
}

export interface GuardrailsRegistryOptions {
  enabledDataTypes?: readonly GuardrailsDataType[];
  disabledBuiltinRuleIds?: readonly string[];
  customRules?: readonly GuardrailsCustomRule[];
  keywordPrefilterEnabled?: boolean;
}

export interface GuardrailsFinding {
  ruleId: string;
  dataType: GuardrailsDataType;
  placeholderType: string;
  start: number;
  end: number;
  value: string;
}

export interface GuardrailsPlaceholderReplacement {
  dataType: GuardrailsDataType;
  original: string;
  placeholder: string;
  placeholderType: string;
  ruleId: string;
}

export interface GuardrailsPlaceholderState {
  replacements: readonly GuardrailsPlaceholderReplacement[];
  reservedPlaceholders: readonly string[];
}

export interface GuardrailsMaskResult {
  maskedText: string;
  state: GuardrailsPlaceholderState;
}

export interface GuardrailsDemaskOptions {
  allowNormalizedPlaceholderDrift?: boolean;
  budget?: GuardrailsDemaskBudget;
}

export interface GuardrailsDemaskBudget {
  remainingExpansionBytes: number;
}

export interface GuardrailsValidationOptions {
  entropy?: number;
  banlist?: readonly string[];
}
