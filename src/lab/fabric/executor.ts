import type { FailureRecordV1, RouteSubjectV1 } from "../events/types";
import { labSandboxEnvironment, rejectProxyEnvironment } from "../live/sandbox";
import type { LabDestinationV1, LabRouteContext } from "../live/types";
import { buildRouteSubjectV1 } from "../subject/route-subject";
import { isTrustedFabricPatchExecutor } from "../../lib/fabric-task-execution-authority";
import {
  FABRIC_COMPATIBILITY_VERSION,
  FABRIC_LIMITS,
  FABRIC_TASK_CLASS_ID,
  FABRIC_TASK_CLASS_VERSION,
  FABRIC_VERIFIER_ID,
  SANDBOX_PROFILE_V1,
  SYNTHETIC_AFTER_UTF8,
  SYNTHETIC_BEFORE_UTF8,
  SYNTHETIC_VALUE_PATH,
} from "./constants";
import { applySyntheticPatch, parseSyntheticPatchV1 } from "./patch";
import { fabricProducerIsolationLimits, runIsolatedFabricProducer } from "./producer-isolate";
import { assertNotUnderUserRepo, createSyntheticScratch, type ScratchTree } from "./scratch";
import {
  buildTaskSubjectV1,
  sandboxProfileDigest,
  taskFixtureDigest,
  taskSubjectId,
  verifierManifestDigest,
} from "./subject";
import type {
  FabricExecutionAuthority,
  FabricHarnessProducerKind,
  FabricTaskOutcomeV1,
  FabricTaskRunResult,
  FabricUsageV1,
  SyntheticPatchV1,
  TrustedFabricPatchExecutor,
} from "./types";
import { FabricTaskError } from "./types";
import { verifyExactTreeDiffV1 } from "./verifier";

/** Options for harness-only fabric task runs (not persistable as production evidence). */
export interface RunFabricTaskHarnessOptions {
  routeSubject: RouteSubjectV1;
  harnessKind: FabricHarnessProducerKind;
  configDir?: string;
  userRepoRoot?: string;
  sourceRefs?: string[];
  now?: () => number;
}

/** Options for authoritative route-bound fabric task execution. */
export interface RunFabricTaskForRouteOptions {
  routeContext: LabRouteContext;
  destination: LabDestinationV1;
  patchExecutor: TrustedFabricPatchExecutor;
  configDir?: string;
  userRepoRoot?: string;
  sourceRefs?: string[];
  now?: () => number;
}

/** Map a FabricTaskError into a ledger failure record. */
function failureFromError(error: FabricTaskError): FailureRecordV1 {
  return {
    class: error.code,
    code: error.code,
    retryable: error.code === "timeout" || error.code === "inactivity_timeout" || error.code === "budget_exhausted",
    attribution: error.attribution,
  };
}

/** Map a failure record to the observation outcome kind for persistence. */
function outcomeFromFailure(failure: FailureRecordV1): FabricTaskOutcomeV1["outcome"] {
  if (failure.class === "behavioral_failure") return "fail";
  if (failure.attribution === "harness") return "inconclusive";
  return "blocked";
}

/** Closed successful patch for deterministic harness injection. */
export function correctSyntheticPatch(): SyntheticPatchV1 {
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: SYNTHETIC_AFTER_UTF8 }],
  };
}

/**
 * Authoritative CL-07 route-bound fabric task execution.
 * Route identity is derived from routeContext + destination; patch production runs in an isolated child.
 */
export async function runFabricSyntheticPatchTaskForRoute(
  options: RunFabricTaskForRouteOptions,
): Promise<FabricTaskRunResult> {
  if (!isTrustedFabricPatchExecutor(options.patchExecutor)) {
    throw new FabricTaskError("untrusted fabric patch executor", "sandbox_violation", "harness");
  }
  const routeSubject = buildRouteSubjectV1(options.routeContext, options.destination, options.configDir);
  return runFabricSyntheticPatchTaskInternal({
    routeSubject,
    routeContext: options.routeContext,
    destination: options.destination,
    patchExecutor: options.patchExecutor,
    harnessKind: undefined,
    executionAuthority: "trusted_route",
    configDir: options.configDir,
    userRepoRoot: options.userRepoRoot,
    sourceRefs: options.sourceRefs,
    now: options.now,
  });
}

