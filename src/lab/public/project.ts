import type { ObservationEvent, ProtocolSubjectV1 } from "../events/types";
import {
  isTrustedPublicRouteAuthority,
  isTrustedPublicTaskAuthority,
  toPublicAdapterFamily,
} from "./authority";
import { publicEvidenceId } from "./ids";
import type {
  PublicEvidenceRecordV1,
  PublicEvidenceSubjectV1,
  PublicProjectionResult,
  PublicProtocolSubjectV1,
  PublicRouteAuthorityV1,
  PublicTaskAuthorityV1,
} from "./types";
import { isPublicIncidentRef, validatePublicEvidenceRecord } from "./validate";

function publicProtocolSubject(subject: ProtocolSubjectV1): PublicProtocolSubjectV1 | null {
  const adapterFamily = toPublicAdapterFamily(subject.effectiveAdapter);
  const inboundProtocol = toPublicAdapterFamily(subject.inboundProtocol);
  const upstreamProtocol = toPublicAdapterFamily(subject.upstreamProtocol);
  if (!adapterFamily || !inboundProtocol || !upstreamProtocol) return null;
  return {
    subjectKind: "protocol",
    adapterFamily,
    inboundProtocol,
    upstreamProtocol,
    surface: subject.surface,
    compatibilityVersion: subject.opencodexCompatibilityVersion,
  };
}

function observedDayUtc(observation: ObservationEvent): string {
  const value = Number.isFinite(observation.completedAt) ? observation.completedAt : observation.recordedAt;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid observation timestamp");
  return date.toISOString().slice(0, 10);
}

export interface ProjectPublicEvidenceRecordInput {
  observation: ObservationEvent;
  verdict: PublicEvidenceRecordV1["verdict"];
  incidentRefs?: string[];
  routeAuthority?: PublicRouteAuthorityV1;
  taskAuthority?: PublicTaskAuthorityV1;
}

export function projectPublicEvidenceRecord(input: ProjectPublicEvidenceRecordInput): PublicProjectionResult {
  const observation = input.observation;
  let subject: PublicEvidenceSubjectV1;

  if (observation.evidenceLayer === "protocol_conformance") {
    if (observation.subject.subjectKind !== "protocol") {
      return { status: "not_exportable", reason: "unsupported_public_adapter" };
    }
    const projected = publicProtocolSubject(observation.subject);
    if (!projected) return { status: "not_exportable", reason: "unsupported_public_adapter" };
    subject = projected;
  } else if (observation.evidenceLayer === "live_route_compatibility") {
    if (observation.subject.subjectKind !== "route"
      || !isTrustedPublicRouteAuthority(input.routeAuthority)
      || input.routeAuthority.localSubjectId !== observation.subjectId) {
      return { status: "not_exportable", reason: "private_route_identity" };
    }
    subject = input.routeAuthority.descriptor;
  } else {
    if (observation.subject.subjectKind !== "task"
      || !isTrustedPublicTaskAuthority(input.taskAuthority)
      || input.taskAuthority.localSubjectId !== observation.subjectId) {
      return { status: "not_exportable", reason: "task_authority_unavailable" };
    }
    subject = input.taskAuthority.descriptor;
  }

  let incidentRefs: Array<{ corpusId: string }> | undefined;
  if (input.incidentRefs !== undefined) {
    if (input.incidentRefs.some((value) => !isPublicIncidentRef(value))) {
      return { status: "not_exportable", reason: "invalid_public_incident_ref" };
    }
    incidentRefs = [...new Set(input.incidentRefs)].sort().map((corpusId) => ({ corpusId }));
  }

  const subjectId = publicEvidenceId("subject", subject);
  const recordWithoutId: Omit<PublicEvidenceRecordV1, "recordId"> = {
    subjectId,
    evidenceLayer: observation.evidenceLayer,
    suiteId: observation.suiteId,
    suiteVersion: observation.suiteVersion,
    scenarioId: observation.scenarioId,
    scenarioVersion: observation.scenarioVersion,
    verdict: input.verdict,
    observedDayUtc: observedDayUtc(observation),
    subject,
    assertions: observation.assertions.slice(0, 64).map((assertion) => ({
      id: assertion.id,
      required: assertion.required,
      passed: assertion.passed,
    })),
    ...(incidentRefs && incidentRefs.length > 0 ? { incidentRefs } : {}),
  };
  const record: PublicEvidenceRecordV1 = {
    recordId: publicEvidenceId("record", recordWithoutId),
    ...recordWithoutId,
  };
  return { status: "exportable", record: validatePublicEvidenceRecord(record) };
}
