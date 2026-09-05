import { expect, setDefaultTimeout, test } from "bun:test";
import {
  createBuiltinGuardrailsRegistry,
  scanGuardrailsText,
} from "../src/guardrails";
import type { GuardrailsRegistry } from "../src/guardrails/types";

setDefaultTimeout(15_000);

interface DonorRuleCase {
  name: string;
  ruleId: string;
  input: string;
  wantFullText: string;
}

interface DonorRuleFixture {
  version: 1;
  source: {
    repository: string;
    commit: string;
    path: string;
    sha256: string;
    license: "Apache-2.0";
    transform: string;
  };
  cases: DonorRuleCase[];
}

test("all 266 built-in rules match their provenance-bound donor fixtures", async () => {
  const fixture = await Bun.file(
    new URL("./fixtures/guardrails-donor-rule-cases.json", import.meta.url),
  ).json() as DonorRuleFixture;
  expect(fixture).toMatchObject({
    version: 1,
    source: {
      repository: "https://github.com/cloud-ru-tech/guardrails-llm-filter",
      commit: "bbd6f27467a53ff3869b59449edf4209f85ae675",
      path: "tests/rules/rules_cases_test.go",
      sha256: "b7eae600c5a1658a69f948ab355cbc25f2b48bdc9f64d3ad3793115711d91214",
      license: "Apache-2.0",
    },
  });
  expect(fixture.cases).toHaveLength(277);

  const registry = createBuiltinGuardrailsRegistry();
  try {
    const rulesById = new Map(
      registry.rules
        .filter(rule => rule.source !== "opencodex")
        .map(rule => [rule.ruleId, rule]),
    );
    expect(rulesById.size).toBe(266);
    expect(new Set(fixture.cases.map(item => item.ruleId)).size).toBe(266);

    for (const donorCase of fixture.cases) {
      const rule = rulesById.get(donorCase.ruleId);
      expect(rule, donorCase.name).toBeDefined();
      const isolated: GuardrailsRegistry = {
        // The donor table exercises regex/capture parity with intentionally
        // repetitive synthetic values. Runtime entropy/banlist behavior has
        // separate coverage in guardrails-registry.test.ts.
        rules: [{
          ...rule!,
          validators: rule!.validators.filter(
            validator => validator !== "entropy" && validator !== "banlist",
          ),
        }],
        groups: registry.groups.filter(group => group.dataType === rule!.dataType),
        keywordPrefilterEnabled: false,
        dispose() {},
      };
      const findings = scanGuardrailsText(isolated, donorCase.input);
      expect(findings, donorCase.name).toHaveLength(1);
      expect(findings[0], donorCase.name).toMatchObject({
        ruleId: donorCase.ruleId,
        dataType: rule!.dataType,
        placeholderType: rule!.masking.placeholderType,
        value: donorCase.wantFullText,
      });
      expect(
        donorCase.input.slice(findings[0]!.start, findings[0]!.end),
        donorCase.name,
      ).toBe(donorCase.wantFullText);
    }
  } finally {
    registry.dispose();
  }
});
