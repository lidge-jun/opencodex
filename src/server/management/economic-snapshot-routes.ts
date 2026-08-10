import { jsonResponse } from "../auth-cors";
import { isPlainRecord } from "./shared";
import type { ManagementContext } from "./context";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { OcxEconomicSnapshot } from "../../types";

const ALLOWED_SOURCES = new Set(["usage-log", "manual", "codex-quota"]);
const ALLOWED_CONFIDENCES = new Set(["authoritative", "observed", "estimated", "unknown"]);

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeIntegerTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeSnapshot(snapshot: OcxEconomicSnapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {
    remaining: Math.max(0, snapshot.remaining),
    updatedAt: snapshot.updatedAt,
    source: snapshot.source,
    confidence: snapshot.confidence,
  };
  if (snapshot.windowStart !== undefined) out.windowStart = snapshot.windowStart;
  if (snapshot.resetAt !== undefined) out.resetAt = snapshot.resetAt;
  if (snapshot.expiresAt !== undefined) out.expiresAt = snapshot.expiresAt;
  if (snapshot.error !== undefined) out.error = snapshot.error;
  return out;
}

export async function handleEconomicSnapshotRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/economic-allowances") {
    if (req.method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);
    const {
      getEconomicQuotaSnapshot,
      countEconomicReservationsForAllowance,
    } = await import("../../combos/economy");
    const now = Date.now();
    const allowances = Object.entries(config.economicAllowances ?? {}).map(([id, allowance]) => {
      const snapshot = getEconomicQuotaSnapshot(id);
      return {
        id,
        unit: allowance.unit,
        capacity: allowance.capacity,
        source: allowance.source,
        window: allowance.window,
        snapshot: snapshot ? normalizeSnapshot(snapshot) : null,
        state: snapshot ? "present" : "unknown",
        activeReservations: countEconomicReservationsForAllowance(id, now),
      };
    });
    return jsonResponse({ allowances }, 200);
  }

  const match = url.pathname.match(/^\/api\/economic-allowances\/([^/]+)\/snapshot$/);
  if (!match) return null;

  let allowanceId: string;
  try {
    allowanceId = decodeURIComponent(match[1]!);
  } catch {
    return jsonResponse({ error: "allowance id has malformed percent-encoding" }, 400);
  }

  if (!config.economicAllowances || !Object.hasOwn(config.economicAllowances, allowanceId)) {
    return jsonResponse({ error: `unknown economic allowance "${allowanceId}"` }, 404);
  }

  if (req.method === "GET") {
    const { getEconomicQuotaSnapshot, countEconomicReservationsForAllowance } = await import("../../combos/economy");
    const snapshot = getEconomicQuotaSnapshot(allowanceId);
    if (!snapshot) {
      return jsonResponse({ allowanceId, snapshot: null, state: "unknown", activeReservations: countEconomicReservationsForAllowance(allowanceId) }, 200);
    }
    return jsonResponse({
      allowanceId,
      snapshot: normalizeSnapshot(snapshot),
      state: "present",
      activeReservations: countEconomicReservationsForAllowance(allowanceId),
    }, 200);
  }

  if (req.method === "PUT") {
    let rawBody: unknown;
    try {
      rawBody = await readManagementJsonBody(req);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }
    if (!isPlainRecord(rawBody)) {
      return jsonResponse({ error: "request body must be an object" }, 400);
    }
    const body = rawBody as Record<string, unknown>;

    if (!finiteNonNegative(body.remaining)) {
      return jsonResponse({ error: "remaining must be a finite non-negative number" }, 400);
    }
    if (!safeIntegerTimestamp(body.updatedAt)) {
      return jsonResponse({ error: "updatedAt must be a safe non-negative integer timestamp" }, 400);
    }
    for (const field of ["windowStart", "resetAt", "expiresAt"] as const) {
      if (body[field] !== undefined && !safeIntegerTimestamp(body[field])) {
        return jsonResponse({ error: `${field} must be a safe non-negative integer timestamp` }, 400);
      }
    }
    if (typeof body.source !== "string" || !ALLOWED_SOURCES.has(body.source)) {
      return jsonResponse({ error: "source must be one of: usage-log, manual, codex-quota" }, 400);
    }
    if (typeof body.confidence !== "string" || !ALLOWED_CONFIDENCES.has(body.confidence)) {
      return jsonResponse({ error: "confidence must be one of: authoritative, observed, estimated, unknown" }, 400);
    }
    if (body.error !== undefined && typeof body.error !== "string") {
      return jsonResponse({ error: "error must be a string" }, 400);
    }

    const snapshot: OcxEconomicSnapshot = {
      remaining: Math.max(0, body.remaining as number),
      updatedAt: body.updatedAt as number,
      source: body.source as string,
      confidence: body.confidence as OcxEconomicSnapshot["confidence"],
      ...(body.windowStart !== undefined ? { windowStart: body.windowStart as number } : {}),
      ...(body.resetAt !== undefined ? { resetAt: body.resetAt as number } : {}),
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt as number } : {}),
      ...(typeof body.error === "string" && body.error ? { error: body.error } : {}),
    };

    const {
      setEconomicQuotaSnapshot,
      getEconomicQuotaSnapshot,
      clearEconomicReservationsForAllowance,
      countEconomicReservationsForAllowance,
    } = await import("../../combos/economy");

    const active = countEconomicReservationsForAllowance(allowanceId);
    const clearReservations = body.clearReservations === true;
    if (active > 0 && !clearReservations) {
      return jsonResponse({
        error: "allowance has in-flight reservations; pass clearReservations:true to replace snapshot",
        allowanceId,
        activeReservations: active,
      }, 409);
    }
    if (clearReservations || active > 0) clearEconomicReservationsForAllowance(allowanceId);
    setEconomicQuotaSnapshot(allowanceId, snapshot);
    const stored = getEconomicQuotaSnapshot(allowanceId)!;
    return jsonResponse({ allowanceId, snapshot: normalizeSnapshot(stored), clearedReservations: active }, 200);
  }

  if (req.method === "DELETE") {
    const {
      clearEconomicQuotaSnapshot,
      getEconomicQuotaSnapshot,
      clearEconomicReservationsForAllowance,
      countEconomicReservationsForAllowance,
    } = await import("../../combos/economy");
    const active = countEconomicReservationsForAllowance(allowanceId);
    const clearReservations = url.searchParams.get("clearReservations") === "true";
    if (active > 0 && !clearReservations) {
      return jsonResponse({
        error: "allowance has in-flight reservations; pass clearReservations=true to clear snapshot",
        allowanceId,
        activeReservations: active,
      }, 409);
    }
    const existing = getEconomicQuotaSnapshot(allowanceId);
    if (clearReservations || active > 0) clearEconomicReservationsForAllowance(allowanceId);
    clearEconomicQuotaSnapshot(allowanceId);
    return jsonResponse({
      allowanceId,
      cleared: true,
      previousState: existing ? "present" : "unknown",
      snapshot: null,
      clearedReservations: active,
    }, 200);
  }

  return jsonResponse({ error: "method not allowed" }, 405);
}
