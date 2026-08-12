import { loadCaseAuthority } from "../conformance/manifest";
import {
  FABRIC_SCENARIO_ID,
  FABRIC_SCENARIO_VERSION,
  FABRIC_SUITE_ID,
  FABRIC_SUITE_VERSION,
} from "../fabric/constants";
import { findPublicRouteRegistryEntry } from "./registry";
import type { PublicEvidenceBundleV1, PublicEvidenceRecordV1, PublicRouteSubjectV1 } from "./types";
import { PublicEvidenceValidationError } from "./validate";

function validateRouteAuthority(subject: PublicRouteSubjectV1): void {
  if (!findPublicRouteRegistryEntry(subject.providerId, subject.modelId, subject.adapterFamily)) {
    throw new PublicEvidenceValidationError("community_authority", "public route is not in reviewed registry authority");
  }
}

function validateScenarioAuthority(record: PublicEvidenceRecordV1): void {
  if (record.evidenceLayer === "task_effectiveness") {
    if (
      record.suiteId !== FABRIC_SUITE_ID
      || record.suiteVersion !== FABRIC_SUITE_VERSION
      || record.scenarioId !== FABRIC_SCENARIO_ID
      || record.scenarioVersion !== FABRIC_SCENARIO_VERSION
      || record.subject.subjectKind !== "task"
      || record.subject.taskClassId !== FABRIC_SCENARIO_ID
      || record.subject.taskClassVersion !== FABRIC_SCENARIO_VERSION
    ) {
      throw new PublicEvidenceValidationError("community_authority", "task scenario authority mismatch");
    }
    validateRouteAuthority(record.subject.route);
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
    throw new PublicEvidenceValidationError("community_authority", "scenario/suite authority mismatch");
  }

  if (record.evidenceLayer === "live_route_compatibility") {
    if (record.subject.subjectKind !== "route") {
      throw new PublicEvidenceValidationError("community_authority", "live route subject mismatch");
    }
    validateRouteAuthority(record.subject);
  }
}

export function validateCommunityEvidenceAuthorities(bundle: PublicEvidenceBundleV1): PublicEvidenceBundleV1 {
  for (const record of bundle.records) validateScenarioAuthority(record);
  return bundle;
}
