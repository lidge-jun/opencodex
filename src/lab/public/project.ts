import type { CompatibilityVerdict } from "../constants";
import type { ObservationEvent, ProtocolSubjectV1 } from "../events/types";
import { validatePublicEvidenceAuthorities } from "./community-authority";
import { publicEvidenceId } from "./ids";
import { validatePublicEvidenceRecordPrivacy } from "./privacy";
import { publicUtcDay } from "./time";
import {
  PUBLIC_ADAPTER_FAMILIES,
  type PublicAdapterFamily,
  type PublicEvidenceProjectionResult,
  type PublicEvidenceRecordV1,
  type PublicIncidentRefV1,
  type PublicProtocolSubjectV1,
} from "./types";
import {
  isPublicIncidentRef,
  PublicEvidenceValidationError,
  validatePublicEvidenceRecord,
} from "./validate";

const PROJECTOR_INVARIANT_ERROR_CODES = new Set([
  "subject_id_mismatch",
  "record_id_mismatch",
]);

export interface ProjectPublicEvidenceRecordInput {
  observation: ObservationEvent;
  verdict: CompatibilityVerdict;
  incidentRefs?: string[];
  publicArtifactRefs?: string[];
}

function asPublicAdapterFamily(value: string): PublicAdapterFamily | undefined {
  return (PUBLIC_ADAPTER_FAMILIES as readonly string[]).includes(value)
    ? value as PublicAdapterFamily
    : undefined;
}

function projectProtocolSubject(subject: ProtocolSubjectV1): PublicProtocolSubjectV1 | undefined {
  const adapterFamily = asPublicAdapterFamily(subject.effectiveAdapter);
  if (!adapterFamily) return undefined;
  return {
    subjectKind: "protocol",
    compatibilityVersion: subject.opencodexCompatibilityVersion,
    adapterFamily,
    inboundProtocol: subject.inboundProtocol,
    upstreamProtocol: subject.upstreamProtocol,
    surface: subject.surface,
  };
}

function projectIncidentRefs(values: string[] | undefined): PublicIncidentRefV1[] | undefined {
  if (values === undefined) return undefined;
  if (values.some((value) => !isPublicIncidentRef(value))) return undefined;
  return values.map((corpusId) => ({ corpusId }));
}

/**
 * Project one local observation into the closed public V1 record shape and apply the
 * complete reviewed authority/privacy boundary before exposing it as exportable.
 *
 * Route and task observations deliberately fail closed here. Persisted RouteSubjectV1
 * contains installation-salted provider-instance and endpoint identity, so the exact
 * public/default route cannot be proven from ledger bytes alone. Dropping those fields
 * would broaden a private exact route into a misleading public claim.
 */
export function projectPublicEvidenceRecord(
  input: ProjectPublicEvidenceRecordInput,
): PublicEvidenceProjectionResult {
  const { observation } = input;

  if (observation.evidenceLayer === "live_route_compatibility" || observation.evidenceLayer === "task_effectiveness") {
    return { status: "not_exportable", reason: "private_route_identity" };
  }
  if (observation.evidenceLayer !== "protocol_conformance" || observation.subject.subjectKind !== "protocol") {
    return { status: "not_exportable", reason: "unsupported_subject" };
  }

  const subject = projectProtocolSubject(observation.subject);
  if (!subject) return { status: "not_exportable", reason: "unsupported_adapter_family" };

  const incidentRefs = projectIncidentRefs(input.incidentRefs);
  if (input.incidentRefs !== undefined && incidentRefs === undefined) {
    return { status: "not_exportable", reason: "unsafe_public_field" };
  }

  try {
    const subjectId = publicEvidenceId("subject", subject);
    const withoutRecordId: Omit<PublicEvidenceRecordV1, "recordId"> = {
      subjectId,
      evidenceLayer: "protocol_conformance",
      suiteId: observation.suiteId,
      suiteVersion: observation.suiteVersion,
      scenarioId: observation.scenarioId,
      scenarioVersion: observation.scenarioVersion,
      verdict: input.verdict,
      observedDayUtc: publicUtcDay(observation.completedAt),
      subject,
      assertions: observation.assertions.map((assertion) => ({
        id: assertion.id,
        required: assertion.required,
        passed: assertion.passed,
      })),
      ...(incidentRefs !== undefined ? { incidentRefs } : {}),
      ...(input.publicArtifactRefs !== undefined ? { artifactRefs: [...input.publicArtifactRefs] } : {}),
    };
    const record = validatePublicEvidenceRecord({
      recordId: publicEvidenceId("record", withoutRecordId),
      ...withoutRecordId,
    });
    validatePublicEvidenceAuthorities([record]);
    validatePublicEvidenceRecordPrivacy(record);
    return { status: "exportable", record };
  } catch (error) {
    if (error instanceof PublicEvidenceValidationError) {
      if (PROJECTOR_INVARIANT_ERROR_CODES.has(error.code)) throw error;
      return { status: "not_exportable", reason: "unsafe_public_field", detailCode: error.code };
    }
    if (error instanceof TypeError && error.message.startsWith("jcsStringify:")) {
      return { status: "not_exportable", reason: "unsafe_public_field" };
    }
    throw error;
  }
}
