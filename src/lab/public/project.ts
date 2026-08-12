import type { CompatibilityVerdict } from "../constants";
import type { ObservationEvent, ProtocolSubjectV1 } from "../events/types";
import { publicEvidenceId } from "./ids";
import {
  PUBLIC_ADAPTER_FAMILIES,
  type PublicAdapterFamily,
  type PublicEvidenceProjectionResult,
  type PublicEvidenceRecordV1,
  type PublicIncidentRefV1,
  type PublicProtocolSubjectV1,
} from "./types";
import { isPublicIncidentRef, validatePublicEvidenceRecord } from "./validate";

export interface ProjectPublicEvidenceRecordInput {
  observation: ObservationEvent;
  verdict: CompatibilityVerdict;
  incidentRefs?: string[];
  publicArtifactRefs?: string[];
}

function utcDay(timestampMs: number): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0) {
    throw new Error("invalid observation completion timestamp");
  }
  return new Date(timestampMs).toISOString().slice(0, 10);
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
 * Project one local observation into the closed public V1 record shape.
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

  const subjectId = publicEvidenceId("subject", subject);
  const withoutRecordId: Omit<PublicEvidenceRecordV1, "recordId"> = {
    subjectId,
    evidenceLayer: "protocol_conformance",
    suiteId: observation.suiteId,
    suiteVersion: observation.suiteVersion,
    scenarioId: observation.scenarioId,
    scenarioVersion: observation.scenarioVersion,
    verdict: input.verdict,
    observedDayUtc: utcDay(observation.completedAt),
    subject,
    assertions: observation.assertions.map((assertion) => ({
      id: assertion.id,
      required: assertion.required,
      passed: assertion.passed,
    })),
    ...(incidentRefs !== undefined ? { incidentRefs } : {}),
    ...(input.publicArtifactRefs !== undefined ? { artifactRefs: [...input.publicArtifactRefs] } : {}),
  };
  const record: PublicEvidenceRecordV1 = {
    recordId: publicEvidenceId("record", withoutRecordId),
    ...withoutRecordId,
  };

  return { status: "exportable", record: validatePublicEvidenceRecord(record) };
}
