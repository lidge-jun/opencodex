import { describe, expect, test } from "bun:test";
import { runScenario } from "../src/lab/conformance/executor";
import { NEGATIVE_CONTROL_FIXTURES } from "../src/lab/conformance/negative-controls";
import { runNegativeControls } from "../src/lab/conformance/runner";

function unexpectedNegativeControlResults(
  results: Awaited<ReturnType<typeof runNegativeControls>>["results"],
): string[] {
  return results
    .filter((result) => (
      result.passed
      || result.classification !== "protocol_failure"
      || result.secondaryCode !== "deterministic_assertion"
    ))
    .map((result) => (
      `${result.scenarioId}: ${result.classification}/${result.secondaryCode ?? "none"}`
      + (result.diagnostics.length > 0 ? ` ${result.diagnostics.join(";")}` : "")
    ));
}

describe("CL-01 negative-control failure accounting", () => {
  test("does not count harness failures as rejected negative controls", async () => {
    let injected = false;
    const summary = await runNegativeControls(async (scenario) => {
      const result = await runScenario(scenario);
      if (injected) return result;
      injected = true;
      return {
        ...result,
        passed: false,
        classification: "harness_failure",
        secondaryCode: "execution_error",
        assertionResults: [],
        diagnostics: ["synthetic harness failure"],
      };
    });

    expect(summary.total).toBe(NEGATIVE_CONTROL_FIXTURES.length);
    expect(summary.rejected).toBe(summary.total - 1);
    expect(summary.passed).toBe(summary.rejected);
    expect(summary.failed).toBe(1);
    expect(summary.results.filter((result) => result.classification === "harness_failure")).toHaveLength(1);
  }, 120000);

  test("counts deterministic protocol failures as rejected negative controls", async () => {
    const summary = await runNegativeControls();

    expect(summary.total).toBe(NEGATIVE_CONTROL_FIXTURES.length);
    expect(unexpectedNegativeControlResults(summary.results)).toEqual([]);
    expect(summary.rejected).toBe(summary.total);
    expect(summary.failed).toBe(0);
  }, 120000);
});
