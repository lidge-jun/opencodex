// CL-03 live result -> CL-02 immutable observation persistence.
import { createArtifactStore, type ArtifactStore } from "../artifacts/store";
import { sanitizeDiagnostic, truncateUtf8 } from "../artifacts/sanitize";
import { LAB_EVENT_SCHEMA_VERSION, LAB_PRODUCER, LAB_PRODUCER_VERSION, OBSERVATION_LIMIT_NAMES, type ObservationOutcome } from "../constants";
import { fixtureDigest, scenarioManifestDigest, subjectIdForSubject, suiteManifestDigest } from "../digest";
import type { FailureRecordV1, ObservationEvent } from "../events/types";
import { assignEventId } from "../events/validate";
import { withLedgerMutation } from "../ledger/store";
import { ensureLabDirs } from "../paths";
import type { CaseAuthority, CaseRecord } from "../conformance/types";
import { trustedLiveResultRetryable } from "../live/executor";
import { expandLiveScenario } from "../live/manifest";
import { liveSuiteManifestObjectForCase } from "../live/suite-manifest";
import type { LiveScenarioRunResult } from "../live/types";

export interface PersistLiveOptions { configDir?: string; recordedAt?: number; startedAt?: number; completedAt?: number; producerVersion?: string; artifactStore?: ArtifactStore }
export interface PersistedLiveObservation { event: ObservationEvent; ledgerPath: string }

function outcomeFromLiveResult(result: LiveScenarioRunResult): ObservationOutcome {
  if (result.passed) return "pass";
  switch (result.classification) {
    case "timeout":
    case "inactivity_timeout":
    case "budget_exhausted":
    case "sandbox_violation":
    case "authentication_blocked":
    case "quota_blocked":
    case "region_blocked":
    case "network_failure":
    case "provider_transient":
      return "blocked";
    case "protocol_failure":
    case "capability_failure":
    case "behavioral_failure":
      return "fail";
    case "inconclusive":
    case "harness_failure":
    case "malformed_producer_outcome":
    case "layer_subject_mismatch":
      return "inconclusive";
    default: {
      const _never: never = result.classification;
      throw new Error(`unmapped failure classification: ${String(_never)}`);
    }
  }
}

function failureFromLiveResult(result: LiveScenarioRunResult, retryable: boolean): FailureRecordV1 | undefined {
  if (result.passed || result.classification === "inconclusive") return undefined;
  const attribution: FailureRecordV1["attribution"] = result.classification === "harness_failure"
    ? "harness"
    : ["authentication_blocked", "quota_blocked", "region_blocked", "network_failure", "provider_transient", "timeout", "inactivity_timeout", "budget_exhausted"].includes(result.classification)
      ? "environment"
      : "route";
  return {
    class: result.classification,
    code: result.secondaryCode ?? result.classification,
    retryable,
    attribution,
  };
}

function requireExecutionTimes(result: LiveScenarioRunResult, opts: PersistLiveOptions): { startedAt: number; completedAt: number } {
  const startedAt = opts.startedAt ?? result.startedAt; const completedAt = opts.completedAt ?? result.completedAt;
  if (!Number.isInteger(startedAt) || !Number.isInteger(completedAt) || startedAt < 0 || completedAt < startedAt) throw new Error("invalid persisted live execution timestamps");
  return { startedAt, completedAt };
}

