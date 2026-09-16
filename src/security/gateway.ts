import { randomBytes } from "node:crypto";
import { isApprovalValid } from "./approval";
import { isBreakerOpen, recordError, tripBreaker } from "./circuit";
import { BLOCKED_ACTION_CLASSES, DEFAULT_RATE_LIMIT_PER_MINUTE, SECURITY_POLICY_VERSION } from "./constants";
import type { SecurityDatabase } from "./db";
import { ingestEvidence } from "./evidence";
import { evaluateSecurityPolicy } from "./policy";
import { resolveScope } from "./scope";
import { verifyScopeToken } from "./token";
import type {
  SecurityCampaignScopeSnapshot,
  SecurityCapability,
  SecurityRole,
  SecurityScopeAsset,
  SecurityScopeExclusion,
  ToolGatewayResult,
  ToolInvocationRequest,
} from "./types";

const FIXTURE_RECON: Record<string, Record<string, unknown>> = {
  "lab.local": {
    host: "lab.local",
    status: 200,
    server: "fixture-httpd/1.0",
    headers: { "x-powered-by": "php/fixture", "content-type": "text/html" },
    notes: "Local lab fixture only. No network request was made.",
  },
  "app.lab.local": {
    host: "app.lab.local",
    status: 200,
    server: "fixture-nginx/1.0",
    headers: { "content-type": "application/json" },
    notes: "Local lab fixture only. No network request was made.",
  },
};

function parseSnapshot(snapshot: SecurityCampaignScopeSnapshot): {
  assets: SecurityScopeAsset[];
  exclusions: SecurityScopeExclusion[];
} {
  return {
    assets: JSON.parse(snapshot.assets_json) as SecurityScopeAsset[],
    exclusions: JSON.parse(snapshot.exclusions_json) as SecurityScopeExclusion[],
  };
}

function denied(reason: string, extra: Partial<ToolGatewayResult> = {}): ToolGatewayResult {
  return {
    decision: "DENY",
    reason_code: reason,
    policy_version: SECURITY_POLICY_VERSION,
    evidence_refs: [],
    ...extra,
  };
}

function consumeRateLimit(db: SecurityDatabase, campaignId: string, capabilityId: string, limit: number, now: Date): boolean {
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  const id = `rl_${campaignId}_${capabilityId}_${windowStart}`;
  const current = db.getRateLimit(id);
  const count = (current?.count ?? 0) + 1;
  db.upsertRateLimit({
    id,
    campaign_id: campaignId,
    capability_id: capabilityId,
    window_started_at: windowStart,
    count,
    limit,
  });
  return count > limit;
}

