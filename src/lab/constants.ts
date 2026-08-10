/** CL-02 projection / ledger constants frozen from CL-00 contracts. */

export const LAB_EVENT_SCHEMA_VERSION = 1;
export const LAB_PROJECTION_SPEC_VERSION = "cl-02.v1";
export const LAB_PRODUCER = "opencodex-lab";
export const LAB_PRODUCER_VERSION = "2.10.2";

export const MAX_INVALIDATION_TARGETS = 1024;
export const MAX_BYTES_PER_ARTIFACT = 256 * 1024;
export const MAX_AGGREGATE_ARTIFACT_BYTES = 1024 * 1024;
export const MAX_ARTIFACTS_PER_RUN = 16;
export const MAX_SERIALIZED_EVENT_BYTES = 64 * 1024;
export const MAX_SANITIZED_STRING_FIELD = 4 * 1024;
export const MAX_EVENT_NESTING_DEPTH = 8;
export const MAX_OBJECT_KEYS_PER_EVENT = 64;
export const MAX_ARRAY_ELEMENTS_PER_EVENT = 256;

export const OBSERVATION_LIMIT_NAMES = [
  "totalTimeoutMs",
  "connectTimeoutMs",
  "firstByteTimeoutMs",
  "inactivityTimeoutMs",
  "maxRequests",
  "maxInputBytes",
  "maxOutputBytes",
  "maxOutputTokens",
  "maxToolCalls",
  "maxArtifactBytes",
] as const;

export type ObservationLimitName = (typeof OBSERVATION_LIMIT_NAMES)[number];

export const EVENT_KINDS = [
  "observation",
  "claim_snapshot",
  "invalidation",
  "purge_tombstone",
] as const;

export type LabEventKind = (typeof EVENT_KINDS)[number];

export const EVIDENCE_LAYERS = [
  "protocol_conformance",
  "live_route_compatibility",
  "task_effectiveness",
] as const;

export type EvidenceLayer = (typeof EVIDENCE_LAYERS)[number];

export const VERDICTS = [
  "UNKNOWN",
  "CLAIMED",
  "PROBED",
  "VERIFIED",
  "DEGRADED",
  "BLOCKED",
  "UNSUPPORTED",
] as const;

export type CompatibilityVerdict = (typeof VERDICTS)[number];

export const INVALIDATION_REASONS = [
  "harness_defect",
  "fixture_defect",
  "redaction_defect",
  "integrity_defect",
  "contract_artifact_missing",
  "manual_correction",
] as const;

export type InvalidationReason = (typeof INVALIDATION_REASONS)[number];

export const PURGE_ACTIONS = [
  "ledger",
  "sqlite",
  "artifact",
  "scratch",
  "export",
] as const;

export type PurgeAction = (typeof PURGE_ACTIONS)[number];

export const CLAIM_SOURCE_KINDS = [
  "provider_config",
  "provider_registry",
  "cached_catalog",
  "native_metadata",
  "adapter_inference",
] as const;

export type ClaimSourceKind = (typeof CLAIM_SOURCE_KINDS)[number];

export const ARTIFACT_CLASSES = [
  "scenario_manifest",
  "suite_manifest",
  "fixture",
  "claim_source_manifest",
  "assertion_report",
  "request_shape",
  "response_shape",
  "event_trace",
  "error_taxonomy",
  "verifier_summary",
] as const;

export type ArtifactClass = (typeof ARTIFACT_CLASSES)[number];

export const CONTRACT_ARTIFACT_CLASSES = [
  "scenario_manifest",
  "suite_manifest",
  "fixture",
  "claim_source_manifest",
] as const;

export type ContractArtifactClass = (typeof CONTRACT_ARTIFACT_CLASSES)[number];

export const EXECUTION_MODES = ["fixture", "live", "fabric"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const OUTCOMES = ["pass", "fail", "blocked", "inconclusive"] as const;
export type ObservationOutcome = (typeof OUTCOMES)[number];

export const CLAIM_POLARITIES = ["supported", "not_supported", "withdrawn"] as const;
export type ClaimPolarity = (typeof CLAIM_POLARITIES)[number];

export const ARTIFACT_FILENAME_EXT = ".bin";
