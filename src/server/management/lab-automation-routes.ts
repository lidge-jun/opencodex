/**
 * CL-08 Compatibility Lab automation management API.
 *
 * - GET  /api/lab/automation
 * - PUT  /api/lab/automation
 * - GET /api/lab/automation/runs
 * - POST /api/lab/automation/run
 * - POST /api/lab/automation/runs/:id/cancel
 *
 * Read endpoints never trigger scheduler ticks or evidence collection.
 */

import { readConfigDiagnostics, getConfigDir } from "../../config";
import {
  buildLabAutomationStatus,
  cancelLabAutomationRun,
  enqueueManualLabRun,
  reconcileLabAutomationQueue,
  startLabAutomationScheduler,
  stopLabAutomationScheduler,
} from "../../lab/automation/orchestrator";
import { planManualLabRun } from "../../lab/automation/planner";
import {
  loadLabAutomationState,
  normalizeLabAutomationRoutesV1,
} from "../../lab/automation/persistence";
import {
  loadLabAutomationConfig,
  saveLabAutomationConfig,
} from "../../lab/automation/config-persistence";
import { normalizeLabAutomationPolicyV1 } from "../../lab/automation/policy";
import { listLabAutomationRuns } from "../../lab/automation/runs-query";
import type { LabAutomationLayer, LabAutomationPolicyV1 } from "../../lab/automation/types";
import { LabAutomationError } from "../../lab/automation/types";
import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import { isPlainRecord } from "./shared";

const AUTOMATION_LAYERS: readonly LabAutomationLayer[] = [
  "protocol_conformance",
  "live_route_compatibility",
  "task_effectiveness",
];
const MANUAL_RUN_KEYS = new Set(["evidenceLayer", "scenarioId", "providerName", "modelId"]);

function automationErrorResponse(code: string, message: string, status: number, ctx: ManagementContext): Response {
  return jsonResponse({ error: { code, message } }, status, ctx.req, ctx.config);
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function parseLimit(raw: string | null, ctx: ManagementContext): number | Response {
  if (raw === null) return 50;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 50;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    return automationErrorResponse("invalid_limit", "limit must be an integer from 1 to 100", 400, ctx);
  }
  return value;
}

function applySchedulerPolicy(policy: LabAutomationPolicyV1, configDir?: string): void {
  reconcileLabAutomationQueue(configDir);
  if (policy.enabled) {
    startLabAutomationScheduler(configDir);
  } else {
    stopLabAutomationScheduler(configDir);
  }
}

