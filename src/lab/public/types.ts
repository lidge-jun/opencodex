import type { CompatibilityVerdict, EvidenceLayer } from "../constants";

export const PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION = "public_route_registry_v1" as const;
export const PUBLIC_EXPORT_POLICY_VERSION = "public_export_policy_v1" as const;

export const PUBLIC_ADAPTER_FAMILIES = [
  "openai-responses",
  "openai-chat",
  "anthropic-messages",
] as const;
export type PublicAdapterFamilyV1 = (typeof PUBLIC_ADAPTER_FAMILIES)[number];

export interface PublicRouteRegistryEntryV1 {
  providerId: string;
  modelId: string;
  adapterFamilies: PublicAdapterFamilyV1[];
}

export interface PublicRouteRegistryManifestV1 {
  schemaVersion: typeof PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION;
  registryVersion: string;
  sourceCommit: string;
  entries: PublicRouteRegistryEntryV1[];
  manifestDigest: string;
}

export interface PublicProtocolSubjectV1 {
  subjectKind: "protocol";
  adapterFamily: PublicAdapterFamilyV1;
  inboundProtocol: PublicAdapterFamilyV1;
  upstreamProtocol: PublicAdapterFamilyV1;
  surface: string;
  compatibilityVersion: string;
}

export interface PublicRouteSubjectV1 {
  subjectKind: "route";
  providerId: string;
  modelId: string;
  adapterFamily: PublicAdapterFamilyV1;
  inboundProtocol: PublicAdapterFamilyV1;
  upstreamProtocol: PublicAdapterFamilyV1;
  surface: string;
  compatibilityVersion: string;
  registryVersion: string;
  registryDigest: string;
}

export interface PublicTaskSubjectV1 {
  subjectKind: "task";
  route: PublicRouteSubjectV1;
  taskClassId: string;
  taskClassVersion: string;
  verifierAuthorityId: string;
}

export type PublicEvidenceSubjectV1 =
  | PublicProtocolSubjectV1
  | PublicRouteSubjectV1
  | PublicTaskSubjectV1;

export interface PublicAssertionSummaryV1 {
  id: string;
  required: boolean;
  passed: boolean;
}

export interface PublicIncidentRefV1 {
  corpusId: string;
}

export interface PublicEvidenceRecordV1 {
  recordId: string;
  subjectId: string;
  evidenceLayer: EvidenceLayer;
  suiteId: string;
  suiteVersion: string;
  scenarioId: string;
  scenarioVersion: string;
  verdict: CompatibilityVerdict;
  observedDayUtc: string;
  subject: PublicEvidenceSubjectV1;
  assertions: PublicAssertionSummaryV1[];
  incidentRefs?: PublicIncidentRefV1[];
  artifactRefs?: string[];
}

export type PublicProjectionNotExportableReason =
  | "private_route_identity"
  | "unsupported_public_adapter"
  | "task_authority_unavailable"
  | "invalid_public_incident_ref";

export type PublicProjectionResult =
  | { status: "exportable"; record: PublicEvidenceRecordV1 }
  | { status: "not_exportable"; reason: PublicProjectionNotExportableReason };

/**
 * Trusted local proof for an exact route. Callers must derive this from the same
 * effective route subject that produced the local observation, never from an
 * imported bundle or user-supplied public descriptor.
 */
export interface PublicRouteAuthorityV1 {
  localSubjectId: string;
  descriptor: PublicRouteSubjectV1;
}
