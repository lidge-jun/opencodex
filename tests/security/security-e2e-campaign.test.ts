import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecurityControlService } from "../../src/security/service";
import { DEMO } from "../../src/security/fixtures";
import { handleSecurityRoutes } from "../../src/server/management/security-routes";
import type { ManagementContext } from "../../src/server/management/context";

function mockCtx(method: string, path: string, body?: unknown): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const req = new Request(url.toString(), {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    req,
    url,
    config: {} as never,
    deps: {} as never,
    version: "test",
    convergeCodexCatalog: async () => ({} as never),
    syncClaudeAgentDefsBestEffort: async () => {},
  };
}

describe("local authorized campaign e2e", () => {
  test("auth → scope → campaign → start → recon fixture → lead → finding → validate → report → close", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "sec-e2e-")), "security.sqlite");
    const svc = new SecurityControlService({ dbPath, seedDemo: true });

    const auth = svc.db.getAuthorization(DEMO.authId)!;
    expect(auth.status).toBe("ACTIVE");
    const scope = svc.verifyScope(DEMO.scopeId, DEMO.actor);
    expect(scope.status).toBe("ACTIVE");

    const campaign = svc.startCampaign(DEMO.campaignId, DEMO.actor);
    expect(campaign.status).toBe("RECON_RUNNING");
    expect(campaign.snapshot_id).toBeTruthy();

    const recon = svc.runPassiveRecon(DEMO.campaignId, DEMO.inScopeApp, DEMO.actor);
    expect(recon.decision).toBe("ALLOW");
    const leads = svc.db.listLeads(DEMO.campaignId);
    expect(leads.length).toBeGreaterThan(0);

    const finding = svc.promoteLeadToFinding(leads[0]!.id, "agent.finding-validator");
    const validated = svc.validateFinding(finding.id, {
      scope: true, reality: true, reproducibility: true, impact: true, evidence: true, novelty: true, policy: true,
    }, "reviewer.lab", "seven questions pass");
    expect(validated.status).toBe("VALIDATED");

    const report = svc.exportReport(DEMO.campaignId, "reviewer.lab");
    expect(report.finding_ids).toContain(validated.id);
    const closed = svc.closeCampaign(DEMO.campaignId, DEMO.actor);
    expect(closed.status).toBe("CLOSED");

    process.env.PAO_SECURITY_CONTROL_PLANE = "true";
    const overview = await handleSecurityRoutes(mockCtx("GET", "/api/security/overview"));
    expect(overview?.status).toBe(200);
    const body = await overview!.json() as { data: { campaigns_active: number } };
    expect(typeof body.data.campaigns_active).toBe("number");
  });
});