/** Harness-only fabric task execution; outcomes are not persistable as production evidence. */
export async function runFabricSyntheticPatchTaskHarness(
  options: RunFabricTaskHarnessOptions,
): Promise<FabricTaskRunResult> {
  return runFabricSyntheticPatchTaskInternal({
    routeSubject: options.routeSubject,
    harnessKind: options.harnessKind,
    executionAuthority: "harness",
    configDir: options.configDir,
    userRepoRoot: options.userRepoRoot,
    sourceRefs: options.sourceRefs,
    now: options.now,
  });
}

/**
 * @deprecated Use runFabricSyntheticPatchTaskHarness or runFabricSyntheticPatchTaskForRoute.
 */
export async function runFabricSyntheticPatchTask(
  options: Omit<RunFabricTaskHarnessOptions, "harnessKind"> & {
    producePatch?: never;
    harnessKind?: RunFabricTaskHarnessOptions["harnessKind"];
  },
): Promise<FabricTaskOutcomeV1> {
  const result = await runFabricSyntheticPatchTaskHarness({
    routeSubject: options.routeSubject,
    harnessKind: options.harnessKind ?? "deterministic_correct",
    configDir: options.configDir,
    userRepoRoot: options.userRepoRoot,
    sourceRefs: options.sourceRefs,
    now: options.now,
  });
  return result.outcome;
}

