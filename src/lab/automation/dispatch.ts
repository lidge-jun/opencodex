import { subjectIdForSubject, scenarioManifestDigest } from "../digest";
import { expandScenario, loadCaseAuthority } from "../conformance/manifest";
import { resolveProtocolExecutionContext, runScenario } from "../conformance/executor";
import { buildProtocolSubjectV1 } from "../subject/protocol-subject";
import { suiteManifestDigestForCase } from "../conformance/suite-manifest";
import { persistConformanceResult } from "../observe/from-conformance";
import { expandLiveScenario, loadLiveCaseAuthority } from "../live/manifest";
import { runLiveScenario } from "../live/executor";
import { liveSuiteManifestDigestForCase } from "../live/suite-manifest";
import { persistLiveResult } from "../observe/from-live";
import { rebuildLabProjection } from "../projection/rebuild";
import { resolvePolicyCompatibilitySubjects } from "../../routing/compatibility/subject";
import type { AutomationDispatchDeps, LabAutomationRunRecordV1 } from "./types";
import { LabAutomationError } from "./types";
import { buildAutomationLiveRouteContext } from "./route-context";
import {
  buildLabAutomationRunKey,
  liveExecutionContractDigest,
  protocolExecutionContractDigest,
} from "./run-key";

export interface DispatchResult {
  terminalState: "completed" | "blocked" | "failed";
  terminalCode: string;
  cooldownCode: string;
  liveRequest: boolean;
}

interface ExpectedRunIdentity {
  runKey: string;
  subjectId: string;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  scenarioId: string;
  scenarioVersion: string;
  scenarioManifestDigest: string;
}

function runIdentityMatches(run: LabAutomationRunRecordV1, expected: ExpectedRunIdentity): boolean {
  return run.runKey === expected.runKey
    && run.subjectId === expected.subjectId
    && run.suiteId === expected.suiteId
    && run.suiteVersion === expected.suiteVersion
    && run.suiteManifestDigest === expected.suiteManifestDigest
    && run.scenarioId === expected.scenarioId
    && run.scenarioVersion === expected.scenarioVersion
    && run.scenarioManifestDigest === expected.scenarioManifestDigest;
}

function shouldEnforceRunIdentity(run: LabAutomationRunRecordV1, deps: AutomationDispatchDeps): boolean {
  // Production orchestration always sets the explicit guard. Canonical planned run keys also
  // self-identify here so direct internal callers cannot accidentally bypass revalidation.
  return deps.enforceRunIdentity === true || /^[0-9a-f]{64}$/i.test(run.runKey);
}

function contractChanged(): DispatchResult {
  return {
    terminalState: "blocked",
    terminalCode: "run_contract_changed",
    cooldownCode: "run_contract_changed",
    liveRequest: false,
  };
}

function routeIneligible(): DispatchResult {
  return {
    terminalState: "blocked",
    terminalCode: "route_ineligible",
    cooldownCode: "route_ineligible",
    liveRequest: false,
  };
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LabAutomationError("cancelled", "cancelled");
}

