import type { OcxConfig } from "../../types";
import { ANTHROPIC_NATIVE_PROVIDER_ID } from "../../config/provider-name";
import { guardrailsApiSettings } from "../../guardrails/config-schema";
import { guardrailsBuiltinRuleCatalog } from "../../guardrails/registry";
import {
  guardrailsPolicyRevision,
  guardrailsRuntimeSnapshot,
} from "../../guardrails/runtime";
import { guardrailsTelemetryOverview } from "../../guardrails/telemetry";

function guardrailsProviderOptions(config: OcxConfig) {
  const selected = config.guardrails?.providerScope?.mode === "selected"
    ? config.guardrails.providerScope.providerIds
    : [];
  const providerIds = new Set([
    ...Object.keys(config.providers),
    ...selected,
    ANTHROPIC_NATIVE_PROVIDER_ID,
  ]);
  return [...providerIds]
    .sort((left, right) => left.localeCompare(right))
    .map(id => {
      const configured = Object.hasOwn(config.providers, id);
      return {
        id,
        kind: id === ANTHROPIC_NATIVE_PROVIDER_ID ? "native" as const : "configured" as const,
        configured: configured || id === ANTHROPIC_NATIVE_PROVIDER_ID,
        disabled: configured ? config.providers[id]?.disabled === true : false,
      };
    });
}

export function guardrailsSettingsDto(config: OcxConfig) {
  return {
    enabled: config.guardrails?.enabled === true,
    ...guardrailsApiSettings(config.guardrails),
    providerOptions: guardrailsProviderOptions(config),
    revision: guardrailsPolicyRevision(config.guardrails ?? {}),
    activation: {
      status: config.guardrails?.enabled === true ? "active" as const : "disabled" as const,
    },
  };
}

export function guardrailsRulesDto(config: OcxConfig) {
  const enabledDataTypes = new Set(config.guardrails?.enabledDataTypes ?? [1, 2, 3, 4, 5, 6]);
  const disabledBuiltin = new Set(config.guardrails?.disabledBuiltinRuleIds ?? []);
  const builtinRules = guardrailsBuiltinRuleCatalog().map(rule => ({
    ...rule,
    enabled: enabledDataTypes.has(rule.dataType) && !disabledBuiltin.has(rule.ruleId),
    custom: false as const,
  }));
  const customRules = structuredClone(config.guardrails?.customRules ?? []);
  const customSummaries = customRules.map(rule => ({
    ruleId: rule.ruleId,
    dataType: rule.dataType,
    group: rule.group,
    displayName: rule.displayName,
    description: rule.description,
    source: "custom" as const,
    enabled: enabledDataTypes.has(rule.dataType),
    custom: true as const,
  }));
  return {
    revision: guardrailsPolicyRevision(config.guardrails ?? {}),
    rules: [...builtinRules, ...customSummaries],
    builtinRuleCount: builtinRules.length,
    customRuleCount: customRules.length,
    customRules,
  };
}

function registryHealth(config: OcxConfig) {
  if (config.guardrails?.enabled !== true) {
    return {
      status: "disabled" as const,
      generation: null,
      policyRevision: guardrailsPolicyRevision(config.guardrails ?? {}),
      effectiveRuleCount: 0,
    };
  }
  try {
    const snapshot = guardrailsRuntimeSnapshot(config);
    return {
      status: "ready" as const,
      generation: snapshot?.generation ?? null,
      policyRevision: snapshot?.policyRevision ?? guardrailsPolicyRevision(config.guardrails),
      effectiveRuleCount: snapshot?.registry.rules.length ?? 0,
    };
  } catch {
    return {
      status: "failed" as const,
      generation: null,
      policyRevision: guardrailsPolicyRevision(config.guardrails),
      effectiveRuleCount: 0,
    };
  }
}

export type GuardrailsTrafficProtection =
  | "disabled"
  | "unavailable"
  | "no-rules"
  | "no-provider-coverage"
  | "detect"
  | "reduced"
  | "enforce";

function hasEffectiveProviderCoverage(config: OcxConfig): boolean {
  const scope = config.guardrails?.providerScope;
  if (scope?.mode !== "selected") return true;
  return scope.providerIds.some(id =>
    id === ANTHROPIC_NATIVE_PROVIDER_ID
    || (
      Object.hasOwn(config.providers, id)
      && config.providers[id]?.disabled !== true
    ));
}

export function guardrailsTrafficProtection(config: OcxConfig): GuardrailsTrafficProtection {
  if (config.guardrails?.enabled !== true) return "disabled";
  const registry = registryHealth(config);
  if (registry.status !== "ready") return "unavailable";
  if (registry.effectiveRuleCount <= 0) return "no-rules";
  if (!hasEffectiveProviderCoverage(config)) return "no-provider-coverage";
  if (config.guardrails.mode === "detect") return "detect";
  if (
    (config.guardrails.enabledDataTypes?.length ?? 6) < 6
    || (config.guardrails.disabledBuiltinRuleIds?.length ?? 0) > 0
    || config.guardrails.failurePolicy === "passthrough"
    || config.guardrails.providerScope?.mode === "selected"
  ) {
    return "reduced";
  }
  return "enforce";
}

export function guardrailsOverviewDto(config: OcxConfig) {
  return {
    ...guardrailsSettingsDto(config),
    registry: registryHealth(config),
    ruleSummary: {
      total: guardrailsBuiltinRuleCatalog().length + (config.guardrails?.customRules?.length ?? 0),
      builtin: guardrailsBuiltinRuleCatalog().length,
      custom: config.guardrails?.customRules?.length ?? 0,
    },
    overview: guardrailsTelemetryOverview(),
  };
}
