import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody } from "./body";
import type { ManagementContext } from "./context";
import { getSkillControlService } from "../../skills";


const SKILL_NAMESPACES = [
  '/api/skills',
  '/api/skill-sources',
  '/api/skill-marketplace',
  '/api/skill-imports',
  '/api/skill-deployments',
  '/api/skill-sync',
  '/api/skill-drift',
  '/api/skill-agents',
  '/api/skill-nodes',
  '/api/skill-reviews',
  '/api/skill-audit',
] as const;

function ownsSkillPath(pathname: string): boolean {
  return SKILL_NAMESPACES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function handleSkillRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  const pathname = url.pathname;
  if (!ownsSkillPath(pathname)) return null;
  const service = getSkillControlService();

  // 1. /api/skills (GET, POST)
  if (pathname === "/api/skills" && req.method === "GET") {
    const skills = service.listSkills();
    return jsonResponse({ data: skills }, 200, req, config);
  }
  if (pathname === "/api/skills" && req.method === "POST") {
    const body = await readManagementJsonBody(req) as Record<string, unknown>;
    const { name, markdown, files, sourceType } = body;
    if (!name || !markdown) {
      return jsonResponse({ error: "Missing name or markdown content" }, 400, req, config);
    }
    const imported = await service.importer.importRaw(
      String(name),
      String(markdown),
      (files as Record<string, string>) ?? {},
      (sourceType as any) ?? "LOCAL_FOLDER",
    );
    service.db.upsertSkill(imported.skill);
    service.db.upsertSkillVersion(imported.version);
    service.registerVersionFiles(imported.version.id, imported.entryContent, imported.bundledFiles);
    return jsonResponse({ skill: imported.skill, version: imported.version }, 201, req, config);
  }

  // 2. /api/skill-sources (GET, POST)
  if (pathname === "/api/skill-sources" && req.method === "GET") {
    const sources = service.db.listSources();
    return jsonResponse({ data: sources }, 200, req, config);
  }
  if (pathname === "/api/skill-sources" && req.method === "POST") {
    const body = await readManagementJsonBody(req) as Record<string, unknown>;
    const VALID_SOURCE_TYPES = new Set([
      "LOCAL_FOLDER", "GIT", "GITHUB", "SKILLS_SH", "PRIVATE_GIT",
      "GENERATED", "BUNDLED", "ORGANIZATION", "UNKNOWN",
    ]);
    const VALID_TRUST_LEVELS = new Set(["trusted", "verified", "community", "unknown", "untrusted"]);

    const rawSourceType = String(body.source_type || "LOCAL_FOLDER");
    if (!VALID_SOURCE_TYPES.has(rawSourceType)) {
      return jsonResponse({ error: `Invalid source_type: ${rawSourceType}` }, 400, req, config);
    }
    const rawTrustLevel = String(body.trust_level || "community");
    if (!VALID_TRUST_LEVELS.has(rawTrustLevel)) {
      return jsonResponse({ error: `Invalid trust_level: ${rawTrustLevel}` }, 400, req, config);
    }

    const now = new Date().toISOString();
    const source = {
      id: String(body.id || `src_${Date.now()}`),
      source_type: rawSourceType as any,
      display_name: String(body.display_name || body.id),
      base_url: body.base_url ? String(body.base_url) : undefined,
      repository_url: body.repository_url ? String(body.repository_url) : undefined,
      default_ref: body.default_ref ? String(body.default_ref) : undefined,
      auth_ref: body.auth_ref ? String(body.auth_ref) : undefined,
      trust_level: rawTrustLevel as any,
      enabled: body.enabled !== false,
      created_at: now,
      updated_at: now,
    };
    service.db.upsertSource(source);
    return jsonResponse({ source }, 201, req, config);
  }

  // 3. /api/skill-marketplace/search (GET)
  if (pathname === "/api/skill-marketplace/search" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    const items = await service.searchMarketplace(q);
    return jsonResponse({ data: items }, 200, req, config);
  }

  // 4. /api/skill-imports (POST)
  if (pathname === "/api/skill-imports" && req.method === "POST") {
    const body = await readManagementJsonBody(req) as Record<string, unknown>;
    const { type, ref, path, options } = body;
    let result;
    if (type === "marketplace") {
      result = await service.importFromMarketplace(String(ref), options as any);
    } else if (type === "local") {
      result = await service.importLocal(String(path), options as any);
    } else {
      return jsonResponse({ error: "Invalid import type. Expected 'marketplace' or 'local'" }, 400, req, config);
    }
    return jsonResponse({ skill: result.skill, version: result.version }, 201, req, config);
  }

  // 5. /api/skill-deployments/plan (POST)
  if (pathname === "/api/skill-deployments/plan" && req.method === "POST") {
    const body = await readManagementJsonBody(req) as Record<string, unknown>;
    const { skillVersionId, agentType, scope, projectPath, nodeId, forceOverwriteUnmanaged } = body;
    const plan = await service.planDeployment(
      String(skillVersionId),
      {
        agentType: String(agentType || "codex"),
        scope: (scope as any) || "user",
        projectPath: projectPath ? String(projectPath) : undefined,
        nodeId: nodeId ? String(nodeId) : undefined,
      },
      { forceOverwriteUnmanaged: Boolean(forceOverwriteUnmanaged) },
    );
    return jsonResponse({ plan }, 200, req, config);
  }

  // 6. /api/skill-deployments (GET, POST)
  if (pathname === "/api/skill-deployments" && req.method === "GET") {
    const deps = service.listDeployments();
    return jsonResponse({ data: deps }, 200, req, config);
  }
  if (pathname === "/api/skill-deployments" && req.method === "POST") {
    const body = await readManagementJsonBody(req) as Record<string, unknown>;
    const { planId, actor } = body;
    const result = await service.applyDeploymentPlan(String(planId), actor ? String(actor) : "user");
    return jsonResponse({ result }, 201, req, config);
  }

  // 7. /api/skill-sync (POST) & /api/skill-sync/plan (POST)
  if (pathname === "/api/skill-sync/plan" && req.method === "POST") {
    const body = await readManagementJsonBody(req) as Record<string, unknown>;
    return jsonResponse({ syncPlan: body }, 200, req, config);
  }
  if (pathname === "/api/skill-sync" && req.method === "POST") {
    const body = await readManagementJsonBody(req) as Record<string, unknown>;
    const { skillId, fromAgent, toAgents, scope } = body;
    const results = await service.syncSkill(
      String(skillId),
      String(fromAgent),
      toAgents as string[],
      (scope as any) || "user",
    );
    return jsonResponse({ results }, 200, req, config);
  }

  // 8. /api/skill-drift/check (POST) & /api/skill-drift (GET)
  if (pathname === "/api/skill-drift/check" && req.method === "POST") {
    const body = (await readManagementJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    if (body.deploymentId) {
      const res = await service.checkDeploymentDrift(String(body.deploymentId));
      return jsonResponse({ drift: res }, 200, req, config);
    }
    const all = await service.checkAllDrift();
    return jsonResponse({ data: all }, 200, req, config);
  }
  if (pathname === "/api/skill-drift" && req.method === "GET") {
    const events = service.db.listDriftEvents();
    return jsonResponse({ data: events }, 200, req, config);
  }

  // 9. /api/skill-agents (GET) & /api/skill-agents/detect (POST)
  if (pathname === "/api/skill-agents" && req.method === "GET") {
    const agents = service.db.listAgents();
    return jsonResponse({ data: agents }, 200, req, config);
  }
  if (pathname === "/api/skill-agents/detect" && req.method === "POST") {
    const detected = await service.detectAgents();
    return jsonResponse({ data: detected }, 200, req, config);
  }

  // 10. /api/skill-nodes (GET, POST)
  if (pathname === "/api/skill-nodes" && req.method === "GET") {
    const nodes = service.listNodes();
    return jsonResponse({ data: nodes }, 200, req, config);
  }
  if (pathname === "/api/skill-nodes" && req.method === "POST") {
    const body = await readManagementJsonBody(req) as Record<string, unknown>;
    const now = new Date().toISOString();
    const node = {
      id: String(body.id || `node_${Date.now()}`),
      name: String(body.name || body.id),
      kind: (body.kind as any) || "ssh",
      hostname: body.hostname ? String(body.hostname) : undefined,
      port: body.port ? Number(body.port) : 22,
      username: body.username ? String(body.username) : "agent",
      auth_ref: body.auth_ref ? String(body.auth_ref) : undefined,
      host_key_fingerprint: body.host_key_fingerprint ? String(body.host_key_fingerprint) : undefined,
      environment: (body.environment as any) || "dev",
      status: "ONLINE" as const,
      allowed_roots: (body.allowed_roots as string[]) ?? [],
      tags: (body.tags as string[]) ?? [],
      created_at: now,
      updated_at: now,
    };
    service.upsertNode(node);
    return jsonResponse({ node }, 201, req, config);
  }

  // 11. /api/skill-reviews (GET)
  if (pathname === "/api/skill-reviews" && req.method === "GET") {
    const reviews = service.db.listReviews();
    return jsonResponse({ data: reviews }, 200, req, config);
  }

  // 12. /api/skill-audit (GET)
  if (pathname === "/api/skill-audit" && req.method === "GET") {
    const audit = service.listAuditEvents();
    return jsonResponse({ data: audit }, 200, req, config);
  }

  // Parameterized routes (regex matches)

  // /api/skills/{id} (GET, DELETE)
  const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (skillMatch) {
    const id = decodeURIComponent(skillMatch[1]!);
    if (req.method === "GET") {
      const skill = service.getSkill(id);
      if (!skill) return jsonResponse({ error: "Skill not found" }, 404, req, config);
      return jsonResponse({ skill }, 200, req, config);
    }
    if (req.method === "DELETE") {
      const deleted = service.db.deleteSkill(id);
      return jsonResponse({ deleted }, 200, req, config);
    }
  }

  // /api/skills/{id}/versions (GET)
  const versionsMatch = pathname.match(/^\/api\/skills\/([^/]+)\/versions$/);
  if (versionsMatch && req.method === "GET") {
    const id = decodeURIComponent(versionsMatch[1]!);
    const versions = service.listSkillVersions(id);
    return jsonResponse({ data: versions }, 200, req, config);
  }

  // /api/skills/{id}/versions/{version} (GET)
  const versionDetailMatch = pathname.match(/^\/api\/skills\/([^/]+)\/versions\/([^/]+)$/);
  if (versionDetailMatch && req.method === "GET") {
    const skillId = decodeURIComponent(versionDetailMatch[1]!);
    const ver = decodeURIComponent(versionDetailMatch[2]!);
    const versionRecord = service.getSkillVersion(`${skillId}@${ver}`);
    if (!versionRecord) return jsonResponse({ error: "Version not found" }, 404, req, config);
    return jsonResponse({ version: versionRecord }, 200, req, config);
  }

  // /api/skills/{id}/scan (POST)
  const scanMatch = pathname.match(/^\/api\/skills\/([^/]+)\/scan$/);
  if (scanMatch && req.method === "POST") {
    const id = decodeURIComponent(scanMatch[1]!);
    const skill = service.getSkill(id);
    if (!skill) return jsonResponse({ error: "Skill not found" }, 404, req, config);
    const versionId = `${id}@${skill.current_version}`;
    const scanRes = service.scanSkill(versionId);
    return jsonResponse(scanRes, 200, req, config);
  }

  // /api/skills/{id}/findings (GET)
  const findingsMatch = pathname.match(/^\/api\/skills\/([^/]+)\/findings$/);
  if (findingsMatch && req.method === "GET") {
    const id = decodeURIComponent(findingsMatch[1]!);
    const skill = service.getSkill(id);
    if (!skill) return jsonResponse({ error: "Skill not found" }, 404, req, config);
    const versionId = `${id}@${skill.current_version}`;
    const findings = service.getFindings(versionId);
    return jsonResponse({ findings }, 200, req, config);
  }

  // /api/skills/{id}/review (POST)
  const reviewMatch = pathname.match(/^\/api\/skills\/([^/]+)\/review$/);
  if (reviewMatch && req.method === "POST") {
    const id = decodeURIComponent(reviewMatch[1]!);
    const skill = service.getSkill(id);
    if (!skill) return jsonResponse({ error: "Skill not found" }, 404, req, config);
    const versionId = `${id}@${skill.current_version}`;
    const rev = service.requestReview(versionId, "user");
    return jsonResponse({ review: rev }, 201, req, config);
  }

  // /api/skills/{id}/publish (POST)
  const publishMatch = pathname.match(/^\/api\/skills\/([^/]+)\/publish$/);
  if (publishMatch && req.method === "POST") {
    const id = decodeURIComponent(publishMatch[1]!);
    const skill = service.getSkill(id);
    if (!skill) return jsonResponse({ error: "Skill not found" }, 404, req, config);
    const versionId = `${id}@${skill.current_version}`;
    const pub = service.publishVersion(versionId, "user");
    return jsonResponse({ version: pub }, 200, req, config);
  }

  // /api/skills/{id}/quarantine (POST)
  const quarantineMatch = pathname.match(/^\/api\/skills\/([^/]+)\/quarantine$/);
  if (quarantineMatch && req.method === "POST") {
    const id = decodeURIComponent(quarantineMatch[1]!);
    const body = (await readManagementJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const quarantined = service.quarantineSkill(id, String(body.reason || "Manual quarantine"));
    return jsonResponse({ skill: quarantined }, 200, req, config);
  }

  // /api/skills/{id}/revoke (POST)
  const revokeMatch = pathname.match(/^\/api\/skills\/([^/]+)\/revoke$/);
  if (revokeMatch && req.method === "POST") {
    const id = decodeURIComponent(revokeMatch[1]!);
    const body = (await readManagementJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
    const revoked = service.revokeSkill(id, String(body.reason || "Manual revocation"));
    return jsonResponse({ skill: revoked }, 200, req, config);
  }

  // /api/skill-deployments/{id}/rollback (POST)
  const rollbackMatch = pathname.match(/^\/api\/skill-deployments\/([^/]+)\/rollback$/);
  if (rollbackMatch && req.method === "POST") {
    const id = decodeURIComponent(rollbackMatch[1]!);
    const rolled = await service.rollbackDeployment(id, "user");
    return jsonResponse({ result: rolled }, 200, req, config);
  }

  // /api/skill-deployments/{id} (DELETE)
  const depDeleteMatch = pathname.match(/^\/api\/skill-deployments\/([^/]+)$/);
  if (depDeleteMatch && req.method === "DELETE") {
    const id = decodeURIComponent(depDeleteMatch[1]!);
    const removed = await service.removeDeployment(id, "user");
    return jsonResponse({ result: removed }, 200, req, config);
  }

  // /api/skill-nodes/{id}/test (POST)
  const nodeTestMatch = pathname.match(/^\/api\/skill-nodes\/([^/]+)\/test$/);
  if (nodeTestMatch && req.method === "POST") {
    const id = decodeURIComponent(nodeTestMatch[1]!);
    const testRes = await service.testNodeConnection(id);
    return jsonResponse(testRes, 200, req, config);
  }

  // /api/skill-nodes/{id} (DELETE)
  const nodeDeleteMatch = pathname.match(/^\/api\/skill-nodes\/([^/]+)$/);
  if (nodeDeleteMatch && req.method === "DELETE") {
    const id = decodeURIComponent(nodeDeleteMatch[1]!);
    const deleted = service.deleteNode(id);
    return jsonResponse({ deleted }, 200, req, config);
  }

  // /api/skill-reviews/{id}/decision (POST)
  const decisionMatch = pathname.match(/^\/api\/skill-reviews\/([^/]+)\/decision$/);
  if (decisionMatch && req.method === "POST") {
    const id = decodeURIComponent(decisionMatch[1]!);
    const body = await readManagementJsonBody(req) as Record<string, unknown>;
    const decision = (body.decision as any) || "APPROVED";
    const reason = String(body.reason || "Approved");
    const reviewer = String(body.reviewer || "admin");
    const updated = service.submitReviewDecision(id, decision, reviewer, reason, body.constraints as any);
    return jsonResponse({ review: updated }, 200, req, config);
  }

  return jsonResponse({ error: "Not found" }, 404, req, config);
}

