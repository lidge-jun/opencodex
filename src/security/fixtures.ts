import { DEFAULT_APPROVAL_TTL_MINUTES, DEFAULT_CAPABILITIES, DEFAULT_RATE_LIMIT_PER_MINUTE } from "./constants";
import type { SecurityDatabase } from "./db";
import { defaultAgentRecords } from "./agents";
import { normalizeAsset } from "./scope";
import type { AssetClass, SecurityPolicyProfile } from "./types";

export const DEMO = {
  orgId: "org.lab",
  authId: "auth.lab",
  expiredAuthId: "auth.expired",
  scopeId: "scope.lab",
  campaignId: "campaign.lab",
  profileId: "profile.strict",
  inScope: "lab.local",
  inScopeApp: "app.lab.local",
  excluded: "admin.lab.local",
  unknown: "evil.example",
  actor: "operator.lab",
} as const;

export function seedCapabilitiesAndAgents(db: SecurityDatabase, now = new Date()): void {
  const created = now.toISOString();
  for (const agent of defaultAgentRecords(now)) db.upsertAgent(agent);
  for (const cap of DEFAULT_CAPABILITIES) {
    db.upsertCapability({ ...cap, enabled: !cap.restricted });
  }
  db.upsertTool({
    id: "tool.recon-fixture",
    capability_id: "cap.recon-passive",
    name: "Local recon fixture",
    kind: "local_fixture",
    allowlisted: true,
    timeout_ms: 1000,
    max_response_bytes: 16_384,
    kill_switch: false,
  });
  db.upsertTool({
    id: "tool.validate-fixture",
    capability_id: "cap.validate-active",
    name: "Local validation fixture",
    kind: "local_fixture",
    allowlisted: true,
    timeout_ms: 1000,
    max_response_bytes: 16_384,
    kill_switch: false,
  });
  db.upsertMcp({
    id: "mcp.local-fixture",
    name: "Local fixture MCP",
    transport: "stdio",
    endpoint: "security://mcp/local-fixture",
    capabilities: ["recon_fixture"],
    risk_tier: "R1",
    network_policy: "deny-all-except-fixture",
    requires_scope: true,
    requires_approval: false,
    credential_ref: "secret://security/mcp/local-fixture",
    health_state: "HEALTHY",
    kill_switch: false,
    last_verified_at: created,
  });
}

export function seedStrictPolicy(db: SecurityDatabase, now = new Date()): SecurityPolicyProfile {
  const profile: SecurityPolicyProfile = {
    id: DEMO.profileId,
    name: "Strict default",
    default_risk_ceiling: "R2",
    block_r3: true,
    r2_requires_approval: true,
    approval_ttl_minutes: DEFAULT_APPROVAL_TTL_MINUTES,
    self_approval: false,
    require_authorization: true,
    require_scope_token: true,
    created_at: now.toISOString(),
  };
  db.upsertPolicyProfile(profile);
  return profile;
}

function addAsset(db: SecurityDatabase, scopeId: string, assetClass: AssetClass, value: string, criticality: number, now: string): string {
  const id = `ast_${assetClass}_${value.replace(/[^a-z0-9]+/gi, "_")}`;
  db.insertAsset({
    id,
    scope_id: scopeId,
    asset_class: assetClass,
    value,
    normalized_asset: normalizeAsset(assetClass, value),
    criticality,
    created_at: now,
  });
  return id;
}

export function seedDemoEnvironment(db: SecurityDatabase, now = new Date()): typeof DEMO {
  const ts = now.toISOString();
  seedCapabilitiesAndAgents(db, now);
  seedStrictPolicy(db, now);

  db.upsertOrganization({ id: DEMO.orgId, name: "Local Lab", created_at: ts, updated_at: ts });

  const from = new Date(now.getTime() - 60_000).toISOString();
  const until = new Date(now.getTime() + 7 * 24 * 3600_000).toISOString();
  db.upsertAuthorization({
    id: DEMO.authId,
    organization_id: DEMO.orgId,
    type: "lab",
    source_reference: "local-lab-authorization",
    valid_from: from,
    valid_until: until,
    status: "ACTIVE",
    allowed_action_classes: ["asset_discovery", "fingerprinting", "controlled_validation", "parse_files", "classify_artifacts", "normalize_scope", "rank_leads", "validate_finding", "write_report", "memory_curate"],
    prohibited_action_classes: ["credential_attack", "privilege_escalation", "persistence", "malware_execution", "data_exfiltration", "service_disruption", "destructive_action"],
    notes: "Safe local demo. No live third-party systems.",
    created_by: DEMO.actor,
    verified_by: DEMO.actor,
    verified_at: ts,
    approval_owner: "reviewer.lab",
    created_at: ts,
    updated_at: ts,
  });
  db.upsertAuthorization({
    id: DEMO.expiredAuthId,
    organization_id: DEMO.orgId,
    type: "lab",
    source_reference: "expired-lab-authorization",
    valid_from: new Date(now.getTime() - 14 * 24 * 3600_000).toISOString(),
    valid_until: new Date(now.getTime() - 24 * 3600_000).toISOString(),
    status: "EXPIRED",
    allowed_action_classes: ["asset_discovery"],
    prohibited_action_classes: [],
    created_by: DEMO.actor,
    created_at: ts,
    updated_at: ts,
  });

  db.upsertScope({
    id: DEMO.scopeId,
    authorization_id: DEMO.authId,
    name: "Local lab assets",
    status: "ACTIVE",
    rate_limit_per_minute: DEFAULT_RATE_LIMIT_PER_MINUTE,
    notes: "lab.local and app.lab.local. admin.lab.local is excluded.",
    created_by: DEMO.actor,
    created_at: ts,
    updated_at: ts,
  });
  try {
    addAsset(db, DEMO.scopeId, "domain", DEMO.inScope, 3, ts);
    addAsset(db, DEMO.scopeId, "domain", DEMO.inScopeApp, 4, ts);
    addAsset(db, DEMO.scopeId, "local_lab", "lab://local", 2, ts);
    db.insertExclusion({
      id: "exc_admin_lab_local",
      scope_id: DEMO.scopeId,
      asset_class: "domain",
      value: DEMO.excluded,
      normalized_asset: normalizeAsset("domain", DEMO.excluded),
      reason: "Administrative interface excluded from recon.",
      created_at: ts,
    });
  } catch (err: unknown) {
    const isConstraint = err instanceof Error && (err.message.includes("constraint") || err.message.includes("UNIQUE"));
    if (!isConstraint) throw err;
  }

  db.upsertCampaign({
    id: DEMO.campaignId,
    organization_id: DEMO.orgId,
    authorization_id: DEMO.authId,
    scope_id: DEMO.scopeId,
    name: "Local lab authorized campaign",
    status: "DRAFT",
    policy_profile_id: DEMO.profileId,
    owner_id: DEMO.actor,
    created_at: ts,
    updated_at: ts,
  });

  return DEMO;
}
