export type GuardrailsMode = "detect" | "enforce";
export type GuardrailsFailurePolicy = "block" | "passthrough";
export type GuardrailsDataType = 1 | 2 | 3 | 4 | 5 | 6;
export type GuardrailsProviderScope =
  | { mode: "all" }
  | { mode: "selected"; providerIds: string[] };
export type GuardrailsTrafficProtection =
  | "unknown"
  | "disabled"
  | "unavailable"
  | "no-rules"
  | "no-provider-coverage"
  | "detect"
  | "reduced"
  | "enforce";
export type GuardrailsSurface = "responses" | "chat" | "messages" | "compact";
export type GuardrailsResult =
  | "scanned"
  | "masked"
  | "detected"
  | "blocked"
  | "passthrough"
  | "demask_warning"
  | "tool_argument_restore_skipped";

export interface GuardrailsSettings {
  activation: { status: "active" | "disabled" };
  configuredEnabled: boolean;
  customRuleCount: number;
  disabledBuiltinRuleIds: string[];
  enabled: boolean;
  enabledDataTypes: GuardrailsDataType[];
  failurePolicy: GuardrailsFailurePolicy;
  keywordPrefilterEnabled: boolean;
  mode: GuardrailsMode;
  providerOptions: Array<{
    id: string;
    kind: "configured" | "native";
    configured: boolean;
    disabled: boolean;
  }>;
  providerScope: GuardrailsProviderScope;
  revision: string;
}

export const GUARDRAILS_MUTABLE_SETTING_KEYS = [
  "enabled",
  "mode",
  "failurePolicy",
  "providerScope",
  "enabledDataTypes",
  "disabledBuiltinRuleIds",
  "keywordPrefilterEnabled",
] as const satisfies readonly (keyof GuardrailsSettings)[];

export type GuardrailsSettingsPatch = Partial<Pick<
  GuardrailsSettings,
  (typeof GUARDRAILS_MUTABLE_SETTING_KEYS)[number]
>>;

export interface GuardrailsActivityEvent {
  id: number;
  timestamp: number;
  surface: GuardrailsSurface;
  mode: GuardrailsMode;
  result: GuardrailsResult;
  registryGeneration: number;
  count: number;
  categoryIds: GuardrailsDataType[];
  ruleIds: string[];
  latencyMs: number;
  severity: "info" | "warning" | "high";
}

export interface GuardrailsTelemetry {
  counters: {
    scanned: number;
    masked: number;
    detected: number;
    blocked: number;
    passthrough: number;
    demaskWarning: number;
    toolArgumentRestoreSkipped: number;
  };
  topRules: Array<{ id: string; count: number }>;
  topCategories: Array<{ id: GuardrailsDataType; count: number }>;
  recentEvents: GuardrailsActivityEvent[];
  lastPassthroughAt: number | null;
  retention: {
    kind: "in-memory";
    ttlMs: number;
    maxEvents: number;
    maxBytes: number;
    currentEvents: number;
    currentBytes: number;
    evictedEvents: number;
    oldestAt: number | null;
    lastEventAt: number | null;
  };
}

export interface GuardrailsOverview extends GuardrailsSettings {
  registry: {
    status: "disabled" | "ready" | "failed";
    generation: number | null;
    policyRevision: string;
    effectiveRuleCount: number;
  };
  ruleSummary: { total: number; builtin: number; custom: number };
  overview: GuardrailsTelemetry;
}

export interface GuardrailsRuleSummary {
  ruleId: string;
  dataType: GuardrailsDataType;
  group: string;
  displayName: string;
  description: string;
  source: "manual" | "gitleaks" | "opencodex" | "custom";
  enabled: boolean;
  custom: boolean;
}

export interface GuardrailsCustomRule {
  banlist: string[];
  dataType: GuardrailsDataType;
  description: string;
  displayName: string;
  entropy?: number;
  group: string;
  groupPriority: number;
  keywords: string[];
  masking: { captureGroups: number[]; placeholderType: string };
  minLength?: number;
  name: string;
  regex: string;
  ruleId: string;
  validators: string[];
}

export interface GuardrailsRules {
  revision: string;
  rules: GuardrailsRuleSummary[];
  builtinRuleCount: number;
  customRuleCount: number;
  customRules: GuardrailsCustomRule[];
}

export interface GuardrailsActivity extends GuardrailsTelemetry {
  events: GuardrailsActivityEvent[];
  totalMatching: number;
  filteredSummary: {
    eventCount: number;
    findingCount: number;
    averageLatencyMs: number;
    topRules: Array<{ id: string; count: number }>;
    topCategories: Array<{ id: GuardrailsDataType; count: number }>;
  };
}

export interface GuardrailsActivityFilters {
  category: GuardrailsDataType | "";
  mode: GuardrailsMode | "";
  result: GuardrailsResult | "";
  surface: GuardrailsSurface | "";
}

export interface GuardrailsImportPreview {
  ok: boolean;
  dryRun: true;
  mode: "merge" | "replace";
  createCount: number;
  unchangedCount: number;
  replaceCount: number;
  conflicts: string[];
  securityDiff: GuardrailsImportSecurityDiff;
  error?: string;
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
  mode: GuardrailsImportValueDiff<GuardrailsMode>;
  failurePolicy: GuardrailsImportValueDiff<GuardrailsFailurePolicy>;
  providerScope: GuardrailsImportValueDiff<GuardrailsProviderScope> & {
    addedProviderIds: string[];
    removedProviderIds: string[];
  };
  enabledDataTypes: GuardrailsImportValueDiff<GuardrailsDataType[]> & {
    added: GuardrailsDataType[];
    removed: GuardrailsDataType[];
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

export interface GuardrailsTesterResult {
  mode: "effective" | "draft";
  simulation: true;
  trafficProtection: Exclude<GuardrailsTrafficProtection, "unknown">;
  maskedPreview: string;
  findingCount: number;
  findings: Array<{
    start: number;
    end: number;
    ruleId: string;
    dataType: GuardrailsDataType;
    placeholderType: string;
    placeholder: string | null;
  }>;
}
