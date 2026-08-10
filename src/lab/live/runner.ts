import { CL03_LIVE_SUITES } from "../conformance/types";
import { isLiveCaseApplicableToRoute, runLiveScenario, type LiveExecutorOptions } from "./executor";
import { discoverLiveScenarios, loadLiveCaseAuthority } from "./manifest";
import type { LabRouteContext, LiveScenarioRunResult } from "./types";

export interface LiveRunSummary { total: number; passed: number; failed: number; results: LiveScenarioRunResult[] }

export async function runLiveSuite(routeContext: LabRouteContext, suites: readonly string[] = CL03_LIVE_SUITES, opts: LiveExecutorOptions = {}): Promise<LiveRunSummary> {
  const authority = loadLiveCaseAuthority();
  const scenarios = discoverLiveScenarios(authority, suites).filter((scenario) => isLiveCaseApplicableToRoute(scenario, routeContext));
  const results: LiveScenarioRunResult[] = [];
  for (const scenario of scenarios) results.push(await runLiveScenario(scenario, routeContext, opts));
  const passed = results.filter((row) => row.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

export function listLiveScenarioIds(suites: readonly string[] = CL03_LIVE_SUITES): string[] {
  return discoverLiveScenarios(loadLiveCaseAuthority(), suites).map((scenario) => scenario.id);
}
