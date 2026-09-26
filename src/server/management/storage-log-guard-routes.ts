import { resolveCodexHomeDir } from "../../codex/home";
import {
  compactCodexLogs,
  type CodexLogGuardCompactionResult,
} from "../../codex/log-guard/maintenance";
import {
  getCodexLogGuardProtectionStatus,
  protectCodexLogs,
  repairCodexLogGuardProtection,
  unprotectCodexLogs,
  type CodexLogGuardMutationResult,
  type CodexLogGuardStatus,
} from "../../codex/log-guard/protection";
import { scanStorageAsync, type StorageReport } from "../../storage/scanner";
import { noteStorageMutationCompleted, storageMutationEpoch } from "../../storage/storage-mutation-coordinator";
import { jsonResponse } from "../auth-cors";
import {
  managementBodyTooLargeResponse,
  readManagementJsonBody,
} from "./body";
import type { ManagementContext } from "./context";

const INSPECTION_FAILED_MESSAGE = "Codex log inspection failed";

function inspectionUnavailable(report: CodexLogGuardStatus): boolean {
  return report.schema.state === "unavailable";
}

function mutationStatus(result: CodexLogGuardMutationResult): number {
  if (result.ok) return 200;
  switch (result.error) {
    case "process_enumeration_failed":
      return 503;
    case "codex_running":
    case "busy":
    case "unsupported_schema":
    case "trigger_collision":
    case "unsafe_path":
      return 409;
    case "database_error":
    case "config_write_failed":
      return 500;
  }
}

function compactStatus(result: CodexLogGuardCompactionResult): number {
  if (result.ok) return 200;
  switch (result.error) {
    case "process_enumeration_failed":
      return 503;
    case "codex_running":
    case "busy":
    case "unsupported_schema":
    case "auto_vacuum_not_incremental":
    case "unsafe_path":
    case "integrity_check_failed":
      return 409;
    case "database_error":
      return 500;
  }
}

function mutationResponse(
  result: CodexLogGuardMutationResult,
  ctx: ManagementContext,
): Response {
  return result.ok
    ? jsonResponse(result.status, 200, ctx.req, ctx.config)
    : jsonResponse({ error: result.error }, mutationStatus(result), ctx.req, ctx.config);
}

function compactResponse(
  result: CodexLogGuardCompactionResult,
  ctx: ManagementContext,
): Response {
  if (result.ok) {
    return jsonResponse({ report: result.report }, 200, ctx.req, ctx.config);
  }
  return jsonResponse(
    result.error === "integrity_check_failed"
      ? { error: result.error, phase: result.phase }
      : { error: result.error },
    compactStatus(result),
    ctx.req,
    ctx.config,
  );
}

async function readProtectMode(ctx: ManagementContext): Promise<"compat" | "quiet" | Response> {
  let body: unknown;
  try {
    body = await readManagementJsonBody(ctx.req);
  } catch (error) {
    const tooLarge = managementBodyTooLargeResponse(error, ctx.req, ctx.config);
    if (tooLarge) return tooLarge;
    return jsonResponse({ error: "invalid_request" }, 400, ctx.req, ctx.config);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ error: "invalid_request" }, 400, ctx.req, ctx.config);
  }
  const mode = (body as Record<string, unknown>).mode;
  if (mode !== "compat" && mode !== "quiet") {
    return jsonResponse({ error: "invalid_mode" }, 400, ctx.req, ctx.config);
  }
  return mode;
}

/**
 * Concurrent GET /api/storage requests for the same CODEX_HOME share one walk; nothing is
 * cached past it. A walk is joined only while no storage mutation has completed since it
 * started, so a read issued after a cleanup, restore, policy run or Log Guard change always
 * rescans instead of receiving sizes observed before it.
 */
interface StorageScanFlight {
  epoch: number;
  promise: Promise<StorageReport>;
}
const storageScanFlights = new Map<string, StorageScanFlight>();

export function sharedStorageScan(
  codexHome: string,
  scan: (codexHome: string) => Promise<StorageReport> = scanStorageAsync,
): Promise<StorageReport> {
  const epoch = storageMutationEpoch();
  const pending = storageScanFlights.get(codexHome);
  if (pending && pending.epoch === epoch) return pending.promise;
  const flight: StorageScanFlight = {
    epoch,
    promise: scan(codexHome).finally(() => {
      // A newer flight may already own this key; only retire our own entry.
      if (storageScanFlights.get(codexHome) === flight) storageScanFlights.delete(codexHome);
    }),
  };
  storageScanFlights.set(codexHome, flight);
  return flight.promise;
}

