import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecurityControlService } from "../../src/security/service";
import { DEMO } from "../../src/security/fixtures";
import { handleSecurityRoutes } from "../../src/server/management/security-routes";
import type { ManagementContext } from "../../src/server/management/context";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "sec-db-")), "security.sqlite");
}

function service(): SecurityControlService {
  return new SecurityControlService({ dbPath: tempDb(), seedDemo: true });
}

describe("security control plane integration", () => {
  const prev = process.env.PAO_SECURITY_CONTROL_PLANE;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAO_SECURITY_CONTROL_PLANE;
    else process.env.PAO_SECURITY_CONTROL_PLANE = prev;
  });

  test("1. authorized in-scope R1 recon produces a lead", () => {
    const svc = service();
    const started = svc.startCampaign(DEMO.campaignId, DEMO.actor);
    expect(["RECON_RUNNING", "READY"]).toContain(started.status);
    expect(started.snapshot_id).toBeTruthy();
    const result = svc.runPassiveRecon(DEMO.campaignId, DEMO.inScope, DEMO.actor);
    expect(result.decision).toBe("ALLOW");
    expect(result.evidence_refs.length).toBeGreaterThan(0);
    expect(svc.db.listLeads(DEMO.campaignId).length).toBeGreaterThan(0);
  });

  test("2. out-of-scope target is denied", () => {
    const svc = service();
    svc.startCampaign(DEMO.campaignId, DEMO.actor);
    const result = svc.runPassiveRecon(DEMO.campaignId, DEMO.unknown, DEMO.actor);
    expect(result.decision).toBe("DENY");
    expect(result.reason_code).toBe("UNKNOWN_ASSET");
  });

  test("3. expired authorization is denied", () => {
    const svc = service();
    const campaign = svc.createCampaign({
      name: "expired",
      authorization_id: DEMO.expiredAuthId,
      scope_id: DEMO.scopeId,
      owner_id: DEMO.actor,
    });
    const started = svc.startCampaign(campaign.id, DEMO.actor);
    expect(started.status === "BLOCKED_SCOPE" || started.status === "BLOCKED_POLICY").toBe(true);
  });

  test("4. excluded asset is denied", () => {
    const svc = service();
    svc.startCampaign(DEMO.campaignId, DEMO.actor);
    const result = svc.runPassiveRecon(DEMO.campaignId, DEMO.excluded, DEMO.actor);
    expect(result.decision).toBe("DENY");
    expect(result.reason_code).toBe("ASSET_EXCLUDED");
  });

  test("5. R2 without approval is not executed", () => {
    const svc = service();
    svc.startCampaign(DEMO.campaignId, DEMO.actor);
    const token = svc.issueToken(DEMO.campaignId, "cap.validate-active", DEMO.actor);
    const result = svc.invoke({
      campaign_id: DEMO.campaignId,
      actor_id: DEMO.actor,
      actor_role: "security_operator",
      agent_id: "agent.finding-validator",
      capability_id: "cap.validate-active",
      scope_token: token.token,
      target: DEMO.inScope,
      reason: "active validation",
    });
    expect(result.decision).toBe("APPROVAL_REQUIRED");
    expect(svc.db.listApprovals("PENDING").length).toBeGreaterThan(0);
  });

  test("6. R2 with bounded approval may run the fixture", () => {
    const svc = service();
    svc.startCampaign(DEMO.campaignId, DEMO.actor);
    const token = svc.issueToken(DEMO.campaignId, "cap.validate-active", DEMO.actor);
    const pending = svc.invoke({
      campaign_id: DEMO.campaignId,
      actor_id: DEMO.actor,
      actor_role: "security_operator",
      agent_id: "agent.finding-validator",
      capability_id: "cap.validate-active",
      scope_token: token.token,
      target: DEMO.inScope,
      reason: "active validation",
    });
    const approvalId = String((pending.output as { approval_id?: string } | undefined)?.approval_id ?? svc.db.listApprovals("PENDING")[0]?.id);
    const granted = svc.decideApprovalRequest(approvalId, "APPROVE_ONCE", "reviewer.lab", "once");
    expect(granted.status).toBe("GRANTED");
    const token2 = svc.issueToken(DEMO.campaignId, "cap.validate-active", DEMO.actor);
    const allowed = svc.invoke({
      campaign_id: DEMO.campaignId,
      actor_id: DEMO.actor,
      actor_role: "security_operator",
      agent_id: "agent.finding-validator",
      capability_id: "cap.validate-active",
      scope_token: token2.token,
      target: DEMO.inScope,
      approval_id: granted.id,
      reason: "active validation after approval",
    });
    expect(allowed.decision).toBe("ALLOW");
  });

  test("7. R3 is blocked", () => {
    const svc = service();
    svc.startCampaign(DEMO.campaignId, DEMO.actor);
    const result = svc.invoke({
      campaign_id: DEMO.campaignId,
      actor_id: DEMO.actor,
      actor_role: "security_operator",
      agent_id: "agent.recon-agent",
      capability_id: "cap.credential-attack",
      target: DEMO.inScope,
      reason: "should never run",
    });
    expect(result.decision).toBe("DENY");
    expect(["R3_BLOCKED", "RESTRICTED_CAPABILITY", "CAPABILITY_DISABLED"]).toContain(result.reason_code);
  });

  test("8. weak finding cannot be exported", () => {
    const svc = service();
    svc.startCampaign(DEMO.campaignId, DEMO.actor);
    svc.runPassiveRecon(DEMO.campaignId, DEMO.inScope, DEMO.actor);
    const lead = svc.db.listLeads(DEMO.campaignId)[0]!;
    const finding = svc.promoteLeadToFinding(lead.id, "agent.finding-validator");
    const rejected = svc.validateFinding(finding.id, {
      scope: true, reality: false, reproducibility: false, impact: false, evidence: false, novelty: true, policy: true,
    }, "reviewer.lab", "weak");
    expect(rejected.status).toBe("REJECTED");
    expect(() => svc.exportReport(DEMO.campaignId, DEMO.actor, [rejected.id])).toThrow(/validated findings/);
  });

  test("9. valid finding can be reported", () => {
    const svc = service();
    svc.startCampaign(DEMO.campaignId, DEMO.actor);
    svc.runPassiveRecon(DEMO.campaignId, DEMO.inScope, DEMO.actor);
    const lead = svc.db.listLeads(DEMO.campaignId)[0]!;
    const finding = svc.promoteLeadToFinding(lead.id, "agent.finding-validator");
    const validated = svc.validateFinding(finding.id, {
      scope: true, reality: true, reproducibility: true, impact: true, evidence: true, novelty: true, policy: true,
    }, "reviewer.lab", "pass");
    expect(validated.status).toBe("VALIDATED");
    const report = svc.exportReport(DEMO.campaignId, DEMO.actor, [validated.id]);
    expect(report.sha256).toHaveLength(64);
    expect(report.markdown).toContain(validated.title);
  });

  test("10. duplicate lead is not a second finding", () => {
    const svc = service();
    svc.startCampaign(DEMO.campaignId, DEMO.actor);
    svc.runPassiveRecon(DEMO.campaignId, DEMO.inScope, DEMO.actor);
    svc.runPassiveRecon(DEMO.campaignId, DEMO.inScope, DEMO.actor);
    const leads = svc.db.listLeads(DEMO.campaignId);
    expect(leads.filter(l => l.title.includes(DEMO.inScope)).length).toBe(1);
    const first = svc.promoteLeadToFinding(leads[0]!.id, "agent.finding-validator");
    const second = svc.promoteLeadToFinding(leads[0]!.id, "agent.finding-validator");
    expect(second.id).toBe(first.id);
  });

  test("circuit breaker trips on unknown asset then denies follow-up", () => {
    const svc = service();
    svc.startCampaign(DEMO.campaignId, DEMO.actor);
    svc.runPassiveRecon(DEMO.campaignId, DEMO.unknown, DEMO.actor);
    expect(svc.breakerOpen(DEMO.campaignId)).toBe(true);
    const follow = svc.runPassiveRecon(DEMO.campaignId, DEMO.inScope, DEMO.actor);
    expect(follow.reason_code).toBe("CIRCUIT_BREAKER_OPEN");
  });

  test("fixture assets and exclusions seed independently and tolerate re-seed", () => {
    // Seed a shareable DB twice: each asset/exclusion insert must be handled
    // independently, so an already-present duplicate is ignored per record while
    // the whole environment still seeds.
    const dbPath = tempDb();
    const first = new SecurityControlService({ dbPath, seedDemo: true });
    const again = new SecurityControlService({ dbPath, seedDemo: true });

    const assets = first.db.listAssets(DEMO.scopeId);
    const assetValues = assets.map(a => a.value).sort();
    expect(assetValues).toEqual([DEMO.inScope, DEMO.inScopeApp, "lab://local"].sort());

    const exclusions = first.db.listExclusions(DEMO.scopeId);
    expect(exclusions.map(e => e.value)).toContain(DEMO.excluded);

    // Re-seeding must not duplicate fixture records nor leave partial groups.
    const assetsAfter = again.db.listAssets(DEMO.scopeId).map(a => a.value).sort();
    const exclusionsAfter = again.db.listExclusions(DEMO.scopeId).map(e => e.value).sort();
    expect(assetsAfter).toEqual(assetValues);
    expect(exclusionsAfter).toEqual(exclusions.map(e => e.value).sort());
  });

  test("mutating API refuses when feature flag is off", async () => {
    delete process.env.PAO_SECURITY_CONTROL_PLANE;
    const url = new URL("http://127.0.0.1:10100/api/security/campaigns");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", authorization_id: DEMO.authId, scope_id: DEMO.scopeId }),
    });
    const ctx = {
      req,
      url,
      config: {} as never,
      deps: {} as never,
      version: "test",
      convergeCodexCatalog: async () => ({} as never),
      syncClaudeAgentDefsBestEffort: async () => {},
    } as ManagementContext;
    const res = await handleSecurityRoutes(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});
