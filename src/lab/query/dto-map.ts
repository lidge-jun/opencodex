import { sanitizeDiagnostic } from "../artifacts/sanitize";
import type {
  ClaimSnapshotEvent,
  InvalidationEvent,
  LabEvent,
  ObservationEvent,
  PurgeTombstoneEvent,
  RouteDependencyV1,
  RouteSubjectV1,
  TaskSubjectV1,
} from "../events/types";
import { validateLabEvent } from "../events/validate";
import type {
  ArtifactMetadataDto,
  ClaimSnapshotEventDto,
  EventListItemDto,
  InvalidationEventDto,
  LabEventDto,
  ObservationDto,
  ObservationEventDto,
  ProtocolSubjectDto,
  PurgeTombstoneEventDto,
  RouteDependencyDto,
  RouteSubjectDto,
  SubjectDto,
  SubjectListItemDto,
  TaskSubjectDto,
  VerdictDto,
} from "./types";

const SECRETISH = /sk-[a-z0-9]{10,}|Bearer\s+[A-Za-z0-9._\-]+|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}/gi;
const URL_USERINFO = /https?:\/\/[^/\s:@]+:[^/\s@]+@/gi;
const WINDOWS_PATH = /[A-Za-z]:\\(?:[^\\:*?"<>|\r\n]+\\)*[^\\:*?"<>|\r\n]*/g;
const POSIX_HOME = /(?:^|[^A-Za-z0-9_])(?:\/home\/|\/Users\/|~\/)[^\s"'<>|]+/g;

export function sanitizePublicText(value: string | null | undefined, max = 256): string | null {
  if (value === null || value === undefined) return null;
  let out = sanitizeDiagnostic(value);
  out = out.replace(SECRETISH, "[redacted]");
  out = out.replace(URL_USERINFO, "[redacted-url]@");
  out = out.replace(WINDOWS_PATH, "[redacted-path]");
  out = out.replace(POSIX_HOME, "[redacted-path]");
  if (out.length > max) out = out.slice(0, max);
  return out;
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function mapVerdictRow(row: Record<string, unknown>): VerdictDto {
  return {
    projectionKey: String(row.projection_key),
    subjectId: String(row.subject_id),
    evidenceLayer: row.evidence_layer as VerdictDto["evidenceLayer"],
    suiteId: String(row.suite_id),
    suiteVersion: String(row.suite_version),
    suiteManifestDigest: String(row.suite_manifest_digest),
    projectionSpecVersion: String(row.projection_spec_version),
    verdict: row.verdict as VerdictDto["verdict"],
    asOf: Number(row.as_of),
    scenarioManifestDigests: parseJsonArray(String(row.scenario_manifest_digests_json)),
    claimSourceDigest: row.claim_source_digest ? String(row.claim_source_digest) : null,
    contributingEventIds: parseJsonArray(String(row.contributing_event_ids_json)),
    contradictingEventIds: parseJsonArray(String(row.contradicting_event_ids_json)),
    notes: parseJsonArray(String(row.notes_json)).map((n) => sanitizePublicText(n, 512) ?? ""),
  };
}

function mapRouteDependency(dep: RouteDependencyV1): RouteDependencyDto {
  return {
    role: dep.role,
    providerId: dep.providerId,
    providerInstanceFingerprint: dep.providerInstanceFingerprint,
    clientModelId: dep.clientModelId,
    upstreamModelId: dep.upstreamModelId,
    effectiveAdapter: dep.effectiveAdapter,
    upstreamProtocol: dep.upstreamProtocol,
    endpointFingerprint: dep.endpointFingerprint,
    behaviorFingerprint: dep.behaviorFingerprint,
  };
}

function mapRouteSubject(subject: RouteSubjectV1): RouteSubjectDto {
  return {
    subjectKind: "route",
    subjectSchemaVersion: 1,
    providerId: subject.providerId,
    providerInstanceFingerprint: subject.providerInstanceFingerprint,
    clientModelId: subject.clientModelId,
    upstreamModelId: subject.upstreamModelId,
    effectiveAdapter: subject.effectiveAdapter,
    inboundProtocol: subject.inboundProtocol,
    upstreamProtocol: subject.upstreamProtocol,
    surface: subject.surface,
    opencodexCompatibilityVersion: subject.opencodexCompatibilityVersion,
    behaviorFingerprint: subject.behaviorFingerprint,
    endpointFingerprint: subject.endpointFingerprint,
    dependencies: subject.dependencies.map(mapRouteDependency),
  };
}

export function mapSubjectJson(subjectJson: string): SubjectDto | null {
  try {
    const parsed = JSON.parse(subjectJson) as Record<string, unknown>;
    const kind = parsed.subjectKind;
    if (kind === "protocol") {
      return {
        subjectKind: "protocol",
        subjectSchemaVersion: 1,
        opencodexCompatibilityVersion: String(parsed.opencodexCompatibilityVersion),
        effectiveAdapter: String(parsed.effectiveAdapter),
        inboundProtocol: String(parsed.inboundProtocol),
        upstreamProtocol: String(parsed.upstreamProtocol),
        surface: String(parsed.surface),
        behaviorFingerprint: String(parsed.behaviorFingerprint),
      };
    }
    if (kind === "route") {
      return mapRouteSubject(parsed as unknown as RouteSubjectV1);
    }
    if (kind === "task") {
      const task = parsed as unknown as TaskSubjectV1;
      return {
        subjectKind: "task",
        subjectSchemaVersion: 1,
        routeSubject: mapRouteSubject(task.routeSubject),
        taskClassId: task.taskClassId,
        taskClassVersion: task.taskClassVersion,
        taskFixtureDigest: task.taskFixtureDigest,
        verifierManifestDigest: task.verifierManifestDigest,
        fabricCompatibilityVersion: task.fabricCompatibilityVersion,
        sandboxProfileDigest: task.sandboxProfileDigest,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function mapSubjectListRow(row: Record<string, unknown>): SubjectListItemDto {
  return {
    subjectId: String(row.subject_id),
    subjectKind: String(row.subject_kind),
  };
}

export function mapObservationRow(
  row: Record<string, unknown>,
  excluded: boolean,
  exclusionReason: string | null,
): ObservationDto {
  return {
    eventId: String(row.event_id),
    subjectId: String(row.subject_id),
    evidenceLayer: row.evidence_layer as ObservationDto["evidenceLayer"],
    suiteId: String(row.suite_id),
    suiteVersion: String(row.suite_version),
    suiteManifestDigest: String(row.suite_manifest_digest),
    scenarioId: String(row.scenario_id),
    scenarioVersion: String(row.scenario_version),
    scenarioManifestDigest: String(row.scenario_manifest_digest),
    outcome: row.outcome as ObservationDto["outcome"],
    completedAt: Number(row.completed_at),
    executionMode: row.execution_mode as ObservationDto["executionMode"],
    excluded,
    exclusionReason: sanitizePublicText(exclusionReason),
  };
}

export function mapEventListRow(row: Record<string, unknown>): EventListItemDto {
  return {
    eventId: String(row.event_id),
    eventKind: row.event_kind as EventListItemDto["eventKind"],
    recordedAt: Number(row.recorded_at),
    excluded: Number(row.excluded) === 1,
    exclusionReason: sanitizePublicText(row.exclusion_reason ? String(row.exclusion_reason) : null),
  };
}

export function mapArtifactRow(row: Record<string, unknown>): ArtifactMetadataDto {
  return {
    digest: String(row.digest),
    artifactClass: row.artifact_class ? row.artifact_class as ArtifactMetadataDto["artifactClass"] : null,
    mediaType: row.media_type ? String(row.media_type) : null,
    byteCount: row.byte_count === null || row.byte_count === undefined ? null : Number(row.byte_count),
    status: row.status as ArtifactMetadataDto["status"],
    lastError: sanitizePublicText(row.last_error ? String(row.last_error) : null),
  };
}

function exclusionFromRow(row: Record<string, unknown>): { excluded: boolean; exclusionReason: string | null } {
  return {
    excluded: Number(row.excluded) === 1,
    exclusionReason: sanitizePublicText(row.exclusion_reason ? String(row.exclusion_reason) : null),
  };
}

export function mapValidatedEventToDto(event: LabEvent, excluded: boolean, exclusionReason: string | null): LabEventDto {
  const base = {
    eventId: event.eventId,
    recordedAt: event.recordedAt,
    producer: event.producer,
    producerVersion: event.producerVersion,
    excluded,
    exclusionReason: sanitizePublicText(exclusionReason),
  };
  if (event.eventKind === "observation") {
    const obs = event as ObservationEvent;
    return {
      eventKind: "observation",
      ...base,
      evidenceLayer: obs.evidenceLayer,
      scenarioId: obs.scenarioId,
      scenarioVersion: obs.scenarioVersion,
      scenarioManifestDigest: obs.scenarioManifestDigest,
      suiteId: obs.suiteId,
      suiteVersion: obs.suiteVersion,
      suiteManifestDigest: obs.suiteManifestDigest,
      subjectId: obs.subjectId,
      startedAt: obs.startedAt,
      completedAt: obs.completedAt,
      executionMode: obs.executionMode,
      attempt: obs.attempt,
      outcome: obs.outcome,
    } satisfies ObservationEventDto;
  }
  if (event.eventKind === "claim_snapshot") {
    const claim = event as ClaimSnapshotEvent;
    return {
      eventKind: "claim_snapshot",
      ...base,
      subjectId: claim.subjectId,
      capability: claim.capability,
      polarity: claim.polarity,
      sourceManifestDigest: claim.sourceManifestDigest,
      effectiveAt: claim.effectiveAt,
    } satisfies ClaimSnapshotEventDto;
  }
  if (event.eventKind === "invalidation") {
    const inv = event as InvalidationEvent;
    return {
      eventKind: "invalidation",
      ...base,
      reason: inv.reason,
      targetEventIds: [...inv.targetEventIds],
    } satisfies InvalidationEventDto;
  }
  const purge = event as PurgeTombstoneEvent;
  return {
    eventKind: "purge_tombstone",
    ...base,
    targetEventIds: [...purge.targetEventIds],
    targetArtifactDigests: [...purge.targetArtifactDigests],
    purgeActions: [...purge.purgeActions],
  } satisfies PurgeTombstoneEventDto;
}

export function parseEventPayloadToDto(
  payloadJson: string,
  excluded: boolean,
  exclusionReason: string | null,
): LabEventDto | null {
  try {
    const parsed = JSON.parse(payloadJson);
    const event = validateLabEvent(parsed);
    return mapValidatedEventToDto(event, excluded, exclusionReason);
  } catch {
    return null;
  }
}
