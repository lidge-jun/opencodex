import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizationClockStatus, actionClassAllowed } from "../../src/security/authorization";
import { createApprovalRequest, decideApproval, isApprovalValid } from "../../src/security/approval";
import { canTransitionCampaign } from "../../src/security/campaign";
import { isSecurityControlPlaneEnabled } from "../../src/security/enabled";
import { ingestEvidence, redactSecrets } from "../../src/security/evidence";
import { applyValidation, evaluateSevenQuestions } from "../../src/security/findings";
import { createFinding } from "../../src/security/findings";
import { importSecurityPackage } from "../../src/security/importer";
import { scoreLead } from "../../src/security/leads";
import { containsSensitiveMemory, sanitizeReusableMemory } from "../../src/security/memory";
import { evaluateSecurityPolicy } from "../../src/security/policy";
import { normalizeAsset, resolveScope } from "../../src/security/scope";
import type { SecurityCapability, SecurityPolicyProfile, SecurityScopeAsset, SecurityScopeExclusion } from "../../src/security/types";

const profile: SecurityPolicyProfile = {
  id: "p",
  name: "strict",
  default_risk_ceiling: "R2",
  block_r3: true,
  r2_requires_approval: true,
  approval_ttl_minutes: 30,
  self_approval: false,
  require_authorization: true,
  require_scope_token: true,
  created_at: new Date().toISOString(),
};

const r0: SecurityCapability = {
  id: "cap.parse-local",
  name: "parse",
  risk_tier: "R0",
  network_access: false,
  requires_scope: false,
  requires_approval: false,
  restricted: false,
  allowed_environments: ["lab"],
  capabilities: ["parse_files"],
  prohibited_capabilities: [],
  enabled: true,
};

const r1: SecurityCapability = {
  ...r0,
  id: "cap.recon-passive",
  name: "recon",
  risk_tier: "R1",
  network_access: true,
  requires_scope: true,
  capabilities: ["asset_discovery"],
};

const r2: SecurityCapability = {
  ...r1,
  id: "cap.validate-active",
  name: "validate",
  risk_tier: "R2",
  requires_approval: true,
  capabilities: ["controlled_validation"],
};

const r3: SecurityCapability = {
  ...r2,
  id: "cap.credential-attack",
  name: "blocked",
  risk_tier: "R3",
  restricted: true,
  capabilities: ["credential_attack"],
  enabled: false,
};

function asset(value: string, asset_class: SecurityScopeAsset["asset_class"] = "domain"): SecurityScopeAsset {
  return {
    id: value,
    scope_id: "s",
    asset_class,
    value,
    normalized_asset: normalizeAsset(asset_class, value),
    criticality: 1,
    created_at: new Date().toISOString(),
  };
}

describe("feature flag", () => {
  test("defaults off", () => {
    expect(isSecurityControlPlaneEnabled({})).toBe(false);
    expect(isSecurityControlPlaneEnabled({ PAO_SECURITY_CONTROL_PLANE: "true" })).toBe(true);
    expect(isSecurityControlPlaneEnabled({ PAO_SECURITY_CONTROL_PLANE: "yes" })).toBe(true);
    expect(isSecurityControlPlaneEnabled({ PAO_SECURITY_CONTROL_PLANE: "false" })).toBe(false);
  });
});

describe("scope matching", () => {
  test("normalizes domains and trailing dots", () => {
    expect(normalizeAsset("domain", "WWW.Lab.Local.")).toBe("lab.local");
  });

  test("in-scope domain and subdomain", () => {
    const assets = [asset("lab.local")];
    expect(resolveScope("lab.local", assets, []).match).toBe("IN_SCOPE");
    expect(resolveScope("app.lab.local", assets, []).match).toBe("IN_SCOPE");
  });

  test("exclusions always win", () => {
    const assets = [asset("lab.local")];
    const exclusions: SecurityScopeExclusion[] = [{
      id: "x",
      scope_id: "s",
      asset_class: "domain",
      value: "admin.lab.local",
      normalized_asset: "admin.lab.local",
      created_at: new Date().toISOString(),
    }];
    expect(resolveScope("admin.lab.local", assets, exclusions).match).toBe("EXCLUDED");
    expect(resolveScope("admin.lab.local", assets, exclusions).reason_code).toBe("ASSET_EXCLUDED");
  });

  test("unknown assets deny; similarity is not in-scope", () => {
    const assets = [asset("lab.local")];
    expect(resolveScope("evil.example", assets, []).match).toBe("UNKNOWN");
    expect(resolveScope("lab.local.evil.example", assets, []).match).toBe("UNKNOWN");
  });

  test("expired scope", () => {
    expect(resolveScope("lab.local", [asset("lab.local")], [], { expired: true }).match).toBe("EXPIRED");
  });

  test("cidr contains", () => {
    const assets = [asset("10.0.0.0/24", "cidr")];
    expect(resolveScope("10.0.0.8", assets, []).match).toBe("IN_SCOPE");
    expect(resolveScope("10.0.1.8", assets, []).match).toBe("UNKNOWN");
  });
});

