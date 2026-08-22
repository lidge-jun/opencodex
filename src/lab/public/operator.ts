import { replayLabLedger } from "../ledger/store";
import { labLedgerPath } from "../paths";
import { queryLabEvents, queryLabVerdicts } from "../query";
import type { ObservationEvent } from "../events/types";
import {
  importCommunityEvidenceBundle,
  listCommunityEvidence,
} from "./community";
import { readPrivateRegularFile } from "./file-safety";
import { withPublicEvidenceMutationLock } from "./mutation-lock";
import { recordLocalPublicOrigin } from "./origin";
import type { ProjectPublicEvidenceRecordInput } from "./project";
import { projectPublicEvidenceRecord } from "./project";
import {
  signPublicEvidenceBundle,
  verifyPublicEvidenceBundle,
} from "./signature";
import { storePublicEvidenceBundle } from "./storage";
import { parseStrictPublicJson } from "./strict-json";
import { publicUtcDay } from "./time";
import { PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION, PUBLIC_EXPORT_POLICY_VERSION } from "./types";
import type {
  PublicEvidenceBundleV1,
  PublicEvidencePreviewBundleV1,
  PublicEvidenceRecordV1,
  PublicProjectionNotExportableReason,
} from "./types";
import { PublicEvidenceValidationError } from "./validate";

const MAX_OPERATOR_EVENTS = 256;
const MAX_PUBLIC_FILE_BYTES = 2 * 1024 * 1024;
const EMPTY_PREVIEW_DAY = "1970-01-01";
const PRIVATE_STORAGE_LOCATOR = "<private>";

export interface ProjectPublicEvidenceInput {
  records: ProjectPublicEvidenceRecordInput[];
}

export function projectPublicEvidence(input: ProjectPublicEvidenceInput): {
  bundle: PublicEvidencePreviewBundleV1;
  excluded: Array<{ index: number; reason: PublicProjectionNotExportableReason }>;
} {
  const records: PublicEvidenceRecordV1[] = [];
  const excluded: Array<{ index: number; reason: PublicProjectionNotExportableReason }> = [];
  let latestExportableCompletedAt: number | null = null;

  input.records.forEach((recordInput, index) => {
    const projected = projectPublicEvidenceRecord(recordInput);
    if (projected.status !== "exportable") {
      excluded.push({ index, reason: projected.reason });
      return;
    }
    records.push(projected.record);
    latestExportableCompletedAt = Math.max(
      latestExportableCompletedAt ?? recordInput.observation.completedAt,
      recordInput.observation.completedAt,
    );
  });
  records.sort((a, b) => a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0);
  return {
    bundle: {
      schemaVersion: PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION,
      exportPolicyVersion: PUBLIC_EXPORT_POLICY_VERSION,
      createdDayUtc: latestExportableCompletedAt === null
        ? EMPTY_PREVIEW_DAY
        : publicUtcDay(latestExportableCompletedAt),
      records,
      artifacts: [],
    },
    excluded,
  };
}

export type PublicOperatorExclusionReason =
  | PublicProjectionNotExportableReason
  | "event_not_found"
  | "not_observation"
  | "event_excluded"
  | "no_canonical_verdict";

export interface PublicOperatorExclusionV1 {
  selectionIndex: number;
  reason: PublicOperatorExclusionReason;
}

export interface LocalPublicPreviewV1 {
  bundle: PublicEvidencePreviewBundleV1;
  excluded: PublicOperatorExclusionV1[];
}

export interface LocalPublicExportV1 {
  bundle: PublicEvidenceBundleV1;
  stored: { path: typeof PRIVATE_STORAGE_LOCATOR; created: boolean };
  excluded: PublicOperatorExclusionV1[];
}

export type PublicVerificationSummaryV1 =
  | { status: "cryptographically_valid"; bundleId: string; publisherKeyId: string; locallyVerified: false }
  | { status: "schema_rejected" | "digest_invalid" | "signature_invalid"; locallyVerified: false };

