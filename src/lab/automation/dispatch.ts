import { loadCaseAuthority } from "../conformance/manifest";
import { runScenario } from "../conformance/executor";
import { persistConformanceResult } from "../observe/from-conformance";
import { loadLiveCaseAuthority } from "../live/manifest";
import { runLiveScenario } from "../live/executor";
import { persistLiveResult } from "../observe/from-live";
import { rebuildLabProjection } from "../projection/rebuild";
import { resolvePolicyCompatibilitySubjects } from "../../routing/compatibility/subject";
import type { OcxConfig } from "../../types";
import type { AutomationDispatchDeps, LabAutomationRunRecordV1 } from "./types";
import { LabAutomationError } from "./types";
import { buildAutomationLiveRouteContext } from "./route-context";

export interface DispatchResult {
  terminalState: "completed" | "blocked" | "failed";
  terminalCode: string;
  liveRequest: boolean;
}

/** Closed dispatcher to existing CL-01 / CL-03 / CL-07 producers. */
export async function dispatchLabAutomationRun(
  run: LabAutomationRunRecordV1,
  deps: AutomationDispatchDeps,
): Promise<DispatchResult> {
  const configDir = deps.configDir;
  switch (run.evidenceLayer) {
    case "protocol_conformance": {
      if (deps.abortSignal?.aborted) {
        throw new LabAutomationError("cancelled", "cancelled");
      }
      const authority = loadCaseAuthority();
      const caseRecord = authority.cases.find((row) => row.id === run.scenarioId);
      if (!caseRecord) {
        throw new LabAutomationError("missing protocol scenario", "dispatch_failure");
      }
      const result = await runScenario(caseRecord);
      if (deps.abortSignal?.aborted) {
        throw new LabAutomationError("cancelled", "cancelled");
      }
      persistConformanceResult(result, caseRecord, authority, { configDir });
      rebuildLabProjection(configDir);
      return {
        terminalState: result.passed ? "completed" : "failed",
        terminalCode: result.passed ? "pass" : "protocol_fail",
        liveRequest: false,
      };
    }
    case "live_route_compatibility": {
      if (!deps.routeExecutor) {
        return { terminalState: "blocked", terminalCode: "route_ineligible", liveRequest: false };
      }
      if (!deps.loadConfig || !run.providerName || !run.modelId) {
        throw new LabAutomationError("live dispatch requires route configuration", "dispatch_failure");
      }
      const config = deps.loadConfig();
      const routed = config.providers?.[run.providerName];
      if (!routed) {
        return { terminalState: "blocked", terminalCode: "route_ineligible", liveRequest: false };
      }
      const resolved = resolvePolicyCompatibilitySubjects(
        config,
        run.providerName,
        run.modelId,
        routed,
        configDir,
      );
      if (!resolved.route) {
        return { terminalState: "blocked", terminalCode: "route_ineligible", liveRequest: false };
      }
      const authority = loadLiveCaseAuthority();
      const caseRecord = authority.cases.find((row) => row.id === run.scenarioId);
      if (!caseRecord) {
        throw new LabAutomationError("missing live scenario", "dispatch_failure");
      }
      const routeContext = buildAutomationLiveRouteContext(
        resolved.route,
        routed.allowPrivateNetwork === true,
      );
      const result = await runLiveScenario(caseRecord, routeContext, {
        configDir,
        routeExecutor: deps.routeExecutor,
        cancelSignal: deps.abortSignal,
        resolve: deps.resolve,
      });
      if (result.executionAuthority === "trusted_route") {
        persistLiveResult(result, caseRecord, authority, { configDir });
        rebuildLabProjection(configDir);
      }
      const blocked = result.classification === "authentication_blocked"
        || result.classification === "quota_blocked"
        || result.classification === "region_blocked";
      return {
        terminalState: result.passed ? "completed" : blocked ? "blocked" : "failed",
        terminalCode: result.secondaryCode ?? result.classification,
        liveRequest: true,
      };
    }
    case "task_effectiveness":
      throw new LabAutomationError("task_effectiveness background execution is not enabled", "task_background_disabled");
    default:
      throw new LabAutomationError(`unsupported evidence layer ${run.evidenceLayer as string}`, "dispatch_failure");
  }
}
