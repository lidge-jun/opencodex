/**
 * CL-04 read-only Compatibility Lab management API.
 *
 * - GET /api/lab/status
 * - GET /api/lab/verdicts
 * - GET /api/lab/subjects
 * - GET /api/lab/subjects/:subjectId
 * - GET /api/lab/observations
 * - GET /api/lab/events
 * - GET /api/lab/events/:eventId
 * - GET /api/lab/artifacts
 * - GET /api/lab/artifacts/:digest
 * - GET /api/lab/catalog
 */

import {
  ARTIFACT_CLASSES,
  EVIDENCE_LAYERS,
  EXECUTION_MODES,
  EVENT_KINDS,
  OUTCOMES,
  VERDICTS,
  type EvidenceLayer,
  type ExecutionMode,
  type LabEventKind,
  type ObservationOutcome,
  type CompatibilityVerdict,
} from "../../lab/constants";
import {
  InvalidCursorError,
  LabProjectionIncompatibleError,
  LabProjectionUnavailableError,
  LAB_QUERY_MAX_PAGE_SIZE,
  PASSIVE_PRODUCTION_MAX_LIMIT,
  queryLabArtifactByDigest,
  queryLabArtifacts,
  queryLabCatalogEntries,
  queryLabEventById,
  queryLabEvents,
  queryLabObservations,
  queryLabStatus,
  queryLabSubjectById,
  queryLabSubjects,
  queryLabVerdicts,
  queryPassiveProductionSignals,
} from "../../lab/query";
import {
  exportLocalPublicEvidence,
  importCommunityEvidenceValue,
  listCommunityEvidenceContext,
  parseStrictPublicJson,
  previewLocalPublicEvidence,
  summarizePublicEvidenceVerification,
  PublicEvidenceValidationError,
} from "../../lab/public";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

function parseQueryInt(raw: string | null): number | undefined | "invalid" {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "invalid";
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : "invalid";
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  ctx: ManagementContext,
): Response {
  return jsonResponse({ error: { code, message } }, status, ctx.req, ctx.config);
}

function projectionErrorResponse(err: unknown, ctx: ManagementContext): Response | null {
  if (err instanceof LabProjectionUnavailableError) {
    return errorResponse("lab_projection_unavailable", "lab projection is not available", 503, ctx);
  }
  if (err instanceof LabProjectionIncompatibleError) {
    return errorResponse("lab_projection_incompatible", "lab projection schema or spec version is incompatible", 503, ctx);
  }
  if (err instanceof InvalidCursorError) {
    return errorResponse("invalid_cursor", "invalid cursor", 400, ctx);
  }
  return null;
}

function parseLimit(
  raw: string | null,
  ctx: ManagementContext,
  max = LAB_QUERY_MAX_PAGE_SIZE,
): number | undefined | Response {
  const parsed = raw === null ? undefined : parseQueryInt(raw);
  if (parsed === "invalid") {
    return errorResponse(
      "invalid_limit",
      `limit must be an integer from 1 to ${max}`,
      400,
      ctx,
    );
  }
  if (parsed !== undefined && (parsed < 1 || parsed > max)) {
    return errorResponse(
      "invalid_limit",
      `limit must be an integer from 1 to ${max}`,
      400,
      ctx,
    );
  }
  return parsed;
}

function parseRange(
  fromRaw: string | null,
  toRaw: string | null,
  ctx: ManagementContext,
): { from?: number; to?: number } | Response {
  const fromParsed = parseQueryInt(fromRaw);
  if (fromParsed === "invalid") {
    return errorResponse("invalid_range", "from must be an integer timestamp", 400, ctx);
  }
  const toParsed = parseQueryInt(toRaw);
  if (toParsed === "invalid") {
    return errorResponse("invalid_range", "to must be an integer timestamp", 400, ctx);
  }
  if (fromParsed !== undefined && toParsed !== undefined && fromParsed > toParsed) {
    return errorResponse("invalid_range", "from must not be after to", 400, ctx);
  }
  return { from: fromParsed, to: toParsed };
}

