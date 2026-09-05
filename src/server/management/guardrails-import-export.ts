import type {
  OcxGuardrailsConfig,
  OcxGuardrailsCustomRule,
  OcxGuardrailsDataType,
} from "../../types";
import {
  guardrailsApiSettings,
  parseGuardrailsConfig,
  parseGuardrailsCustomRule,
  type GuardrailsSettingsPatch,
} from "../../guardrails/config-schema";
import { createGuardrailsRegistry } from "../../guardrails/registry";

export const GUARDRAILS_BUNDLE_VERSION = 1;

export interface GuardrailsExportBundle {
  version: 1;
  settings: ReturnType<typeof guardrailsApiSettings>;
  customRules: OcxGuardrailsCustomRule[];
}

export function guardrailsExportBundle(config: OcxGuardrailsConfig | undefined): GuardrailsExportBundle {
  return {
    version: GUARDRAILS_BUNDLE_VERSION,
    settings: guardrailsApiSettings(config),
    customRules: structuredClone(config?.customRules ?? []),
  };
}

type ParsedImport = {
  mode: "merge" | "replace";
  dryRun: boolean;
  bundle: GuardrailsExportBundle;
};

export interface GuardrailsImportReport {
  mode: "merge" | "replace";
  createCount: number;
  unchangedCount: number;
  replaceCount: number;
  conflicts: string[];
  securityDiff: GuardrailsImportSecurityDiff;
}

interface GuardrailsImportValueDiff<T> {
  before: T;
  after: T;
  changed: boolean;
  weakening: boolean;
}

