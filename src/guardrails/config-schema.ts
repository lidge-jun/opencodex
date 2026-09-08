import { z } from "zod";
import type {
  OcxGuardrailsConfig,
  OcxGuardrailsDataType,
} from "../types";
import type { OcxGuardrailsProviderScope } from "../types/config";
import { isValidGuardrailsProviderId } from "../config/provider-name";
import { MAX_GUARDRAILS_SCANNABLE_LEAF_BYTES } from "./scanner";
import type { GuardrailsCustomRule, GuardrailsRegistryOptions } from "./types";

const DATA_TYPES = [1, 2, 3, 4, 5, 6] as const;
// Keep the config bound independent of the current registry size so adding a
// built-in rule does not make a previously valid "disable all" policy invalid.
const MAX_DISABLED_BUILTIN_RULE_IDS = 512;
export const MAX_GUARDRAILS_CUSTOM_RULES = 100;
export const MAX_GUARDRAILS_PROVIDER_IDS = 256;
export const MAX_GUARDRAILS_RULE_PATTERN_BYTES = 4_096;
const VALIDATORS = [
  "luhn", "snils", "inn_person", "inn_org", "ogrn", "ogrnip", "iban_mod97", "email_ascii",
  "payment_card", "payment_card_no_luhn", "entropy", "banlist", "ip_v4", "ip_v6", "ip_public", "ip_private",
] as const;

function issueMessage(result: z.ZodSafeParseError<unknown>): string {
  const issue = result.error.issues[0];
  const suffix = issue?.path.length ? `.${issue.path.join(".")}` : "";
  return `guardrails${suffix}: ${issue?.message ?? "invalid configuration"}`;
}

const dataTypeSchema = z.union(DATA_TYPES.map(value => z.literal(value)));
const validatorSchema = z.enum(VALIDATORS);
const providerIdSchema = z.string().refine(
  isValidGuardrailsProviderId,
  "must be a valid provider ID",
);
const providerScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({
    mode: z.literal("selected"),
    providerIds: z.array(providerIdSchema)
      .min(1)
      .max(MAX_GUARDRAILS_PROVIDER_IDS)
      .refine(
        values => new Set(values).size === values.length,
        "must not contain duplicate provider IDs",
      ),
  }).strict(),
]);

function byteLimitedString(maximum: number) {
  return z.string().refine(
    value => new TextEncoder().encode(value).byteLength <= maximum,
    `must not exceed ${maximum} UTF-8 bytes`,
  );
}

const customRuleSchema = z.object({
  ruleId: z.string().regex(/^[a-z0-9_.-]{1,128}$/),
  name: byteLimitedString(256).min(1),
  dataType: dataTypeSchema,
  group: byteLimitedString(128).min(1),
  groupPriority: z.number().int().min(-10_000).max(10_000),
  displayName: byteLimitedString(256).min(1),
  description: byteLimitedString(2_048),
  regex: byteLimitedString(MAX_GUARDRAILS_RULE_PATTERN_BYTES).min(1),
  minLength: z.number().int().min(1).max(MAX_GUARDRAILS_SCANNABLE_LEAF_BYTES).optional(),
  keywords: z.array(byteLimitedString(256).min(1)).max(64),
  entropy: z.number().min(0).max(16).optional(),
  banlist: z.array(byteLimitedString(1_024).min(1)).max(1_024),
  validators: z.array(validatorSchema).max(VALIDATORS.length)
    .refine(values => new Set(values).size === values.length, "must not contain duplicate validators"),
  masking: z.object({
    captureGroups: z.array(z.number().int().positive()).max(64)
      .refine(values => new Set(values).size === values.length, "must not contain duplicate capture groups"),
    placeholderType: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  }).strict(),
}).strict().superRefine((rule, ctx) => {
  const usesEntropy = rule.validators.includes("entropy");
  if (usesEntropy && rule.entropy === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["entropy"],
      message: "is required when the entropy validator is enabled",
    });
  } else if (!usesEntropy && rule.entropy !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["entropy"],
      message: "requires the entropy validator",
    });
  }

  const usesBanlist = rule.validators.includes("banlist");
  if (usesBanlist && rule.banlist.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["banlist"],
      message: "must not be empty when the banlist validator is enabled",
    });
  } else if (!usesBanlist && rule.banlist.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["banlist"],
      message: "requires the banlist validator",
    });
  }

  for (const [left, right] of [
    ["ip_v4", "ip_v6"],
    ["ip_public", "ip_private"],
  ] as const) {
    if (rule.validators.includes(left) && rule.validators.includes(right)) {
      ctx.addIssue({
        code: "custom",
        path: ["validators"],
        message: `${left} and ${right} cannot be combined`,
      });
    }
  }
});

const guardrailsConfigInputSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["enforce", "detect"]).optional(),
  failurePolicy: z.enum(["block", "passthrough"]).optional(),
  providerScope: providerScopeSchema.optional(),
  enabledDataTypes: z.array(dataTypeSchema)
    .min(1)
    .max(DATA_TYPES.length)
    .refine(values => new Set(values).size === values.length, "must not contain duplicate data types")
    .optional(),
  disabledBuiltinRuleIds: z.array(z.string().min(1).max(160).regex(/^[a-zA-Z0-9._-]+$/))
    .max(MAX_DISABLED_BUILTIN_RULE_IDS)
    .refine(values => new Set(values).size === values.length, "must not contain duplicate rule IDs")
    .optional(),
  customRules: z.array(customRuleSchema)
    .max(MAX_GUARDRAILS_CUSTOM_RULES)
    .refine(values => new Set(values.map(rule => rule.ruleId)).size === values.length, "must not contain duplicate custom rule IDs")
    .refine(values => new Set(values.map(rule => rule.masking.placeholderType)).size === values.length, "custom placeholder types must be unique")
    .optional(),
  keywordPrefilterEnabled: z.boolean().optional(),
}).strict();

export type GuardrailsSettingsPatch = Partial<OcxGuardrailsConfig>;

function normalizeGuardrailsProviderScope(
  scope: OcxGuardrailsProviderScope | undefined,
): OcxGuardrailsProviderScope | undefined {
  if (!scope || scope.mode === "all") return undefined;
  return {
    mode: "selected",
    providerIds: [...scope.providerIds].sort(),
  };
}

function normalizeGuardrailsConfig(config: OcxGuardrailsConfig): OcxGuardrailsConfig {
  const normalized = { ...config };
  const providerScope = normalizeGuardrailsProviderScope(config.providerScope);
  if (providerScope) normalized.providerScope = providerScope;
  else delete normalized.providerScope;
  return normalized;
}

