import {
  LAB_QUERY_DEFAULT_PAGE_SIZE,
  LAB_QUERY_MAX_PAGE_SIZE,
} from "./constants";
import {
  closeLabReadConnection,
  countTable,
  openLabReadConnection,
  type LabReadConnection,
} from "./connection";
import {
  assertCursorFilters,
  artifactCursor,
  decodeLabCursor,
  encodeLabCursor,
  eventCursor,
  filterKeyFor,
  observationCursor,
  subjectCursor,
  verdictCursor,
} from "./cursor";
import {
  mapArtifactRow,
  mapEventListRow,
  mapObservationRow,
  mapSubjectJson,
  mapSubjectListRow,
  mapVerdictRow,
  parseEventPayloadToDto,
} from "./dto-map";
import { InvalidCursorError } from "./errors";
import { queryLabCatalog } from "./catalog";
import type {
  ArtifactFilters,
  ArtifactMetadataDto,
  EventFilters,
  EventListItemDto,
  LabEventDto,
  LabStatusDto,
  ObservationDto,
  ObservationFilters,
  PaginatedResult,
  SubjectDto,
  SubjectListItemDto,
  VerdictDto,
  VerdictFilters,
} from "./types";

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return LAB_QUERY_DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(limit, 1), LAB_QUERY_MAX_PAGE_SIZE);
}

export function queryLabStatus(configDir?: string): LabStatusDto {
  try {
    const conn = openLabReadConnection(configDir);
    try {
      return {
        projectionAvailable: true,
        sqliteSchemaVersion: conn.schemaVersion,
        projectionSpecVersion: conn.projectionSpecVersion,
        builtAtMs: conn.builtAtMs,
        eventCount: countTable(conn, "events"),
        subjectCount: countTable(conn, "subjects"),
        observationCount: countTable(conn, "observations"),
        claimCount: countTable(conn, "claims"),
        verdictCount: countTable(conn, "verdicts"),
        artifactCount: countTable(conn, "artifacts"),
        corruptionCount: countTable(conn, "corruption"),
      };
    } finally {
      closeLabReadConnection(conn);
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const code = String((err as { code: unknown }).code);
      if (code === "lab_projection_incompatible") {
        return { projectionAvailable: false, projectionIncompatible: true };
      }
    }
    return { projectionAvailable: false };
  }
}

function withConnection<T>(configDir: string | undefined, fn: (conn: LabReadConnection) => T): T {
  const conn = openLabReadConnection(configDir);
  try {
    return fn(conn);
  } finally {
    closeLabReadConnection(conn);
  }
}

export function queryLabVerdicts(
  filters: VerdictFilters = {},
  cursorRaw?: string | null,
  limit?: number,
  configDir?: string,
): PaginatedResult<VerdictDto> {
  const pageSize = clampLimit(limit);
  const filterRecord: Record<string, unknown> = { ...filters };
  const decoded = cursorRaw ? decodeLabCursor(cursorRaw) : null;
  if (cursorRaw && !decoded) throw new InvalidCursorError();
  if (decoded) assertCursorFilters(decoded, filterRecord, "verdicts");

  return withConnection(configDir, (conn) => {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.subjectId) {
      where.push("subject_id = ?");
      params.push(filters.subjectId);
    }
    if (filters.layer) {
      where.push("evidence_layer = ?");
      params.push(filters.layer);
    }
    if (filters.suiteId) {
      where.push("suite_id = ?");
      params.push(filters.suiteId);
    }
    if (filters.verdict) {
      where.push("verdict = ?");
      params.push(filters.verdict);
    }
    if (filters.from !== undefined) {
      where.push("as_of >= ?");
      params.push(filters.from);
    }
    if (filters.to !== undefined) {
      where.push("as_of <= ?");
      params.push(filters.to);
    }
    if (decoded && decoded.k === "verdicts") {
      where.push("(as_of < ? OR (as_of = ? AND projection_key > ?))");
      params.push(decoded.a, decoded.a, decoded.p);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = conn.db
      .query(
        `SELECT projection_key, subject_id, evidence_layer, suite_id, suite_version,
                suite_manifest_digest, projection_spec_version, verdict, as_of,
                scenario_manifest_digests_json, claim_source_digest,
                contributing_event_ids_json, contradicting_event_ids_json, notes_json
         FROM verdicts ${whereSql}
         ORDER BY as_of DESC, projection_key ASC
         LIMIT ?`,
      )
      .all(...params, pageSize + 1) as Array<Record<string, unknown>>;

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const items = pageRows.map(mapVerdictRow);
    let nextCursor: string | undefined;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1]!;
      nextCursor = encodeLabCursor(
        verdictCursor(Number(last.as_of), String(last.projection_key), filterRecord),
      );
    }
    return { items, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  });
}

