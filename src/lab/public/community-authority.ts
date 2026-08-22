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

type ProtocolCaseAuthority = ReturnType<typeof loadCaseAuthority>;

interface ProtocolAuthoritySnapshot {
  scenarioVersion: string;
  suiteVersion: string;
  sourceCommit: string;
  load: () => ProtocolCaseAuthority;
}

// Public records are historical evidence. Never replace an authority entry when a
// protocol version advances: retain the old loader and append a new snapshot.
const PROTOCOL_AUTHORITY_SNAPSHOTS: readonly ProtocolAuthoritySnapshot[] = Object.freeze([
  Object.freeze({
    scenarioVersion: "1.0.0",
    suiteVersion: "1.0.0",
    sourceCommit: "3ad5bb6bd3f76f6879d84b78ea39edd3e01ec296",
    load: loadCaseAuthority,
  }),
]);

const cachedCaseAuthorities = new Map<string, ProtocolCaseAuthority>();
let cachedFabricCaseAuthority: ReturnType<typeof loadFabricCaseAuthority> | null = null;
let cachedVerifierManifestDigest: string | null = null;

function protocolAuthorityKey(snapshot: ProtocolAuthoritySnapshot): string {
  return `${snapshot.suiteVersion}\0${snapshot.scenarioVersion}`;
}

function caseAuthorityFor(record: PublicEvidenceRecordV1): ProtocolCaseAuthority {
  const snapshot = PROTOCOL_AUTHORITY_SNAPSHOTS.find((candidate) =>
    candidate.scenarioVersion === record.scenarioVersion
    && candidate.suiteVersion === record.suiteVersion
  );
  if (!snapshot) {
    throw new PublicEvidenceValidationError(
      "public_authority",
      "scenario/suite authority version is not retained",
    );
  }

  const key = protocolAuthorityKey(snapshot);
  const cached = cachedCaseAuthorities.get(key);
  if (cached) return cached;

  const authority = snapshot.load();
  if (
    String(authority.manifestDefaults.version) !== snapshot.scenarioVersion
    || String(authority.manifestDefaults.suiteVersion) !== snapshot.suiteVersion
    || authority.sourceCommit !== snapshot.sourceCommit
  ) {
    throw new Error("public protocol authority snapshot drift");
  }
  cachedCaseAuthorities.set(key, authority);
  return authority;
}

function fabricCaseAuthority(): ReturnType<typeof loadFabricCaseAuthority> {
  cachedFabricCaseAuthority ??= loadFabricCaseAuthority();
  return cachedFabricCaseAuthority;
}

function reviewedVerifierManifestDigest(): string {
  cachedVerifierManifestDigest ??= verifierManifestDigest();
  return cachedVerifierManifestDigest;
}

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
  if (allowed.size !== assertions.length) {
    throw new PublicEvidenceValidationError("public_authority", "reviewed scenario assertion authority contains duplicates");
  }
  if (record.assertions.length !== allowed.size) {
    throw new PublicEvidenceValidationError(
      "public_authority",
      "public assertion set does not exactly match reviewed scenario authority",
    );
  }
  const seen = new Set<string>();
  for (const assertion of record.assertions) {
    if (seen.has(assertion.id)) {
      throw new PublicEvidenceValidationError("public_authority", "public assertion set contains duplicate assertion ids");
    }
    seen.add(assertion.id);
    if (!allowed.has(assertion.id) || allowed.get(assertion.id) !== assertion.required) {
      throw new PublicEvidenceValidationError(
        "public_authority",
        "public assertion id/required flag is not in reviewed scenario authority",
      );
    }
  }
  for (const assertionId of allowed.keys()) {
    if (!seen.has(assertionId)) {
      throw new PublicEvidenceValidationError("public_authority", "public assertion set is missing reviewed scenario authority");
    }
  }
}

function validateTaskAuthority(record: PublicEvidenceRecordV1): void {
  const fabricAuthority = fabricCaseAuthority();
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
    || record.subject.verifierManifestDigest !== reviewedVerifierManifestDigest()
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

  const authority = caseAuthorityFor(record);
  const caseRecord = authority.cases.find((candidate) => candidate.id === record.scenarioId);
  if (!caseRecord || caseRecord.suite !== record.suiteId) {
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
