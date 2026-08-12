import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { replayLabLedger } from "../ledger/store";
import { labExportDir, labLedgerPath } from "../paths";
import { queryLabEventById, queryLabVerdicts } from "../query";
import type { ObservationEvent } from "../events/types";
import { validatePublicEvidenceAuthorities } from "./community-authority";
import { importCommunityEvidenceBundle, listCommunityEvidence } from "./community";
import { validatePublicEvidenceRecordPrivacy } from "./privacy";
import type { ProjectPublicEvidenceRecordInput } from "./project";
import { projectPublicEvidenceRecord } from "./project";
import { signPublicEvidenceBundle, verifyPublicEvidenceBundle } from "./signature";
import { writePublicEvidenceBundle } from "./storage";
import { parseStrictPublicJson } from "./strict-json";
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
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

export interface ProjectPublicEvidenceInput {
  /** @deprecated V1 derives this only from records that remain exportable. */
  createdDayUtc?: string;
  records: ProjectPublicEvidenceRecordInput[];
}

function utcDay(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new PublicEvidenceValidationError("public_selection_time", "selected observation has an invalid completion timestamp");
  }
  return date.toISOString().slice(0, 10);
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
    try {
      validatePublicEvidenceAuthorities([projected.record]);
      validatePublicEvidenceRecordPrivacy(projected.record);
      records.push(projected.record);
      latestExportableCompletedAt = Math.max(
        latestExportableCompletedAt ?? recordInput.observation.completedAt,
        recordInput.observation.completedAt,
      );
    } catch (error) {
      if (!(error instanceof PublicEvidenceValidationError)) throw error;
      excluded.push({ index, reason: "unsafe_public_field" });
    }
  });
  records.sort((a, b) => a.recordId.localeCompare(b.recordId));
  return {
    bundle: {
      schemaVersion: PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION,
      exportPolicyVersion: PUBLIC_EXPORT_POLICY_VERSION,
      // Empty previews are intentionally unsignable and use a constant day so excluded
      // observation timestamps can never influence public output.
      createdDayUtc: latestExportableCompletedAt === null ? EMPTY_PREVIEW_DAY : utcDay(latestExportableCompletedAt),
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
  eventId: string;
  reason: PublicOperatorExclusionReason;
}

export interface LocalPublicPreviewV1 {
  bundle: PublicEvidencePreviewBundleV1;
  excluded: PublicOperatorExclusionV1[];
}

export interface LocalPublicExportV1 {
  bundle: PublicEvidenceBundleV1;
  stored: { path: string; created: boolean };
  excluded: PublicOperatorExclusionV1[];
}

export type PublicVerificationSummaryV1 =
  | { status: "cryptographically_valid"; bundleId: string; publisherKeyId: string; locallyVerified: false }
  | { status: "schema_rejected" | "digest_invalid" | "signature_invalid"; locallyVerified: false; detail?: string };

function assertOperatorEventIds(eventIds: readonly string[]): string[] {
  if (eventIds.length === 0 || eventIds.length > MAX_OPERATOR_EVENTS) {
    throw new PublicEvidenceValidationError(
      "public_selection_limit",
      `public evidence selection must contain 1..${MAX_OPERATOR_EVENTS} event ids`,
    );
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const eventId of eventIds) {
    if (!/^[0-9a-f]{64}$/.test(eventId)) {
      throw new PublicEvidenceValidationError(
        "public_selection_event_id",
        "public evidence event ids must be lowercase sha256 hex",
      );
    }
    if (seen.has(eventId)) continue;
    seen.add(eventId);
    unique.push(eventId);
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
  const eventIds = assertOperatorEventIds(input.eventIds);
  const replay = replayLabLedger(labLedgerPath(configDir));
  const byId = new Map(replay.events.map((event) => [event.eventId, event] as const));
  const projectInputs: ProjectPublicEvidenceRecordInput[] = [];
  const projectEventIds: string[] = [];
  const excluded: PublicOperatorExclusionV1[] = [];
  let sawObservation = false;

  for (const eventId of eventIds) {
    const event = byId.get(eventId);
    if (!event) {
      excluded.push({ eventId, reason: "event_not_found" });
      continue;
    }
    if (event.eventKind !== "observation") {
      excluded.push({ eventId, reason: "not_observation" });
      continue;
    }
    sawObservation = true;
    const projectedEvent = queryLabEventById(eventId, configDir);
    if (!projectedEvent) {
      excluded.push({ eventId, reason: "event_not_found" });
      continue;
    }
    if (projectedEvent.excluded) {
      excluded.push({ eventId, reason: "event_excluded" });
      continue;
    }
    const verdict = canonicalVerdictForObservation(event, configDir);
    if (!verdict) {
      excluded.push({ eventId, reason: "no_canonical_verdict" });
      continue;
    }
    projectInputs.push({ observation: event, verdict });
    projectEventIds.push(eventId);
  }

  if (!sawObservation) {
    throw new PublicEvidenceValidationError("public_selection_empty", "public evidence selection contains no observation events");
  }

  const projected = projectPublicEvidence({ records: projectInputs });
  for (const row of projected.excluded) {
    excluded.push({ eventId: projectEventIds[row.index]!, reason: row.reason });
  }
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
  const expectedPath = join(labExportDir(configDir), `${bundle.bundleId}.json`);
  const created = !existsSync(expectedPath);
  const path = writePublicEvidenceBundle(bundle, configDir);
  return { bundle, stored: { path, created }, excluded: preview.excluded };
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
  const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new PublicEvidenceValidationError("public_file_unsafe", "public evidence input must be a regular non-symlink file");
    }
    if (stats.size > MAX_PUBLIC_FILE_BYTES) {
      throw new PublicEvidenceValidationError("public_file_too_large", "public evidence input exceeds 2 MiB");
    }
    const bytes = readFileSync(fd);
    if (bytes.byteLength > MAX_PUBLIC_FILE_BYTES) {
      throw new PublicEvidenceValidationError("public_file_too_large", "public evidence input exceeds 2 MiB");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function parsePublicFile(path: string): unknown {
  return parseStrictPublicJson(readBoundedPublicFile(path), "public evidence input", "public_file_json");
}

export function verifyPublicEvidenceFile(path: string): PublicVerificationSummaryV1 {
  return summarizePublicEvidenceVerification(parsePublicFile(path));
}

export function importCommunityEvidenceFile(path: string, configDir?: string) {
  const imported = importCommunityEvidenceBundle(readBoundedPublicFile(path), configDir);
  return { ...imported, trustClass: "community_untrusted_v1" as const, locallyVerified: false as const };
}

export function importCommunityEvidenceValue(raw: unknown, configDir?: string) {
  const imported = importCommunityEvidenceBundle(raw, configDir);
  return { ...imported, trustClass: "community_untrusted_v1" as const, locallyVerified: false as const };
}

export function listCommunityEvidenceContext(configDir?: string) {
  return {
    evidence: listCommunityEvidence(configDir),
    trustClass: "community_untrusted_v1" as const,
    locallyVerified: false as const,
  };
}
