import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, readOptionalManagementJsonBody } from "./body";
import type { ManagementContext } from "./context";
import { getSocialPublishingService } from "../../social";

function disabledResponse(req: Request, config: ManagementContext["config"]): Response {
  return jsonResponse(
    { error: "Social publishing control plane is disabled. Set SOCIAL_PUBLISHING_ENABLED=true." },
    403,
    req,
    config,
  );
}

function fail(req: Request, config: ManagementContext["config"], error: unknown, status = 400): Response {
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ error: message }, status, req, config);
}

function actorOf(body: Record<string, unknown> | undefined, fallback = "operator"): string {
  const value = body?.actor ?? body?.requested_by ?? body?.created_by ?? body?.approver_id;
  return value ? String(value) : fallback;
}

export async function handleSocialRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/social")) return null;

  const service = getSocialPublishingService();
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (mutating && !service.enabled()) return disabledResponse(req, config);

  try {
    // 1. Overview
    if (pathname === "/api/social/overview" && req.method === "GET") {
      return jsonResponse({ data: service.getOverview() }, 200, req, config);
    }

    // 1b. Approvals and analytics (across publications)
    if (pathname === "/api/social/approvals" && req.method === "GET") {
      return jsonResponse({ data: service.db.listAllApprovals() }, 200, req, config);
    }
    if (pathname === "/api/social/analytics" && req.method === "GET") {
      return jsonResponse({ data: service.db.listAnalyticsSnapshots() }, 200, req, config);
    }

    // 2. Instances
    if (pathname === "/api/social/openpost/instances" && req.method === "GET") {
      return jsonResponse({ data: service.db.listInstances() }, 200, req, config);
    }
    if (pathname === "/api/social/openpost/instances" && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const inst = await service.registerInstance({
        id: String(body.id ?? `inst_${Date.now()}`),
        name: String(body.name ?? "OpenPost"),
        base_url: String(body.base_url),
        auth_mode: (body.auth_mode as any) ?? "token",
        secret_ref: String(body.secret_ref ?? `secret://openpost/${body.id}/token`),
        mcp_endpoint: body.mcp_endpoint ? String(body.mcp_endpoint) : undefined,
        actor: actorOf(body),
      });
      return jsonResponse({ instance: inst }, 201, req, config);
    }

    const testMatch = pathname.match(/^\/api\/social\/openpost\/instances\/([^/]+)\/test$/);
    if (testMatch && req.method === "POST") {
      const id = decodeURIComponent(testMatch[1]!);
      const health = await service.testInstance(id);
      return jsonResponse({ health }, 200, req, config);
    }

    const syncInstMatch = pathname.match(/^\/api\/social\/openpost\/instances\/([^/]+)\/sync$/);
    if (syncInstMatch && req.method === "POST") {
      const id = decodeURIComponent(syncInstMatch[1]!);
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown> | undefined;
      const accounts = await service.syncAccounts(id, actorOf(body));
      return jsonResponse({ accounts }, 200, req, config);
    }

    // 3. Accounts
    if (pathname === "/api/social/accounts" && req.method === "GET") {
      const platform = url.searchParams.get("platform") ?? undefined;
      const readiness = url.searchParams.get("readiness") ?? undefined;
      return jsonResponse({ data: service.db.listAccounts({ platform, readiness }) }, 200, req, config);
    }

    const accRefreshMatch = pathname.match(/^\/api\/social\/accounts\/([^/]+)\/refresh-capabilities$/);
    if (accRefreshMatch && req.method === "POST") {
      const id = decodeURIComponent(accRefreshMatch[1]!);
      const acc = service.db.getAccount(id);
      if (!acc) return jsonResponse({ error: "Account not found" }, 404, req, config);
      const provider = service.getProvider(acc.openpost_instance_id);
      const caps = await provider.getAccountCapabilities(acc.openpost_account_ref);
      acc.capabilities = caps;
      acc.capability_json = JSON.stringify(caps);
      acc.last_sync_at = new Date().toISOString();
      service.db.upsertAccount(acc);
      return jsonResponse({ account: acc }, 200, req, config);
    }

    const accDetailMatch = pathname.match(/^\/api\/social\/accounts\/([^/]+)$/);
    if (accDetailMatch && req.method === "GET") {
      const id = decodeURIComponent(accDetailMatch[1]!);
      const acc = service.db.getAccount(id);
      if (!acc) return jsonResponse({ error: "Account not found" }, 404, req, config);
      return jsonResponse({ account: acc }, 200, req, config);
    }

    // 4. Publications
    if (pathname === "/api/social/publications" && req.method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return jsonResponse({ data: service.db.listPublications({ status }) }, 200, req, config);
    }
    if (pathname === "/api/social/publications" && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const pub = service.createPublication({
        source_type: (body.source_type as any) ?? "text",
        master_title: body.master_title ? String(body.master_title) : null,
        master_caption: body.master_caption ? String(body.master_caption) : null,
        master_description: body.master_description ? String(body.master_description) : null,
        master_tags: Array.isArray(body.master_tags) ? body.master_tags.map(String) : [],
        scheduled_at: body.scheduled_at ? String(body.scheduled_at) : null,
        timezone: body.timezone ? String(body.timezone) : "UTC",
        created_by_type: "human",
        created_by_id: actorOf(body),
      });
      return jsonResponse({ publication: pub }, 201, req, config);
    }

    const pubRenditionsMatch = pathname.match(/^\/api\/social\/publications\/([^/]+)\/generate-renditions$/);
    if (pubRenditionsMatch && req.method === "POST") {
      const id = decodeURIComponent(pubRenditionsMatch[1]!);
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const accountIds = Array.isArray(body.account_ids) ? body.account_ids.map(String) : [];
      const renditions = service.generateRenditionsForPublication(id, accountIds);
      return jsonResponse({ renditions }, 200, req, config);
    }

    const pubValidateMatch = pathname.match(/^\/api\/social\/publications\/([^/]+)\/validate$/);
    if (pubValidateMatch && req.method === "POST") {
      const id = decodeURIComponent(pubValidateMatch[1]!);
      const evaluation = service.validatePublication(id);
      return jsonResponse({ evaluation }, 200, req, config);
    }

    const pubApprovalMatch = pathname.match(/^\/api\/social\/publications\/([^/]+)\/approve$/);
    if (pubApprovalMatch && req.method === "POST") {
      const id = decodeURIComponent(pubApprovalMatch[1]!);
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown> | undefined;
      const approval = service.approvePublication({
        publicationId: id,
        renditionId: body?.rendition_id ? String(body.rendition_id) : null,
        decision: "approved",
        approverId: actorOf(body),
        note: body?.note ? String(body.note) : undefined,
      });
      return jsonResponse({ approval }, 200, req, config);
    }

    const pubRejectMatch = pathname.match(/^\/api\/social\/publications\/([^/]+)\/reject$/);
    if (pubRejectMatch && req.method === "POST") {
      const id = decodeURIComponent(pubRejectMatch[1]!);
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown> | undefined;
      const approval = service.approvePublication({
        publicationId: id,
        renditionId: body?.rendition_id ? String(body.rendition_id) : null,
        decision: "rejected",
        approverId: actorOf(body),
        note: body?.note ? String(body.note) : undefined,
      });
      return jsonResponse({ approval }, 200, req, config);
    }

    const pubScheduleMatch = pathname.match(/^\/api\/social\/publications\/([^/]+)\/schedule$/);
    if (pubScheduleMatch && req.method === "POST") {
      const id = decodeURIComponent(pubScheduleMatch[1]!);
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown> | undefined;
      const result = await service.schedulePublication(id, actorOf(body));
      return jsonResponse(result, 200, req, config);
    }

    const pubPublishMatch = pathname.match(/^\/api\/social\/publications\/([^/]+)\/publish$/);
    if (pubPublishMatch && req.method === "POST") {
      const id = decodeURIComponent(pubPublishMatch[1]!);
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown> | undefined;
      const result = await service.publishNow(id, actorOf(body));
      return jsonResponse(result, 200, req, config);
    }

    const pubCancelMatch = pathname.match(/^\/api\/social\/publications\/([^/]+)\/cancel$/);
    if (pubCancelMatch && req.method === "POST") {
      const id = decodeURIComponent(pubCancelMatch[1]!);
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown> | undefined;
      const pub = await service.cancelPublication(id, actorOf(body));
      return jsonResponse({ publication: pub }, 200, req, config);
    }

    const pubReconcileMatch = pathname.match(/^\/api\/social\/publications\/([^/]+)\/reconcile$/);
    if (pubReconcileMatch && req.method === "POST") {
      const id = decodeURIComponent(pubReconcileMatch[1]!);
      const pub = await service.reconcilePublication(id);
      return jsonResponse({ publication: pub }, 200, req, config);
    }

    const pubAnalyticsMatch = pathname.match(/^\/api\/social\/publications\/([^/]+)\/analytics$/);
    if (pubAnalyticsMatch && req.method === "GET") {
      const id = decodeURIComponent(pubAnalyticsMatch[1]!);
      const snapshots = service.db.listAnalyticsSnapshots({ publication_id: id });
      return jsonResponse({ data: snapshots }, 200, req, config);
    }

    const pubDetailMatch = pathname.match(/^\/api\/social\/publications\/([^/]+)$/);
    if (pubDetailMatch && req.method === "GET") {
      const id = decodeURIComponent(pubDetailMatch[1]!);
      const pub = service.db.getPublication(id);
      if (!pub) return jsonResponse({ error: "Publication not found" }, 404, req, config);
      const renditions = service.db.listRenditions(id);
      const assets = service.db.listAssets(id);
      const approvals = service.db.listApprovals(id);
      const evaluations = service.db.listPolicyEvaluations(id);
      return jsonResponse({ publication: pub, renditions, assets, approvals, evaluations }, 200, req, config);
    }
    if (pubDetailMatch && req.method === "PATCH") {
      const id = decodeURIComponent(pubDetailMatch[1]!);
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const pub = service.updatePublication(id, body as any, actorOf(body));
      return jsonResponse({ publication: pub }, 200, req, config);
    }

    // 5. Jobs
    if (pathname === "/api/social/jobs" && req.method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return jsonResponse({ data: service.db.listDeliveryJobs({ status }) }, 200, req, config);
    }

    const jobRetryMatch = pathname.match(/^\/api\/social\/jobs\/([^/]+)\/retry$/);
    if (jobRetryMatch && req.method === "POST") {
      const id = decodeURIComponent(jobRetryMatch[1]!);
      const jobs = service.db.listDeliveryJobs();
      const job = jobs.find(j => j.id === id);
      if (!job) return jsonResponse({ error: "Job not found" }, 404, req, config);
      job.status = "pending";
      job.next_attempt_at = null;
      service.db.upsertDeliveryJob(job);
      return jsonResponse({ job }, 200, req, config);
    }

    // 6. Audit
    if (pathname === "/api/social/audit" && req.method === "GET") {
      return jsonResponse({ data: service.db.listAuditEvents() }, 200, req, config);
    }

    return jsonResponse({ error: "Not found" }, 404, req, config);
  } catch (error) {
    return fail(req, config, error);
  }
}