function parseLayer(raw: string | null, ctx: ManagementContext): EvidenceLayer | undefined | Response {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!EVIDENCE_LAYERS.includes(trimmed as EvidenceLayer)) {
    return errorResponse("invalid_layer", "layer must be a supported evidence layer", 400, ctx);
  }
  return trimmed as EvidenceLayer;
}

function parseVerdict(raw: string | null, ctx: ManagementContext): CompatibilityVerdict | undefined | Response {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!VERDICTS.includes(trimmed as CompatibilityVerdict)) {
    return errorResponse("invalid_verdict", "verdict must be a supported compatibility verdict", 400, ctx);
  }
  return trimmed as CompatibilityVerdict;
}

function parseEventKind(raw: string | null, ctx: ManagementContext): LabEventKind | undefined | Response {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!EVENT_KINDS.includes(trimmed as LabEventKind)) {
    return errorResponse("invalid_event_kind", "eventKind must be a supported lab event kind", 400, ctx);
  }
  return trimmed as LabEventKind;
}

function parseOutcome(raw: string | null, ctx: ManagementContext): ObservationOutcome | undefined | Response {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!OUTCOMES.includes(trimmed as ObservationOutcome)) {
    return errorResponse("invalid_outcome", "outcome must be a supported observation outcome", 400, ctx);
  }
  return trimmed as ObservationOutcome;
}

function parseExecutionMode(raw: string | null, ctx: ManagementContext): ExecutionMode | undefined | Response {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!EXECUTION_MODES.includes(trimmed as ExecutionMode)) {
    return errorResponse("invalid_execution_mode", "executionMode must be a supported lab execution mode", 400, ctx);
  }
  return trimmed as ExecutionMode;
}

function rejectUnsafeId(id: string, ctx: ManagementContext): Response | null {
  if (id.includes("/") || id.includes("\\") || id.includes("%2f") || id.includes("%5c")) {
    return errorResponse("not_found", "unknown resource", 404, ctx);
  }
  if (id.length === 0 || id.length > 256) {
    return errorResponse("not_found", "unknown resource", 404, ctx);
  }
  return null;
}

function decodePathSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function paginatedEnvelope<T>(page: { items: T[]; nextCursor?: string; hasMore: boolean }, key: string) {
  return {
    [key]: page.items,
    hasMore: page.hasMore,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

const MAX_PUBLIC_REQUEST_BYTES = 2 * 1024 * 1024;

async function readBoundedPublicJson(req: Request): Promise<unknown> {
  const lengthRaw = req.headers.get("content-length");
  if (lengthRaw) {
    const length = Number(lengthRaw);
    if (!Number.isFinite(length) || length < 0 || length > MAX_PUBLIC_REQUEST_BYTES) {
      throw new PublicEvidenceValidationError(
        "public_request_too_large",
        "public evidence request exceeds 2 MiB",
      );
    }
  }
  if (!req.body) {
    throw new PublicEvidenceValidationError("public_request_body", "JSON body is required");
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PUBLIC_REQUEST_BYTES) {
      await reader.cancel();
      throw new PublicEvidenceValidationError(
        "public_request_too_large",
        "public evidence request exceeds 2 MiB",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseStrictPublicJson(bytes, "public evidence request");
}

function publicEventIds(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PublicEvidenceValidationError("public_request_body", "request body must be an object");
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "eventIds") {
    throw new PublicEvidenceValidationError("public_request_body", "only eventIds is accepted");
  }
  const eventIds = (raw as { eventIds?: unknown }).eventIds;
  if (!Array.isArray(eventIds) || !eventIds.every((value) => typeof value === "string")) {
    throw new PublicEvidenceValidationError("public_request_body", "eventIds must be a string array");
  }
  return eventIds as string[];
}

function publicBundleValue(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PublicEvidenceValidationError("public_request_body", "request body must be an object");
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "bundle") {
    throw new PublicEvidenceValidationError("public_request_body", "only bundle is accepted");
  }
  return (raw as { bundle?: unknown }).bundle;
}

function publicErrorResponse(err: unknown, ctx: ManagementContext): Response {
  if (err instanceof PublicEvidenceValidationError) {
    const status = err.code === "community_cache_busy" ? 503 : 400;
    const response = errorResponse(err.code, err.message, status, ctx);
    if (status === 503) response.headers.set("Retry-After", "1");
    return response;
  }
  const projected = projectionErrorResponse(err, ctx);
  if (projected) return projected;
  return errorResponse("public_evidence_internal", "internal public evidence failure", 500, ctx);
}

export async function handleLabRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;
  if (!url.pathname.startsWith("/api/lab")) return null;

  if (req.method === "GET" && url.pathname === "/api/lab/public/community") {
    try {
      return jsonResponse(listCommunityEvidenceContext(), 200, req, config);
    } catch (err) {
      return publicErrorResponse(err, ctx);
    }
  }

  if (req.method === "POST") {
    if (url.pathname === "/api/lab/public/preview") {
      try {
        const body = await readBoundedPublicJson(req);
        return jsonResponse(
          previewLocalPublicEvidence({ eventIds: publicEventIds(body) }),
          200,
          req,
          config,
        );
      } catch (err) {
        return publicErrorResponse(err, ctx);
      }
    }
    if (url.pathname === "/api/lab/public/export") {
      try {
        const body = await readBoundedPublicJson(req);
        return jsonResponse(
          exportLocalPublicEvidence({ eventIds: publicEventIds(body) }),
          200,
          req,
          config,
        );
      } catch (err) {
        return publicErrorResponse(err, ctx);
      }
    }
    if (url.pathname === "/api/lab/public/verify") {
      try {
        const body = await readBoundedPublicJson(req);
        const result = summarizePublicEvidenceVerification(publicBundleValue(body));
        return jsonResponse(
          result,
          result.status === "cryptographically_valid" ? 200 : 400,
          req,
          config,
        );
      } catch (err) {
        return publicErrorResponse(err, ctx);
      }
    }
    if (url.pathname === "/api/lab/public/community/import") {
      try {
        const body = await readBoundedPublicJson(req);
        return jsonResponse(
          importCommunityEvidenceValue(publicBundleValue(body)),
          200,
          req,
          config,
        );
      } catch (err) {
        return publicErrorResponse(err, ctx);
      }
    }
    return null;
  }

  if (req.method !== "GET") return null;

  if (url.pathname === "/api/lab/status") {
    return jsonResponse(queryLabStatus(), 200, req, config);
  }

  if (url.pathname === "/api/lab/production-signals") {
    const subjectId = url.searchParams.get("subjectId")?.trim();
    if (!subjectId) return errorResponse("invalid_subject", "subjectId is required", 400, ctx);
    const limit = parseLimit(url.searchParams.get("limit"), ctx, PASSIVE_PRODUCTION_MAX_LIMIT);
    if (limit instanceof Response) return limit;
    try {
      return jsonResponse(queryPassiveProductionSignals(subjectId, limit), 200, req, config);
    } catch {
      return errorResponse("invalid_subject", "subjectId must be an exact Lab route subject id", 400, ctx);
    }
  }

  if (url.pathname === "/api/lab/catalog") {
    const layerRaw = url.searchParams.get("layer");
    const layerParsed = layerRaw ? parseLayer(layerRaw, ctx) : undefined;
    if (layerParsed instanceof Response) return layerParsed;
    const suiteId = url.searchParams.get("suiteId")?.trim() || url.searchParams.get("suite")?.trim() || undefined;
    try {
      const scenarios = queryLabCatalogEntries({ layer: layerParsed, suiteId });
      return jsonResponse({ scenarios }, 200, req, config);
    } catch (err) {
      const mapped = projectionErrorResponse(err, ctx);
      if (mapped) return mapped;
      return errorResponse("server_error", "internal lab read failure", 500, ctx);
    }
  }

  if (url.pathname === "/api/lab/verdicts") {
    const limit = parseLimit(url.searchParams.get("limit"), ctx);
    if (limit instanceof Response) return limit;
    const range = parseRange(url.searchParams.get("from"), url.searchParams.get("to"), ctx);
    if (range instanceof Response) return range;
    const layer = parseLayer(url.searchParams.get("layer"), ctx);
    if (layer instanceof Response) return layer;
    const verdict = parseVerdict(url.searchParams.get("verdict"), ctx);
    if (verdict instanceof Response) return verdict;
    try {
      const page = queryLabVerdicts({
        subjectId: url.searchParams.get("subjectId")?.trim() || undefined,
        layer,
        suiteId: url.searchParams.get("suiteId")?.trim() || undefined,
        verdict,
        from: range.from,
        to: range.to,
      }, url.searchParams.get("cursor"), limit);
      return jsonResponse(paginatedEnvelope(page, "verdicts"), 200, req, config);
    } catch (err) {
      const mapped = projectionErrorResponse(err, ctx);
      if (mapped) return mapped;
      return errorResponse("server_error", "internal lab read failure", 500, ctx);
    }
  }

  if (url.pathname === "/api/lab/subjects") {
    const limit = parseLimit(url.searchParams.get("limit"), ctx);
    if (limit instanceof Response) return limit;
    try {
      const page = queryLabSubjects(url.searchParams.get("kind")?.trim() || undefined, url.searchParams.get("cursor"), limit);
      return jsonResponse(paginatedEnvelope(page, "subjects"), 200, req, config);
    } catch (err) {
      const mapped = projectionErrorResponse(err, ctx);
      if (mapped) return mapped;
      return errorResponse("server_error", "internal lab read failure", 500, ctx);
    }
  }

  const subjectMatch = url.pathname.match(/^\/api\/lab\/subjects\/([^/]+)$/);
  if (subjectMatch) {
    const subjectId = decodePathSegment(subjectMatch[1]!);
    if (subjectId === null) return errorResponse("not_found", "unknown resource", 404, ctx);
    const unsafe = rejectUnsafeId(subjectId, ctx);
    if (unsafe) return unsafe;
    try {
      const subject = queryLabSubjectById(subjectId);
      if (!subject) return errorResponse("not_found", "unknown subject", 404, ctx);
      return jsonResponse({ subjectId, subject }, 200, req, config);
    } catch (err) {
      const mapped = projectionErrorResponse(err, ctx);
      if (mapped) return mapped;
      return errorResponse("server_error", "internal lab read failure", 500, ctx);
    }
  }

  if (url.pathname === "/api/lab/observations") {
    const limit = parseLimit(url.searchParams.get("limit"), ctx);
    if (limit instanceof Response) return limit;
    const range = parseRange(url.searchParams.get("from"), url.searchParams.get("to"), ctx);
    if (range instanceof Response) return range;
    const layer = parseLayer(url.searchParams.get("layer"), ctx);
    if (layer instanceof Response) return layer;
    const outcome = parseOutcome(url.searchParams.get("outcome"), ctx);
    if (outcome instanceof Response) return outcome;
    const executionMode = parseExecutionMode(url.searchParams.get("executionMode"), ctx);
    if (executionMode instanceof Response) return executionMode;
    try {
      const page = queryLabObservations({
        subjectId: url.searchParams.get("subjectId")?.trim() || undefined,
        layer,
        suiteId: url.searchParams.get("suiteId")?.trim() || undefined,
        scenarioId: url.searchParams.get("scenarioId")?.trim() || undefined,
        outcome,
        executionMode,
        from: range.from,
        to: range.to,
      }, url.searchParams.get("cursor"), limit);
      return jsonResponse(paginatedEnvelope(page, "observations"), 200, req, config);
    } catch (err) {
      const mapped = projectionErrorResponse(err, ctx);
      if (mapped) return mapped;
      return errorResponse("server_error", "internal lab read failure", 500, ctx);
    }
  }

  if (url.pathname === "/api/lab/events") {
    const limit = parseLimit(url.searchParams.get("limit"), ctx);
    if (limit instanceof Response) return limit;
    const range = parseRange(url.searchParams.get("from"), url.searchParams.get("to"), ctx);
    if (range instanceof Response) return range;
    const eventKind = parseEventKind(url.searchParams.get("eventKind"), ctx);
    if (eventKind instanceof Response) return eventKind;
    const excludedRaw = url.searchParams.get("excluded");
    if (excludedRaw !== null && excludedRaw !== "true" && excludedRaw !== "false") {
      return errorResponse("invalid_excluded", "excluded must be true or false", 400, ctx);
    }
    const excluded = excludedRaw === "true" ? true : excludedRaw === "false" ? false : undefined;
    try {
      const page = queryLabEvents({
        eventKind,
        subjectId: url.searchParams.get("subjectId")?.trim() || undefined,
        from: range.from,
        to: range.to,
        excluded,
      }, url.searchParams.get("cursor"), limit);
      return jsonResponse(paginatedEnvelope(page, "events"), 200, req, config);
    } catch (err) {
      const mapped = projectionErrorResponse(err, ctx);
      if (mapped) return mapped;
      return errorResponse("server_error", "internal lab read failure", 500, ctx);
    }
  }

  const eventMatch = url.pathname.match(/^\/api\/lab\/events\/([^/]+)$/);
  if (eventMatch) {
    const eventId = decodePathSegment(eventMatch[1]!);
    if (eventId === null) return errorResponse("not_found", "unknown resource", 404, ctx);
    const unsafe = rejectUnsafeId(eventId, ctx);
    if (unsafe) return unsafe;
    try {
      const event = queryLabEventById(eventId);
      if (!event) return errorResponse("not_found", "unknown event", 404, ctx);
      return jsonResponse({ event }, 200, req, config);
    } catch (err) {
      const mapped = projectionErrorResponse(err, ctx);
      if (mapped) return mapped;
      return errorResponse("server_error", "internal lab read failure", 500, ctx);
    }
  }

  if (url.pathname === "/api/lab/artifacts") {
    const limit = parseLimit(url.searchParams.get("limit"), ctx);
    if (limit instanceof Response) return limit;
    const statusRaw = url.searchParams.get("status")?.trim();
    const artifactClass = url.searchParams.get("artifactClass")?.trim() || undefined;
    if (statusRaw && !["present", "corrupt", "purged_unavailable"].includes(statusRaw)) {
      return errorResponse("invalid_status", "status must be present, corrupt, or purged_unavailable", 400, ctx);
    }
    if (artifactClass && !ARTIFACT_CLASSES.includes(artifactClass as (typeof ARTIFACT_CLASSES)[number])) {
      return errorResponse(
        "invalid_artifact_class",
        "artifactClass must be a supported artifact class",
        400,
        ctx,
      );
    }
    try {
      const page = queryLabArtifacts({
        status: statusRaw as "present" | "corrupt" | "purged_unavailable" | undefined,
        artifactClass: artifactClass as import("../../lab/constants").ArtifactClass | undefined,
      }, url.searchParams.get("cursor"), limit);
      return jsonResponse(paginatedEnvelope(page, "artifacts"), 200, req, config);
    } catch (err) {
      const mapped = projectionErrorResponse(err, ctx);
      if (mapped) return mapped;
      return errorResponse("server_error", "internal lab read failure", 500, ctx);
    }
  }

  const artifactMatch = url.pathname.match(/^\/api\/lab\/artifacts\/([^/]+)$/);
  if (artifactMatch) {
    const digest = decodePathSegment(artifactMatch[1]!);
    if (digest === null) return errorResponse("not_found", "unknown resource", 404, ctx);
    const unsafe = rejectUnsafeId(digest, ctx);
    if (unsafe) return unsafe;
    try {
      const artifact = queryLabArtifactByDigest(digest);
      if (!artifact) return errorResponse("not_found", "unknown artifact", 404, ctx);
      return jsonResponse({ artifact }, 200, req, config);
    } catch (err) {
      const mapped = projectionErrorResponse(err, ctx);
      if (mapped) return mapped;
      return errorResponse("server_error", "internal lab read failure", 500, ctx);
    }
  }

  return null;
}