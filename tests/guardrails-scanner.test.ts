import { expect, setDefaultTimeout, test } from "bun:test";
import { createGuardrailsRegistry } from "../src/guardrails/registry";
import { scanGuardrailsText } from "../src/guardrails/scanner";
import type { GuardrailsCustomRule } from "../src/guardrails/types";

setDefaultTimeout(15_000);

test("Guardrails minLength uses UTF-8 bytes like Go len(string)", () => {
  const rule: GuardrailsCustomRule = {
    ruleId: "custom.utf8-min-length",
    name: "UTF-8 min length",
    dataType: 6,
    group: "CUSTOM",
    groupPriority: 0,
    displayName: "UTF-8 min length",
    description: "Test-only custom rule",
    regex: "(.+)",
    keywords: [],
    banlist: [],
    validators: [],
    minLength: 2,
    masking: { captureGroups: [1], placeholderType: "CUSTOM_TEST" },
  };
  const registry = createGuardrailsRegistry({ customRules: [rule] });

  try {
    expect(scanGuardrailsText(registry, "é")).toEqual([
      expect.objectContaining({ ruleId: rule.ruleId, value: "é" }),
    ]);
    expect(scanGuardrailsText(registry, "a")
      .filter(finding => finding.ruleId === rule.ruleId)).toEqual([]);
  } finally {
    registry.dispose();
  }
});