export async function handleLabAutomationRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;
  if (!url.pathname.startsWith("/api/lab/automation")) return null;

  const configDir = getConfigDir();

  if (url.pathname === "/api/lab/automation" && req.method === "GET") {
    return jsonResponse(buildLabAutomationStatus(configDir), 200, req, config);
  }

  if (url.pathname === "/api/lab/automation/runs" && req.method === "GET") {
    const limit = parseLimit(url.searchParams.get("limit"), ctx);
    if (limit instanceof Response) return limit;
    const cursor = url.searchParams.get("cursor")?.trim() || undefined;
    try {
      const status = buildLabAutomationStatus(configDir);
      const runsPage = listLabAutomationRuns(loadLabAutomationState(configDir), limit, cursor);
      return jsonResponse({
        runs: runsPage.items,
        hasMore: runsPage.hasMore,
        ...(runsPage.nextCursor ? { nextCursor: runsPage.nextCursor } : {}),
        counters: status.counters,
      }, 200, req, config);
    } catch (error) {
      if (error instanceof LabAutomationError && error.code === "invalid_cursor") {
        return automationErrorResponse(error.code, error.message, 400, ctx);
      }
      throw error;
    }
  }

  const cancelMatch = url.pathname.match(/^\/api\/lab\/automation\/runs\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    let runId: string;
    try {
      runId = decodeURIComponent(cancelMatch[1]!);
    } catch {
      return automationErrorResponse("invalid_run_id", "run id is not valid percent-encoding", 400, ctx);
    }
    const cancelled = cancelLabAutomationRun(runId, configDir);
    if (!cancelled) return automationErrorResponse("not_found", "unknown or non-cancellable run", 404, ctx);
    return jsonResponse({ cancelled: true, runId }, 200, req, config);
  }

  if (url.pathname === "/api/lab/automation/run" && req.method === "POST") {
    try {
      const body = await readManagementJsonBody(req);
      if (!isPlainRecord(body)) return automationErrorResponse("invalid_body", "body must be an object", 400, ctx);
      if (hasUnknownKeys(body, MANUAL_RUN_KEYS)) {
        return automationErrorResponse("invalid_body", "manual run body contains unknown fields", 400, ctx);
      }
      const evidenceLayer = body.evidenceLayer;
      const scenarioId = body.scenarioId;
      if (typeof evidenceLayer !== "string" || !AUTOMATION_LAYERS.includes(evidenceLayer as LabAutomationLayer)) {
        return automationErrorResponse("invalid_layer", "evidenceLayer must be a supported automation layer", 400, ctx);
      }
      if (typeof scenarioId !== "string" || scenarioId.length === 0) {
        return automationErrorResponse("invalid_scenario", "scenarioId is required", 400, ctx);
      }
      let ocxConfig: import("../../types").OcxConfig | undefined;
      try {
        ocxConfig = readConfigDiagnostics().config;
      } catch {
        ocxConfig = config;
      }
      const planned = planManualLabRun({
        evidenceLayer: evidenceLayer as LabAutomationLayer,
        scenarioId,
        providerName: typeof body.providerName === "string" ? body.providerName : undefined,
        modelId: typeof body.modelId === "string" ? body.modelId : undefined,
        config: ocxConfig,
        configDir,
      });
      // This endpoint is intentionally synchronous: completion is the acknowledgement boundary.
      // Existing harness execution limits provide the route-level deadline, and disconnects cancel
      // through Request.signal instead of leaving orphaned provider work running.
      const record = await enqueueManualLabRun(planned, configDir, req.signal);
      if (!record) return automationErrorResponse("enqueue_failed", "manual run could not be enqueued", 500, ctx);
      return jsonResponse({ run: record, trigger: "manual" }, 200, req, config);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      if (error instanceof LabAutomationError) {
        return automationErrorResponse(error.code, error.message, 400, ctx);
      }
      return automationErrorResponse("server_error", "manual run failed", 500, ctx);
    }
  }

  if (url.pathname === "/api/lab/automation" && req.method === "PUT") {
    try {
      const body = await readManagementJsonBody(req);
      if (!isPlainRecord(body)) return automationErrorResponse("invalid_body", "body must be an object", 400, ctx);
      // Only policy/routes are authoritative. Other top-level properties are ignored rather than
      // treated as injectable process-local capabilities (for example a fake routeExecutor).
      let { policy, routes } = loadLabAutomationConfig(configDir);
      if (body.policy !== undefined) {
        if (!isPlainRecord(body.policy)) return automationErrorResponse("invalid_policy", "policy must be an object", 400, ctx);
        const incoming = body.policy as Record<string, unknown>;
        const mergedLayers = incoming.layers === undefined
          ? policy.layers
          : isPlainRecord(incoming.layers)
            ? { ...policy.layers, ...incoming.layers }
            : incoming.layers;
        policy = normalizeLabAutomationPolicyV1({
          ...policy,
          ...incoming,
          layers: mergedLayers,
        });
      }
      if (body.routes !== undefined) {
        if (!isPlainRecord(body.routes)) return automationErrorResponse("invalid_routes", "routes must be an object", 400, ctx);
        routes = normalizeLabAutomationRoutesV1(body.routes);
      }

      // One atomic rename publishes policy and routes as a coherent generation. A failed write
      // leaves the previous generation authoritative and scheduler reconciliation is not applied.
      if (body.policy !== undefined || body.routes !== undefined) {
        saveLabAutomationConfig(policy, routes, configDir);
      }
      applySchedulerPolicy(policy, configDir);
      return jsonResponse(buildLabAutomationStatus(configDir), 200, req, config);
    } catch (error) {
      rethrowManagementBodyTooLarge(error);
      if (error instanceof LabAutomationError) {
        return automationErrorResponse(error.code, error.message, 400, ctx);
      }
      return automationErrorResponse("server_error", "automation policy update failed", 500, ctx);
    }
  }

  return automationErrorResponse("not_found", "unknown resource", 404, ctx);
}