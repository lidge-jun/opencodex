import type { OcxConfig, OcxGuardrailsConfig, OcxGuardrailsCustomRule } from "../../types";
import {
  parseGuardrailsConfig,
  parseGuardrailsCustomRule,
} from "../../guardrails/config-schema";
import { createGuardrailsRegistry } from "../../guardrails/registry";
import { maskGuardrailsText } from "../../guardrails/placeholders";
import {
  MAX_GUARDRAILS_SCANNABLE_LEAF_BYTES,
  scanGuardrailsText,
} from "../../guardrails/scanner";
import { guardrailsTrafficProtection } from "./guardrails-dto";

export const GUARDRAILS_TESTER_MAX_TEXT_BYTES = MAX_GUARDRAILS_SCANNABLE_LEAF_BYTES;

type TesterRequest = {
  text: string;
  settings?: OcxGuardrailsConfig;
  draftRule?: OcxGuardrailsCustomRule;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseTesterRequest(value: unknown): { ok: true; request: TesterRequest } | {
  ok: false;
  error: string;
  status: number;
} {
  if (!isRecord(value)) return { ok: false, error: "tester body must be an object", status: 400 };
  if (Object.keys(value).some(key => !["text", "settings", "draftRule"].includes(key))) {
    return { ok: false, error: "tester body contains an unsupported field", status: 400 };
  }
  if (typeof value.text !== "string") return { ok: false, error: "tester text must be a string", status: 400 };
  if (Buffer.byteLength(value.text, "utf8") > GUARDRAILS_TESTER_MAX_TEXT_BYTES) {
    return { ok: false, error: "tester text exceeds 128 KiB", status: 413 };
  }
  let settings: OcxGuardrailsConfig | undefined;
  if (value.settings !== undefined) {
    const parsed = parseGuardrailsConfig(value.settings);
    if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };
    settings = parsed.config;
  }
  let draftRule: OcxGuardrailsCustomRule | undefined;
  if (value.draftRule !== undefined) {
    const parsed = parseGuardrailsCustomRule(value.draftRule);
    if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };
    draftRule = parsed.rule;
  }
  return { ok: true, request: { text: value.text, settings, draftRule } };
}

export function runGuardrailsTester(
  config: OcxConfig,
  value: unknown,
): { ok: true; result: Record<string, unknown> } | { ok: false; error: string; status: number } {
  const parsed = parseTesterRequest(value);
  if (!parsed.ok) return parsed;
  const effective = {
    ...(config.guardrails ?? {}),
    ...(parsed.request.settings ?? {}),
  };
  if (parsed.request.draftRule) {
    const current = effective.customRules ?? [];
    const index = current.findIndex(rule => rule.ruleId === parsed.request.draftRule!.ruleId);
    effective.customRules = index < 0
      ? [...current, parsed.request.draftRule]
      : current.map((rule, ruleIndex) => ruleIndex === index ? parsed.request.draftRule! : rule);
  }
  const validatedEffective = parseGuardrailsConfig(effective);
  if (!validatedEffective.ok) {
    return { ok: false, error: validatedEffective.error, status: 400 };
  }
  const registry = createGuardrailsRegistry({
    enabledDataTypes: validatedEffective.config.enabledDataTypes,
    disabledBuiltinRuleIds: validatedEffective.config.disabledBuiltinRuleIds,
    customRules: validatedEffective.config.customRules,
    keywordPrefilterEnabled: validatedEffective.config.keywordPrefilterEnabled,
  });
  try {
    const findings = scanGuardrailsText(registry, parsed.request.text);
    const masked = maskGuardrailsText(parsed.request.text, findings);
    const placeholderByFinding = new Map(
      masked.state.replacements.map(replacement => [
        `${replacement.ruleId}\u0000${replacement.original}`,
        replacement.placeholder,
      ]),
    );
    return {
      ok: true,
      result: {
        mode: parsed.request.settings || parsed.request.draftRule ? "draft" : "effective",
        simulation: true,
        trafficProtection: guardrailsTrafficProtection(config),
        maskedPreview: masked.maskedText,
        findingCount: findings.length,
        findings: findings.map(finding => ({
          start: finding.start,
          end: finding.end,
          ruleId: finding.ruleId,
          dataType: finding.dataType,
          placeholderType: finding.placeholderType,
          placeholder: placeholderByFinding.get(`${finding.ruleId}\u0000${finding.value}`) ?? null,
        })),
      },
    };
  } finally {
    registry.dispose();
  }
}