async function runFabricSyntheticPatchTaskInternal(input: {
  routeSubject: RouteSubjectV1;
  routeContext?: LabRouteContext;
  destination?: LabDestinationV1;
  patchExecutor?: TrustedFabricPatchExecutor;
  harnessKind?: FabricHarnessProducerKind;
  executionAuthority: FabricExecutionAuthority;
  configDir?: string;
  userRepoRoot?: string;
  sourceRefs?: string[];
  now?: () => number;
}): Promise<FabricTaskRunResult> {
  rejectProxyEnvironment();
  labSandboxEnvironment();

  const startedAt = input.now?.() ?? Date.now();
  const fixtureDigest = taskFixtureDigest();
  const verifierDigest = verifierManifestDigest();
  const sandboxDigest = sandboxProfileDigest();
  const taskSubject = buildTaskSubjectV1({
    routeSubject: input.routeSubject,
    taskFixtureDigest: fixtureDigest,
    verifierManifestDigest: verifierDigest,
    sandboxProfileDigest: sandboxDigest,
    fabricCompatibilityVersion: FABRIC_COMPATIBILITY_VERSION,
  });
  const subjectId = taskSubjectId(taskSubject);

  const usage: FabricUsageV1 = {
    inputBytes: Buffer.byteLength(SYNTHETIC_BEFORE_UTF8, "utf8"),
    outputBytes: 0,
    patchOperations: 0,
    filesTouched: 0,
    artifactBytes: 0,
    elapsedMs: 0,
    inactiveMs: 0,
  };

  let scratch: ScratchTree | undefined;
  let producerCompletedAt = startedAt;
  let lastActivityAt = startedAt;

  try {
    scratch = createSyntheticScratch(input.configDir);
    if (input.userRepoRoot) {
      assertNotUnderUserRepo(scratch.root, input.userRepoRoot);
    }

    const isolation = fabricProducerIsolationLimits();
    const inactivityTimeoutMs =
      input.harnessKind === "infinite_sync"
        ? isolation.totalTimeoutMs + 1_000
        : isolation.inactivityTimeoutMs;
    let patchRaw: unknown;
    try {
      if (input.harnessKind) {
        lastActivityAt = input.now?.() ?? Date.now();
        const isolated = await runIsolatedFabricProducer({
          harnessKind: input.harnessKind,
          scratchRoot: scratch.root,
          totalTimeoutMs: isolation.totalTimeoutMs,
          inactivityTimeoutMs,
          now: input.now,
        });
        patchRaw = isolated.patch;
        lastActivityAt = isolated.lastActivityAt;
        producerCompletedAt = input.now?.() ?? Date.now();
      } else if (input.patchExecutor && input.routeContext && input.destination) {
        lastActivityAt = input.now?.() ?? Date.now();
        const isolated = await runIsolatedFabricProducer({
          executorModulePath: input.patchExecutor.executorModulePath,
          scratchRoot: scratch.root,
          totalTimeoutMs: isolation.totalTimeoutMs,
          inactivityTimeoutMs: isolation.inactivityTimeoutMs,
          executorInput: {
            routeContext: input.routeContext,
            destination: input.destination,
            routeSubject: input.routeSubject,
            scratchRoot: scratch.root,
            reportActivity: () => undefined,
            signal: new AbortController().signal,
          },
          now: input.now,
        });
        patchRaw = isolated.patch;
        lastActivityAt = isolated.lastActivityAt;
        producerCompletedAt = input.now?.() ?? Date.now();
      } else {
        throw new FabricTaskError("fabric task run missing producer", "harness_failure", "harness");
      }
    } catch (error) {
      const completedAt = input.now?.() ?? Date.now();
      usage.elapsedMs = completedAt - startedAt;
      usage.inactiveMs = Math.max(0, completedAt - lastActivityAt);
      if (error instanceof FabricTaskError) {
        const failure = failureFromError(error);
        return {
          executionAuthority: input.executionAuthority,
          outcome: sealOutcome({
            taskSubject,
            subjectId,
            fixtureDigest,
            verifierDigest,
            sandboxDigest,
            startedAt,
            completedAt,
            usage,
            outcome: outcomeFromFailure(failure),
            verifier: infrastructureVerifier(verifierDigest, error.code),
            failure,
            sourceRefs: input.sourceRefs,
          }),
        };
      }
      throw error;
    }

    let patch;
    let applied;
    try {
      patch = parseSyntheticPatchV1(patchRaw);
      applied = applySyntheticPatch(scratch.root, patch);
    } catch (error) {
      const completedAt = input.now?.() ?? Date.now();
      usage.elapsedMs = completedAt - startedAt;
      usage.inactiveMs = Math.max(0, completedAt - lastActivityAt);
      if (error instanceof FabricTaskError) {
        const failure = failureFromError(error);
        return {
          executionAuthority: input.executionAuthority,
          outcome: sealOutcome({
            taskSubject,
            subjectId,
            fixtureDigest,
            verifierDigest,
            sandboxDigest,
            startedAt,
            completedAt,
            usage,
            outcome: outcomeFromFailure(failure),
            verifier: infrastructureVerifier(verifierDigest, error.code),
            failure,
            sourceRefs: input.sourceRefs,
          }),
        };
      }
      throw error;
    }
    usage.outputBytes = applied.bytesWritten;
    usage.patchOperations = applied.patchOperations;
    usage.filesTouched = applied.filesTouched;

    let verifier;
    try {
      verifier = verifyExactTreeDiffV1(scratch.root);
    } catch (error) {
      const completedAt = input.now?.() ?? Date.now();
      usage.elapsedMs = completedAt - startedAt;
      usage.inactiveMs = Math.max(0, completedAt - lastActivityAt);
      if (error instanceof FabricTaskError) {
        const failure = failureFromError(error);
        return {
          executionAuthority: input.executionAuthority,
          outcome: sealOutcome({
            taskSubject,
            subjectId,
            fixtureDigest,
            verifierDigest,
            sandboxDigest,
            startedAt,
            completedAt,
            usage,
            outcome: outcomeFromFailure(failure),
            verifier: infrastructureVerifier(verifierDigest, error.code),
            failure,
            sourceRefs: input.sourceRefs,
          }),
        };
      }
      throw error;
    }

    const completedAt = input.now?.() ?? Date.now();
    usage.elapsedMs = completedAt - startedAt;
    usage.inactiveMs = Math.max(0, completedAt - lastActivityAt);

    if (verifier.passed) {
      return {
        executionAuthority: input.executionAuthority,
        outcome: sealOutcome({
          taskSubject,
          subjectId,
          fixtureDigest,
          verifierDigest,
          sandboxDigest,
          startedAt,
          completedAt,
          usage,
          outcome: "pass",
          verifier,
          sourceRefs: input.sourceRefs,
        }),
      };
    }

    const failure: FailureRecordV1 = {
      class: "behavioral_failure",
      code: verifier.reason ?? "verifier_failed",
      retryable: false,
      attribution: "route",
    };
    return {
      executionAuthority: input.executionAuthority,
      outcome: sealOutcome({
        taskSubject,
        subjectId,
        fixtureDigest,
        verifierDigest,
        sandboxDigest,
        startedAt,
        completedAt,
        usage,
        outcome: "fail",
        verifier,
        failure,
        sourceRefs: input.sourceRefs,
      }),
    };
  } catch (error) {
    const completedAt = input.now?.() ?? Date.now();
    usage.elapsedMs = completedAt - startedAt;
    usage.inactiveMs = Math.max(0, completedAt - lastActivityAt);
    if (error instanceof FabricTaskError) {
      const failure = failureFromError(error);
      return {
        executionAuthority: input.executionAuthority,
        outcome: sealOutcome({
          taskSubject,
          subjectId,
          fixtureDigest,
          verifierDigest,
          sandboxDigest,
          startedAt,
          completedAt,
          usage,
          outcome: outcomeFromFailure(failure),
          verifier: infrastructureVerifier(verifierDigest, error.code),
          failure,
          sourceRefs: input.sourceRefs,
        }),
      };
    }
    const failure: FailureRecordV1 = {
      class: "harness_failure",
      code: "harness_failure",
      retryable: false,
      attribution: "harness",
    };
    return {
      executionAuthority: input.executionAuthority,
      outcome: sealOutcome({
        taskSubject,
        subjectId,
        fixtureDigest,
        verifierDigest,
        sandboxDigest,
        startedAt,
        completedAt,
        usage,
        outcome: "inconclusive",
        verifier: infrastructureVerifier(verifierDigest, "harness_failure"),
        failure,
        sourceRefs: input.sourceRefs,
      }),
    };
  } finally {
    scratch?.cleanup();
  }
}