export interface GuardrailsImportSecurityDiff {
  weakensProtection: boolean;
  requiresReview: boolean;
  enabled: GuardrailsImportValueDiff<boolean>;
  mode: GuardrailsImportValueDiff<"enforce" | "detect">;
  failurePolicy: GuardrailsImportValueDiff<"block" | "passthrough">;
  providerScope: GuardrailsImportValueDiff<ReturnType<typeof guardrailsApiSettings>["providerScope"]> & {
    addedProviderIds: string[];
    removedProviderIds: string[];
  };
  enabledDataTypes: GuardrailsImportValueDiff<OcxGuardrailsDataType[]> & {
    added: OcxGuardrailsDataType[];
    removed: OcxGuardrailsDataType[];
  };
  disabledBuiltinRules: {
    beforeCount: number;
    afterCount: number;
    newlyDisabledCount: number;
    reenabledCount: number;
    changed: boolean;
    weakening: boolean;
  };
  customRules: {
    beforeCount: number;
    afterCount: number;
    addedCount: number;
    removedCount: number;
    changedDefinitionCount: number;
    changedRuleIds: string[];
    removedRuleIds: string[];
    changed: boolean;
    weakening: boolean;
    requiresReview: boolean;
  };
  keywordPrefilterEnabled: GuardrailsImportValueDiff<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function valueDiff<T>(
  before: T,
  after: T,
  weakening: boolean,
): GuardrailsImportValueDiff<T> {
  return {
    before,
    after,
    changed: before !== after,
    weakening,
  };
}

function securityRelevantCustomRule(rule: OcxGuardrailsCustomRule) {
  return {
    dataType: rule.dataType,
    group: rule.group,
    groupPriority: rule.groupPriority,
    regex: rule.regex,
    keywords: [...rule.keywords].sort(),
    banlist: [...rule.banlist].sort(),
    validators: [...rule.validators].sort(),
    entropy: rule.entropy,
    minLength: rule.minLength,
    masking: {
      placeholderType: rule.masking.placeholderType,
      captureGroups: [...rule.masking.captureGroups].sort((left, right) => left - right),
    },
  };
}

function securityDiff(
  current: ReturnType<typeof guardrailsApiSettings>,
  imported: ReturnType<typeof guardrailsApiSettings>,
  currentCustomRules: readonly OcxGuardrailsCustomRule[],
  importedCustomRules: readonly OcxGuardrailsCustomRule[],
): GuardrailsImportSecurityDiff {
  const beforeTypes = [...current.enabledDataTypes];
  const afterTypes = [...imported.enabledDataTypes];
  const beforeTypeSet = new Set(beforeTypes);
  const afterTypeSet = new Set(afterTypes);
  const added = afterTypes.filter(dataType => !beforeTypeSet.has(dataType));
  const removed = beforeTypes.filter(dataType => !afterTypeSet.has(dataType));
  const beforeDisabled = new Set(current.disabledBuiltinRuleIds);
  const afterDisabled = new Set(imported.disabledBuiltinRuleIds);
  const newlyDisabledCount = [...afterDisabled]
    .filter(ruleId => !beforeDisabled.has(ruleId)).length;
  const reenabledCount = [...beforeDisabled]
    .filter(ruleId => !afterDisabled.has(ruleId)).length;
  const beforeCustomRules = new Map(currentCustomRules.map(rule => [rule.ruleId, rule]));
  const afterCustomRules = new Map(importedCustomRules.map(rule => [rule.ruleId, rule]));
  const addedCustomRuleCount = [...afterCustomRules.keys()]
    .filter(ruleId => !beforeCustomRules.has(ruleId)).length;
  const removedRuleIds = [...beforeCustomRules.keys()]
    .filter(ruleId => !afterCustomRules.has(ruleId))
    .sort();
  const changedRuleIds = [...afterCustomRules]
    .filter(([ruleId, rule]) => {
      const before = beforeCustomRules.get(ruleId);
      return before !== undefined
        && JSON.stringify(securityRelevantCustomRule(before))
          !== JSON.stringify(securityRelevantCustomRule(rule));
    })
    .map(([ruleId]) => ruleId)
    .sort();
  const removedCustomRuleCount = removedRuleIds.length;
  const changedCustomRuleCount = changedRuleIds.length;
  const enabled = valueDiff(
    current.configuredEnabled,
    imported.configuredEnabled,
    current.configuredEnabled && !imported.configuredEnabled,
  );
  const mode = valueDiff(
    current.mode,
    imported.mode,
    current.mode === "enforce" && imported.mode === "detect",
  );
  const failurePolicy = valueDiff(
    current.failurePolicy,
    imported.failurePolicy,
    current.failurePolicy === "block" && imported.failurePolicy === "passthrough",
  );
  const currentProviderIds = current.providerScope.mode === "selected"
    ? current.providerScope.providerIds
    : [];
  const importedProviderIds = imported.providerScope.mode === "selected"
    ? imported.providerScope.providerIds
    : [];
  const currentProviderSet = new Set(currentProviderIds);
  const importedProviderSet = new Set(importedProviderIds);
  const addedProviderIds = importedProviderIds.filter(id => !currentProviderSet.has(id));
  const removedProviderIds = currentProviderIds.filter(id => !importedProviderSet.has(id));
  const providerScopeChanged = current.providerScope.mode !== imported.providerScope.mode
    || addedProviderIds.length > 0
    || removedProviderIds.length > 0;
  const providerScope = {
    before: current.providerScope,
    after: imported.providerScope,
    changed: providerScopeChanged,
    weakening: current.providerScope.mode === "all" && imported.providerScope.mode === "selected"
      || current.providerScope.mode === "selected"
        && imported.providerScope.mode === "selected"
        && removedProviderIds.length > 0,
    addedProviderIds,
    removedProviderIds,
  };
  const enabledDataTypes = {
    before: beforeTypes,
    after: afterTypes,
    added,
    removed,
    changed: added.length > 0 || removed.length > 0,
    weakening: removed.length > 0,
  };
  const disabledBuiltinRules = {
    beforeCount: beforeDisabled.size,
    afterCount: afterDisabled.size,
    newlyDisabledCount,
    reenabledCount,
    changed: newlyDisabledCount > 0 || reenabledCount > 0,
    weakening: newlyDisabledCount > 0,
  };
  const keywordPrefilterEnabled = valueDiff(
    current.keywordPrefilterEnabled,
    imported.keywordPrefilterEnabled,
    false,
  );
  const customRules = {
    beforeCount: beforeCustomRules.size,
    afterCount: afterCustomRules.size,
    addedCount: addedCustomRuleCount,
    removedCount: removedCustomRuleCount,
    changedDefinitionCount: changedCustomRuleCount,
    changedRuleIds,
    removedRuleIds,
    changed: addedCustomRuleCount > 0
      || removedCustomRuleCount > 0
      || changedCustomRuleCount > 0,
    weakening: removedCustomRuleCount > 0,
    requiresReview: changedCustomRuleCount > 0,
  };
  const weakensProtection = [
      enabled.weakening,
      mode.weakening,
      failurePolicy.weakening,
      providerScope.weakening,
      enabledDataTypes.weakening,
      disabledBuiltinRules.weakening,
      customRules.weakening,
      keywordPrefilterEnabled.weakening,
    ].some(Boolean);
  return {
    weakensProtection,
    requiresReview: weakensProtection || customRules.requiresReview,
    enabled,
    mode,
    failurePolicy,
    providerScope,
    enabledDataTypes,
    disabledBuiltinRules,
    customRules,
    keywordPrefilterEnabled,
  };
}

function parseBundle(value: unknown): { ok: true; bundle: GuardrailsExportBundle } | { ok: false; error: string } {
  if (!isRecord(value)
    || Object.keys(value).some(key => !["version", "settings", "customRules"].includes(key))
    || value.version !== GUARDRAILS_BUNDLE_VERSION
    || !isRecord(value.settings)
    || !Array.isArray(value.customRules)) {
    return { ok: false, error: "invalid Guardrails import bundle" };
  }
  const settingsKeys = new Set([
    "configuredEnabled",
    "mode",
    "failurePolicy",
    "providerScope",
    "enabledDataTypes",
    "disabledBuiltinRuleIds",
    "customRuleCount",
    "keywordPrefilterEnabled",
  ]);
  if (Object.keys(value.settings).some(key => !settingsKeys.has(key))) {
    return { ok: false, error: "Guardrails import settings contain an unsupported field" };
  }
  const requiredSettingsKeys = [...settingsKeys].filter(key => key !== "providerScope");
  if (requiredSettingsKeys.some(key => !Object.prototype.hasOwnProperty.call(value.settings, key))) {
    return { ok: false, error: "Guardrails import settings are incomplete" };
  }
  const parsedSettings = parseGuardrailsConfig({
    enabled: value.settings.configuredEnabled,
    mode: value.settings.mode,
    failurePolicy: value.settings.failurePolicy,
    providerScope: value.settings.providerScope ?? { mode: "all" },
    enabledDataTypes: value.settings.enabledDataTypes,
    disabledBuiltinRuleIds: value.settings.disabledBuiltinRuleIds,
    keywordPrefilterEnabled: value.settings.keywordPrefilterEnabled,
  });
  if (!parsedSettings.ok) return { ok: false, error: parsedSettings.error };
  const customRules: OcxGuardrailsCustomRule[] = [];
  for (const rawRule of value.customRules) {
    const parsedRule = parseGuardrailsCustomRule(rawRule);
    if (!parsedRule.ok) return { ok: false, error: parsedRule.error };
    customRules.push(parsedRule.rule);
  }
  if (value.settings.customRuleCount !== customRules.length) {
    return { ok: false, error: "Guardrails import customRuleCount does not match customRules" };
  }
  const complete = parseGuardrailsConfig({ ...parsedSettings.config, customRules });
  if (!complete.ok) return { ok: false, error: complete.error };
  return {
    ok: true,
    bundle: {
      version: GUARDRAILS_BUNDLE_VERSION,
      settings: guardrailsApiSettings(complete.config),
      customRules,
    },
  };
}

export function parseGuardrailsImport(value: unknown): { ok: true; request: ParsedImport } | {
  ok: false;
  error: string;
} {
  if (!isRecord(value)
    || Object.keys(value).some(key => !["mode", "dryRun", "bundle"].includes(key))
    || (value.mode !== "merge" && value.mode !== "replace")
    || typeof value.dryRun !== "boolean") {
    return { ok: false, error: "import requires mode, dryRun, and bundle" };
  }
  const bundle = parseBundle(value.bundle);
  return bundle.ok
    ? { ok: true, request: { mode: value.mode, dryRun: value.dryRun, bundle: bundle.bundle } }
    : bundle;
}

export function prepareGuardrailsImport(
  current: OcxGuardrailsConfig | undefined,
  request: ParsedImport,
): {
  ok: true;
  patch: GuardrailsSettingsPatch;
  report: GuardrailsImportReport;
} | {
  ok: false;
  error: string;
  conflicts?: string[];
  report?: GuardrailsImportReport;
} {
  const incoming = request.bundle.customRules;
  const existing = current?.customRules ?? [];
  const existingById = new Map(existing.map(rule => [rule.ruleId, rule]));
  const conflicts: string[] = [];
  let createCount = 0;
  let unchangedCount = 0;
  let replaceCount = 0;
  let customRules: OcxGuardrailsCustomRule[];
  const importedSettings = request.mode === "merge"
    ? guardrailsApiSettings(current)
    : request.bundle.settings;

  if (request.mode === "replace") {
    customRules = incoming;
    createCount = incoming.filter(rule => !existingById.has(rule.ruleId)).length;
    replaceCount = incoming.length - createCount;
  } else {
    customRules = [...existing];
    for (const rule of incoming) {
      const prior = existingById.get(rule.ruleId);
      if (!prior) {
        customRules.push(rule);
        createCount += 1;
      } else if (JSON.stringify(prior) === JSON.stringify(rule)) {
        unchangedCount += 1;
      } else {
        conflicts.push(rule.ruleId);
      }
    }
  }
  const report: GuardrailsImportReport = {
    mode: request.mode,
    createCount,
    unchangedCount,
    replaceCount,
    conflicts,
    securityDiff: securityDiff(
      guardrailsApiSettings(current),
      importedSettings,
      existing,
      customRules,
    ),
  };
  if (conflicts.length > 0) {
    return {
      ok: false,
      error: "Guardrails import has conflicting custom rule IDs",
      conflicts,
      report,
    };
  }

  const settings: OcxGuardrailsConfig = {
    enabled: importedSettings.configuredEnabled,
    mode: importedSettings.mode,
    failurePolicy: importedSettings.failurePolicy,
    providerScope: structuredClone(importedSettings.providerScope),
    enabledDataTypes: [...importedSettings.enabledDataTypes],
    disabledBuiltinRuleIds: [...importedSettings.disabledBuiltinRuleIds],
    keywordPrefilterEnabled: importedSettings.keywordPrefilterEnabled,
    customRules,
  };
  const parsed = parseGuardrailsConfig(settings);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const registry = createGuardrailsRegistry({
    enabledDataTypes: parsed.config.enabledDataTypes,
    disabledBuiltinRuleIds: parsed.config.disabledBuiltinRuleIds,
    customRules: parsed.config.customRules,
    keywordPrefilterEnabled: parsed.config.keywordPrefilterEnabled,
  });
  registry.dispose();
  return {
    ok: true,
    patch: parsed.config,
    report,
  };
}
