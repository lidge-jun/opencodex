import { readJsonOrThrow } from "../fetch-json";
import {
  artifactDigestsForVerdict,
  isPlainObject,
  parseArtifactMetadata,
  parseLabEvent,
  parseLabStatus,
  parseObservationsPage,
  parseSubjectDetail,
  parseSubjectPage,
  parseVerdictPage,
  type ArtifactMetadataDto,
  type LabEventDto,
  type LabStatusDto,
  type ObservationDto,
  type PaginatedObservations,
  type PaginatedSubjects,
  type PaginatedVerdicts,
  type SubjectDetailDto,
  type SubjectListItemDto,
  type VerdictDto,
  type VerdictQueryFilters,
} from "./compatibility-matrix-shared";

const PAGE_LIMIT = 50;
const MAX_PAGES = 200;
const DETAIL_CONCURRENCY = 6;
const MAX_DETAIL_REFERENCES = 200;

async function fetchLabJson<T>(apiBase: string, path: string, signal: AbortSignal): Promise<T | undefined> {
  const res = await fetch(`${apiBase}${path}`, { signal });
  return readJsonOrThrow<T>(res);
}

function buildQuery(params: Record<string, string | undefined>, cursor?: string): string {
  const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  if (cursor) query.set("cursor", cursor);
  return query.toString();
}

export class LabDataContractError extends Error {}

function invalidResponse(): LabDataContractError {
  return new LabDataContractError();
}

function assertPaginationContract(raw: Record<string, unknown>, hasMore: boolean, nextCursor: string | undefined) {
  if (raw.hasMore !== undefined && typeof raw.hasMore !== "boolean") throw invalidResponse();
  if (raw.nextCursor !== undefined && typeof raw.nextCursor !== "string") throw invalidResponse();
  if (hasMore && !nextCursor) throw invalidResponse();
}

function parseStrictVerdictPage(raw: unknown): PaginatedVerdicts {
  if (!isPlainObject(raw) || !Array.isArray(raw.verdicts)) throw invalidResponse();
  const page = parseVerdictPage(raw);
  if (page.verdicts.length !== raw.verdicts.length) throw invalidResponse();
  assertPaginationContract(raw, page.hasMore, page.nextCursor);
  return page;
}

function parseStrictSubjectPage(raw: unknown): PaginatedSubjects {
  if (!isPlainObject(raw) || !Array.isArray(raw.subjects)) throw invalidResponse();
  const page = parseSubjectPage(raw);
  if (page.subjects.length !== raw.subjects.length) throw invalidResponse();
  assertPaginationContract(raw, page.hasMore, page.nextCursor);
  return page;
}

function parseStrictObservationPage(raw: unknown): PaginatedObservations {
  if (!isPlainObject(raw) || !Array.isArray(raw.observations)) throw invalidResponse();
  const page = parseObservationsPage(raw);
  if (page.observations.length !== raw.observations.length) throw invalidResponse();
  assertPaginationContract(raw, page.hasMore, page.nextCursor);
  return page;
}

export async function fetchLabStatus(apiBase: string, signal: AbortSignal): Promise<LabStatusDto> {
  const raw = await fetchLabJson<unknown>(apiBase, "/api/lab/status", signal);
  const status = parseLabStatus(raw);
  if (!status) throw invalidResponse();
  return status;
}

export async function fetchVerdictPage(
  apiBase: string,
  filters: VerdictQueryFilters,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<PaginatedVerdicts> {
  const raw = await fetchLabJson<unknown>(
    apiBase,
    `/api/lab/verdicts?${buildQuery({
      layer: filters.layer,
      verdict: filters.verdict,
      subjectId: filters.subjectId,
      suiteId: filters.suiteId,
    }, cursor)}`,
    signal,
  );
  return parseStrictVerdictPage(raw);
}

export async function fetchSubjectPage(
  apiBase: string,
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<PaginatedSubjects> {
  const raw = await fetchLabJson<unknown>(apiBase, `/api/lab/subjects?${buildQuery({}, cursor)}`, signal);
  return parseStrictSubjectPage(raw);
}

type CollectedPages<T> = {
  rows: T[];
  truncated: boolean;
};

async function collectPages<T>(
  loadPage: (cursor: string | undefined) => Promise<{ rows: T[]; hasMore: boolean; nextCursor?: string }>,
): Promise<CollectedPages<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const page = await loadPage(cursor);
    rows.push(...page.rows);
    if (!page.hasMore) return { rows, truncated: false };
    const next = page.nextCursor;
    if (!next || seen.has(next) || next === cursor) {
      throw new LabDataContractError();
    }
    seen.add(next);
    cursor = next;
  }
  return { rows, truncated: true };
}

export async function fetchAllSubjects(apiBase: string, signal: AbortSignal): Promise<CollectedPages<SubjectListItemDto>> {
  return collectPages(async cursor => {
    const page = await fetchSubjectPage(apiBase, cursor, signal);
    return { rows: page.subjects, hasMore: page.hasMore, nextCursor: page.nextCursor };
  });
}

