import { expect, test } from "bun:test";
import {
  createGuardrailsPlaceholderState,
  demaskGuardrailsTextWithDiagnosticsForTests,
} from "../src/guardrails/placeholders";

test("placeholder tokenizer work scales linearly on adversarial unterminated input", () => {
  const samples = [64, 128, 256, 512].map(kib => "<".repeat(kib * 1024));
  const operations = samples.map(input => {
    const result = demaskGuardrailsTextWithDiagnosticsForTests(
      input,
      createGuardrailsPlaceholderState(),
    );
    expect(result.text).toBe(input);
    expect(result.diagnostics.maxCandidateTokenLength).toBe(0);
    return result.diagnostics.visitedCodeUnits
      + result.diagnostics.closingSearchCodeUnits;
  });

  expect(operations).toEqual(samples.map(input => input.length * 2));
});

test("repeated invalid custom-rule validation does not exhaust the RE2 WASM heap", () => {
  const iterations = 60_000;
  const script = `
    import {
      GuardrailsRuleCompileError,
      validateGuardrailsCustomRulesCompatibility,
    } from "./src/guardrails/registry.ts";

    const rule = {
      ruleId: "custom.invalid",
      name: "Invalid",
      dataType: 6,
      group: "CUSTOM",
      groupPriority: 0,
      displayName: "Invalid",
      description: "Invalid-regex stress fixture",
      regex: "(",
      keywords: [],
      banlist: [],
      validators: [],
      masking: { captureGroups: [], placeholderType: "INVALID_STRESS" },
    };
    let rejected = 0;
    for (let index = 0; index < ${iterations}; index += 1) {
      try {
        validateGuardrailsCustomRulesCompatibility([rule]);
      } catch (error) {
        if (!(error instanceof GuardrailsRuleCompileError)) throw error;
        rejected += 1;
      }
    }
    if (rejected !== ${iterations}) throw new Error("invalid rules were not rejected");
    console.log(JSON.stringify({ rejected }));
  `;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: process.cwd(),
    env: { ...process.env },
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
    rejected: iterations,
  });
});
