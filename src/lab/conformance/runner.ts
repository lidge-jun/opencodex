import { discoverScenarios, loadCaseAuthority } from "./manifest";
import { runScenario } from "./executor";
import { baseCaseForNegativeControl, buildNegativeControls } from "./negative-controls";
import type { CaseRecord, ScenarioRunResult } from "./types";
import { CL01_SUITES } from "./types";

export interface ConformanceRunSummary {
  /** Number of scenarios executed. */
  total: number;
  /** Number of scenarios that met their expected outcome. */
  passed: number;
  /** Number of scenarios that did not meet their expected outcome. */
  failed: number;
  results: ScenarioRunResult[];
}

export interface NegativeControlRunSummary extends ConformanceRunSummary {
  /** Number of deliberately defective controls correctly rejected by the harness. */
  rejected: number;
}

type ScenarioRunner = (caseRecord: CaseRecord) => Promise<ScenarioRunResult>;

export async function runConformanceSuite(
  suites: readonly string[] = CL01_SUITES,
): Promise<ConformanceRunSummary> {
  const authority = loadCaseAuthority();
  const scenarios = discoverScenarios(authority, suites);
  if (scenarios.length === 0) throw new Error("harness_failure: no CL-01 scenarios discovered");
  const results: ScenarioRunResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }
  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

export async function runNegativeControls(
  execute: ScenarioRunner = runScenario,
): Promise<NegativeControlRunSummary> {
  const authority = loadCaseAuthority();
  const scenarios = buildNegativeControls(discoverScenarios(authority));
  if (scenarios.length === 0) throw new Error("harness_failure: no negative controls discovered");
  const results: ScenarioRunResult[] = [];
  for (const scenario of scenarios) {
    const baseCase = baseCaseForNegativeControl(scenario.id, authority.cases);
    const executionScenario = baseCase ? { ...scenario, id: baseCase.id } : scenario;
    const result = await execute(executionScenario);
    results.push({ ...result, scenarioId: scenario.id });
  }
  const rejected = results.filter((r) => (
    !r.passed
    && r.classification === "protocol_failure"
    && r.secondaryCode === "deterministic_assertion"
  )).length;
  return {
    total: results.length,
    passed: rejected,
    rejected,
    failed: results.length - rejected,
    results,
  };
}

export function listScenarioIds(suites: readonly string[] = CL01_SUITES): string[] {
  const authority = loadCaseAuthority();
  return discoverScenarios(authority, suites).map((s) => s.id);
}
