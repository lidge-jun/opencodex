/**
 * Cursor-paginated request-history API (RI-02).
 *
 * - `GET /api/request-history` - keyset-paginated rows with filters
 * - `GET /api/request-history/:requestId` - one canonical row
 *
 * The index is a derived projection of `usage.jsonl`; every response carries
 * an `index` status block so callers can see schema version, indexed rows and
 * any repair the indexer performed.
 */

import {
  queryRequestHistory,
  requestHistoryRowById,
  REQUEST_HISTORY_MAX_PAGE_SIZE,
} from "../../routing/history/indexer";
import { InvalidCursorError } from "../../routing/history/cursor";
import { requestLogEntryFromPersistedUsage } from "../request-log";
import { requestLogDto } from "./shared";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

function parseQueryInt(raw: string | null): number | undefined | "invalid" {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "invalid";
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : "invalid";
}

export async function handleRequestHistoryRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;
  if (!url.pathname.startsWith("/api/request-history")) return null;

  if (url.pathname === "/api/request-history" && req.method === "GET") {
    const statusRaw = parseQueryInt(url.searchParams.get("status"));
    if (statusRaw === "invalid") {
      return jsonResponse({ error: { code: "invalid_status", message: "status must be an integer from 100 to 599" } }, 400, req, config);
    }
    const status = statusRaw;
    if (status !== undefined && (status < 100 || status > 599)) {
      return jsonResponse({ error: { code: "invalid_status", message: "status must be an integer from 100 to 599" } }, 400, req, config);
    }
    const fromRaw = parseQueryInt(url.searchParams.get("from"));
    if (fromRaw === "invalid") {
      return jsonResponse({ error: { code: "invalid_from", message: "from must be an integer timestamp" } }, 400, req, config);
    }
    const toRaw = parseQueryInt(url.searchParams.get("to"));
    if (toRaw === "invalid") {
      return jsonResponse({ error: { code: "invalid_to", message: "to must be an integer timestamp" } }, 400, req, config);
    }
    const from = fromRaw;
    const to = toRaw;
    if (from !== undefined && to !== undefined && from > to) {
      return jsonResponse({ error: { code: "invalid_range", message: "from must not be after to" } }, 400, req, config);
    }
    const limitRaw = url.searchParams.get("limit");
    const limitParsed = limitRaw === null ? undefined : parseQueryInt(limitRaw);
    if (limitParsed === "invalid") {
      return jsonResponse(
        { error: { code: "invalid_limit", message: `limit must be an integer from 1 to ${REQUEST_HISTORY_MAX_PAGE_SIZE}` } },
        400,
        req,
        config,
      );
    }
    const limit = limitParsed;
    if (limit !== undefined && (limit < 1 || limit > REQUEST_HISTORY_MAX_PAGE_SIZE)) {
      return jsonResponse(
        { error: { code: "invalid_limit", message: `limit must be an integer from 1 to ${REQUEST_HISTORY_MAX_PAGE_SIZE}` } },
        400,
        req,
        config,
      );
    }
    const cursor = url.searchParams.get("cursor");
    try {
      const page = await queryRequestHistory({
        provider: url.searchParams.get("provider")?.trim() || undefined,
        model: url.searchParams.get("model")?.trim() || undefined,
        requestedModel: url.searchParams.get("requestedModel")?.trim() || undefined,
        status,
        conversationId: url.searchParams.get("conversationId")?.trim() || undefined,
        surface: url.searchParams.get("surface")?.trim() || undefined,
        inboundProtocol: url.searchParams.get("inboundProtocol")?.trim() || undefined,
        apiKeyId: url.searchParams.get("apiKeyId")?.trim() || undefined,
        profileId: url.searchParams.get("profileId")?.trim() || undefined,
        fallback: url.searchParams.get("fallback") === "true"
          ? true
          : url.searchParams.get("fallback") === "false" ? false : undefined,
        from,
        to,
      }, cursor, limit);
      return jsonResponse({
        entries: page.rows.map(row => requestLogDto(requestLogEntryFromPersistedUsage(row))),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        hasMore: page.hasMore,
        index: {
          schemaVersion: page.meta.schemaVersion,
          indexedRows: page.meta.indexedRows,
          sourceSize: page.meta.sourceSize,
          sourceMtimeMs: page.meta.sourceMtimeMs,
          builtAtMs: page.meta.builtAtMs,
          lastError: page.meta.lastError,
        },
      }, 200, req, config);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return jsonResponse({ error: { code: "invalid_cursor", message: "invalid cursor" } }, 400, req, config);
      }
      throw err;
    }
  }

  if (url.pathname.startsWith("/api/request-history/") && req.method === "GET") {
    let requestId: string;
    try {
      requestId = decodeURIComponent(url.pathname.slice("/api/request-history/".length));
    } catch {
      return jsonResponse({ error: { code: "not_found", message: "unknown request" } }, 404, req, config);
    }
    if (!requestId || requestId.includes("/")) {
      return jsonResponse({ error: { code: "not_found", message: "unknown request" } }, 404, req, config);
    }
    const entry = await requestHistoryRowById(requestId);
    if (!entry) {
      return jsonResponse({ error: { code: "not_found", message: "unknown request" } }, 404, req, config);
    }
    return jsonResponse(requestLogDto(requestLogEntryFromPersistedUsage(entry)), 200, req, config);
  }

  return null;
}
