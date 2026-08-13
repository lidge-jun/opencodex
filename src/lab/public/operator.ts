import { replayLabLedger } from "../ledger/store";
import { labLedgerPath } from "../paths";
import { queryLabEventById, queryLabVerdicts } from "../query";
import type { ObservationEvent } from "../events/types";
import {
  importCommunityEvidenceBundle,
  listCommunityEvidence,
} from "./community";
import { readPrivateRegularFile } from "./file-safety";
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
  records.sort((a, b) => a.recordId.localeCompare(b.recordId));
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
  | { status: "schema_rejected" | "digest_invalid" | "signature_invalid"; locallyVerified: false; detail?: string };

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

function canonicalVerdictForObservation(
  observation: ObservationEvent,
  configDir?: string,
): ProjectPublicEvidenceRecordInput["verdict"] | null {
  const filters = {
    subjectId: observation.subjectId,
    layer: observation.evidenceLayer,
    suiteId: observation.suiteId,
  };
  let cursor: string | undefined;
  do {
    const page = queryLabVerdicts(filters, cursor, 200, configDir);
    const verdict = page.items.find((row) =>
      row.suiteVersion === observation.suiteVersion && row.contributingEventIds.includes(observation.eventId),
    );
    if (verdict) return verdict.verdict;
    if (!page.hasMore || !page.nextCursor) return null;
    cursor = page.nextCursor;
  } while (true);
}

export function previewLocalPublicEvidence(
  input: { eventIds: readonly string[] },
  configDir?: string,
): LocalPublicPreviewV1 {
  const selections = assertOperatorEventIds(input.eventIds);
  const replay = replayLabLedger(labLedgerPath(configDir));
  const byId = new Map(replay.events.map((event) => [event.eventId, event] as const));
  const projectInputs: ProjectPublicEvidenceRecordInput[] = [];
  const projectSelectionIndices: number[] = [];
  const excluded: PublicOperatorExclusionV1[] = [];
  let sawObservation = false;

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
    sawObservation = true;
    const projectedEvent = queryLabEventById(eventId, configDir);
    if (!projectedEvent) {
      excluded.push({ selectionIndex, reason: "event_not_found" });
      continue;
    }
    if (projectedEvent.excluded) {
      excluded.push({ selectionIndex, reason: "event_excluded" });
      continue;
    }
    const verdict = canonicalVerdictForObservation(event, configDir);
    if (!verdict) {
      excluded.push({ selectionIndex, reason: "no_canonical_verdict" });
      continue;
    }
    projectInputs.push({ observation: event, verdict });
    projectSelectionIndices.push(selectionIndex);
  }

  if (!sawObservation) {
    throw new PublicEvidenceValidationError("public_selection_empty", "public evidence selection contains no observation events");
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
  recordLocalPublicOrigin({ publisherKeyId: bundle.publisher.keyId, bundleId: bundle.bundleId }, configDir);
  const stored = storePublicEvidenceBundle(bundle, configDir);
  return {
    bundle,
    stored: { path: PRIVATE_STORAGE_LOCATOR, created: stored.created },
    excluded: preview.excluded,
  };
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
