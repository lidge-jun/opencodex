import { describe, expect, test } from "bun:test";
import { createApprovalRequest, decideApproval, isApprovalValidForVersion } from "../../src/skills/approval";
import { evaluateSkillPolicy } from "../../src/skills/policy";
import type { SkillRiskAssessment, SkillVersionRecord } from "../../src/skills/types";

describe("Skill Policy & Approval Workflow", () => {
  const lowRisk: SkillRiskAssessment = {
    score: 10,
    level: "low",
    inferred_capabilities: ["filesystem.project.read"],
    findings: [],
    hard_escalations: [],
  };

  const criticalRisk: SkillRiskAssessment = {
    score: 95,
    level: "critical",
    inferred_capabilities: ["process.command.execute", "network.exfiltration"],
    findings: [],
    hard_escalations: ["Policy bypass + destructive command"],
  };

  test("policy allows low risk skills in development", () => {
    const decision = evaluateSkillPolicy(lowRisk, { environment: "dev" });
    expect(decision.effect).toBe("allow");
  });

  test("policy denies autonomous deployment for critical skills", () => {
    const decision = evaluateSkillPolicy(criticalRisk, {
      environment: "dev",
      isAutonomousDeploy: true,
      hasApproval: false,
    });
    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("cannot be deployed autonomously");
  });

  test("policy requires approval for shell execution in production", () => {
    const prodRisk: SkillRiskAssessment = {
      score: 30,
      level: "medium",
      inferred_capabilities: ["process.command.execute"],
      findings: [],
      hard_escalations: [],
    };

    const unapproved = evaluateSkillPolicy(prodRisk, { environment: "prod", hasApproval: false });
    expect(unapproved.effect).toBe("require_approval");

    const approved = evaluateSkillPolicy(prodRisk, { environment: "prod", hasApproval: true });
    expect(approved.effect).toBe("allow");
  });

  test("approval binds to exact content hash; content mutation invalidates approval", () => {
    const originalHash = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const mutatedHash = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

    const approval = createApprovalRequest({
      skillVersionId: "test.skill@1.0.0",
      contentSha256: originalHash,
      requestedBy: "agent-1",
    });

    const approved = decideApproval(approval, "APPROVED", "operator-1", "Looks good").record;

    const validVersion: SkillVersionRecord = {
      id: "test.skill@1.0.0",
      skill_id: "test.skill",
      version: "1.0.0",
      manifest: {} as any,
      content_sha256: originalHash,
      scan_status: "scanned",
      immutable: true,
      created_at: new Date().toISOString(),
    };

    expect(isApprovalValidForVersion(approved, validVersion)).toBe(true);

    const mutatedVersion: SkillVersionRecord = {
      ...validVersion,
      content_sha256: mutatedHash,
    };

    // Fails closed: Approval is INVALID for mutated content!
    expect(isApprovalValidForVersion(approved, mutatedVersion)).toBe(false);
  });

  test("separation of duties prevents self-approval of elevated risk skills", () => {
    const approval = createApprovalRequest({
      skillVersionId: "critical.skill@1.0.0",
      contentSha256: "sha256:abc",
      requestedBy: "agent-1",
      riskSnapshot: criticalRisk,
    });

    // Same actor attempting self-approval:
    const outcome = decideApproval(approval, "APPROVED", "agent-1", "Self approving");
    expect(outcome.error).toContain("Self-approval rejected");
    expect(outcome.record.status).toBe("PENDING");
  });
});