describe("authorization clock", () => {
  test("active / pending / expired", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    expect(authorizationClockStatus({
      status: "ACTIVE",
      valid_from: "2026-09-01T00:00:00Z",
      valid_until: "2026-09-30T00:00:00Z",
    }, now)).toBe("ACTIVE");
    expect(authorizationClockStatus({
      status: "ACTIVE",
      valid_from: "2026-09-20T00:00:00Z",
      valid_until: "2026-09-30T00:00:00Z",
    }, now)).toBe("PENDING_VERIFICATION");
    expect(authorizationClockStatus({
      status: "ACTIVE",
      valid_from: "2026-08-01T00:00:00Z",
      valid_until: "2026-09-01T00:00:00Z",
    }, now)).toBe("EXPIRED");
    expect(authorizationClockStatus({
      status: "REVOKED",
      valid_from: "2026-09-01T00:00:00Z",
      valid_until: "2026-09-30T00:00:00Z",
    }, now)).toBe("REVOKED");
  });

  test("empty allow-list denies", () => {
    expect(actionClassAllowed({ allowed_action_classes: [], prohibited_action_classes: [] }, "asset_discovery")).toBe(false);
    expect(actionClassAllowed({ allowed_action_classes: ["*"], prohibited_action_classes: ["credential_attack"] }, "asset_discovery")).toBe(true);
    expect(actionClassAllowed({ allowed_action_classes: ["*"], prohibited_action_classes: ["credential_attack"] }, "credential_attack")).toBe(false);
  });
});

describe("policy engine", () => {
  const auth = {
    id: "a",
    organization_id: "o",
    type: "lab" as const,
    source_reference: "x",
    valid_from: "2020-01-01T00:00:00Z",
    valid_until: "2030-01-01T00:00:00Z",
    status: "ACTIVE" as const,
    allowed_action_classes: ["asset_discovery"],
    prohibited_action_classes: [],
    created_by: "t",
    created_at: "",
    updated_at: "",
  };

  test("R0 allows locally", () => {
    const d = evaluateSecurityPolicy({
      capability: r0,
      authorization: auth,
      scopeMatch: "UNKNOWN",
      hasScopeToken: false,
      hasValidApproval: false,
      profile,
    });
    expect(d.decision).toBe("ALLOW");
    expect(d.reason_code).toBe("R0_LOCAL");
  });

  test("R3 is blocked", () => {
    const d = evaluateSecurityPolicy({
      capability: r3,
      authorization: auth,
      scopeMatch: "IN_SCOPE",
      hasScopeToken: true,
      hasValidApproval: true,
      profile,
    });
    expect(d.decision).toBe("DENY");
    expect(d.reason_code).toBe("RESTRICTED_CAPABILITY");
  });

  test("unknown asset denies", () => {
    const d = evaluateSecurityPolicy({
      capability: r1,
      authorization: auth,
      scopeMatch: "UNKNOWN",
      hasScopeToken: true,
      hasValidApproval: false,
      profile,
    });
    expect(d.decision).toBe("DENY");
    expect(d.reason_code).toBe("UNKNOWN_ASSET");
  });

  test("R2 requires approval", () => {
    const d = evaluateSecurityPolicy({
      capability: r2,
      authorization: auth,
      scopeMatch: "IN_SCOPE",
      hasScopeToken: true,
      hasValidApproval: false,
      profile,
      campaignStatus: "RECON_RUNNING",
    });
    expect(d.decision).toBe("APPROVAL_REQUIRED");
  });

  test("missing capability denies", () => {
    const d = evaluateSecurityPolicy({
      authorization: auth,
      scopeMatch: "IN_SCOPE",
      hasScopeToken: true,
      hasValidApproval: false,
      profile,
    });
    expect(d.reason_code).toBe("UNCLASSIFIED_CAPABILITY");
  });

  test("circuit breaker open denies", () => {
    const d = evaluateSecurityPolicy({
      capability: r0,
      authorization: auth,
      scopeMatch: "IN_SCOPE",
      hasScopeToken: true,
      hasValidApproval: false,
      profile,
      breakerOpen: true,
    });
    expect(d.reason_code).toBe("CIRCUIT_BREAKER_OPEN");
  });
});