function infrastructureVerifier(manifestDigest: string, reason: string): FabricTaskOutcomeV1["verifier"] {
  return {
    verifierId: FABRIC_VERIFIER_ID,
    manifestDigest,
    passed: false,
    pathSummaries: [],
    reason,
  };
}

/** Assemble an immutable FabricTaskOutcomeV1 from executor state. */
function sealOutcome(input: {
  taskSubject: FabricTaskOutcomeV1["taskSubject"];
  subjectId: string;
  fixtureDigest: string;
  verifierDigest: string;
  sandboxDigest: string;
  startedAt: number;
  completedAt: number;
  usage: FabricUsageV1;
  outcome: FabricTaskOutcomeV1["outcome"];
  verifier: FabricTaskOutcomeV1["verifier"];
  failure?: FailureRecordV1;
  sourceRefs?: string[];
}): FabricTaskOutcomeV1 {
  return {
    schemaVersion: 1,
    taskClassId: FABRIC_TASK_CLASS_ID,
    taskClassVersion: FABRIC_TASK_CLASS_VERSION,
    routeSubject: input.taskSubject.routeSubject,
    taskSubject: input.taskSubject,
    subjectId: input.subjectId,
    taskFixtureDigest: input.fixtureDigest,
    verifierManifestDigest: input.verifierDigest,
    fabricCompatibilityVersion: FABRIC_COMPATIBILITY_VERSION,
    sandboxProfileDigest: input.sandboxDigest,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    limits: { ...FABRIC_LIMITS },
    usage: { ...input.usage },
    outcome: input.outcome,
    verifier: {
      ...input.verifier,
      pathSummaries: [...input.verifier.pathSummaries],
    },
    ...(input.failure ? { failure: { ...input.failure } } : {}),
    artifactDigests: [],
    ...(input.sourceRefs ? { sourceRefs: [...input.sourceRefs] } : {}),
  };
}

/** Declared sandbox policy for the frozen scratch producer (not runtime enforcement). */
export function fabricDeclaredSandboxPolicy(): {
  network: boolean;
  userMcp: boolean;
  arbitraryShell: boolean;
  userRepository: boolean;
} {
  return {
    network: SANDBOX_PROFILE_V1.allowNetwork,
    userMcp: SANDBOX_PROFILE_V1.allowUserMcp,
    arbitraryShell: SANDBOX_PROFILE_V1.allowShell,
    userRepository: SANDBOX_PROFILE_V1.allowUserRepository,
  };
}

/** @deprecated Use fabricDeclaredSandboxPolicy. */
export const fabricScratchCapabilityProbe = fabricDeclaredSandboxPolicy;
