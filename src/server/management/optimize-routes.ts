import { jsonResponse } from "../auth-cors";
import { saveConfigPreservingClaudeCode } from "../../config";
import type { ManagementContext } from "./context";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import { isPlainRecord } from "./shared";
import { DEFAULT_HEADROOM_TIMEOUT_MS, DEFAULT_HEADROOM_URL } from "../../optimize/constants";
import { checkHeadroomStatus, startHeadroom } from "../../optimize/headroom";
import { compressText } from "../../optimize/rtk";
import type { RtkStats } from "../../optimize/types";

export function getOptimizeSettings(config: import("../../types").OcxConfig) {
  const opt = config.optimize || {};
  return {
    rtkEnabled: opt.rtkEnabled !== false,
    headroomEnabled: opt.headroomEnabled === true,
    headroomUrl: opt.headroomUrl || DEFAULT_HEADROOM_URL,
    headroomTimeoutMs: opt.headroomTimeoutMs || DEFAULT_HEADROOM_TIMEOUT_MS,
    ponytailEnabled: opt.ponytailEnabled === true,
    ponytailLevel: opt.ponytailLevel || "full",
  };
}

export async function handleOptimizeRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;

  if (url.pathname === "/api/optimize" && req.method === "GET") {
    return jsonResponse(getOptimizeSettings(config), 200, req, config);
  }

  if (url.pathname === "/api/optimize" && req.method === "PATCH") {
    let raw: unknown;
    try {
      raw = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400, req, config);
    }
    if (!isPlainRecord(raw)) {
      return jsonResponse({ error: "body must be a JSON object" }, 400, req, config);
    }

    const body = raw as {
      rtkEnabled?: unknown;
      headroomEnabled?: unknown;
      headroomUrl?: unknown;
      headroomTimeoutMs?: unknown;
      ponytailEnabled?: unknown;
      ponytailLevel?: unknown;
    };

    if (body.rtkEnabled !== undefined && typeof body.rtkEnabled !== "boolean") {
      return jsonResponse({ error: "rtkEnabled must be a boolean" }, 400, req, config);
    }
    if (body.headroomEnabled !== undefined && typeof body.headroomEnabled !== "boolean") {
      return jsonResponse({ error: "headroomEnabled must be a boolean" }, 400, req, config);
    }
    if (body.headroomUrl !== undefined && typeof body.headroomUrl !== "string") {
      return jsonResponse({ error: "headroomUrl must be a string" }, 400, req, config);
    }
    if (body.headroomTimeoutMs !== undefined && (typeof body.headroomTimeoutMs !== "number" || body.headroomTimeoutMs <= 0)) {
      return jsonResponse({ error: "headroomTimeoutMs must be a positive number" }, 400, req, config);
    }
    if (body.ponytailEnabled !== undefined && typeof body.ponytailEnabled !== "boolean") {
      return jsonResponse({ error: "ponytailEnabled must be a boolean" }, 400, req, config);
    }
    if (body.ponytailLevel !== undefined && body.ponytailLevel !== "lite" && body.ponytailLevel !== "full" && body.ponytailLevel !== "ultra") {
      return jsonResponse({ error: "ponytailLevel must be 'lite', 'full', or 'ultra'" }, 400, req, config);
    }

    const next = { ...(config.optimize || {}) };
    if (typeof body.rtkEnabled === "boolean") next.rtkEnabled = body.rtkEnabled;
    if (typeof body.headroomEnabled === "boolean") next.headroomEnabled = body.headroomEnabled;
    if (typeof body.headroomUrl === "string") {
      const trimmed = body.headroomUrl.trim();
      if (trimmed) next.headroomUrl = trimmed;
      else delete next.headroomUrl;
    }
    if (typeof body.headroomTimeoutMs === "number") next.headroomTimeoutMs = Math.round(body.headroomTimeoutMs);
    if (typeof body.ponytailEnabled === "boolean") next.ponytailEnabled = body.ponytailEnabled;
    if (body.ponytailLevel === "lite" || body.ponytailLevel === "full" || body.ponytailLevel === "ultra") {
      next.ponytailLevel = body.ponytailLevel;
    }

    config.optimize = next;
    saveConfigPreservingClaudeCode(config);

    return jsonResponse({ ok: true, settings: getOptimizeSettings(config) }, 200, req, config);
  }

  if (url.pathname === "/api/optimize/headroom/status" && req.method === "GET") {
    const targetUrl = url.searchParams.get("url") || config.optimize?.headroomUrl || DEFAULT_HEADROOM_URL;
    const timeoutMs = config.optimize?.headroomTimeoutMs || DEFAULT_HEADROOM_TIMEOUT_MS;
    const status = await checkHeadroomStatus(targetUrl, timeoutMs);
    return jsonResponse(status, 200, req, config);
  }

  if (url.pathname === "/api/optimize/headroom/start" && req.method === "POST") {
    const targetUrl = config.optimize?.headroomUrl || DEFAULT_HEADROOM_URL;
    const result = await startHeadroom(targetUrl);
    return jsonResponse(result, result.ok ? 200 : 400, req, config);
  }

  if (url.pathname === "/api/optimize/test" && req.method === "POST") {
    let raw: unknown;
    try {
      raw = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400, req, config);
    }
    if (!isPlainRecord(raw)) {
      return jsonResponse({ error: "body must be a JSON object" }, 400, req, config);
    }
    const text = typeof (raw as { text?: unknown }).text === "string" ? (raw as { text: string }).text : "";
    const stats: RtkStats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
    const compressed = compressText(text, stats, "test");
    const filter = stats.hits[0]?.filter || null;
    return jsonResponse({
      filter,
      originalLength: text.length,
      compressedLength: compressed.length,
      saved: Math.max(0, text.length - compressed.length),
      compressed,
    }, 200, req, config);
  }

  return null;
}
