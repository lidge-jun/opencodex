import { admitCodexCliUpdateJob, readCodexCliUpdateJob, runCodexCliUpdateJob } from "../../codex/cli-update-job";
import { runCodexCliUpdateApplyInWorker, runCodexCliUpdatePlanInWorker } from "../../codex/cli-update-job-worker";
import { jsonResponse } from "../auth-cors";
import { trackBackgroundWork } from "../../lib/background-work";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import type { ManagementContext } from "./context";
import { hasHumanDashboardSession } from "./consent-session";

const STATUS = /^\/api\/codex\/cli-update\/jobs\/([0-9a-f-]{36})$/;

export async function handleCodexCliUpdateRoutes(ctx: ManagementContext): Promise<Response | null> {
  if (ctx.url.pathname === "/api/codex/cli-update/plan") {
    if (ctx.req.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405, ctx.req, ctx.config);
    try {
      const plan = await runCodexCliUpdatePlanInWorker();
      return jsonResponse(plan, 200, ctx.req, ctx.config);
    } catch { return jsonResponse({ error: "plan_unavailable" }, 503, ctx.req, ctx.config); }
  }
  const match = STATUS.exec(ctx.url.pathname);
  if (match && ctx.req.method === "GET") {
    try {
      const job = await readCodexCliUpdateJob(match[1]!);
      return job ? jsonResponse(job, 200, ctx.req, ctx.config) : jsonResponse({ error: "job_not_found" }, 404, ctx.req, ctx.config);
    } catch { return jsonResponse({ error: "job_state_unavailable" }, 503, ctx.req, ctx.config); }
  }
  if (ctx.url.pathname !== "/api/codex/cli-update/apply") return null;
  if (ctx.req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, ctx.req, ctx.config);
  if (!hasHumanDashboardSession(ctx) || !ctx.trustedLoopbackIngress) {
    return jsonResponse({ error: "local_dashboard_confirmation_required" }, 403, ctx.req, ctx.config);
  }
  let body: unknown;
  try { body = await readManagementJsonBody(ctx.req); }
  catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid_json" }, 400, ctx.req, ctx.config); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error: "invalid_request" }, 400, ctx.req, ctx.config);
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !["requestId", "planId", "confirmed"].includes(key))
    || value.confirmed !== true || typeof value.requestId !== "string" || typeof value.planId !== "string") {
    return jsonResponse({ error: "invalid_request" }, 400, ctx.req, ctx.config);
  }
  try {
    const admitted = await admitCodexCliUpdateJob({ requestId: value.requestId, planId: value.planId, confirmed: true });
    if (admitted.kind === "accepted") {
      const work = runCodexCliUpdateJob(admitted.job.jobId, admitted.generation,
        () => runCodexCliUpdateApplyInWorker(value.planId as string, { jobId: admitted.job.jobId }));
      trackBackgroundWork(`codex-cli-update:${admitted.job.jobId}`, work).catch(() => undefined);
    }
    return jsonResponse({ job: admitted.job }, 202, ctx.req, ctx.config);
  } catch (error) {
    const code = error instanceof Error ? error.message : "admission_failed";
    const status = code === "idempotency_conflict" ? 409 : code === "invalid_request" ? 400 : 503;
    const response = jsonResponse({ error: ["invalid_request", "idempotency_conflict", "store_full", "job_store_busy", "unsupported_store", "unsafe_store"].includes(code) ? code : "admission_failed" }, status, ctx.req, ctx.config);
    if (code === "job_store_busy") response.headers.set("Retry-After", "1");
    return response;
  }
}
