import { loadCaseAuthority } from "../conformance/manifest";
import {
  FABRIC_COMPATIBILITY_VERSION,
  FABRIC_SCENARIO_ID,
  FABRIC_SCENARIO_VERSION,
  FABRIC_SUITE_ID,
  FABRIC_SUITE_VERSION,
  FABRIC_TASK_CLASS_ID,
  FABRIC_TASK_CLASS_VERSION,
} from "../fabric/constants";
import { loadFabricCaseAuthority } from "../fabric/manifest";
import { verifierManifestDigest } from "../fabric/subject";
import { findPublicRouteRegistryEntry } from "./registry";
import type { PublicEvidenceBundleV1, PublicEvidenceRecordV1, PublicRouteSubjectV1 } from "./types";
import { PublicEvidenceValidationError } from "./validate";

function validateRouteAuthority(subject: PublicRouteSubjectV1): void {
  const entry = findPublicRouteRegistryEntry(subject.providerId, subject.modelId);
  if (!entry || !entry.adapterFamilies.includes(subject.adapterFamily)) {
    throw new PublicEvidenceValidationError("public_authority", "public route is not in reviewed registry authority");
  }
}

function validateAssertionAuthority(
  record: PublicEvidenceRecordV1,
  assertions: readonly { id: string; required: boolean }[],
): void {
  const allowed = new Map(assertions.map((assertion) => [assertion.id, assertion.required] as const));
  for (const assertion of record.assertions) {
    if (!allowed.has(assertion.id) || allowed.get(assertion.id) !== assertion.required) {
      throw new PublicEvidenceValidationError(
        "public_authority",
        "public assertion id/required flag is not in reviewed scenario authority",
      );
    }
  }
}

function validateTaskAuthority(record: PublicEvidenceRecordV1): void {
  const fabricAuthority = loadFabricCaseAuthority();
  const caseRecord = fabricAuthority.cases.find((candidate) => candidate.id === FABRIC_SCENARIO_ID);
  if (
    !caseRecord
    || record.suiteId !== FABRIC_SUITE_ID
    || record.suiteVersion !== FABRIC_SUITE_VERSION
    || record.scenarioId !== FABRIC_SCENARIO_ID
    || record.scenarioVersion !== FABRIC_SCENARIO_VERSION
    || record.subject.subjectKind !== "task"
    || record.subject.taskClassId !== FABRIC_TASK_CLASS_ID
    || record.subject.taskClassVersion !== FABRIC_TASK_CLASS_VERSION
    || record.subject.taskFixtureDigest !== caseRecord.fixture.digest
    || record.subject.verifierManifestDigest !== verifierManifestDigest()
    || record.subject.fabricCompatibilityVersion !== FABRIC_COMPATIBILITY_VERSION
  ) {
    throw new PublicEvidenceValidationError("public_authority", "task scenario/verifier authority mismatch");
  }
  validateAssertionAuthority(record, caseRecord.assertions);
  validateRouteAuthority(record.subject.route);
}

function validateScenarioAuthority(record: PublicEvidenceRecordV1): void {
  if (record.evidenceLayer === "task_effectiveness") {
    validateTaskAuthority(record);
    return;
  }

  const authority = loadCaseAuthority();
  const caseRecord = authority.cases.find((candidate) => candidate.id === record.scenarioId);
  if (
    !caseRecord
    || caseRecord.suite !== record.suiteId
    || record.scenarioVersion !== String(authority.manifestDefaults.version)
    || record.suiteVersion !== String(authority.manifestDefaults.suiteVersion)
  ) {
    throw new PublicEvidenceValidationError("public_authority", "scenario/suite authority mismatch");
  }
  validateAssertionAuthority(record, caseRecord.assertions);

  if (record.evidenceLayer === "live_route_compatibility") {
    if (record.subject.subjectKind !== "route") {
      throw new PublicEvidenceValidationError("public_authority", "live route subject mismatch");
    }
    validateRouteAuthority(record.subject);
  }
}

/** Repository-owned authority gate used by both local signing and community imports. */
export function validatePublicEvidenceAuthorities(records: readonly PublicEvidenceRecordV1[]): void {
  for (const record of records) validateScenarioAuthority(record);
}

export function validateCommunityEvidenceAuthorities(bundle: PublicEvidenceBundleV1): PublicEvidenceBundleV1 {
  validatePublicEvidenceAuthorities(bundle.records);
  return bundle;
}
