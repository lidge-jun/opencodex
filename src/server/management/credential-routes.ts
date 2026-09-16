import { jsonResponse } from "../auth-cors";
import { readManagementJsonBody, readOptionalManagementJsonBody } from "./body";
import type { ManagementContext } from "./context";
import { getCredentialRuntimeService } from "../../credentials";
import type { CredentialRole, CredentialType, SensitiveAction } from "../../credentials/types";

function disabledResponse(req: Request, config: ManagementContext["config"]): Response {
  return jsonResponse(
    { error: "Credential runtime is disabled. Set CREDENTIAL_RUNTIME_ENABLED=true." },
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
  const value = body?.actor ?? body?.requested_by ?? body?.requester_id;
  return value ? String(value) : fallback;
}

function roleOf(body: Record<string, unknown> | undefined, header?: string | null): CredentialRole {
  const raw = body?.actor_role ?? body?.role ?? header;
  return getCredentialRuntimeService().parseRole(raw ? String(raw) : undefined);
}

export async function handleCredentialRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config } = ctx;
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/credentials")) return null;

  const service = getCredentialRuntimeService();
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (mutating && !service.enabled()) return disabledResponse(req, config);

  try {
    if (pathname === "/api/credentials/overview" && req.method === "GET") {
      return jsonResponse({ data: service.overview() }, 200, req, config);
    }

    if (pathname === "/api/credentials" && req.method === "GET") {
      const provider = url.searchParams.get("provider") ?? undefined;
      const status = url.searchParams.get("status") ?? undefined;
      const environment = url.searchParams.get("environment") ?? undefined;
      const providerRow = provider
        ? (service.db.getProviderBySlug(provider) ?? service.db.getProvider(provider))
        : null;
      return jsonResponse({
        data: service.listPublic({
          provider_id: providerRow?.id,
          status,
          environment: environment ?? undefined,
        }),
      }, 200, req, config);
    }

    if (pathname === "/api/credentials" && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const created = await service.importCredential({
        provider: String(body.provider ?? ""),
        name: String(body.name ?? "credential"),
        secret: String(body.secret ?? ""),
        credential_type: body.credential_type as CredentialType | undefined,
        environment: body.environment ? String(body.environment) : undefined,
        scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
        expires_at: body.expires_at ? String(body.expires_at) : null,
        remaining_budget: body.remaining_budget == null ? null : Number(body.remaining_budget),
        budget_limit: body.budget_limit == null ? null : Number(body.budget_limit),
        actor: actorOf(body),
        actor_role: roleOf(body, req.headers.get("x-credential-role")),
        idempotency_key: req.headers.get("idempotency-key") ?? (body.idempotency_key ? String(body.idempotency_key) : undefined),
        validate: body.validate !== false,
      });
      return jsonResponse({ credential: created }, 201, req, config);
    }

    if (pathname === "/api/credentials/providers" && req.method === "GET") {
      return jsonResponse({ data: service.db.listProviders() }, 200, req, config);
    }

    if (pathname === "/api/credentials/pool" && req.method === "GET") {
      const provider = url.searchParams.get("provider") ?? undefined;
      return jsonResponse({ data: service.listCandidates(provider ?? undefined) }, 200, req, config);
    }

    if (pathname === "/api/credentials/health" && req.method === "GET") {
      return jsonResponse({
        data: service.listPublic().map(row => ({
          id: row.id,
          health_status: row.health_status,
          health_score: row.health_score,
          status: row.status,
          routing_eligible: row.routing_eligible,
        })),
      }, 200, req, config);
    }

    if (pathname === "/api/credentials/health/run" && req.method === "POST") {
      const n = await service.runHealthPass();
      return jsonResponse({ data: { checked: n } }, 200, req, config);
    }

    if (pathname === "/api/credentials/quota" && req.method === "GET") {
      return jsonResponse({
        data: service.listPublic().map(row => ({
          id: row.id,
          remaining_budget: row.remaining_budget,
          budget_limit: row.budget_limit,
          health_status: row.health_status,
        })),
      }, 200, req, config);
    }

    if (pathname === "/api/credentials/policies" && req.method === "GET") {
      return jsonResponse({ data: service.db.listPolicies() }, 200, req, config);
    }
    if (pathname === "/api/credentials/policies" && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const row = service.upsertPolicy({
        name: String(body.name ?? "policy"),
        policy_type: body.policy_type ? String(body.policy_type) : undefined,
        enabled: body.enabled !== false,
        priority: body.priority == null ? undefined : Number(body.priority),
        policy: (body.policy as never) ?? {},
      });
      return jsonResponse({ policy: row }, 201, req, config);
    }
    if (pathname === "/api/credentials/policies/evaluate" && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const decision = service.evaluatePolicy({
        credential_id: String(body.credential_id ?? ""),
        agent_id: body.agent_id ? String(body.agent_id) : undefined,
        model: body.model ? String(body.model) : undefined,
        purpose: body.purpose ? String(body.purpose) : undefined,
        required_scope: body.required_scope ? String(body.required_scope) : undefined,
        actor_role: roleOf(body, req.headers.get("x-credential-role")),
        action: (body.action as SensitiveAction | "lease") ?? "lease",
      });
      return jsonResponse({ decision }, 200, req, config);
    }

    if (pathname === "/api/credentials/approvals" && req.method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return jsonResponse({ data: service.db.listApprovals(status) }, 200, req, config);
    }

    if (pathname === "/api/credentials/audit" && req.method === "GET") {
      return jsonResponse({ data: service.db.listAudit() }, 200, req, config);
    }

    if (pathname === "/api/credentials/leases" && req.method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      return jsonResponse({ data: service.db.listLeases(status ?? undefined) }, 200, req, config);
    }
    if (pathname === "/api/credentials/leases" && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const grant = service.acquireLease({
        requester_type: String(body.requester_type ?? "agent"),
        requester_id: String(body.requester_id ?? actorOf(body)),
        agent_id: body.agent_id ? String(body.agent_id) : undefined,
        provider: String(body.provider ?? ""),
        model: body.model ? String(body.model) : undefined,
        purpose: body.purpose ? String(body.purpose) : undefined,
        required_scope: body.required_scope ? String(body.required_scope) : undefined,
        estimated_cost: body.estimated_cost == null ? undefined : Number(body.estimated_cost),
        ttl_seconds: body.ttl_seconds == null ? undefined : Number(body.ttl_seconds),
        actor_role: roleOf(body, req.headers.get("x-credential-role")),
        correlation_id: body.correlation_id ? String(body.correlation_id) : undefined,
      });
      return jsonResponse({ lease: grant }, 201, req, config);
    }

    if (pathname === "/api/credentials/oauth/sessions" && req.method === "GET") {
      return jsonResponse({ data: service.db.listOauth() }, 200, req, config);
    }
    if (pathname === "/api/credentials/oauth/start" && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const started = await service.startOauth({
        provider: String(body.provider ?? ""),
        redirect_uri: body.redirect_uri ? String(body.redirect_uri) : undefined,
        scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : undefined,
        actor: actorOf(body),
      });
      return jsonResponse({
        session: started.session,
        authorize_url: started.authorize_url,
        state: started.state,
      }, 201, req, config);
    }
    if (pathname === "/api/credentials/oauth/callback" && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const view = await service.completeOauth({
        state: String(body.state ?? ""),
        code: String(body.code ?? ""),
        actor: actorOf(body),
        idempotency_key: req.headers.get("idempotency-key") ?? (body.idempotency_key ? String(body.idempotency_key) : undefined),
      });
      return jsonResponse({ credential: view }, 200, req, config);
    }

    if (pathname === "/api/credentials/expiry/run" && req.method === "POST") {
      const n = service.runExpiryPass();
      return jsonResponse({ data: { expired: n } }, 200, req, config);
    }

    const credMatch = pathname.match(/^\/api\/credentials\/([^/]+)$/);
    if (credMatch && !["overview", "providers", "pool", "health", "quota", "policies", "approvals", "audit", "leases", "oauth", "expiry"].includes(credMatch[1]!)) {
      const id = decodeURIComponent(credMatch[1]!);
      if (req.method === "GET") {
        const row = service.db.getCredential(id);
        if (!row) return jsonResponse({ error: "Credential not found" }, 404, req, config);
        return jsonResponse({ credential: service.toPublicView(row) }, 200, req, config);
      }
      if (req.method === "DELETE") {
        const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
        const result = service.deleteCredential(id, actorOf(body), roleOf(body, req.headers.get("x-credential-role")));
        return jsonResponse({ result }, 200, req, config);
      }
    }

    const validateMatch = pathname.match(/^\/api\/credentials\/([^/]+)\/validate$/);
    if (validateMatch && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const view = await service.validateCredential(decodeURIComponent(validateMatch[1]!), actorOf(body));
      return jsonResponse({ credential: view }, 200, req, config);
    }

    const healthMatch = pathname.match(/^\/api\/credentials\/([^/]+)\/health$/);
    if (healthMatch && req.method === "POST") {
      const view = await service.runHealthCheck(decodeURIComponent(healthMatch[1]!));
      return jsonResponse({ credential: view }, 200, req, config);
    }

    const quarantineMatch = pathname.match(/^\/api\/credentials\/([^/]+)\/quarantine$/);
    if (quarantineMatch && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const view = service.quarantineCredential(decodeURIComponent(quarantineMatch[1]!), actorOf(body), String(body.reason ?? "operator"));
      return jsonResponse({ credential: view }, 200, req, config);
    }

    const revokeMatch = pathname.match(/^\/api\/credentials\/([^/]+)\/revoke$/);
    if (revokeMatch && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const result = service.revokeCredential(
        decodeURIComponent(revokeMatch[1]!),
        actorOf(body),
        roleOf(body, req.headers.get("x-credential-role")),
        req.headers.get("idempotency-key") ?? undefined,
      );
      return jsonResponse({ result }, 200, req, config);
    }

    const rotateMatch = pathname.match(/^\/api\/credentials\/([^/]+)\/rotate$/);
    if (rotateMatch && req.method === "POST") {
      const body = await readManagementJsonBody(req) as Record<string, unknown>;
      const result = await service.rotateCredential({
        credential_id: decodeURIComponent(rotateMatch[1]!),
        secret: String(body.secret ?? ""),
        actor: actorOf(body),
        actor_role: roleOf(body, req.headers.get("x-credential-role")),
        idempotency_key: req.headers.get("idempotency-key") ?? undefined,
      });
      return jsonResponse({ result }, 200, req, config);
    }

    const activateMatch = pathname.match(/^\/api\/credentials\/([^/]+)\/activate$/);
    if (activateMatch && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const view = service.activateCredential(decodeURIComponent(activateMatch[1]!), actorOf(body));
      return jsonResponse({ credential: view }, 200, req, config);
    }

    const disableMatch = pathname.match(/^\/api\/credentials\/([^/]+)\/disable$/);
    if (disableMatch && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const view = service.disableCredential(decodeURIComponent(disableMatch[1]!), actorOf(body));
      return jsonResponse({ credential: view }, 200, req, config);
    }

    const refreshMatch = pathname.match(/^\/api\/credentials\/([^/]+)\/refresh$/);
    if (refreshMatch && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const view = await service.refreshCredential(decodeURIComponent(refreshMatch[1]!), actorOf(body));
      return jsonResponse({ credential: view }, 200, req, config);
    }

    const leaseRelease = pathname.match(/^\/api\/credentials\/leases\/([^/]+)\/release$/);
    if (leaseRelease && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const lease = service.releaseLease(decodeURIComponent(leaseRelease[1]!), actorOf(body, "system"));
      return jsonResponse({ lease }, 200, req, config);
    }

    const approveMatch = pathname.match(/^\/api\/credentials\/approvals\/([^/]+)\/approve$/);
    if (approveMatch && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const row = service.decideApproval(decodeURIComponent(approveMatch[1]!), "approved", actorOf(body, "reviewer"));
      return jsonResponse({ approval: row }, 200, req, config);
    }
    const rejectMatch = pathname.match(/^\/api\/credentials\/approvals\/([^/]+)\/reject$/);
    if (rejectMatch && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const row = service.decideApproval(decodeURIComponent(rejectMatch[1]!), "rejected", actorOf(body, "reviewer"));
      return jsonResponse({ approval: row }, 200, req, config);
    }
    const executeMatch = pathname.match(/^\/api\/credentials\/approvals\/([^/]+)\/execute$/);
    if (executeMatch && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const result = service.executeApproval(decodeURIComponent(executeMatch[1]!), actorOf(body, "reviewer"), {
        secret: body.secret ? String(body.secret) : undefined,
      });
      return jsonResponse({ result }, 200, req, config);
    }

    const providerEnable = pathname.match(/^\/api\/credentials\/providers\/([^/]+)\/enable$/);
    if (providerEnable && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const row = service.setProviderEnabled(decodeURIComponent(providerEnable[1]!), true, actorOf(body), roleOf(body, req.headers.get("x-credential-role")));
      return jsonResponse({ provider: row }, 200, req, config);
    }
    const providerDisable = pathname.match(/^\/api\/credentials\/providers\/([^/]+)\/disable$/);
    if (providerDisable && req.method === "POST") {
      const body = await readOptionalManagementJsonBody(req) as Record<string, unknown>;
      const row = service.setProviderEnabled(decodeURIComponent(providerDisable[1]!), false, actorOf(body), roleOf(body, req.headers.get("x-credential-role")));
      return jsonResponse({ provider: row }, 200, req, config);
    }

    return jsonResponse({ error: "Not found" }, 404, req, config);
  } catch (error) {
    return fail(req, config, error);
  }
}