function runLocalFixture(capability: SecurityCapability, target: string): { ok: boolean; output: Record<string, unknown>; reason?: string } {
  if (capability.id === "cap.credential-attack" || capability.restricted) {
    return { ok: false, output: {}, reason: "RESTRICTED_CAPABILITY" };
  }
  if (capability.network_access && capability.risk_tier !== "R0") {
    const host = target.replace(/^https?:\/\//, "").split("/")[0]?.toLowerCase() ?? target;
    const fixture = FIXTURE_RECON[host] ?? FIXTURE_RECON[target];
    if (!fixture) {
      return {
        ok: true,
        output: {
          target,
          fixture: true,
          status: "no-match",
          notes: "No fixture data for this in-scope asset. Live tools are not invoked.",
        },
      };
    }
    return { ok: true, output: { ...fixture, fixture: true, target } };
  }
  return {
    ok: true,
    output: { target, fixture: true, capability: capability.id, notes: "Local non-targeting capability executed in-process." },
  };
}

export function invokeSecurityTool(
  db: SecurityDatabase,
  request: ToolInvocationRequest,
  options: { now?: Date; actorRole?: SecurityRole } = {},
): ToolGatewayResult {
  const now = options.now ?? new Date();
  const campaign = db.getCampaign(request.campaign_id);
  if (!campaign) return denied("CAMPAIGN_NOT_FOUND");

  const capability = db.getCapability(request.capability_id);
  const agent = db.getAgent(request.agent_id);
  const auth = db.getAuthorization(campaign.authorization_id);
  const profile = db.getPolicyProfile(campaign.policy_profile_id);
  if (!profile) return denied("POLICY_PROFILE_MISSING");

  if (!capability) return denied("UNCLASSIFIED_CAPABILITY");
  if (capability.restricted) return denied("RESTRICTED_CAPABILITY");
  if (!capability.enabled) return denied("CAPABILITY_DISABLED");
  if (capability.risk_tier === "R3") return denied("R3_BLOCKED");
  if (capability.capabilities.some(c => (BLOCKED_ACTION_CLASSES as readonly string[]).includes(c))) {
    return denied("RESTRICTED_CAPABILITY");
  }

  const tools = db.listTools().filter(t => t.capability_id === request.capability_id);
  if (tools.some(t => t.kill_switch) || tools.some(t => !t.allowlisted && t.kind !== "local_fixture")) {
    return denied("TOOL_KILL_SWITCH");
  }
  if (tools.length === 0 && capability.network_access) {
    return denied("TOOL_NOT_ALLOWLISTED");
  }

  const snapshot = campaign.snapshot_id ? db.getSnapshot(campaign.snapshot_id) : null;
  const scopePack = snapshot
    ? parseSnapshot(snapshot)
    : { assets: db.listAssets(campaign.scope_id), exclusions: db.listExclusions(campaign.scope_id) };
  const scopeExpired = Boolean(auth && Date.parse(auth.valid_until) <= now.getTime());
  const scopeMatch = resolveScope(request.target, scopePack.assets, scopePack.exclusions, { expired: scopeExpired });

  let hasScopeToken = false;
  let scopeTokenId: string | undefined;
  if (request.scope_token) {
    const verified = verifyScopeToken(db, request.scope_token, {
      campaign_id: request.campaign_id,
      capability_id: request.capability_id,
    }, now);
    hasScopeToken = verified.ok;
    if (verified.ok) scopeTokenId = verified.record.id;
    else if (capability?.requires_scope && profile.require_scope_token) {
      return denied(verified.reason_code);
    }
  }

  const approval = request.approval_id ? db.getApproval(request.approval_id) : null;
  const hasValidApproval = isApprovalValid(approval, {
    campaign_id: request.campaign_id,
    capability_id: request.capability_id,
    target: request.target,
  }, now);

  if (isBreakerOpen(db, campaign.id)) {
    return denied("CIRCUIT_BREAKER_OPEN");
  }

  const evaluation = evaluateSecurityPolicy({
    capability,
    requestedTier: request.risk_tier,
    authorization: auth,
    scopeMatch: scopeMatch.match,
    hasScopeToken,
    hasValidApproval,
    campaignStatus: campaign.status,
    agentMaxTier: agent?.max_risk_tier,
    breakerOpen: false,
    profile,
    now,
  });

  const decisionId = `pdc_${randomBytes(8).toString("hex")}`;
  db.insertPolicyDecision({
    id: decisionId,
    campaign_id: campaign.id,
    capability_id: request.capability_id,
    target: request.target,
    decision: evaluation.decision,
    reason_code: evaluation.reason_code,
    policy_version: evaluation.policy_version,
    risk_tier: evaluation.risk_tier,
    created_at: now.toISOString(),
  });

  const executionId = `exe_${randomBytes(8).toString("hex")}`;
  db.insertExecution({
    id: executionId,
    campaign_id: campaign.id,
    agent_id: request.agent_id,
    actor_id: request.actor_id,
    capability_id: request.capability_id,
    scope_token_id: scopeTokenId,
    target: request.target,
    risk_tier: evaluation.risk_tier,
    approval_id: request.approval_id,
    policy_decision_id: decisionId,
    status: evaluation.decision === "ALLOW" ? "STARTED" : "DENIED",
    reason_code: evaluation.reason_code,
    started_at: now.toISOString(),
    finished_at: evaluation.decision === "ALLOW" ? undefined : now.toISOString(),
  });

  db.insertAudit({
    id: `aud_${randomBytes(8).toString("hex")}`,
    event_type: evaluation.decision === "ALLOW" ? "SECURITY_POLICY_ALLOW" : evaluation.decision === "APPROVAL_REQUIRED" ? "SECURITY_APPROVAL_REQUESTED" : "SECURITY_POLICY_DENY",
    actor_id: request.actor_id,
    actor_role: options.actorRole ?? request.actor_role,
    campaign_id: campaign.id,
    execution_id: executionId,
    policy_decision_id: decisionId,
    agent_id: request.agent_id,
    target: request.target,
    metadata: { reason_code: evaluation.reason_code, capability_id: request.capability_id },
    created_at: now.toISOString(),
  });

  if (evaluation.decision !== "ALLOW") {
    if (evaluation.reason_code === "UNKNOWN_ASSET" || evaluation.reason_code === "ASSET_EXCLUDED" || evaluation.reason_code === "SCOPE_EXPIRED") {
      tripBreaker(db, campaign.id, "scope", now);
    }
    if (evaluation.reason_code === "AUTHORIZATION_NOT_ACTIVE" || evaluation.reason_code === "NO_AUTHORIZATION") {
      tripBreaker(db, campaign.id, "authorization", now);
    }
    return {
      decision: evaluation.decision,
      execution_id: executionId,
      reason_code: evaluation.reason_code,
      policy_version: evaluation.policy_version,
      evidence_refs: [],
    };
  }

  const scope = db.getScope(campaign.scope_id);
  const limit = scope?.rate_limit_per_minute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  if (consumeRateLimit(db, campaign.id, request.capability_id, limit, now)) {
    tripBreaker(db, campaign.id, "rate", now);
    db.insertExecution({
      id: executionId,
      campaign_id: campaign.id,
      agent_id: request.agent_id,
      actor_id: request.actor_id,
      capability_id: request.capability_id,
      target: request.target,
      risk_tier: evaluation.risk_tier,
      status: "DENIED",
      reason_code: "RATE_LIMITED",
      started_at: now.toISOString(),
      finished_at: now.toISOString(),
    });
    return denied("RATE_LIMITED", { execution_id: executionId });
  }

  if (!capability) return denied("UNCLASSIFIED_CAPABILITY", { execution_id: executionId });

  const ran = runLocalFixture(capability, request.target);
  if (!ran.ok) {
    recordError(db, campaign.id, now);
    db.insertExecution({
      id: executionId,
      campaign_id: campaign.id,
      agent_id: request.agent_id,
      actor_id: request.actor_id,
      capability_id: request.capability_id,
      target: request.target,
      risk_tier: evaluation.risk_tier,
      policy_decision_id: decisionId,
      status: "FAILED",
      reason_code: ran.reason,
      started_at: now.toISOString(),
      finished_at: now.toISOString(),
    });
    return denied(ran.reason ?? "TOOL_FAILED", { execution_id: executionId });
  }

  const evidence = ingestEvidence({
    campaign_id: campaign.id,
    asset_id: scopeMatch.asset?.id,
    execution_id: executionId,
    type: capability.id === "cap.recon-passive" ? "recon_fixture" : "tool_output",
    body: JSON.stringify(ran.output),
    mime_type: "application/json",
    captured_by: request.actor_id,
    now,
  });
  db.insertEvidence(evidence);
  db.insertExecution({
    id: executionId,
    campaign_id: campaign.id,
    agent_id: request.agent_id,
    actor_id: request.actor_id,
    capability_id: request.capability_id,
    scope_token_id: scopeTokenId,
    target: request.target,
    risk_tier: evaluation.risk_tier,
    approval_id: request.approval_id,
    policy_decision_id: decisionId,
    status: "FINISHED",
    reason_code: evaluation.reason_code,
    started_at: now.toISOString(),
    finished_at: now.toISOString(),
  });
  db.insertAudit({
    id: `aud_${randomBytes(8).toString("hex")}`,
    event_type: "SECURITY_TOOL_FINISHED",
    actor_id: request.actor_id,
    actor_role: options.actorRole ?? request.actor_role,
    campaign_id: campaign.id,
    execution_id: executionId,
    agent_id: request.agent_id,
    target: request.target,
    metadata: { evidence_id: evidence.id },
    created_at: now.toISOString(),
  });

  return {
    decision: "ALLOW",
    execution_id: executionId,
    reason_code: evaluation.reason_code,
    policy_version: evaluation.policy_version,
    evidence_refs: [evidence.id],
    output: ran.output,
  };
}