/**
 * Log Guard results that are refused before anything under CODEX_HOME is touched. Anything
 * else (success, a database or config write failure, `busy` which compaction can report
 * after partial progress, a post-compaction integrity failure) may have changed storage.
 */
const REFUSED_BEFORE_CHANGE: ReadonlySet<string> = new Set([
  "unsupported_schema",
  "codex_running",
  "process_enumeration_failed",
  "unsafe_path",
  "trigger_collision",
  "auto_vacuum_not_incremental",
]);

export function logGuardResultMayHaveChangedStorage(
  result: CodexLogGuardMutationResult | CodexLogGuardCompactionResult,
): boolean {
  if (result.ok) return true;
  if (result.error === "integrity_check_failed") return result.phase === "after";
  return !REFUSED_BEFORE_CHANGE.has(result.error);
}

/** Invalidate in-flight storage scans only when the Log Guard operation may have changed storage. */
function afterLogGuardMutation(
  result: CodexLogGuardMutationResult | CodexLogGuardCompactionResult,
  response: Response,
): Response {
  if (logGuardResultMayHaveChangedStorage(result)) noteStorageMutationCompleted();
  return response;
}

/** Codex Log Guard diagnostics plus explicit protection and maintenance mutations. */
export async function handleStorageLogGuardRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps } = ctx;
  const protectionDeps = deps.codexLogGuardProtectionDeps;

  if (url.pathname === "/api/storage/codex-logs") {
    if (req.method !== "GET") return null;
    try {
      const report = getCodexLogGuardProtectionStatus(protectionDeps);
      if (inspectionUnavailable(report)) {
        return jsonResponse({ error: "inspect_failed", message: INSPECTION_FAILED_MESSAGE }, 500, req, config);
      }
      return jsonResponse(report, 200, req, config);
    } catch {
      return jsonResponse({
        error: "inspect_failed",
        message: INSPECTION_FAILED_MESSAGE,
      }, 500, req, config);
    }
  }

  if (url.pathname === "/api/storage/codex-logs/protect") {
    if (req.method !== "POST") return null;
    const mode = await readProtectMode(ctx);
    if (mode instanceof Response) return mode;
    const result = protectCodexLogs(mode, protectionDeps);
    return afterLogGuardMutation(result, mutationResponse(result, ctx));
  }

  if (url.pathname === "/api/storage/codex-logs/unprotect") {
    if (req.method !== "POST") return null;
    const result = unprotectCodexLogs(protectionDeps);
    return afterLogGuardMutation(result, mutationResponse(result, ctx));
  }

  if (url.pathname === "/api/storage/codex-logs/repair") {
    if (req.method !== "POST") return null;
    const result = repairCodexLogGuardProtection(protectionDeps);
    return afterLogGuardMutation(result, mutationResponse(result, ctx));
  }

  if (url.pathname === "/api/storage/codex-logs/compact") {
    if (req.method !== "POST") return null;
    const result = compactCodexLogs(deps.codexLogGuardMaintenanceDeps);
    return afterLogGuardMutation(result, compactResponse(result, ctx));
  }

  if (url.pathname !== "/api/storage" || req.method !== "GET") return null;

  // Keep the existing CODEX_HOME scan as the primary storage contract. The Log Guard
  // report is attached separately so an external sqlite_home is visible without being
  // silently folded into CODEX_HOME totals.
  let storage;
  try {
    storage = await sharedStorageScan(resolveCodexHomeDir());
  } catch {
    const fallback = {
      codexHome: resolveCodexHomeDir(),
      generatedAt: Date.now(),
      total: { bytes: 0, fileCount: 0 },
      buckets: [],
      error: "scan_failed",
    };
    try {
      const report = getCodexLogGuardProtectionStatus(protectionDeps);
      return inspectionUnavailable(report)
        ? jsonResponse({ ...fallback, codexLogs: null, codexLogsError: "inspect_failed" }, 200, req, config)
        : jsonResponse({ ...fallback, codexLogs: report }, 200, req, config);
    } catch {
      return jsonResponse({ ...fallback, codexLogs: null, codexLogsError: "inspect_failed" }, 200, req, config);
    }
  }

  try {
    const report = getCodexLogGuardProtectionStatus(protectionDeps);
    return inspectionUnavailable(report)
      ? jsonResponse({ ...storage, codexLogs: null, codexLogsError: "inspect_failed" }, 200, req, config)
      : jsonResponse({ ...storage, codexLogs: report }, 200, req, config);
  } catch {
    // Log Guard inspection is auxiliary to the existing Storage page. A config/path
    // resolution failure must not take the legacy read-only storage report down with it.
    return jsonResponse({ ...storage, codexLogs: null, codexLogsError: "inspect_failed" }, 200, req, config);
  }
}
