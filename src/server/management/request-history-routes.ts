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

function parseOptionalInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw.trim());
  return Number.isInteger(value) ? value : undefined;
}

export async function handleRequestHistoryRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;
  if (!url.pathname.startsWith("/api/request-history")) return null;

  if (url.pathname === "/api/request-history" && req.method === "GET") {
    const status = parseOptionalInt(url.searchParams.get("status"));
    if (status !== undefined && (status < 100 || status > 599)) {
      return jsonResponse({ error: { code: "invalid_status", message: "status must be an integer from 100 to 599" } }, 400, req, config);
    }
    const from = parseOptionalInt(url.searchParams.get("from"));
    const to = parseOptionalInt(url.searchParams.get("to"));
    if (from !== undefined && to !== undefined && from > to) {
      return jsonResponse({ error: { code: "invalid_range", message: "from must not be after to" } }, 400, req, config);
    }
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? undefined : parseOptionalInt(limitRaw);
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
    const requestId = decodeURIComponent(url.pathname.slice("/api/request-history/".length));
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
