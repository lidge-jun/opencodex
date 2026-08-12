import { domainHash, jcsStringify } from "../digest";
import type { ObservationEvent, ProtocolSubjectV1, RouteSubjectV1 } from "../events/types";
import { PUBLIC_ROUTE_REGISTRY_V1, findPublicRouteRegistryEntry } from "./registry";
import type {
  PublicAdapterFamilyV1,
  PublicEvidenceRecordV1,
  PublicEvidenceSubjectV1,
  PublicProjectionResult,
  PublicProtocolSubjectV1,
  PublicRouteAuthorityV1,
} from "./types";
import { isPublicIncidentRef, validatePublicEvidenceRecord } from "./validate";

const PUBLIC_ID_DOMAINS = {
  subject: "ocx-lab:public-subject:v1",
  record: "ocx-lab:public-record:v1",
  bundle: "ocx-lab:public-bundle:v1",
  artifact: "ocx-lab:public-artifact:v1",
  publisher: "ocx-lab:public-publisher:v1",
  revocation: "ocx-lab:public-revocation:v1",
} as const;

export type PublicEvidenceIdKind = keyof typeof PUBLIC_ID_DOMAINS;

export function publicEvidenceId(kind: PublicEvidenceIdKind, payload: unknown): string {
  return domainHash(PUBLIC_ID_DOMAINS[kind], jcsStringify(payload));
}

function publicAdapterFamily(value: string): PublicAdapterFamilyV1 | null {
  switch (value) {
    case "openai-responses": return "openai-responses";
    case "openai-chat": return "openai-chat";
    case "anthropic":
    case "anthropic-messages": return "anthropic-messages";
    case "responses": return "openai-responses";
    case "chat": return "openai-chat";
    default: return null;
  }
}

function publicProtocolSubject(subject: ProtocolSubjectV1): PublicProtocolSubjectV1 | null {
  const adapterFamily = publicAdapterFamily(subject.effectiveAdapter);
  const inboundProtocol = publicAdapterFamily(subject.inboundProtocol);
  const upstreamProtocol = publicAdapterFamily(subject.upstreamProtocol);
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

function routeAuthorityMatches(
  subject: RouteSubjectV1,
  localSubjectId: string,
  authority: PublicRouteAuthorityV1 | undefined,
): boolean {
  if (!authority || authority.localSubjectId !== localSubjectId) return false;
  if (subject.dependencies.length !== 0) return false;
  if (subject.clientModelId !== subject.upstreamModelId) return false;
  const descriptor = authority.descriptor;
  if (descriptor.subjectKind !== "route") return false;
  if (descriptor.providerId !== subject.providerId || descriptor.modelId !== subject.upstreamModelId) return false;
  if (descriptor.registryDigest !== PUBLIC_ROUTE_REGISTRY_V1.manifestDigest
    || descriptor.registryVersion !== PUBLIC_ROUTE_REGISTRY_V1.registryVersion) return false;
  const adapterFamily = publicAdapterFamily(subject.effectiveAdapter);
  const inboundProtocol = publicAdapterFamily(subject.inboundProtocol);
  const upstreamProtocol = publicAdapterFamily(subject.upstreamProtocol);
  if (!adapterFamily || !inboundProtocol || !upstreamProtocol) return false;
  if (descriptor.adapterFamily !== adapterFamily
    || descriptor.inboundProtocol !== inboundProtocol
    || descriptor.upstreamProtocol !== upstreamProtocol
    || descriptor.surface !== subject.surface
    || descriptor.compatibilityVersion !== subject.opencodexCompatibilityVersion) return false;
  return findPublicRouteRegistryEntry(descriptor.providerId, descriptor.modelId, descriptor.adapterFamily) !== null;
}

function observedDayUtc(observation: ObservationEvent): string {
  const value = Number.isFinite(observation.completedAt) ? observation.completedAt : observation.recordedAt;
  return new Date(value).toISOString().slice(0, 10);
}

export interface ProjectPublicEvidenceRecordInput {
  observation: ObservationEvent;
  verdict: PublicEvidenceRecordV1["verdict"];
  incidentRefs?: string[];
  routeAuthority?: PublicRouteAuthorityV1;
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
      || !routeAuthorityMatches(observation.subject, observation.subjectId, input.routeAuthority)) {
      return { status: "not_exportable", reason: "private_route_identity" };
    }
    subject = input.routeAuthority!.descriptor;
  } else {
    return { status: "not_exportable", reason: "task_authority_unavailable" };
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
