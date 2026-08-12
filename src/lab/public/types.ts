import type { CompatibilityVerdict, EvidenceLayer } from "../constants";

export const PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION = "public_route_registry_v1" as const;
export const PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION = "public_evidence_bundle_v1" as const;
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
  /** Reviewed canonical public endpoint used only as local export authority. */
  canonicalBaseUrl: string;
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

export interface PublicArtifactV1 {
  artifactId: string;
  mediaType: "application/json" | "text/plain; charset=utf-8";
  byteCount: number;
  contentBase64: string;
}

export interface PublicEvidenceBundleUnsignedV1 {
  schemaVersion: typeof PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION;
  exportPolicyVersion: typeof PUBLIC_EXPORT_POLICY_VERSION;
  bundleId: string;
  createdDayUtc: string;
  records: PublicEvidenceRecordV1[];
  artifacts: PublicArtifactV1[];
}

export type PublicProjectionNotExportableReason =
  | "private_route_identity"
  | "unsupported_public_adapter"
  | "task_authority_unavailable"
  | "invalid_public_incident_ref";

export type PublicProjectionResult =
  | { status: "exportable"; record: PublicEvidenceRecordV1 }
  | { status: "not_exportable"; reason: PublicProjectionNotExportableReason };

/** Opaque runtime capability. Plain-object copies are intentionally untrusted. */
export interface PublicRouteAuthorityV1 {
  localSubjectId: string;
  descriptor: PublicRouteSubjectV1;
}

/** Opaque runtime capability. Plain-object copies are intentionally untrusted. */
export interface PublicTaskAuthorityV1 {
  localSubjectId: string;
  descriptor: PublicTaskSubjectV1;
}
