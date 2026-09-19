import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, readOptionalManagementJsonBody } from "./body";
import type { ManagementContext } from "./context";
import { getSecurityControlService } from "../../security";
import type { ApprovalDecisionKind, AssetClass, AuthorizationType, SevenQuestionAnswers } from "../../security/types";

function disabledResponse(req: Request, config: ManagementContext["config"]): Response {
  return jsonResponse(
    { error: "Security control plane is disabled. Set PAO_SECURITY_CONTROL_PLANE=true." },
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
  const value = body?.actor ?? body?.requested_by ?? body?.reviewer ?? body?.created_by;
  return value ? String(value) : fallback;
}

export async function handleSecurityRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/security")) return null;

  const service = getSecurityControlService();
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (mutating && !service.enabled()) return disabledResponse(req, config);

  try {
    if (pathname === "/api/security/overview" && req.method === "GET") {
      return jsonResponse({ data: service.overview() }, 200, req, config);
    }

    if (pathname === "/api/security/authorizations" && req.method === "GET") {
      return jsonResponse({ data: service.db.listAuthorizations() }, 200, req, config);
    }
    if (pathname === "/api/security/authorizations" && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const created = service.createAuthorization({
        organization_id: body.organization_id ? String(body.organization_id) : undefined,
        type: (body.type as AuthorizationType) || "lab",
        source_reference: String(body.source_reference ?? ""),
        valid_from: String(body.valid_from ?? new Date().toISOString()),
        valid_until: String(body.valid_until ?? new Date(Date.now() + 7 * 86400_000).toISOString()),
        allowed_action_classes: Array.isArray(body.allowed_action_classes) ? body.allowed_action_classes.map(String) : ["asset_discovery"],
        prohibited_action_classes: Array.isArray(body.prohibited_action_classes) ? body.prohibited_action_classes.map(String) : [],
        notes: body.notes ? String(body.notes) : undefined,
        created_by: actorOf(body),
      });
      return jsonResponse({ authorization: created }, 201, req, config);
    }

    if (pathname === "/api/security/scopes" && req.method === "GET") {
      return jsonResponse({ data: service.db.listScopes() }, 200, req, config);
    }
    if (pathname === "/api/security/scopes" && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const created = service.createScope({
        authorization_id: String(body.authorization_id ?? ""),
        name: String(body.name ?? "scope"),
        created_by: actorOf(body),
        rate_limit_per_minute: body.rate_limit_per_minute ? Number(body.rate_limit_per_minute) : undefined,
        notes: body.notes ? String(body.notes) : undefined,
        assets: Array.isArray(body.assets) ? body.assets as Array<{ asset_class: AssetClass; value: string; criticality?: number }> : [],
        exclusions: Array.isArray(body.exclusions) ? body.exclusions as Array<{ asset_class: AssetClass; value: string; reason?: string }> : [],
      });
      return jsonResponse({ scope: created }, 201, req, config);
    }

    if (pathname === "/api/security/campaigns" && req.method === "GET") {
      return jsonResponse({ data: service.db.listCampaigns() }, 200, req, config);
    }
    if (pathname === "/api/security/campaigns" && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const created = service.createCampaign({
        name: String(body.name ?? "campaign"),
        authorization_id: String(body.authorization_id ?? ""),
        scope_id: String(body.scope_id ?? ""),
        owner_id: actorOf(body),
        organization_id: body.organization_id ? String(body.organization_id) : undefined,
        policy_profile_id: body.policy_profile_id ? String(body.policy_profile_id) : undefined,
      });
      return jsonResponse({ campaign: created }, 201, req, config);
    }

    if (pathname === "/api/security/approvals" && req.method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return jsonResponse({ data: service.db.listApprovals(status) }, 200, req, config);
    }

    if (pathname === "/api/security/findings" && req.method === "GET") {
      const campaignId = url.searchParams.get("campaign_id") ?? undefined;
      return jsonResponse({ data: service.db.listFindings(campaignId ?? undefined) }, 200, req, config);
    }

    if (pathname === "/api/security/skills" && req.method === "GET") {
      return jsonResponse({ data: service.db.listPackages() }, 200, req, config);
    }
    if (pathname === "/api/security/skills/import" && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const imported = service.importPackage(String(body.path ?? ""), actorOf(body));
      return jsonResponse({ package: imported }, 201, req, config);
    }

    if (pathname === "/api/security/tools" && req.method === "GET") {
      return jsonResponse({ data: service.db.listTools() }, 200, req, config);
    }

    if (pathname === "/api/security/mcp" && req.method === "GET") {
      return jsonResponse({ data: service.db.listMcpServers() }, 200, req, config);
    }

    if (pathname === "/api/security/policies" && req.method === "GET") {
      return jsonResponse({ data: service.db.listPolicyProfiles() }, 200, req, config);
    }
    if (pathname === "/api/security/policies/evaluate" && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const decision = service.evaluate({
        campaign_id: body.campaign_id ? String(body.campaign_id) : undefined,
        capability_id: String(body.capability_id ?? ""),
        target: String(body.target ?? ""),
        actor_id: actorOf(body),
        agent_id: body.agent_id ? String(body.agent_id) : undefined,
        scope_token: body.scope_token ? String(body.scope_token) : undefined,
        approval_id: body.approval_id ? String(body.approval_id) : undefined,
      });
      return jsonResponse({ decision }, 200, req, config);
    }

    if (pathname === "/api/security/audit" && req.method === "GET") {
      const campaignId = url.searchParams.get("campaign_id") ?? undefined;
      return jsonResponse({ data: service.db.listAudit(campaignId ?? undefined) }, 200, req, config);
    }

    const authMatch = pathname.match(/^\/api\/security\/authorizations\/([^/]+)$/);
    if (authMatch) {
      const id = decodeURIComponent(authMatch[1]!);
      if (req.method === "GET") {
        const row = service.db.getAuthorization(id);
        if (!row) return jsonResponse({ error: "Authorization not found" }, 404, req, config);
        return jsonResponse({ authorization: row }, 200, req, config);
      }
      if (req.method === "PATCH") {
        const body = await readManagementJsonBody(req) as Record<string, unknown>;
        const patched = service.patchAuthorization(id, {
          status: body.status as never,
          notes: body.notes ? String(body.notes) : undefined,
          valid_from: body.valid_from ? String(body.valid_from) : undefined,
          valid_until: body.valid_until ? String(body.valid_until) : undefined,
          allowed_action_classes: Array.isArray(body.allowed_action_classes) ? body.allowed_action_classes.map(String) : undefined,
          prohibited_action_classes: Array.isArray(body.prohibited_action_classes) ? body.prohibited_action_classes.map(String) : undefined,
          approval_owner: body.approval_owner ? String(body.approval_owner) : undefined,
        }, actorOf(body));
        return jsonResponse({ authorization: patched }, 200, req, config);
      }
    }

    const authVerify = pathname.match(/^\/api\/security\/authorizations\/([^/]+)\/verify$/);
    if (authVerify && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const verified = service.verifyAuthorization(decodeURIComponent(authVerify[1]!), actorOf(body, "reviewer"));
      return jsonResponse({ authorization: verified }, 200, req, config);
    }

    const scopeMatch = pathname.match(/^\/api\/security\/scopes\/([^/]+)$/);
    if (scopeMatch) {
      const id = decodeURIComponent(scopeMatch[1]!);
      if (req.method === "GET") {
        const row = service.db.getScope(id);
        if (!row) return jsonResponse({ error: "Scope not found" }, 404, req, config);
        return jsonResponse({
          scope: row,
          assets: service.db.listAssets(id),
          exclusions: service.db.listExclusions(id),
        }, 200, req, config);
      }
      if (req.method === "PATCH") {
        const body = await readManagementJsonBody(req) as Record<string, unknown>;
        const current = service.db.getScope(id);
        if (!current) return jsonResponse({ error: "Scope not found" }, 404, req, config);
        const next = {
          ...current,
          name: body.name ? String(body.name) : current.name,
          status: (body.status as typeof current.status) ?? current.status,
          rate_limit_per_minute: body.rate_limit_per_minute ? Number(body.rate_limit_per_minute) : current.rate_limit_per_minute,
          notes: body.notes ? String(body.notes) : current.notes,
          updated_at: new Date().toISOString(),
        };
        service.db.upsertScope(next);
        return jsonResponse({ scope: next }, 200, req, config);
      }
    }

    const scopeVerify = pathname.match(/^\/api\/security\/scopes\/([^/]+)\/verify$/);
    if (scopeVerify && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const verified = service.verifyScope(decodeURIComponent(scopeVerify[1]!), actorOf(body, "reviewer"));
      return jsonResponse({ scope: verified }, 200, req, config);
    }

    const campaignMatch = pathname.match(/^\/api\/security\/campaigns\/([^/]+)$/);
    if (campaignMatch && req.method === "GET") {
      const id = decodeURIComponent(campaignMatch[1]!);
      const campaign = service.db.getCampaign(id);
      if (!campaign) return jsonResponse({ error: "Campaign not found" }, 404, req, config);
      return jsonResponse({ campaign }, 200, req, config);
    }

    const campaignStart = pathname.match(/^\/api\/security\/campaigns\/([^/]+)\/start$/);
    if (campaignStart && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const campaign = service.startCampaign(decodeURIComponent(campaignStart[1]!), actorOf(body));
      return jsonResponse({ campaign }, 200, req, config);
    }
    const campaignPause = pathname.match(/^\/api\/security\/campaigns\/([^/]+)\/pause$/);
    if (campaignPause && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const campaign = service.pauseCampaign(decodeURIComponent(campaignPause[1]!), actorOf(body));
      return jsonResponse({ campaign }, 200, req, config);
    }
    const campaignResume = pathname.match(/^\/api\/security\/campaigns\/([^/]+)\/resume$/);
    if (campaignResume && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const campaign = service.resumeCampaign(decodeURIComponent(campaignResume[1]!), actorOf(body));
      return jsonResponse({ campaign }, 200, req, config);
    }
    const campaignCancel = pathname.match(/^\/api\/security\/campaigns\/([^/]+)\/cancel$/);
    if (campaignCancel && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const campaign = service.cancelCampaign(decodeURIComponent(campaignCancel[1]!), actorOf(body));
      return jsonResponse({ campaign }, 200, req, config);
    }
    const campaignRecon = pathname.match(/^\/api\/security\/campaigns\/([^/]+)\/recon$/);
    if (campaignRecon && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const result = service.runPassiveRecon(decodeURIComponent(campaignRecon[1]!), String(body.target ?? ""), actorOf(body));
      return jsonResponse({ result }, 200, req, config);
    }
    const campaignLeads = pathname.match(/^\/api\/security\/campaigns\/([^/]+)\/leads$/);
    if (campaignLeads && req.method === "GET") {
      return jsonResponse({ data: service.db.listLeads(decodeURIComponent(campaignLeads[1]!)) }, 200, req, config);
    }
    const campaignFindings = pathname.match(/^\/api\/security\/campaigns\/([^/]+)\/findings$/);
    if (campaignFindings && req.method === "GET") {
      return jsonResponse({ data: service.db.listFindings(decodeURIComponent(campaignFindings[1]!)) }, 200, req, config);
    }
    const campaignEvidence = pathname.match(/^\/api\/security\/campaigns\/([^/]+)\/evidence$/);
    if (campaignEvidence && req.method === "GET") {
      return jsonResponse({ data: service.db.listEvidence(decodeURIComponent(campaignEvidence[1]!)) }, 200, req, config);
    }
    const campaignAudit = pathname.match(/^\/api\/security\/campaigns\/([^/]+)\/audit$/);
    if (campaignAudit && req.method === "GET") {
      return jsonResponse({ data: service.db.listAudit(decodeURIComponent(campaignAudit[1]!)) }, 200, req, config);
    }

    const approveMatch = pathname.match(/^\/api\/security\/approvals\/([^/]+)\/approve$/);
    if (approveMatch && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const decision = (body.decision as ApprovalDecisionKind) || "APPROVE_ONCE";
      const row = service.decideApprovalRequest(decodeURIComponent(approveMatch[1]!), decision, actorOf(body, "reviewer"), String(body.reason ?? "approved"));
      return jsonResponse({ approval: row }, 200, req, config);
    }
    const denyMatch = pathname.match(/^\/api\/security\/approvals\/([^/]+)\/deny$/);
    if (denyMatch && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const row = service.decideApprovalRequest(decodeURIComponent(denyMatch[1]!), "DENY", actorOf(body, "reviewer"), String(body.reason ?? "denied"));
      return jsonResponse({ approval: row }, 200, req, config);
    }

    const findingValidate = pathname.match(/^\/api\/security\/findings\/([^/]+)\/validate$/);
    if (findingValidate && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const answers = (body.answers ?? {}) as SevenQuestionAnswers;
      const finding = service.validateFinding(decodeURIComponent(findingValidate[1]!), {
        scope: Boolean(answers.scope),
        reality: Boolean(answers.reality),
        reproducibility: Boolean(answers.reproducibility),
        impact: Boolean(answers.impact),
        evidence: Boolean(answers.evidence),
        novelty: Boolean(answers.novelty),
        policy: Boolean(answers.policy),
      }, actorOf(body, "reviewer"), String(body.notes ?? ""));
      return jsonResponse({ finding }, 200, req, config);
    }
    const findingReport = pathname.match(/^\/api\/security\/findings\/([^/]+)\/report$/);
    if (findingReport && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const finding = service.db.getFinding(decodeURIComponent(findingReport[1]!));
      if (!finding) return jsonResponse({ error: "Finding not found" }, 404, req, config);
      const report = service.exportReport(finding.campaign_id, actorOf(body, "reviewer"), [finding.id]);
      return jsonResponse({ report }, 200, req, config);
    }

    const pkgActivate = pathname.match(/^\/api\/security\/skills\/([^/]+)\/activate$/);
    if (pkgActivate && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const pkg = service.activatePackage(decodeURIComponent(pkgActivate[1]!), actorOf(body));
      return jsonResponse({ package: pkg }, 200, req, config);
    }
    const pkgQuarantine = pathname.match(/^\/api\/security\/skills\/([^/]+)\/quarantine$/);
    if (pkgQuarantine && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const pkg = service.quarantinePackage(decodeURIComponent(pkgQuarantine[1]!), actorOf(body));
      return jsonResponse({ package: pkg }, 200, req, config);
    }

    const mcpTest = pathname.match(/^\/api\/security\/mcp\/([^/]+)\/test$/);
    if (mcpTest && req.method === "POST") {
      const server = service.testMcp(decodeURIComponent(mcpTest[1]!));
      return jsonResponse({ server }, 200, req, config);
    }
  } catch (error) {
    return fail(req, config, error);
  }

  return null;
}