export function queryLabSubjects(
  kind?: string,
  cursorRaw?: string | null,
  limit?: number,
  configDir?: string,
): PaginatedResult<SubjectListItemDto> {
  const pageSize = clampLimit(limit);
  const filterRecord: Record<string, unknown> = { kind };
  const decoded = cursorRaw ? decodeLabCursor(cursorRaw) : null;
  if (cursorRaw && !decoded) throw new InvalidCursorError();
  if (decoded) assertCursorFilters(decoded, filterRecord, "subjects");

  return withConnection(configDir, (conn) => {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (kind) {
      where.push("subject_kind = ?");
      params.push(kind);
    }
    if (decoded && decoded.k === "subjects") {
      where.push("subject_id > ?");
      params.push(decoded.s);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = conn.db
      .query(`SELECT subject_id, subject_kind FROM subjects ${whereSql} ORDER BY subject_id ASC LIMIT ?`)
      .all(...params, pageSize + 1) as Array<Record<string, unknown>>;

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const items = pageRows.map(mapSubjectListRow);
    let nextCursor: string | undefined;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1]!;
      nextCursor = encodeLabCursor(subjectCursor(String(last.subject_id), filterRecord));
    }
    return { items, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  });
}

export function queryLabSubjectById(subjectId: string, configDir?: string): SubjectDto | null {
  return withConnection(configDir, (conn) => {
    const row = conn.db
      .query("SELECT subject_json FROM subjects WHERE subject_id = ?")
      .get(subjectId) as { subject_json: string } | null;
    if (!row) return null;
    return mapSubjectJson(row.subject_json);
  });
}

export function queryLabObservations(
  filters: ObservationFilters = {},
  cursorRaw?: string | null,
  limit?: number,
  configDir?: string,
): PaginatedResult<ObservationDto> {
  const pageSize = clampLimit(limit);
  const filterRecord: Record<string, unknown> = { ...filters };
  const decoded = cursorRaw ? decodeLabCursor(cursorRaw) : null;
  if (cursorRaw && !decoded) throw new InvalidCursorError();
  if (decoded) assertCursorFilters(decoded, filterRecord, "observations");

  return withConnection(configDir, (conn) => {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.subjectId) {
      where.push("o.subject_id = ?");
      params.push(filters.subjectId);
    }
    if (filters.layer) {
      where.push("o.evidence_layer = ?");
      params.push(filters.layer);
    }
    if (filters.suiteId) {
      where.push("o.suite_id = ?");
      params.push(filters.suiteId);
    }
    if (filters.scenarioId) {
      where.push("o.scenario_id = ?");
      params.push(filters.scenarioId);
    }
    if (filters.outcome) {
      where.push("o.outcome = ?");
      params.push(filters.outcome);
    }
    if (filters.executionMode) {
      where.push("o.execution_mode = ?");
      params.push(filters.executionMode);
    }
    if (filters.from !== undefined) {
      where.push("o.completed_at >= ?");
      params.push(filters.from);
    }
    if (filters.to !== undefined) {
      where.push("o.completed_at <= ?");
      params.push(filters.to);
    }
    if (decoded && decoded.k === "observations") {
      where.push("(o.completed_at < ? OR (o.completed_at = ? AND o.event_id < ?))");
      params.push(decoded.c, decoded.c, decoded.e);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = conn.db
      .query(
        `SELECT o.event_id, o.subject_id, o.evidence_layer, o.suite_id, o.suite_version,
                o.suite_manifest_digest, o.scenario_id, o.scenario_version, o.scenario_manifest_digest,
                o.outcome, o.completed_at, o.execution_mode,
                e.excluded, e.exclusion_reason
         FROM observations o
         JOIN events e ON e.event_id = o.event_id
         ${whereSql}
         ORDER BY o.completed_at DESC, o.event_id DESC
         LIMIT ?`,
      )
      .all(...params, pageSize + 1) as Array<Record<string, unknown>>;

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const items = pageRows.map((row) =>
      mapObservationRow(row, Number(row.excluded) === 1, row.exclusion_reason ? String(row.exclusion_reason) : null),
    );
    let nextCursor: string | undefined;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1]!;
      nextCursor = encodeLabCursor(
        observationCursor(Number(last.completed_at), String(last.event_id), filterRecord),
      );
    }
    return { items, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  });
}

