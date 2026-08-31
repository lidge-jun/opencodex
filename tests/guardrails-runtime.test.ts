import { expect, test } from "bun:test";
import { compileGuardrailsRuntimeSnapshot, leaseGuardrailsRuntimeSnapshot, publishGuardrailsRuntimeSnapshot } from "../src/guardrails/runtime";
import { scanGuardrailsText } from "../src/guardrails/scanner";
import type { OcxConfig, OcxGuardrailsConfig } from "../src/types";

function guardrailsConfig(): OcxGuardrailsConfig {
  return {
    enabled: true,
    customRules: [{
      ruleId: "test.runtime-lease",
      name: "Runtime lease test",
      dataType: 5,
      displayName: "Runtime lease test",
      description: "Test-only custom matcher",
      regex: "sk_live_[A-Za-z0-9]+",
      keywords: [],
      banlist: [],
      validators: [],
      masking: { captureGroups: [], placeholderType: "TEST_TOKEN" },
    }],
  };
}

test("an active snapshot retains custom RE2 matchers across a hot reload", () => {
  const config = { guardrails: guardrailsConfig() } as OcxConfig;
  const initial = compileGuardrailsRuntimeSnapshot(config.guardrails!);
  publishGuardrailsRuntimeSnapshot(config, initial);
  const lease = leaseGuardrailsRuntimeSnapshot(config);
  expect(lease).toBeDefined();

  const replacement = compileGuardrailsRuntimeSnapshot(guardrailsConfig());
  publishGuardrailsRuntimeSnapshot(config, replacement);

  expect(scanGuardrailsText(lease!.snapshot.registry, "sk_live_abcdefghijklmnopqrstuvwx")).toHaveLength(1);
  lease!.release();
  publishGuardrailsRuntimeSnapshot(config, undefined);
});