export const guardrailsConfigSchema = guardrailsConfigInputSchema.transform(
  value => normalizeGuardrailsConfig(value as OcxGuardrailsConfig),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGuardrailsConfig(value: unknown): { config: OcxGuardrailsConfig; ok: true } | { error: string; ok: false } {
  const result = guardrailsConfigSchema.safeParse(value);
  if (!result.success) return { ok: false, error: issueMessage(result) };
  return { ok: true, config: result.data as OcxGuardrailsConfig };
}

export function parseGuardrailsCustomRule(
  value: unknown,
): { rule: NonNullable<OcxGuardrailsConfig["customRules"]>[number]; ok: true } | { error: string; ok: false } {
  const result = customRuleSchema.safeParse(value);
  if (!result.success) return { ok: false, error: issueMessage(result) };
  return { ok: true, rule: result.data };
}

/** Strict write boundary for the tolerant `configSchema` field. */
export function guardrailsConfigError(config: unknown): string | null {
  if (!isRecord(config) || !Object.hasOwn(config, "guardrails") || config.guardrails === undefined) return null;
  const result = parseGuardrailsConfig(config.guardrails);
  return result.ok ? null : `schema_invalid: ${result.error}`;
}

export function malformedGuardrailsConfigWarning(raw: unknown): string | null {
  if (!isRecord(raw) || !Object.hasOwn(raw, "guardrails") || raw.guardrails === undefined) return null;
  const result = parseGuardrailsConfig(raw.guardrails);
  return result.ok ? null : `${result.error} was ignored`;
}

export function parseGuardrailsSettingsPatch(value: unknown): { patch: GuardrailsSettingsPatch; ok: true } | { error: string; ok: false } {
  if (!isRecord(value)) return { ok: false, error: "settings body must be an object" };
  const allowed = new Set([
    "enabled",
    "mode",
    "failurePolicy",
    "providerScope",
    "enabledDataTypes",
    "disabledBuiltinRuleIds",
    "keywordPrefilterEnabled",
  ]);
  if (Object.keys(value).some(key => !allowed.has(key))) return { ok: false, error: "settings body contains an unsupported field" };
  if (Object.keys(value).length === 0) return { ok: false, error: "provide at least one Guardrails setting" };
  const result = guardrailsConfigInputSchema.safeParse(value);
  return result.success
    ? { ok: true, patch: result.data as GuardrailsSettingsPatch }
    : { ok: false, error: issueMessage(result) };
}

function sameValues<T>(left: readonly T[] | undefined, right: readonly T[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameProviderScope(
  left: OcxGuardrailsProviderScope | undefined,
  right: OcxGuardrailsProviderScope | undefined,
): boolean {
  if (left?.mode !== "selected" || right?.mode !== "selected") {
    return left?.mode !== "selected" && right?.mode !== "selected";
  }
  return sameValues(
    [...left.providerIds].sort(),
    [...right.providerIds].sort(),
  );
}

export function guardrailsConfigEqual(left: OcxGuardrailsConfig | undefined, right: OcxGuardrailsConfig | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left?.enabled === right?.enabled
    && left?.mode === right?.mode
    && left?.failurePolicy === right?.failurePolicy
    && sameProviderScope(left?.providerScope, right?.providerScope)
    && left?.keywordPrefilterEnabled === right?.keywordPrefilterEnabled
    && sameValues(left?.enabledDataTypes, right?.enabledDataTypes)
    && sameValues(left?.disabledBuiltinRuleIds, right?.disabledBuiltinRuleIds)
    && JSON.stringify(left?.customRules) === JSON.stringify(right?.customRules);
}

export function applyGuardrailsSettingsPatch(
  previous: OcxGuardrailsConfig | undefined,
  patch: GuardrailsSettingsPatch,
): OcxGuardrailsConfig | undefined {
  const next = normalizeGuardrailsConfig({ ...previous, ...patch });
  if (next.enabled === false
    && next.mode === undefined
    && next.failurePolicy === undefined
    && next.providerScope === undefined
    && next.enabledDataTypes === undefined
    && next.disabledBuiltinRuleIds === undefined
    && next.customRules === undefined
    && next.keywordPrefilterEnabled === undefined) {
    return undefined;
  }
  return next;
}

export function guardrailsApiSettings(config: OcxGuardrailsConfig | undefined): {
  configuredEnabled: boolean;
  customRuleCount: number;
  disabledBuiltinRuleIds: readonly string[];
  enabledDataTypes: readonly OcxGuardrailsDataType[];
  failurePolicy: "block" | "passthrough";
  keywordPrefilterEnabled: boolean;
  mode: "enforce" | "detect";
  providerScope: OcxGuardrailsProviderScope;
} {
  return {
    configuredEnabled: config?.enabled === true,
    mode: config?.mode ?? "enforce",
    failurePolicy: config?.failurePolicy ?? "block",
    providerScope: config?.providerScope?.mode === "selected"
      ? { mode: "selected", providerIds: [...config.providerScope.providerIds] }
      : { mode: "all" },
    enabledDataTypes: config?.enabledDataTypes ?? DATA_TYPES,
    disabledBuiltinRuleIds: config?.disabledBuiltinRuleIds ?? [],
    customRuleCount: config?.customRules?.length ?? 0,
    keywordPrefilterEnabled: config?.keywordPrefilterEnabled === true,
  };
}

/** Type-only bridge from persisted declarative rules to the RE2 runtime. */
export function guardrailsRegistryOptions(config: OcxGuardrailsConfig): GuardrailsRegistryOptions {
  const customRules: GuardrailsCustomRule[] | undefined = config.customRules?.map(rule => ({
    ...rule,
    keywords: [...rule.keywords],
    banlist: [...rule.banlist],
    validators: [...rule.validators],
    masking: { captureGroups: [...rule.masking.captureGroups], placeholderType: rule.masking.placeholderType },
  }));
  return {
    enabledDataTypes: config.enabledDataTypes,
    disabledBuiltinRuleIds: config.disabledBuiltinRuleIds,
    customRules,
    keywordPrefilterEnabled: config.keywordPrefilterEnabled,
  };
}