export function queryLabEvents(
  filters: EventFilters = {},
  cursorRaw?: string | null,
  limit?: number,
  configDir?: string,
): PaginatedResult<EventListItemDto> {
  const pageSize = clampLimit(limit);
  const filterRecord: Record<string, unknown> = { ...filters };
  const decoded = cursorRaw ? decodeLabCursor(cursorRaw) : null;
  if (cursorRaw && !decoded) throw new InvalidCursorError();
  if (decoded) assertCursorFilters(decoded, filterRecord, "events");

  return withConnection(configDir, (conn) => {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.eventKind) {
      where.push("e.event_kind = ?");
      params.push(filters.eventKind);
    }
    if (filters.from !== undefined) {
      where.push("e.recorded_at >= ?");
      params.push(filters.from);
    }
    if (filters.to !== undefined) {
      where.push("e.recorded_at <= ?");
      params.push(filters.to);
    }
    if (filters.excluded !== undefined) {
      where.push("e.excluded = ?");
      params.push(filters.excluded ? 1 : 0);
    }
    if (filters.subjectId) {
      where.push(
        "(EXISTS (SELECT 1 FROM observations ox WHERE ox.event_id = e.event_id AND ox.subject_id = ?) OR EXISTS (SELECT 1 FROM claims cx WHERE cx.event_id = e.event_id AND cx.subject_id = ?))",
      );
      params.push(filters.subjectId, filters.subjectId);
    }
    if (decoded && decoded.k === "events") {
      where.push("(e.recorded_at < ? OR (e.recorded_at = ? AND e.event_id < ?))");
      params.push(decoded.r, decoded.r, decoded.e);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = conn.db
      .query(
        `SELECT e.event_id, e.event_kind, e.recorded_at, e.excluded, e.exclusion_reason
         FROM events e
         ${whereSql}
         ORDER BY e.recorded_at DESC, e.event_id DESC
         LIMIT ?`,
      )
      .all(...params, pageSize + 1) as Array<Record<string, unknown>>;

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const items = pageRows.map(mapEventListRow);
    let nextCursor: string | undefined;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1]!;
      nextCursor = encodeLabCursor(
        eventCursor(Number(last.recorded_at), String(last.event_id), filterRecord),
      );
    }
    return { items, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  });
}

export function queryLabEventById(eventId: string, configDir?: string): LabEventDto | null {
  return withConnection(configDir, (conn) => {
    const row = conn.db
      .query(
        "SELECT event_id, payload_json, excluded, exclusion_reason FROM events WHERE event_id = ?",
      )
      .get(eventId) as { payload_json: string; excluded: number; exclusion_reason: string | null } | null;
    if (!row) return null;
    const excluded = Number(row.excluded) === 1;
    const exclusionReason = row.exclusion_reason ? String(row.exclusion_reason) : null;
    return parseEventPayloadToDto(row.payload_json, excluded, exclusionReason);
  });
}

export function queryLabArtifacts(
  filters: ArtifactFilters = {},
  cursorRaw?: string | null,
  limit?: number,
  configDir?: string,
): PaginatedResult<ArtifactMetadataDto> {
  const pageSize = clampLimit(limit);
  const filterRecord: Record<string, unknown> = { ...filters };
  const decoded = cursorRaw ? decodeLabCursor(cursorRaw) : null;
  if (cursorRaw && !decoded) throw new InvalidCursorError();
  if (decoded) assertCursorFilters(decoded, filterRecord, "artifacts");

  return withConnection(configDir, (conn) => {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.status) {
      where.push("status = ?");
      params.push(filters.status);
    }
    if (filters.artifactClass) {
      where.push("artifact_class = ?");
      params.push(filters.artifactClass);
    }
    if (decoded && decoded.k === "artifacts") {
      where.push("digest > ?");
      params.push(decoded.d);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = conn.db
      .query(
        `SELECT digest, artifact_class, media_type, byte_count, status, last_error
         FROM artifacts ${whereSql} ORDER BY digest ASC LIMIT ?`,
      )
      .all(...params, pageSize + 1) as Array<Record<string, unknown>>;

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const items = pageRows.map(mapArtifactRow);
    let nextCursor: string | undefined;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1]!;
      nextCursor = encodeLabCursor(artifactCursor(String(last.digest), filterRecord));
    }
    return { items, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  });
}

export function queryLabArtifactByDigest(digest: string, configDir?: string): ArtifactMetadataDto | null {
  return withConnection(configDir, (conn) => {
    const row = conn.db
      .query(
        "SELECT digest, artifact_class, media_type, byte_count, status, last_error FROM artifacts WHERE digest = ?",
      )
      .get(digest) as Record<string, unknown> | null;
    if (!row) return null;
    return mapArtifactRow(row);
  });
}

export function queryLabCatalogEntries(
  filters: { layer?: string; suiteId?: string } = {},
): ReturnType<typeof queryLabCatalog> {
  return queryLabCatalog({
    layer: filters.layer as import("../constants").EvidenceLayer | undefined,
    suiteId: filters.suiteId,
  });
}

export { filterKeyFor };
