import { describe, expect, test } from "bun:test";
import {
  assertFabricOutcomeV1,
  buildTaskSubjectV1,
  FABRIC_LIMITS,
  FABRIC_VERIFIER_ID,
  subjectIdForSubject,
  type FabricTaskOutcomeV1,
  type RouteSubjectV1,
} from "../src/lab";
import { FabricTaskError } from "../src/lab/fabric/types";

function routeSubject(): RouteSubjectV1 {
  return {
    subjectSchemaVersion: 1,
    subjectKind: "route",
    providerId: "provider-a",
    providerInstanceFingerprint: "a".repeat(64),
    clientModelId: "model-a",
    upstreamModelId: "model-a",
    effectiveAdapter: "openai-responses",
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-responses",
    surface: "responses-http",
    opencodexCompatibilityVersion: "b".repeat(64),
    behaviorFingerprint: "c".repeat(64),
    endpointFingerprint: "d".repeat(64),
    dependencies: [],
  };
}

function validOutcome(): FabricTaskOutcomeV1 {
  const taskSubject = buildTaskSubjectV1({ routeSubject: routeSubject() });
  return {
    schemaVersion: 1,
    taskClassId: taskSubject.taskClassId,
    taskClassVersion: taskSubject.taskClassVersion,
    routeSubject: taskSubject.routeSubject,
    taskSubject,
    subjectId: subjectIdForSubject(taskSubject),
    taskFixtureDigest: taskSubject.taskFixtureDigest,
    verifierManifestDigest: taskSubject.verifierManifestDigest,
    fabricCompatibilityVersion: taskSubject.fabricCompatibilityVersion,
    sandboxProfileDigest: taskSubject.sandboxProfileDigest,
    startedAt: 100,
    completedAt: 200,
    limits: { ...FABRIC_LIMITS },
    usage: {
      inputBytes: 7,
      outputBytes: 6,
      patchOperations: 1,
      filesTouched: 1,
      artifactBytes: 0,
      elapsedMs: 100,
      inactiveMs: 0,
    },
    outcome: "pass",
    verifier: {
      verifierId: FABRIC_VERIFIER_ID,
      manifestDigest: taskSubject.verifierManifestDigest,
      passed: true,
      pathSummaries: [],
    },
    artifactDigests: [],
  };
}

function changedDigest(value: string): string {
  return `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`;
}

describe("CL-07 fabric outcome validation", () => {
  test("accepts a canonical outcome", () => {
    const outcome = validOutcome();
    expect(assertFabricOutcomeV1(outcome)).toBe(outcome);
  });

  test("rejects undeclared nested producer fields", () => {
    const outcome = validOutcome();
    const malformed = [
      { ...outcome, usage: { ...outcome.usage, credential: "secret" } },
      { ...outcome, limits: { ...outcome.limits, unexpectedLimit: 1 } },
      { ...outcome, taskSubject: { ...outcome.taskSubject, credential: "secret" } },
      {
        ...outcome,
        taskSubject: {
          ...outcome.taskSubject,
          routeSubject: { ...outcome.taskSubject.routeSubject, credential: "secret" },
        },
      },
      { ...outcome, routeSubject: { ...outcome.routeSubject, credential: "secret" } },
    ];

    for (const candidate of malformed) {
      expect(() => assertFabricOutcomeV1(candidate)).toThrow(FabricTaskError);
    }
  });

  test("rejects negative or reversed execution timestamps", () => {
    const outcome = validOutcome();
    expect(() => assertFabricOutcomeV1({ ...outcome, startedAt: -1 })).toThrow(FabricTaskError);
    expect(() => assertFabricOutcomeV1({ ...outcome, startedAt: 201 })).toThrow(FabricTaskError);
    expect(() => assertFabricOutcomeV1({ ...outcome, startedAt: 100.5 })).toThrow(FabricTaskError);
    expect(() => assertFabricOutcomeV1({ ...outcome, completedAt: 200.5 })).toThrow(FabricTaskError);
  });

  test("rejects contradictory task identity fields", () => {
    const outcome = validOutcome();
    const malformed = [
      { ...outcome, subjectId: changedDigest(outcome.subjectId) },
      { ...outcome, taskClassId: `${outcome.taskClassId}-other` },
      { ...outcome, taskFixtureDigest: changedDigest(outcome.taskFixtureDigest) },
      {
        ...outcome,
        verifier: {
          ...outcome.verifier,
          manifestDigest: changedDigest(outcome.verifier.manifestDigest),
        },
      },
    ];

    for (const candidate of malformed) {
      expect(() => assertFabricOutcomeV1(candidate)).toThrow(FabricTaskError);
    }
  });
});