export async function fetchSubjectDetail(
  apiBase: string,
  subjectId: string,
  signal: AbortSignal,
): Promise<SubjectDetailDto> {
  const raw = await fetchLabJson<unknown>(apiBase, `/api/lab/subjects/${encodeURIComponent(subjectId)}`, signal);
  const subject = parseSubjectDetail(raw);
  if (!subject) throw invalidResponse();
  return subject;
}

export async function fetchObservationsPage(
  apiBase: string,
  filters: { subjectId: string; layer?: string; suiteId?: string },
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<PaginatedObservations> {
  const raw = await fetchLabJson<unknown>(
    apiBase,
    `/api/lab/observations?${buildQuery({
      subjectId: filters.subjectId,
      layer: filters.layer,
      suiteId: filters.suiteId,
    }, cursor)}`,
    signal,
  );
  return parseStrictObservationPage(raw);
}

async function fetchAllObservations(
  apiBase: string,
  filters: { subjectId: string; layer?: string; suiteId?: string },
  signal: AbortSignal,
): Promise<CollectedPages<ObservationDto>> {
  return collectPages(async cursor => {
    const page = await fetchObservationsPage(apiBase, filters, cursor, signal);
    return { rows: page.observations, hasMore: page.hasMore, nextCursor: page.nextCursor };
  });
}

export async function fetchEventById(apiBase: string, eventId: string, signal: AbortSignal): Promise<LabEventDto> {
  const raw = await fetchLabJson<unknown>(apiBase, `/api/lab/events/${encodeURIComponent(eventId)}`, signal);
  const event = parseLabEvent(raw);
  if (!event) throw invalidResponse();
  return event;
}

export async function fetchArtifactByDigest(
  apiBase: string,
  digest: string,
  signal: AbortSignal,
): Promise<ArtifactMetadataDto> {
  const raw = await fetchLabJson<unknown>(apiBase, `/api/lab/artifacts/${encodeURIComponent(digest)}`, signal);
  const artifact = parseArtifactMetadata(raw);
  if (!artifact) throw invalidResponse();
  return artifact;
}

export type PassiveProductionSummaryDto = {
  verificationStatus: "not_verification";
  summary: {
    subjectId: string;
    verificationStatus: "not_verification";
    recentProductionAttempts: number;
    recentSuccessfulAttempts: number;
    recentRouteErrorSignals: number;
    lastObservedProductionAttempt?: number;
  };
};

function parsePassiveProductionSummary(raw: unknown): PassiveProductionSummaryDto {
  if (!isPlainObject(raw) || raw.verificationStatus !== "not_verification" || !isPlainObject(raw.summary)) {
    throw invalidResponse();
  }
  const summary = raw.summary;
  if (summary.verificationStatus !== "not_verification"
    || typeof summary.subjectId !== "string"
    || typeof summary.recentProductionAttempts !== "number"
    || typeof summary.recentSuccessfulAttempts !== "number"
    || typeof summary.recentRouteErrorSignals !== "number"
    || (summary.lastObservedProductionAttempt !== undefined && typeof summary.lastObservedProductionAttempt !== "number")) {
    throw invalidResponse();
  }
  return { verificationStatus: "not_verification", summary: summary as PassiveProductionSummaryDto["summary"] };
}

export async function fetchPassiveProductionSummary(
  apiBase: string,
  subjectId: string,
  signal: AbortSignal,
): Promise<PassiveProductionSummaryDto> {
  const raw = await fetchLabJson<unknown>(
    apiBase,
    `/api/lab/production-signals?${buildQuery({ subjectId })}`,
    signal,
  );
  return parsePassiveProductionSummary(raw);
}

export type CommunityEvidenceSummaryRowDto = {
  trustClass: "community_untrusted_v1";
  status: "cryptographically_valid";
  bundleId: string;
  publisherKeyId: string;
  activeRecordCount: number;
  revokedRecordCount: number;
};

export type CommunityEvidenceContextDto = {
  evidence: CommunityEvidenceSummaryRowDto[];
  trustClass: "community_untrusted_v1";
  locallyVerified: false;
};

function hasOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(raw).every(key => allowedSet.has(key));
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseCommunityEvidenceContext(raw: unknown): CommunityEvidenceContextDto | null {
  if (!isPlainObject(raw)
    || !hasOnlyKeys(raw, ["evidence", "trustClass", "locallyVerified"])
    || raw.trustClass !== "community_untrusted_v1"
    || raw.locallyVerified !== false
    || !Array.isArray(raw.evidence)
    || raw.evidence.length > 4096) {
    return null;
  }
  const evidence: CommunityEvidenceSummaryRowDto[] = [];
  for (const value of raw.evidence) {
    if (!isPlainObject(value)
      || !hasOnlyKeys(value, [
        "trustClass", "status", "bundleId", "publisherKeyId",
        "activeRecordCount", "revokedRecordCount",
      ])
      || value.trustClass !== "community_untrusted_v1"
      || value.status !== "cryptographically_valid"
      || !isSha256Hex(value.bundleId)
      || !isSha256Hex(value.publisherKeyId)
      || !isNonNegativeInteger(value.activeRecordCount)
      || !isNonNegativeInteger(value.revokedRecordCount)) {
      return null;
    }
    evidence.push({
      trustClass: "community_untrusted_v1",
      status: "cryptographically_valid",
      bundleId: value.bundleId,
      publisherKeyId: value.publisherKeyId,
      activeRecordCount: value.activeRecordCount,
      revokedRecordCount: value.revokedRecordCount,
    });
  }
  return { evidence, trustClass: "community_untrusted_v1", locallyVerified: false };
}

export async function fetchCommunityEvidenceContext(
  apiBase: string,
  signal: AbortSignal,
): Promise<CommunityEvidenceContextDto> {
  const raw = await fetchLabJson<unknown>(apiBase, "/api/lab/public/community", signal);
  const context = parseCommunityEvidenceContext(raw);
  if (!context) throw invalidResponse();
  return context;
}

export type LabPageData = {
  status: LabStatusDto;
  verdicts: VerdictDto[];
  subjects: SubjectListItemDto[];
  subjectsTruncated: boolean;
  hasMore: boolean;
  nextCursor?: string;
  community: CommunityEvidenceContextDto | null;
};

export async function fetchLabPageData(
  apiBase: string,
  filters: VerdictQueryFilters,
  signal: AbortSignal,
): Promise<LabPageData> {
  const [status, community] = await Promise.all([
    fetchLabStatus(apiBase, signal),
    fetchCommunityEvidenceContext(apiBase, signal).catch(error => {
      if (signal.aborted) throw error;
      return null;
    }),
  ]);
  if (!status.projectionAvailable) {
    return { status, verdicts: [], subjects: [], subjectsTruncated: false, hasMore: false, community };
  }
  const [verdictPage, subjects] = await Promise.all([
    fetchVerdictPage(apiBase, filters, undefined, signal),
    fetchAllSubjects(apiBase, signal),
  ]);
  return {
    status,
    verdicts: verdictPage.verdicts,
    subjects: subjects.rows,
    subjectsTruncated: subjects.truncated,
    hasMore: verdictPage.hasMore,
    nextCursor: verdictPage.nextCursor,
    community,
  };
}

export async function fetchMoreVerdicts(
  apiBase: string,
  filters: VerdictQueryFilters,
  cursor: string,
  signal: AbortSignal,
): Promise<PaginatedVerdicts> {
  return fetchVerdictPage(apiBase, filters, cursor, signal);
}

export type VerdictDetailData = {
  subject: SubjectDetailDto;
  observations: ObservationDto[];
  observationsTruncated: boolean;
  events: LabEventDto[];
  artifacts: ArtifactMetadataDto[];
  production: PassiveProductionSummaryDto | null;
};

async function mapSettledBounded<TItem, TResult>(
  items: readonly TItem[],
  concurrency: number,
  signal: AbortSignal,
  mapper: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const limited = items.slice(0, MAX_DETAIL_REFERENCES);
  const results: TResult[] = [];
  let index = 0;
  const worker = async () => {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const current = index++;
      if (current >= limited.length) return;
      try {
        results.push(await mapper(limited[current]!));
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
  };
  const workerCount = Math.min(concurrency, limited.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function fetchVerdictDetail(
  apiBase: string,
  verdict: VerdictDto,
  signal: AbortSignal,
): Promise<VerdictDetailData> {
  const eventIds = [...new Set([...verdict.contributingEventIds, ...verdict.contradictingEventIds])];
  const digests = artifactDigestsForVerdict(verdict);
  const observationFilters = {
    subjectId: verdict.subjectId,
    layer: verdict.evidenceLayer,
    suiteId: verdict.suiteId,
  };
  const [subject, observations, events, artifacts, production] = await Promise.all([
    fetchSubjectDetail(apiBase, verdict.subjectId, signal),
    fetchAllObservations(apiBase, observationFilters, signal),
    mapSettledBounded(eventIds, DETAIL_CONCURRENCY, signal, id => fetchEventById(apiBase, id, signal)),
    mapSettledBounded(digests, DETAIL_CONCURRENCY, signal, digest => fetchArtifactByDigest(apiBase, digest, signal)),
    fetchPassiveProductionSummary(apiBase, verdict.subjectId, signal).catch(error => {
      if (signal.aborted) throw error;
      return null;
    }),
  ]);
  return {
    subject,
    observations: observations.rows,
    observationsTruncated: observations.truncated,
    events,
    artifacts,
    production,
  };
}