export function observationFromLiveResult(result: LiveScenarioRunResult, caseRecord: CaseRecord, authority: CaseAuthority, opts: PersistLiveOptions = {}): { event: ObservationEvent; artifacts: ReturnType<ArtifactStore["put"]>[] } {
  const retryable = trustedLiveResultRetryable(result, caseRecord, authority);
  if (!result.routeSubject) throw new Error("live evidence without an exact RouteSubjectV1 is not persistable");
  const { startedAt, completedAt } = requireExecutionTimes(result, opts);
  const paths = ensureLabDirs(opts.configDir); const ownsStore = !opts.artifactStore; const store = opts.artifactStore ?? createArtifactStore(paths.artifactsDir);
  try {
    const recordedAt = opts.recordedAt ?? completedAt;
    const expandedScenario = expandLiveScenario(caseRecord, authority); const scenarioDigest = scenarioManifestDigest(expandedScenario);
    const suiteExpanded = liveSuiteManifestObjectForCase(caseRecord, authority); const suiteDigest = suiteManifestDigest(suiteExpanded);
    const fixtureDigests: string[] = []; const artifacts: ReturnType<ArtifactStore["put"]>[] = [];
    const putFixture = (fixture: CaseRecord["fixture"]) => {
      const bytes = new TextEncoder().encode(fixture.bytesUtf8); const digest = fixtureDigest(bytes); fixtureDigests.push(digest);
      artifacts.push(store.put({ artifactClass: "fixture", payload: bytes, expectedDigest: digest, mediaType: fixture.mediaType }));
    };
    putFixture(caseRecord.fixture); if (caseRecord.initiatingRequest) putFixture(caseRecord.initiatingRequest);
    artifacts.push(store.put({ artifactClass: "scenario_manifest", payload: expandedScenario, expectedDigest: scenarioDigest }));
    artifacts.push(store.put({ artifactClass: "suite_manifest", payload: suiteExpanded, expectedDigest: suiteDigest }));
    artifacts.push(store.put({ artifactClass: "assertion_report", payload: { scenarioId: result.scenarioId, passed: result.passed, classification: result.classification,
      assertions: result.assertionResults.map((row) => ({ id: row.id, operator: row.operator, required: row.required, passed: row.passed, observedSummary: row.observedSummary, reason: row.reason })) } }));
    const subject = result.routeSubject; const subjectId = subjectIdForSubject(subject); const authorityLimits = authority.manifestDefaults.executionLimits;
    const limits: Record<string, number | null> = {}; for (const key of OBSERVATION_LIMIT_NAMES) if (key in authorityLimits) limits[key] = authorityLimits[key] ?? null;
    const failure = failureFromLiveResult(result, retryable);
    const eventWithoutId = {
      schemaVersion: LAB_EVENT_SCHEMA_VERSION, eventKind: "observation" as const, recordedAt, producer: LAB_PRODUCER, producerVersion: opts.producerVersion ?? LAB_PRODUCER_VERSION,
      evidenceLayer: "live_route_compatibility" as const, scenarioId: caseRecord.id, scenarioVersion: String(authority.manifestDefaults.version), scenarioManifestDigest: scenarioDigest,
      suiteId: caseRecord.suite, suiteVersion: String(authority.manifestDefaults.suiteVersion), suiteManifestDigest: suiteDigest, fixtureDigests, subject, subjectId,
      startedAt, completedAt, executionMode: "live" as const, attempt: 1, limits, outcome: outcomeFromLiveResult(result),
      // Sanitize before truncating: the reverse order can split a redaction
      // target and persist a fragment of the raw value.
      assertions: result.assertionResults.map((row) => ({ id: row.id, operator: row.operator, required: row.required, passed: row.passed, expectedSummary: "see_assertion_report", observedSummary: truncateUtf8(sanitizeDiagnostic(row.observedSummary), 512), ...(row.reason ? { reason: row.reason } : {}) })),
      ...(caseRecord.expectedFailure ? { expectedFailure: { ...caseRecord.expectedFailure } } : {}),
      environment: { runtime: { platform: process.platform, arch: process.arch, bunVersion: process.versions.bun ?? Bun.version } }, artifactRefs: artifacts,
      ...(failure ? { failure } : {}),
    };
    return { event: assignEventId(eventWithoutId) as ObservationEvent, artifacts };
  } finally { if (ownsStore) store.close(); }
}

export function persistLiveResult(result: LiveScenarioRunResult, caseRecord: CaseRecord, authority: CaseAuthority, opts: PersistLiveOptions = {}): PersistedLiveObservation {
  const paths = ensureLabDirs(opts.configDir); const ownsStore = !opts.artifactStore; const store = opts.artifactStore ?? createArtifactStore(paths.artifactsDir);
  try {
    return withLedgerMutation(paths.ledgerPath, (ledger) => {
      const { event } = observationFromLiveResult(result, caseRecord, authority, { ...opts, artifactStore: store });
      ledger.append(event);
      return { event, ledgerPath: paths.ledgerPath };
    });
  }
  finally { if (ownsStore) store.close(); }
}
