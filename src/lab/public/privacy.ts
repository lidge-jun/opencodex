import type {
  PublicEvidenceBundleUnsignedV1,
  PublicEvidenceBundleV1,
  PublicEvidenceRecordV1,
  PublicEvidenceSubjectV1,
} from "./types";
import { PublicEvidenceValidationError } from "./validate";

const FORBIDDEN_PUBLIC_STRING_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "URL", pattern: /(?:https?|file):\/\//i },
  { label: "local path", pattern: /(?:[A-Za-z]:[\\/]|(?:^|[\\/])(?:Users|home)[\\/])/i },
  { label: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { label: "IP address", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[0-9a-f:]{2,}\]/i },
  { label: "query string", pattern: /[?&][A-Za-z0-9_.~-]+=/ },
  { label: "authorization/header material", pattern: /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|bearer)\b/i },
  { label: "credential", pattern: /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{12,})\b/ },
  { label: "private key", pattern: /-----BEGIN [^-]*PRIVATE KEY-----/i },
  { label: "local request/decision/Fabric id", pattern: /\b(?:request|decision|fabric)_[A-Za-z0-9_-]{6,}\b/i },
  { label: "account/project/tenant context", pattern: /\b(?:account|tenant|project|organization|deployment)[=:][^\s]+/i },
  { label: "precise timestamp", pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/ },
];

function assertPrivacySafeString(value: string, field: string): void {
  for (const { label, pattern } of FORBIDDEN_PUBLIC_STRING_PATTERNS) {
    if (pattern.test(value)) {
      throw new PublicEvidenceValidationError(
        "privacy_rejected",
        `${field} contains forbidden ${label} material`,
      );
    }
  }
}

function scanSubject(subject: PublicEvidenceSubjectV1, field: string): void {
  if (subject.subjectKind === "protocol") {
    assertPrivacySafeString(subject.compatibilityVersion, `${field}.compatibilityVersion`);
    assertPrivacySafeString(subject.adapterFamily, `${field}.adapterFamily`);
    assertPrivacySafeString(subject.inboundProtocol, `${field}.inboundProtocol`);
    assertPrivacySafeString(subject.upstreamProtocol, `${field}.upstreamProtocol`);
    assertPrivacySafeString(subject.surface, `${field}.surface`);
    return;
  }
  if (subject.subjectKind === "route") {
    assertPrivacySafeString(subject.providerId, `${field}.providerId`);
    assertPrivacySafeString(subject.modelId, `${field}.modelId`);
    assertPrivacySafeString(subject.adapterFamily, `${field}.adapterFamily`);
    assertPrivacySafeString(subject.compatibilityVersion, `${field}.compatibilityVersion`);
    return;
  }
  scanSubject(subject.route, `${field}.route`);
  assertPrivacySafeString(subject.taskClassId, `${field}.taskClassId`);
  assertPrivacySafeString(subject.taskClassVersion, `${field}.taskClassVersion`);
  assertPrivacySafeString(subject.fabricCompatibilityVersion, `${field}.fabricCompatibilityVersion`);
}

export function validatePublicEvidenceRecordPrivacy(record: PublicEvidenceRecordV1): void {
  assertPrivacySafeString(record.suiteId, "record.suiteId");
  assertPrivacySafeString(record.suiteVersion, "record.suiteVersion");
  assertPrivacySafeString(record.scenarioId, "record.scenarioId");
  assertPrivacySafeString(record.scenarioVersion, "record.scenarioVersion");
  scanSubject(record.subject, "record.subject");
  for (const [index, assertion] of record.assertions.entries()) {
    assertPrivacySafeString(assertion.id, `record.assertions[${index}].id`);
  }
  for (const [index, incident] of (record.incidentRefs ?? []).entries()) {
    assertPrivacySafeString(incident.corpusId, `record.incidentRefs[${index}].corpusId`);
  }
}

/**
 * Second-pass CL-10 export privacy boundary. Hashes, signatures and publisher public-key
 * bytes are intentionally not pattern-scanned; every human-semantic public string is.
 */
export function validatePublicEvidencePrivacy(
  bundle: PublicEvidenceBundleUnsignedV1 | PublicEvidenceBundleV1,
): void {
  assertPrivacySafeString(bundle.createdDayUtc, "bundle.createdDayUtc");
  for (const record of bundle.records) validatePublicEvidenceRecordPrivacy(record);
  for (const [index, artifact] of bundle.artifacts.entries()) {
    assertPrivacySafeString(artifact.artifactClass, `bundle.artifacts[${index}].artifactClass`);
    assertPrivacySafeString(artifact.mediaType, `bundle.artifacts[${index}].mediaType`);
  }
}
