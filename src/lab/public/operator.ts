import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replayLabLedger } from "../ledger/store";
import { labExportDir, labLedgerPath } from "../paths";
import { queryLabEventById, queryLabVerdicts } from "../query";
import type { ObservationEvent } from "../events/types";
import { PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION, PUBLIC_EXPORT_POLICY_VERSION } from "./types";
import type {
  PublicEvidenceBundleV1,
  PublicEvidencePreviewBundleV1,
  PublicEvidenceRecordV1,
  PublicProjectionNotExportableReason,
} from "./types";
import type { ProjectPublicEvidenceRecordInput } from "./project";
import { projectPublicEvidenceRecord } from "./project";
import { signPublicEvidenceBundle, verifyPublicEvidenceBundle } from "./signature";
import { writePublicEvidenceBundle } from "./storage";
import { importCommunityEvidenceBundle, listCommunityEvidence } from "./community";
import { parseStrictPublicJson } from "./strict-json";
import { PublicEvidenceValidationError } from "./validate";

const MAX_OPERATOR_EVENTS = 256;
const MAX_PUBLIC_FILE_BYTES = 2 * 1024 * 1024;

export interface ProjectPublicEvidenceInput {
  createdDayUtc: string;
  records: ProjectPublicEvidenceRecordInput[];
}

export function projectPublicEvidence(input: ProjectPublicEvidenceInput): {
  bundle: PublicEvidencePreviewBundleV1;
  excluded: Array<{ index: number; reason: PublicProjectionNotExportableReason }>;
} {
  const records: PublicEvidenceRecordV1[] = [];
  const excluded: Array<{ index: number; reason: PublicProjectionNotExportableReason }> = [];
  input.records.forEach((recordInput, index) => {
    const projected = projectPublicEvidenceRecord(recordInput);
    if (projected.status === "exportable") records.push(projected.record);
    else excluded.push({ index, reason: projected.reason });
  });
  records.sort((a, b) => a.recordId.localeCompare(b.recordId));
  return {
    bundle: {
      schemaVersion: PUBLIC_EVIDENCE_BUNDLE_SCHEMA_VERSION,
      exportPolicyVersion: PUBLIC_EXPORT_POLICY_VERSION,
      createdDayUtc: input.createdDayUtc,
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

function utcDay(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new PublicEvidenceValidationError("public_selection_time", "selected observation has an invalid completion timestamp");
  }
  return date.toISOString().slice(0, 10);
}

function canonicalVerdictForObservation(
  observation: ObservationEvent,
  configDir?: string,
): ProjectPublicEvidenceRecordInput["verdict"] | null {
  const page = queryLabVerdicts(
    { subjectId: observation.subjectId, layer: observation.evidenceLayer, suiteId: observation.suiteId },
    undefined,
    200,
    configDir,
  );
  const verdict = page.items.find((row) =>
    row.suiteVersion === observation.suiteVersion && row.contributingEventIds.includes(observation.eventId),
  );
  return verdict?.verdict ?? null;
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
  let latestObservationCompletedAt: number | null = null;

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
    latestObservationCompletedAt = Math.max(latestObservationCompletedAt ?? event.completedAt, event.completedAt);
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

  if (latestObservationCompletedAt === null) {
    throw new PublicEvidenceValidationError("public_selection_empty", "public evidence selection contains no observation events");
  }

  const projected = projectPublicEvidence({
    createdDayUtc: utcDay(latestObservationCompletedAt),
    records: projectInputs,
  });
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
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new PublicEvidenceValidationError("public_file_unsafe", "public evidence input must be a regular non-symlink file");
  }
  if (stats.size > MAX_PUBLIC_FILE_BYTES) {
    throw new PublicEvidenceValidationError("public_file_too_large", "public evidence input exceeds 2 MiB");
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_PUBLIC_FILE_BYTES) {
    throw new PublicEvidenceValidationError("public_file_too_large", "public evidence input exceeds 2 MiB");
  }
  return bytes;
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
