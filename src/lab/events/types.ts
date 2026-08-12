import type {
  ArtifactClass,
  ClaimPolarity,
  ClaimSourceKind,
  EvidenceLayer,
  ExecutionMode,
  InvalidationReason,
  LabEventKind,
  ObservationOutcome,
  PurgeAction,
} from "../constants";
import type { FailureClassification } from "../conformance/types";

export interface LabProducer {
  name: string;
  version: string;
}

export interface ProtocolSubjectV1 {
  subjectSchemaVersion: 1;
  subjectKind: "protocol";
  opencodexCompatibilityVersion: string;
  effectiveAdapter: string;
  inboundProtocol: string;
  upstreamProtocol: string;
  surface: string;
  behaviorFingerprint: string;
}

export interface RouteDependencyV1 {
  role: string;
  providerId: string;
  providerInstanceFingerprint: string;
  clientModelId: string;
  upstreamModelId: string;
  effectiveAdapter: string;
  upstreamProtocol: string;
  endpointFingerprint: string;
  behaviorFingerprint: string;
}

export interface RouteSubjectV1 {
  subjectSchemaVersion: 1;
  subjectKind: "route";
  providerId: string;
  providerInstanceFingerprint: string;
  clientModelId: string;
  upstreamModelId: string;
  effectiveAdapter: string;
  inboundProtocol: string;
  upstreamProtocol: string;
  surface: string;
  opencodexCompatibilityVersion: string;
  behaviorFingerprint: string;
  endpointFingerprint: string;
  dependencies: RouteDependencyV1[];
}

export interface TaskSubjectV1 {
  subjectSchemaVersion: 1;
  subjectKind: "task";
  routeSubject: RouteSubjectV1;
  taskClassId: string;
  taskClassVersion: string;
  taskFixtureDigest: string;
  verifierManifestDigest: string;
  fabricCompatibilityVersion: string;
  sandboxProfileDigest: string;
}

export type EvidenceSubjectV1 = ProtocolSubjectV1 | RouteSubjectV1 | TaskSubjectV1;

export interface ArtifactRefV1 {
  digest: string;
  mediaType: string;
  byteCount: number;
  redactionPolicy: string;
  /** Digest-derived relative name only (e.g. `<sha256>.bin`). */
  relativePath: string;
  artifactClass: ArtifactClass;
}

export interface AssertionRecordV1 {
  id: string;
  operator: string;
  required: boolean;
  passed: boolean;
  expectedSummary: string;
  observedSummary: string;
  reason?: string;
}

export interface FailureRecordV1 {
  class: FailureClassification;
  code: string;
  retryable: boolean;
  attribution: "opencodex" | "route" | "environment" | "harness";
}

export interface LabEventBase {
  schemaVersion: number;
  eventId: string;
  eventKind: LabEventKind;
  recordedAt: number;
  producer: string;
  producerVersion: string;
}

export interface ObservationEvent extends LabEventBase {
  eventKind: "observation";
  evidenceLayer: EvidenceLayer;
  scenarioId: string;
  scenarioVersion: string;
  scenarioManifestDigest: string;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  fixtureDigests: string[];
  subject: EvidenceSubjectV1;
  subjectId: string;
  startedAt: number;
  completedAt: number;
  executionMode: ExecutionMode;
  attempt: number;
  limits: Record<string, number | null>;
  outcome: ObservationOutcome;
  assertions: AssertionRecordV1[];
  failure?: FailureRecordV1;
  expectedFailure?: Record<string, unknown>;
  environment: Record<string, unknown>;
  artifactRefs: ArtifactRefV1[];
  sourceRefs?: string[];
}

export interface ClaimSnapshotEvent extends LabEventBase {
  eventKind: "claim_snapshot";
  evidenceLayer: "live_route_compatibility";
  subject: RouteSubjectV1;
  subjectId: string;
  capability: string;
  polarity: ClaimPolarity;
  sourceManifestDigest: string;
  sourceEventIds: string[];
  supersedes: string[];
  effectiveAt: number;
}

export interface InvalidationEvent extends LabEventBase {
  eventKind: "invalidation";
  targetEventIds: string[];
  reason: InvalidationReason;
}

export interface PurgeTombstoneEvent extends LabEventBase {
  eventKind: "purge_tombstone";
  targetEventIds: string[];
  targetArtifactDigests: string[];
  reason: "sensitive_evidence";
  purgeActions: PurgeAction[];
}

export type LabEvent =
  | ObservationEvent
  | ClaimSnapshotEvent
  | InvalidationEvent
  | PurgeTombstoneEvent;

export type ClaimCapabilityFactsV1 = {
  contextWindow?: number;
  inputModalities?: string[];
  reasoningEfforts?: string[];
  catalogCapabilityNames?: string[];
  serviceTier?: string[];
  toolCapable?: boolean;
  parallelToolCalls?: boolean;
  endpointLocality?: "local" | "private" | "unknown";
  canonicalOpenAiForward?: boolean;
};

export interface ClaimSourceV1 {
  kind: ClaimSourceKind;
  revision: string | null;
  facts: ClaimCapabilityFactsV1;
}

export interface RouteCapabilityEvidenceV1 {
  contextWindow?: number;
  tools?: boolean | "unknown";
  image?: boolean | "unknown";
  structuredOutput?: boolean | "unknown";
  reasoningEfforts?: string[];
  serviceTier?: string | "unknown";
  localOnly?: boolean | "unknown";
  remoteAllowed?: boolean | "unknown";
  encryptedCodexTasks?: boolean | "unknown";
}

export interface ClaimSourceManifestV1 {
  schemaVersion: 1;
  subjectId: string;
  providerId: string;
  clientModelId: string;
  capability: string;
  sources: ClaimSourceV1[];
  resolvedEvidence: RouteCapabilityEvidenceV1;
}

export interface LedgerCorruption {
  kind:
    | "malformed_line"
    | "partial_line"
    | "duplicate_event"
    | "invalid_event"
    | "invalid_reference"
    | "missing_artifact"
    | "artifact_mismatch"
    | "claim_corruption"
    | "empty_ledger";
  lineNumber?: number;
  eventId?: string;
  detail: string;
}

export interface ReplayResult {
  events: LabEvent[];
  corruptions: LedgerCorruption[];
  validLineCount: number;
  totalLineCount: number;
}