function assertOperatorEventIds(eventIds: readonly string[]): Array<{ eventId: string; selectionIndex: number }> {
  if (eventIds.length === 0 || eventIds.length > MAX_OPERATOR_EVENTS) {
    throw new PublicEvidenceValidationError(
      "public_selection_limit",
      `public evidence selection must contain 1..${MAX_OPERATOR_EVENTS} event ids`,
    );
  }
  const unique: Array<{ eventId: string; selectionIndex: number }> = [];
  const seen = new Set<string>();
  for (const [selectionIndex, eventId] of eventIds.entries()) {
    if (!/^[0-9a-f]{64}$/.test(eventId)) {
      throw new PublicEvidenceValidationError(
        "public_selection_event_id",
        "public evidence event ids must be lowercase sha256 hex",
      );
    }
    if (seen.has(eventId)) continue;
    seen.add(eventId);
    unique.push({ eventId, selectionIndex });
  }
  return unique;
}

function projectedObservationState(
  eventIds: readonly string[],
  configDir?: string,
): Map<string, { excluded: boolean }> {
  const pending = new Set(eventIds);
  const state = new Map<string, { excluded: boolean }>();
  let cursor: string | undefined;

  while (pending.size > 0) {
    const page = queryLabEvents({ eventKind: "observation" }, cursor, 200, configDir);
    for (const row of page.items) {
      if (!pending.has(row.eventId)) continue;
      state.set(row.eventId, { excluded: row.excluded });
      pending.delete(row.eventId);
    }
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return state;
}

function canonicalVerdictsForObservations(
  observations: readonly ObservationEvent[],
  configDir?: string,
): Map<string, ProjectPublicEvidenceRecordInput["verdict"]> {
  const verdictByEventId = new Map<string, ProjectPublicEvidenceRecordInput["verdict"]>();
  const groups = new Map<string, {
    subjectId: string;
    evidenceLayer: ObservationEvent["evidenceLayer"];
    suiteId: string;
    observations: ObservationEvent[];
  }>();

  for (const observation of observations) {
    const key = `${observation.subjectId}\0${observation.evidenceLayer}\0${observation.suiteId}`;
    const existing = groups.get(key);
    if (existing) existing.observations.push(observation);
    else groups.set(key, {
      subjectId: observation.subjectId,
      evidenceLayer: observation.evidenceLayer,
      suiteId: observation.suiteId,
      observations: [observation],
    });
  }

  for (const group of groups.values()) {
    const pending = new Map(group.observations.map((observation) => [observation.eventId, observation] as const));
    let cursor: string | undefined;
    while (pending.size > 0) {
      const page = queryLabVerdicts({
        subjectId: group.subjectId,
        layer: group.evidenceLayer,
        suiteId: group.suiteId,
      }, cursor, 200, configDir);
      for (const row of page.items) {
        for (const eventId of row.contributingEventIds) {
          const observation = pending.get(eventId);
          if (!observation) continue;
          if (
            row.subjectId !== observation.subjectId
            || row.evidenceLayer !== observation.evidenceLayer
            || row.suiteId !== observation.suiteId
            || row.suiteVersion !== observation.suiteVersion
          ) {
            continue;
          }
          verdictByEventId.set(eventId, row.verdict);
          pending.delete(eventId);
        }
      }
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }

  return verdictByEventId;
}

export function previewLocalPublicEvidence(
  input: { eventIds: readonly string[] },
  configDir?: string,
): LocalPublicPreviewV1 {
  const selections = assertOperatorEventIds(input.eventIds);
  const replay = replayLabLedger(labLedgerPath(configDir));
  const byId = new Map(replay.events.map((event) => [event.eventId, event] as const));
  const observationSelections: Array<{ observation: ObservationEvent; selectionIndex: number }> = [];
  const excluded: PublicOperatorExclusionV1[] = [];

  for (const { eventId, selectionIndex } of selections) {
    const event = byId.get(eventId);
    if (!event) {
      excluded.push({ selectionIndex, reason: "event_not_found" });
      continue;
    }
    if (event.eventKind !== "observation") {
      excluded.push({ selectionIndex, reason: "not_observation" });
      continue;
    }
    observationSelections.push({ observation: event, selectionIndex });
  }

  if (observationSelections.length === 0) {
    throw new PublicEvidenceValidationError("public_selection_empty", "public evidence selection contains no observation events");
  }

  const projectionByEventId = projectedObservationState(
    observationSelections.map(({ observation }) => observation.eventId),
    configDir,
  );
  const candidates: Array<{ observation: ObservationEvent; selectionIndex: number }> = [];
  for (const candidate of observationSelections) {
    const projectedEvent = projectionByEventId.get(candidate.observation.eventId);
    if (!projectedEvent) {
      excluded.push({ selectionIndex: candidate.selectionIndex, reason: "event_not_found" });
      continue;
    }
    if (projectedEvent.excluded) {
      excluded.push({ selectionIndex: candidate.selectionIndex, reason: "event_excluded" });
      continue;
    }
    candidates.push(candidate);
  }

  const verdictByEventId = canonicalVerdictsForObservations(
    candidates.map((candidate) => candidate.observation),
    configDir,
  );
  const projectInputs: ProjectPublicEvidenceRecordInput[] = [];
  const projectSelectionIndices: number[] = [];
  for (const { observation, selectionIndex } of candidates) {
    const verdict = verdictByEventId.get(observation.eventId);
    if (!verdict) {
      excluded.push({ selectionIndex, reason: "no_canonical_verdict" });
      continue;
    }
    projectInputs.push({ observation, verdict });
    projectSelectionIndices.push(selectionIndex);
  }

  const projected = projectPublicEvidence({ records: projectInputs });
  for (const row of projected.excluded) {
    excluded.push({ selectionIndex: projectSelectionIndices[row.index]!, reason: row.reason });
  }
  excluded.sort((a, b) => a.selectionIndex - b.selectionIndex);
  return { bundle: projected.bundle, excluded };
}

export function exportLocalPublicEvidence(
  input: { eventIds: readonly string[] },
  configDir?: string,
): LocalPublicExportV1 {
  const preview = previewLocalPublicEvidence(input, configDir);
  if (preview.bundle.records.length === 0) {
    throw new PublicEvidenceValidationError("public_export_empty", "selected events produced no exportable public evidence records");
  }
  const bundle = signPublicEvidenceBundle({
    records: preview.bundle.records,
    artifacts: preview.bundle.artifacts,
    createdDayUtc: preview.bundle.createdDayUtc,
    configDir,
  });
  return withPublicEvidenceMutationLock(configDir, () => {
    // Commit purge-owned provenance first. If export publication later fails or the
    // process crashes, an orphan marker is conservative and can be reclaimed later;
    // the inverse state, a durable export without provenance, is not acceptable.
    recordLocalPublicOrigin({ publisherKeyId: bundle.publisher.keyId, bundleId: bundle.bundleId }, configDir);
    const stored = storePublicEvidenceBundle(bundle, configDir);
    return {
      bundle,
      stored: { path: PRIVATE_STORAGE_LOCATOR, created: stored.created },
      excluded: preview.excluded,
    };
  });
}

export function summarizePublicEvidenceVerification(raw: unknown): PublicVerificationSummaryV1 {
  const result = verifyPublicEvidenceBundle(raw as PublicEvidenceBundleV1);
  if (result.status !== "cryptographically_valid") {
    return { status: result.status, locallyVerified: false };
  }
  const bundle = raw as PublicEvidenceBundleV1;
  return {
    status: "cryptographically_valid",
    bundleId: bundle.bundleId,
    publisherKeyId: bundle.publisher.keyId,
    locallyVerified: false,
  };
}

function readBoundedPublicFile(path: string): Buffer {
  return readPrivateRegularFile(path, {
    maxBytes: MAX_PUBLIC_FILE_BYTES,
    errorCode: "public_file_unsafe",
    errorMessage: "public evidence input must be a regular non-symlink file",
    sizeErrorCode: "public_file_too_large",
    sizeErrorMessage: "public evidence input exceeds 2 MiB",
  });
}

function parsePublicFile(path: string): unknown {
  return parseStrictPublicJson(readBoundedPublicFile(path), "public evidence input", "public_file_json");
}

export function verifyPublicEvidenceFile(path: string): PublicVerificationSummaryV1 {
  return summarizePublicEvidenceVerification(parsePublicFile(path));
}

function finishCommunityImport(
  stored: { path: string; created: boolean; bundleId: string; publisherKeyId: string },
) {
  const { path: _privatePath, ...imported } = stored;
  return { ...imported, trustClass: "community_untrusted_v1" as const, locallyVerified: false as const };
}

export function importCommunityEvidenceFile(path: string, configDir?: string) {
  return finishCommunityImport(importCommunityEvidenceBundle(readBoundedPublicFile(path), configDir));
}

export function importCommunityEvidenceValue(raw: unknown, configDir?: string) {
  return finishCommunityImport(importCommunityEvidenceBundle(raw, configDir));
}

export function listCommunityEvidenceContext(configDir?: string) {
  return {
    evidence: listCommunityEvidence(configDir),
    trustClass: "community_untrusted_v1" as const,
    locallyVerified: false as const,
  };
}