describe("approval expiry and self-approval", () => {
  test("expired approval is not valid", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    const record = createApprovalRequest({
      campaign_id: "c",
      capability_id: "cap.validate-active",
      target: "lab.local",
      risk_tier: "R2",
      requested_by: "op",
      expected_effect: "probe",
      policy_rule: "R2",
      ttlMinutes: 30,
      now: new Date("2026-09-15T11:00:00Z"),
    });
    expect(isApprovalValid(record, { campaign_id: "c", capability_id: "cap.validate-active" }, now)).toBe(false);
  });

  test("self-approval rejected", () => {
    const record = createApprovalRequest({
      campaign_id: "c",
      capability_id: "cap.validate-active",
      target: "lab.local",
      risk_tier: "R2",
      requested_by: "op",
      expected_effect: "probe",
      policy_rule: "R2",
    });
    const decided = decideApproval(record, "APPROVE_ONCE", "op", "self", profile);
    expect(decided.error).toMatch(/Self-approval/);
  });
});

describe("evidence and memory sanitizer", () => {
  test("hashes body and redacts secrets", () => {
    const ev = ingestEvidence({
      campaign_id: "c",
      type: "log",
      body: `token=${["ghp", "_abcdefghijklmnopqrstuvwxyz012345"].join("_")} and ok`,
      captured_by: "t",
    });
    expect(ev.sha256).toHaveLength(64);
    expect(ev.redacted_preview).toContain("[REDACTED]");
    expect(ev.raw_preview).toBeUndefined();
  });

  test("reusable memory rejects credentials", () => {
    expect(containsSensitiveMemory("password=hunter2hunter2")).toBe(true);
    const rejected = sanitizeReusableMemory("-----BEGIN RSA PRIVATE KEY-----\nMIIE");
    expect(rejected.rejected).toBe(true);
    const ok = sanitizeReusableMemory("Prefer header-based auth over query tokens.");
    expect(ok.rejected).toBe(false);
  });

  test("redactSecrets is deterministic", () => {
    const a = redactSecrets("api_key=abcdefghijklmnop");
    const b = redactSecrets("api_key=abcdefghijklmnop");
    expect(a.redacted).toBe(b.redacted);
  });
});

describe("validation gate and scoring", () => {
  test("weak evidence fails", () => {
    expect(evaluateSevenQuestions({
      scope: true, reality: false, reproducibility: true, impact: true, evidence: false, novelty: true, policy: true,
    })).toBe("FAIL_WEAK_EVIDENCE");
  });

  test("pass requires all seven", () => {
    expect(evaluateSevenQuestions({
      scope: true, reality: true, reproducibility: true, impact: true, evidence: true, novelty: true, policy: true,
    })).toBe("PASS");
  });

  test("duplicate finding status", () => {
    const finding = createFinding({
      campaign_id: "c",
      title: "x",
      category: "xss",
      severity: "low",
      confidence: 50,
      impact_summary: "i",
      technical_summary: "t",
      created_by_agent_id: "a",
    });
    const applied = applyValidation(finding, {
      scope: true, reality: true, reproducibility: true, impact: true, evidence: true, novelty: false, policy: true,
    }, "v", "dup", true);
    expect(applied.finding.status).toBe("DUPLICATE");
  });

  test("lead score formula", () => {
    expect(scoreLead({
      asset_criticality: 3,
      evidence_strength: 2,
      confidence: 4,
      novelty: 1,
      memory_signal: 1,
      policy_risk_penalty: 2,
      duplication_penalty: 1,
    })).toBe(8);
  });
});

describe("campaign transitions", () => {
  test("draft cannot jump to closed", () => {
    expect(canTransitionCampaign("DRAFT", "CLOSED")).toBe(false);
    expect(canTransitionCampaign("DRAFT", "SCOPE_CHECK")).toBe(true);
    expect(canTransitionCampaign("REPORT_READY", "CLOSED")).toBe(true);
  });
});

describe("static importer never executes", () => {
  test("quarantines install.sh and restricted text", () => {
    const dir = mkdtempSync(join(tmpdir(), "sec-pkg-"));
    writeFileSync(join(dir, "SKILL.md"), "# skill\ncredential spray helper\n");
    writeFileSync(join(dir, "install.sh"), "#!/bin/sh\necho no\n");
    mkdirSync(join(dir, "tools"));
    const imported = importSecurityPackage(dir, "test");
    expect(imported.compatibility).toBe("QUARANTINED");
    expect(imported.restricted_items.some(p => p.includes("install.sh"))).toBe(true);
    expect(imported.warnings.some(w => /never auto-executed/i.test(w) || /will not be run/.test(w))).toBe(true);
  });
});
