import type {
  ArtifactClass,
  CompatibilityVerdict,
  EvidenceLayer,
  ExecutionMode,
  InvalidationReason,
  LabEventKind,
  ObservationOutcome,
  PurgeAction,
} from "../constants";

export interface LabStatusDto {
  projectionAvailable: boolean;
  projectionIncompatible?: boolean;
  sqliteSchemaVersion?: number;
  projectionSpecVersion?: string;
  builtAtMs?: number;
  eventCount?: number;
  subjectCount?: number;
  observationCount?: number;
  claimCount?: number;
  verdictCount?: number;
  artifactCount?: number;
  corruptionCount?: number;
}

export interface VerdictDto {
  projectionKey: string;
  subjectId: string;
  evidenceLayer: EvidenceLayer;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  projectionSpecVersion: string;
  verdict: CompatibilityVerdict;
  asOf: number;
  scenarioManifestDigests: string[];
  claimSourceDigest: string | null;
  contributingEventIds: string[];
  contradictingEventIds: string[];
  notes: string[];
}

export interface ProtocolSubjectDto {
  subjectKind: "protocol";
  subjectSchemaVersion: 1;
  opencodexCompatibilityVersion: string;
  effectiveAdapter: string;
  inboundProtocol: string;
  upstreamProtocol: string;
  surface: string;
  behaviorFingerprint: string;
}

export interface RouteDependencyDto {
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

export interface RouteSubjectDto {
  subjectKind: "route";
  subjectSchemaVersion: 1;
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
  dependencies: RouteDependencyDto[];
}

export interface TaskSubjectDto {
  subjectKind: "task";
  subjectSchemaVersion: 1;
  routeSubject: RouteSubjectDto;
  taskClassId: string;
  taskClassVersion: string;
  taskFixtureDigest: string;
  verifierManifestDigest: string;
  fabricCompatibilityVersion: string;
  sandboxProfileDigest: string;
}

export type SubjectDto = ProtocolSubjectDto | RouteSubjectDto | TaskSubjectDto;

export interface SubjectListItemDto {
  subjectId: string;
  subjectKind: string;
}

export interface ObservationDto {
  eventId: string;
  subjectId: string;
  evidenceLayer: EvidenceLayer;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  scenarioId: string;
  scenarioVersion: string;
  scenarioManifestDigest: string;
  outcome: ObservationOutcome;
  completedAt: number;
  executionMode: ExecutionMode;
  excluded: boolean;
  exclusionReason: string | null;
}

export interface ObservationEventDto {
  eventKind: "observation";
  eventId: string;
  recordedAt: number;
  producer: string;
  producerVersion: string;
  evidenceLayer: EvidenceLayer;
  scenarioId: string;
  scenarioVersion: string;
  scenarioManifestDigest: string;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  subjectId: string;
  startedAt: number;
  completedAt: number;
  executionMode: ExecutionMode;
  attempt: number;
  outcome: ObservationOutcome;
  excluded: boolean;
  exclusionReason: string | null;
}

export interface ClaimSnapshotEventDto {
  eventKind: "claim_snapshot";
  eventId: string;
  recordedAt: number;
  producer: string;
  producerVersion: string;
  subjectId: string;
  capability: string;
  polarity: string;
  sourceManifestDigest: string;
  effectiveAt: number;
  excluded: boolean;
  exclusionReason: string | null;
}

export interface InvalidationEventDto {
  eventKind: "invalidation";
  eventId: string;
  recordedAt: number;
  producer: string;
  producerVersion: string;
  reason: InvalidationReason;
  targetEventIds: string[];
  excluded: boolean;
  exclusionReason: string | null;
}

export interface PurgeTombstoneEventDto {
  eventKind: "purge_tombstone";
  eventId: string;
  recordedAt: number;
  producer: string;
  producerVersion: string;
  targetEventIds: string[];
  targetArtifactDigests: string[];
  purgeActions: PurgeAction[];
  excluded: boolean;
  exclusionReason: string | null;
}

export type LabEventDto =
  | ObservationEventDto
  | ClaimSnapshotEventDto
  | InvalidationEventDto
  | PurgeTombstoneEventDto;

export interface EventListItemDto {
  eventId: string;
  eventKind: LabEventKind;
  recordedAt: number;
  excluded: boolean;
  exclusionReason: string | null;
}

export interface ArtifactMetadataDto {
  digest: string;
  artifactClass: ArtifactClass | null;
  mediaType: string | null;
  byteCount: number | null;
  status: "present" | "corrupt" | "purged_unavailable";
  lastError: string | null;
}

export interface CatalogScenarioDto {
  scenarioId: string;
  scenarioVersion: string;
  evidenceLayer: EvidenceLayer;
  suiteId: string;
  suiteVersion: string;
  capability: string;
  verificationRole: string;
  requirements: {
    inboundProtocols: string[];
    upstreamProtocols: string[];
    surfaces: string[];
  };
  freshness: Record<string, unknown>;
  scenarioManifestDigest: string;
  suiteManifestDigest: string;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface VerdictFilters {
  subjectId?: string;
  layer?: EvidenceLayer;
  suiteId?: string;
  verdict?: CompatibilityVerdict;
  from?: number;
  to?: number;
}

export interface ObservationFilters {
  subjectId?: string;
  layer?: EvidenceLayer;
  suiteId?: string;
  scenarioId?: string;
  outcome?: ObservationOutcome;
  executionMode?: ExecutionMode;
  from?: number;
  to?: number;
}

export interface EventFilters {
  eventKind?: LabEventKind;
  subjectId?: string;
  from?: number;
  to?: number;
  excluded?: boolean;
}

export interface ArtifactFilters {
  status?: "present" | "corrupt" | "purged_unavailable";
  artifactClass?: ArtifactClass;
}

export interface CatalogFilters {
  layer?: EvidenceLayer;
  suiteId?: string;
}
