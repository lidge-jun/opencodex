import type { CompatibilityVerdict, EvidenceLayer } from "../constants";

export const PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION = "public_route_registry_v1" as const;
export const PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION = "public_evidence_bundle_v1" as const;
export const PUBLIC_EVIDENCE_REVOCATION_SCHEMA_VERSION = "public_evidence_revocation_v1" as const;
export const PUBLIC_EXPORT_POLICY_VERSION = "public_export_policy_v1" as const;

export const PUBLIC_ADAPTER_FAMILIES = ["openai-responses", "openai-chat", "anthropic-messages"] as const;
export type PublicAdapterFamilyV1 = (typeof PUBLIC_ADAPTER_FAMILIES)[number];

export interface PublicRouteRegistryEntryV1 {
  providerId: string;
  modelId: string;
  adapterFamilies: PublicAdapterFamilyV1[];
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
export type PublicEvidenceSubjectV1 = PublicProtocolSubjectV1 | PublicRouteSubjectV1 | PublicTaskSubjectV1;
export interface PublicAssertionSummaryV1 { id: string; required: boolean; passed: boolean; }
export interface PublicIncidentRefV1 { corpusId: string; }
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
export interface PublicPublisherV1 {
  algorithm: "ed25519";
  keyId: string;
  publicKey: string;
}
export interface PublicBundleSignatureV1 {
  algorithm: "ed25519";
  signedDigest: string;
  signature: string;
}
export interface PublicEvidenceBundleV1 extends PublicEvidenceBundleUnsignedV1 {
  publisher: PublicPublisherV1;
  bundleDigest: string;
  signature: PublicBundleSignatureV1;
}
export interface PublicPublisherSignerV1 { publisher: PublicPublisherV1; }
export type PublicBundleVerificationResult =
  | { status: "cryptographically_valid"; bundle: PublicEvidenceBundleV1 }
  | { status: "schema_rejected" | "digest_invalid" | "signature_invalid"; detail?: string };

export type PublicRevocationReasonV1 = "publisher_retracted" | "privacy_retraction" | "evidence_invalidated" | "superseded";
export interface PublicRevocationTargetV1 { kind: "bundle" | "record"; id: string; }
export interface PublicEvidenceRevocationV1 {
  schemaVersion: typeof PUBLIC_EVIDENCE_REVOCATION_SCHEMA_VERSION;
  revocationId: string;
  issuedDayUtc: string;
  publisher: PublicPublisherV1;
  targets: PublicRevocationTargetV1[];
  reason: PublicRevocationReasonV1;
  signature: PublicBundleSignatureV1;
}
export type PublicRevocationVerificationResult =
  | { status: "cryptographically_valid"; revocation: PublicEvidenceRevocationV1 }
  | { status: "schema_rejected" | "digest_invalid" | "signature_invalid" | "publisher_mismatch" | "unknown_target"; detail?: string };

export interface CommunityEvidenceSummaryV1 {
  trustClass: "community_untrusted_v1";
  status: "cryptographically_valid";
  bundleId: string;
  publisherKeyId: string;
  activeRecordCount: number;
  revokedRecordCount: number;
}

export type PublicProjectionNotExportableReason = "private_route_identity" | "unsupported_public_adapter" | "task_authority_unavailable" | "invalid_public_incident_ref";
export type PublicProjectionResult = { status: "exportable"; record: PublicEvidenceRecordV1 } | { status: "not_exportable"; reason: PublicProjectionNotExportableReason };
export interface PublicRouteAuthorityV1 { localSubjectId: string; descriptor: PublicRouteSubjectV1; }
export interface PublicTaskAuthorityV1 { localSubjectId: string; descriptor: PublicTaskSubjectV1; }