/** Closed dispatcher to existing CL-01 / CL-03 / CL-07 producers. */
export async function dispatchLabAutomationRun(
  run: LabAutomationRunRecordV1,
  deps: AutomationDispatchDeps,
): Promise<DispatchResult> {
  const configDir = deps.configDir;
  switch (run.evidenceLayer) {
    case "protocol_conformance": {
      assertNotCancelled(deps.abortSignal);
      const authority = loadCaseAuthority();
      const caseRecord = authority.cases.find((row) => row.id === run.scenarioId);
      if (!caseRecord) {
        throw new LabAutomationError("missing protocol scenario", "dispatch_failure");
      }
      const executionContext = resolveProtocolExecutionContext(caseRecord);
      const subject = buildProtocolSubjectV1(executionContext);
      const subjectId = subjectIdForSubject(subject);
      const scenarioDigest = scenarioManifestDigest(expandScenario(caseRecord, authority));
      const suiteDigest = suiteManifestDigestForCase(caseRecord, authority);
      const suiteVersion = authority.manifestDefaults.suiteVersion;
      const scenarioVersion = authority.manifestDefaults.version;
      const expected: ExpectedRunIdentity = {
        runKey: buildLabAutomationRunKey({
          evidenceLayer: "protocol_conformance",
          subjectId,
          suiteId: caseRecord.suite,
          suiteVersion,
          suiteManifestDigest: suiteDigest,
          scenarioId: caseRecord.id,
          scenarioVersion,
          scenarioManifestDigest: scenarioDigest,
          executionContractDigest: protocolExecutionContractDigest(),
        }),
        subjectId,
        suiteId: caseRecord.suite,
        suiteVersion,
        suiteManifestDigest: suiteDigest,
        scenarioId: caseRecord.id,
        scenarioVersion,
        scenarioManifestDigest: scenarioDigest,
      };
      if (shouldEnforceRunIdentity(run, deps) && !runIdentityMatches(run, expected)) return contractChanged();
      const result = await runScenario(caseRecord);
      assertNotCancelled(deps.abortSignal);
      persistConformanceResult(result, caseRecord, authority, { configDir });
      rebuildLabProjection(configDir);
      return {
        terminalState: result.passed ? "completed" : "failed",
        terminalCode: result.passed ? "pass" : "protocol_fail",
        cooldownCode: result.passed ? "pass" : "protocol_failure",
        liveRequest: false,
      };
    }
    case "live_route_compatibility": {
      assertNotCancelled(deps.abortSignal);
      if (!deps.routeExecutor) return routeIneligible();
      if (!deps.loadConfig || !run.providerName || !run.modelId) {
        throw new LabAutomationError("live dispatch requires route configuration", "dispatch_failure");
      }
      const config = deps.loadConfig();
      const routed = config.providers?.[run.providerName];
      if (!routed) return routeIneligible();
      const resolved = resolvePolicyCompatibilitySubjects(
        config,
        run.providerName,
        run.modelId,
        routed,
        configDir,
      );
      if (!resolved.route) return routeIneligible();
      const authority = loadLiveCaseAuthority();
      const caseRecord = authority.cases.find((row) => row.id === run.scenarioId);
      if (!caseRecord) {
        throw new LabAutomationError("missing live scenario", "dispatch_failure");
      }
      const scenarioDigest = scenarioManifestDigest(expandLiveScenario(caseRecord, authority));
      const suiteDigest = liveSuiteManifestDigestForCase(caseRecord, authority);
      const suiteVersion = authority.manifestDefaults.suiteVersion;
      const scenarioVersion = authority.manifestDefaults.version;
      const subjectId = resolved.route.subjectId;
      const expected: ExpectedRunIdentity = {
        runKey: buildLabAutomationRunKey({
          evidenceLayer: "live_route_compatibility",
          subjectId,
          suiteId: caseRecord.suite,
          suiteVersion,
          suiteManifestDigest: suiteDigest,
          scenarioId: caseRecord.id,
          scenarioVersion,
          scenarioManifestDigest: scenarioDigest,
          executionContractDigest: liveExecutionContractDigest(),
        }),
        subjectId,
        suiteId: caseRecord.suite,
        suiteVersion,
        suiteManifestDigest: suiteDigest,
        scenarioId: caseRecord.id,
        scenarioVersion,
        scenarioManifestDigest: scenarioDigest,
      };
      if (shouldEnforceRunIdentity(run, deps) && !runIdentityMatches(run, expected)) return contractChanged();
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
      // Cancellation is orchestration state. Never mint canonical evidence after an abort.
      assertNotCancelled(deps.abortSignal);
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
        cooldownCode: result.classification,
        liveRequest: true,
      };
    }
    case "task_effectiveness":
      throw new LabAutomationError("task_effectiveness background execution is not enabled", "task_background_disabled");
    default:
      throw new LabAutomationError(`unsupported evidence layer ${run.evidenceLayer as string}`, "dispatch_failure");
  }
}
