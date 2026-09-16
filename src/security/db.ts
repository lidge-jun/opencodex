import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { getConfigDir } from "../config/paths";
import type {
  SecurityAgentRecord,
  SecurityApproval,
  SecurityAuditEvent,
  SecurityAuthorization,
  SecurityCampaign,
  SecurityCampaignScopeSnapshot,
  SecurityCapability,
  SecurityCircuitBreaker,
  SecurityEvidence,
  SecurityFinding,
  SecurityImportedPackage,
  SecurityLead,
  SecurityMcpServer,
  SecurityMemoryRef,
  SecurityOrganization,
  SecurityPolicyDecision,
  SecurityPolicyProfile,
  SecurityRateLimit,
  SecurityScope,
  SecurityScopeAsset,
  SecurityScopeExclusion,
  SecurityTask,
  SecurityToolRegistration,
  SecurityValidationResult,
  ScopeToken,
  SecurityExecution,
} from "./types";

export function getDefaultSecurityDbPath(customDir?: string): string {
  const dir = customDir ?? getConfigDir();
  return join(dir, "security.sqlite");
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

export class SecurityDatabase {
  public readonly db: Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? getDefaultSecurityDbPath();
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(resolvedPath);
    try {
      (this.db as Database & { timeout?: number }).timeout = 2000;
    } catch { /* best effort */ }
    this.db.exec("PRAGMA busy_timeout = 2000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS security_organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_authorizations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        "type" TEXT NOT NULL,
        source_reference TEXT NOT NULL,
        evidence_uri TEXT,
        valid_from TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        status TEXT NOT NULL,
        allowed_action_classes TEXT NOT NULL,
        prohibited_action_classes TEXT NOT NULL,
        notes TEXT,
        created_by TEXT NOT NULL,
        verified_by TEXT,
        verified_at TEXT,
        approval_owner TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_scopes (
        id TEXT PRIMARY KEY,
        authorization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        rate_limit_per_minute INTEGER NOT NULL DEFAULT 30,
        notes TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_scope_assets (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        "value" TEXT NOT NULL,
        normalized_asset TEXT NOT NULL,
        criticality INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_scope_exclusions (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        "value" TEXT NOT NULL,
        normalized_asset TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_policy_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        default_risk_ceiling TEXT NOT NULL,
        block_r3 INTEGER NOT NULL DEFAULT 1,
        r2_requires_approval INTEGER NOT NULL DEFAULT 1,
        approval_ttl_minutes INTEGER NOT NULL DEFAULT 30,
        self_approval INTEGER NOT NULL DEFAULT 0,
        require_authorization INTEGER NOT NULL DEFAULT 1,
        require_scope_token INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_campaigns (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        authorization_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        snapshot_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        policy_profile_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        blocked_reason TEXT,
        started_at TEXT,
        closed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_campaign_scope_snapshots (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        authorization_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        assets_json TEXT NOT NULL,
        exclusions_json TEXT NOT NULL,
        allowed_action_classes_json TEXT NOT NULL,
        prohibited_action_classes_json TEXT NOT NULL,
        frozen_at TEXT NOT NULL,
        frozen_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_agents (
        id TEXT PRIMARY KEY,
        "kind" TEXT NOT NULL,
        display_name TEXT NOT NULL,
        max_risk_tier TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_capabilities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        risk_tier TEXT NOT NULL,
        network_access INTEGER NOT NULL DEFAULT 0,
        requires_scope INTEGER NOT NULL DEFAULT 1,
        requires_approval INTEGER NOT NULL DEFAULT 0,
        restricted INTEGER NOT NULL DEFAULT 0,
        allowed_environments TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        prohibited_capabilities TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS security_tool_registrations (
        id TEXT PRIMARY KEY,
        capability_id TEXT NOT NULL,
        name TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        allowlisted INTEGER NOT NULL DEFAULT 0,
        timeout_ms INTEGER NOT NULL DEFAULT 5000,
        max_response_bytes INTEGER NOT NULL DEFAULT 65536,
        kill_switch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS security_mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        transport TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        risk_tier TEXT NOT NULL,
        network_policy TEXT NOT NULL,
        requires_scope INTEGER NOT NULL DEFAULT 1,
        requires_approval INTEGER NOT NULL DEFAULT 1,
        credential_ref TEXT,
        health_state TEXT NOT NULL,
        kill_switch INTEGER NOT NULL DEFAULT 0,
        last_verified_at TEXT
      );
      CREATE TABLE IF NOT EXISTS security_tasks (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        asset_id TEXT,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        approval_id TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_executions (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        task_id TEXT,
        agent_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        scope_token_id TEXT,
        target TEXT NOT NULL,
        risk_tier TEXT NOT NULL,
        approval_id TEXT,
        policy_decision_id TEXT,
        status TEXT NOT NULL,
        reason_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS security_approvals (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        task_id TEXT,
        execution_id TEXT,
        capability_id TEXT NOT NULL,
        target TEXT NOT NULL,
        risk_tier TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_agent_id TEXT,
        request_volume INTEGER NOT NULL DEFAULT 1,
        max_duration_seconds INTEGER NOT NULL DEFAULT 300,
        expected_effect TEXT NOT NULL,
        policy_rule TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        status TEXT NOT NULL,
        decision TEXT,
        decided_by TEXT,
        decision_reason TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS security_leads (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        asset_id TEXT,
        "source" TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        priority INTEGER NOT NULL,
        confidence INTEGER NOT NULL,
        status TEXT NOT NULL,
        assigned_agent_id TEXT,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        memory_refs TEXT,
        score_components TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_touched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_findings (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        asset_id TEXT,
        lead_id TEXT,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        impact_summary TEXT NOT NULL,
        technical_summary TEXT NOT NULL,
        scope_snapshot_id TEXT,
        validation_result_id TEXT,
        status TEXT NOT NULL,
        created_by_agent_id TEXT NOT NULL,
        human_owner_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_validation_results (
        id TEXT PRIMARY KEY,
        finding_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        disposition TEXT NOT NULL,
        answers TEXT NOT NULL,
        notes TEXT NOT NULL,
        validated_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_evidence (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        asset_id TEXT,
        execution_id TEXT,
        "type" TEXT NOT NULL,
        storage_uri TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        captured_by TEXT NOT NULL,
        redaction_state TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        retention_class TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        raw_preview TEXT,
        redacted_preview TEXT
      );
      CREATE TABLE IF NOT EXISTS security_memory_refs (
        id TEXT PRIMARY KEY,
        campaign_id TEXT,
        tier TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        body TEXT NOT NULL,
        sanitized INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS security_policy_decisions (
        id TEXT PRIMARY KEY,
        execution_id TEXT,
        campaign_id TEXT,
        capability_id TEXT NOT NULL,
        target TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        risk_tier TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        campaign_id TEXT,
        execution_id TEXT,
        task_id TEXT,
        approval_id TEXT,
        policy_decision_id TEXT,
        agent_id TEXT,
        target TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_rate_limits (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        window_started_at TEXT NOT NULL,
        "count" INTEGER NOT NULL,
        max_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_circuit_breakers (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        state TEXT NOT NULL,
        trip_count INTEGER NOT NULL DEFAULT 0,
        last_tripped_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(campaign_id, "kind")
      );
      CREATE TABLE IF NOT EXISTS security_scope_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        campaign_id TEXT NOT NULL,
        asset_id TEXT,
        capability_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_imported_packages (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        "source" TEXT NOT NULL,
        source_commit TEXT,
        compatibility TEXT NOT NULL,
        restricted_items TEXT NOT NULL,
        warnings TEXT NOT NULL,
        inventory_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        activated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS security_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT,
        risk_tier TEXT NOT NULL,
        restricted INTEGER NOT NULL DEFAULT 0,
        package_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sec_scope_assets_norm ON security_scope_assets(normalized_asset);
      CREATE INDEX IF NOT EXISTS idx_sec_campaigns_status ON security_campaigns(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_sec_tasks_campaign ON security_tasks(campaign_id, status, priority);
      CREATE INDEX IF NOT EXISTS idx_sec_leads_campaign ON security_leads(campaign_id, status, priority);
      CREATE INDEX IF NOT EXISTS idx_sec_findings_campaign ON security_findings(campaign_id, status, severity);
      CREATE INDEX IF NOT EXISTS idx_sec_executions_campaign ON security_executions(campaign_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_sec_audit_campaign ON security_audit_events(campaign_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sec_policy_exec ON security_policy_decisions(execution_id);
      CREATE INDEX IF NOT EXISTS idx_sec_approvals_status ON security_approvals(status, expires_at);
    `);
  }

  // --- Organizations ---
  public upsertOrganization(row: SecurityOrganization): void {
    this.db.prepare(`INSERT INTO security_organizations (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`)
      .run(row.id, row.name, row.created_at, row.updated_at);
  }
  public getOrganization(id: string): SecurityOrganization | null {
    const r = this.db.prepare("SELECT * FROM security_organizations WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? { id: String(r.id), name: String(r.name), created_at: String(r.created_at), updated_at: String(r.updated_at) } : null;
  }
  public listOrganizations(): SecurityOrganization[] {
    return (this.db.prepare("SELECT * FROM security_organizations ORDER BY name").all() as Record<string, unknown>[])
      .map(r => ({ id: String(r.id), name: String(r.name), created_at: String(r.created_at), updated_at: String(r.updated_at) }));
  }

  // --- Authorizations ---
  public upsertAuthorization(row: SecurityAuthorization): void {
    this.db.prepare(`INSERT INTO security_authorizations
      (id, organization_id, "type", source_reference, evidence_uri, valid_from, valid_until, status,
       allowed_action_classes, prohibited_action_classes, notes, created_by, verified_by, verified_at, approval_owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, valid_from=excluded.valid_from, valid_until=excluded.valid_until,
        allowed_action_classes=excluded.allowed_action_classes, prohibited_action_classes=excluded.prohibited_action_classes,
        notes=excluded.notes, verified_by=excluded.verified_by, verified_at=excluded.verified_at,
        approval_owner=excluded.approval_owner, updated_at=excluded.updated_at`)
      .run(row.id, row.organization_id, row.type, row.source_reference, row.evidence_uri ?? null,
        row.valid_from, row.valid_until, row.status, jsonText(row.allowed_action_classes),
        jsonText(row.prohibited_action_classes), row.notes ?? null, row.created_by,
        row.verified_by ?? null, row.verified_at ?? null, row.approval_owner ?? null,
        row.created_at, row.updated_at);
  }
  private mapAuth(r: Record<string, unknown>): SecurityAuthorization {
    return {
      id: String(r.id), organization_id: String(r.organization_id), type: r.type as SecurityAuthorization["type"],
      source_reference: String(r.source_reference), evidence_uri: r.evidence_uri ? String(r.evidence_uri) : undefined,
      valid_from: String(r.valid_from), valid_until: String(r.valid_until),
      status: r.status as SecurityAuthorization["status"],
      allowed_action_classes: parseJson(r.allowed_action_classes, []),
      prohibited_action_classes: parseJson(r.prohibited_action_classes, []),
      notes: r.notes ? String(r.notes) : undefined, created_by: String(r.created_by),
      verified_by: r.verified_by ? String(r.verified_by) : undefined,
      verified_at: r.verified_at ? String(r.verified_at) : undefined,
      approval_owner: r.approval_owner ? String(r.approval_owner) : undefined,
      created_at: String(r.created_at), updated_at: String(r.updated_at),
    };
  }
  public getAuthorization(id: string): SecurityAuthorization | null {
    const r = this.db.prepare("SELECT * FROM security_authorizations WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapAuth(r) : null;
  }
  public listAuthorizations(): SecurityAuthorization[] {
    return (this.db.prepare("SELECT * FROM security_authorizations ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map(r => this.mapAuth(r));
  }

  // --- Scopes ---
  public upsertScope(row: SecurityScope): void {
    this.db.prepare(`INSERT INTO security_scopes (id, authorization_id, name, status, rate_limit_per_minute, notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, status=excluded.status, rate_limit_per_minute=excluded.rate_limit_per_minute, notes=excluded.notes, updated_at=excluded.updated_at`)
      .run(row.id, row.authorization_id, row.name, row.status, row.rate_limit_per_minute, row.notes ?? null, row.created_by, row.created_at, row.updated_at);
  }
  private mapScope(r: Record<string, unknown>): SecurityScope {
    return {
      id: String(r.id), authorization_id: String(r.authorization_id), name: String(r.name),
      status: r.status as SecurityScope["status"], rate_limit_per_minute: Number(r.rate_limit_per_minute),
      notes: r.notes ? String(r.notes) : undefined, created_by: String(r.created_by),
      created_at: String(r.created_at), updated_at: String(r.updated_at),
    };
  }
  public getScope(id: string): SecurityScope | null {
    const r = this.db.prepare("SELECT * FROM security_scopes WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapScope(r) : null;
  }
  public listScopes(): SecurityScope[] {
    return (this.db.prepare("SELECT * FROM security_scopes ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map(r => this.mapScope(r));
  }
  public insertAsset(row: SecurityScopeAsset): void {
    this.db.prepare(`INSERT INTO security_scope_assets (id, scope_id, asset_class, "value", normalized_asset, criticality, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.scope_id, row.asset_class, row.value, row.normalized_asset, row.criticality, row.created_at);
  }
  public insertExclusion(row: SecurityScopeExclusion): void {
    this.db.prepare(`INSERT INTO security_scope_exclusions (id, scope_id, asset_class, "value", normalized_asset, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.scope_id, row.asset_class, row.value, row.normalized_asset, row.reason ?? null, row.created_at);
  }
  public listAssets(scopeId: string): SecurityScopeAsset[] {
    return (this.db.prepare("SELECT * FROM security_scope_assets WHERE scope_id = ?").all(scopeId) as Record<string, unknown>[]).map(r => ({
      id: String(r.id), scope_id: String(r.scope_id), asset_class: r.asset_class as SecurityScopeAsset["asset_class"],
      value: String(r.value), normalized_asset: String(r.normalized_asset), criticality: Number(r.criticality), created_at: String(r.created_at),
    }));
  }
  public listExclusions(scopeId: string): SecurityScopeExclusion[] {
    return (this.db.prepare("SELECT * FROM security_scope_exclusions WHERE scope_id = ?").all(scopeId) as Record<string, unknown>[]).map(r => ({
      id: String(r.id), scope_id: String(r.scope_id), asset_class: r.asset_class as SecurityScopeExclusion["asset_class"],
      value: String(r.value), normalized_asset: String(r.normalized_asset), reason: r.reason ? String(r.reason) : undefined, created_at: String(r.created_at),
    }));
  }

  // --- Policy profiles ---
  public upsertPolicyProfile(row: SecurityPolicyProfile): void {
    this.db.prepare(`INSERT INTO security_policy_profiles
      (id, name, default_risk_ceiling, block_r3, r2_requires_approval, approval_ttl_minutes, self_approval, require_authorization, require_scope_token, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, default_risk_ceiling=excluded.default_risk_ceiling, block_r3=excluded.block_r3,
        r2_requires_approval=excluded.r2_requires_approval, approval_ttl_minutes=excluded.approval_ttl_minutes, self_approval=excluded.self_approval`)
      .run(row.id, row.name, row.default_risk_ceiling, row.block_r3 ? 1 : 0, row.r2_requires_approval ? 1 : 0,
        row.approval_ttl_minutes, row.self_approval ? 1 : 0, row.require_authorization ? 1 : 0, row.require_scope_token ? 1 : 0, row.created_at);
  }
  private mapProfile(r: Record<string, unknown>): SecurityPolicyProfile {
    return {
      id: String(r.id), name: String(r.name), default_risk_ceiling: r.default_risk_ceiling as SecurityPolicyProfile["default_risk_ceiling"],
      block_r3: Boolean(r.block_r3), r2_requires_approval: Boolean(r.r2_requires_approval),
      approval_ttl_minutes: Number(r.approval_ttl_minutes), self_approval: Boolean(r.self_approval),
      require_authorization: Boolean(r.require_authorization), require_scope_token: Boolean(r.require_scope_token),
      created_at: String(r.created_at),
    };
  }
  public getPolicyProfile(id: string): SecurityPolicyProfile | null {
    const r = this.db.prepare("SELECT * FROM security_policy_profiles WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapProfile(r) : null;
  }
  public listPolicyProfiles(): SecurityPolicyProfile[] {
    return (this.db.prepare("SELECT * FROM security_policy_profiles").all() as Record<string, unknown>[]).map(r => this.mapProfile(r));
  }

  // --- Campaigns ---
  public upsertCampaign(row: SecurityCampaign): void {
    this.db.prepare(`INSERT INTO security_campaigns
      (id, organization_id, authorization_id, scope_id, snapshot_id, name, status, policy_profile_id, owner_id, blocked_reason, started_at, closed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, snapshot_id=excluded.snapshot_id, blocked_reason=excluded.blocked_reason,
        started_at=excluded.started_at, closed_at=excluded.closed_at, updated_at=excluded.updated_at`)
      .run(row.id, row.organization_id, row.authorization_id, row.scope_id, row.snapshot_id ?? null, row.name, row.status,
        row.policy_profile_id, row.owner_id, row.blocked_reason ?? null, row.started_at ?? null, row.closed_at ?? null, row.created_at, row.updated_at);
  }
  private mapCampaign(r: Record<string, unknown>): SecurityCampaign {
    return {
      id: String(r.id), organization_id: String(r.organization_id), authorization_id: String(r.authorization_id),
      scope_id: String(r.scope_id), snapshot_id: r.snapshot_id ? String(r.snapshot_id) : undefined, name: String(r.name),
      status: r.status as SecurityCampaign["status"], policy_profile_id: String(r.policy_profile_id), owner_id: String(r.owner_id),
      blocked_reason: r.blocked_reason ? String(r.blocked_reason) : undefined,
      started_at: r.started_at ? String(r.started_at) : undefined, closed_at: r.closed_at ? String(r.closed_at) : undefined,
      created_at: String(r.created_at), updated_at: String(r.updated_at),
    };
  }
  public getCampaign(id: string): SecurityCampaign | null {
    const r = this.db.prepare("SELECT * FROM security_campaigns WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapCampaign(r) : null;
  }
  public listCampaigns(): SecurityCampaign[] {
    return (this.db.prepare("SELECT * FROM security_campaigns ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map(r => this.mapCampaign(r));
  }
  public insertSnapshot(row: SecurityCampaignScopeSnapshot): void {
    this.db.prepare(`INSERT INTO security_campaign_scope_snapshots
      (id, campaign_id, authorization_id, scope_id, assets_json, exclusions_json, allowed_action_classes_json, prohibited_action_classes_json, frozen_at, frozen_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.campaign_id, row.authorization_id, row.scope_id, row.assets_json, row.exclusions_json,
        row.allowed_action_classes_json, row.prohibited_action_classes_json, row.frozen_at, row.frozen_by);
  }
  public getSnapshot(id: string): SecurityCampaignScopeSnapshot | null {
    const r = this.db.prepare("SELECT * FROM security_campaign_scope_snapshots WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id), campaign_id: String(r.campaign_id), authorization_id: String(r.authorization_id), scope_id: String(r.scope_id),
      assets_json: String(r.assets_json), exclusions_json: String(r.exclusions_json),
      allowed_action_classes_json: String(r.allowed_action_classes_json), prohibited_action_classes_json: String(r.prohibited_action_classes_json),
      frozen_at: String(r.frozen_at), frozen_by: String(r.frozen_by),
    };
  }

  // --- Agents / capabilities / tools / MCP ---
  public upsertAgent(row: SecurityAgentRecord): void {
    this.db.prepare(`INSERT INTO security_agents (id, "kind", display_name, max_risk_tier, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, max_risk_tier=excluded.max_risk_tier`)
      .run(row.id, row.kind, row.display_name, row.max_risk_tier, row.enabled ? 1 : 0, row.created_at);
  }
  public listAgents(): SecurityAgentRecord[] {
    return (this.db.prepare("SELECT * FROM security_agents").all() as Record<string, unknown>[]).map(r => ({
      id: String(r.id), kind: r.kind as SecurityAgentRecord["kind"], display_name: String(r.display_name),
      max_risk_tier: r.max_risk_tier as SecurityAgentRecord["max_risk_tier"], enabled: Boolean(r.enabled), created_at: String(r.created_at),
    }));
  }
  public getAgent(id: string): SecurityAgentRecord | null {
    return this.listAgents().find(a => a.id === id) ?? null;
  }
  public upsertCapability(row: SecurityCapability): void {
    this.db.prepare(`INSERT INTO security_capabilities
      (id, name, risk_tier, network_access, requires_scope, requires_approval, restricted, allowed_environments, capabilities, prohibited_capabilities, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, restricted=excluded.restricted, risk_tier=excluded.risk_tier`)
      .run(row.id, row.name, row.risk_tier, row.network_access ? 1 : 0, row.requires_scope ? 1 : 0, row.requires_approval ? 1 : 0,
        row.restricted ? 1 : 0, jsonText(row.allowed_environments), jsonText(row.capabilities), jsonText(row.prohibited_capabilities), row.enabled ? 1 : 0);
  }
  private mapCap(r: Record<string, unknown>): SecurityCapability {
    return {
      id: String(r.id), name: String(r.name), risk_tier: r.risk_tier as SecurityCapability["risk_tier"],
      network_access: Boolean(r.network_access), requires_scope: Boolean(r.requires_scope),
      requires_approval: Boolean(r.requires_approval), restricted: Boolean(r.restricted),
      allowed_environments: parseJson(r.allowed_environments, []), capabilities: parseJson(r.capabilities, []),
      prohibited_capabilities: parseJson(r.prohibited_capabilities, []), enabled: Boolean(r.enabled),
    };
  }
  public getCapability(id: string): SecurityCapability | null {
    const r = this.db.prepare("SELECT * FROM security_capabilities WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapCap(r) : null;
  }
  public listCapabilities(): SecurityCapability[] {
    return (this.db.prepare("SELECT * FROM security_capabilities").all() as Record<string, unknown>[]).map(r => this.mapCap(r));
  }
  public upsertTool(row: SecurityToolRegistration): void {
    this.db.prepare(`INSERT INTO security_tool_registrations
      (id, capability_id, name, "kind", allowlisted, timeout_ms, max_response_bytes, kill_switch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET allowlisted=excluded.allowlisted, kill_switch=excluded.kill_switch`)
      .run(row.id, row.capability_id, row.name, row.kind, row.allowlisted ? 1 : 0, row.timeout_ms, row.max_response_bytes, row.kill_switch ? 1 : 0);
  }
  public listTools(): SecurityToolRegistration[] {
    return (this.db.prepare("SELECT * FROM security_tool_registrations").all() as Record<string, unknown>[]).map(r => ({
      id: String(r.id), capability_id: String(r.capability_id), name: String(r.name),
      kind: r.kind as SecurityToolRegistration["kind"], allowlisted: Boolean(r.allowlisted),
      timeout_ms: Number(r.timeout_ms), max_response_bytes: Number(r.max_response_bytes), kill_switch: Boolean(r.kill_switch),
    }));
  }
  public upsertMcp(row: SecurityMcpServer): void {
    this.db.prepare(`INSERT INTO security_mcp_servers
      (id, name, transport, endpoint, capabilities, risk_tier, network_policy, requires_scope, requires_approval, credential_ref, health_state, kill_switch, last_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET health_state=excluded.health_state, kill_switch=excluded.kill_switch, last_verified_at=excluded.last_verified_at`)
      .run(row.id, row.name, row.transport, row.endpoint, jsonText(row.capabilities), row.risk_tier, row.network_policy,
        row.requires_scope ? 1 : 0, row.requires_approval ? 1 : 0, row.credential_ref ?? null, row.health_state, row.kill_switch ? 1 : 0, row.last_verified_at ?? null);
  }
  public listMcpServers(): SecurityMcpServer[] {
    return (this.db.prepare("SELECT * FROM security_mcp_servers").all() as Record<string, unknown>[]).map(r => ({
      id: String(r.id), name: String(r.name), transport: String(r.transport), endpoint: String(r.endpoint),
      capabilities: parseJson(r.capabilities, []), risk_tier: r.risk_tier as SecurityMcpServer["risk_tier"],
      network_policy: String(r.network_policy), requires_scope: Boolean(r.requires_scope),
      requires_approval: Boolean(r.requires_approval), credential_ref: r.credential_ref ? String(r.credential_ref) : undefined,
      health_state: r.health_state as SecurityMcpServer["health_state"], kill_switch: Boolean(r.kill_switch),
      last_verified_at: r.last_verified_at ? String(r.last_verified_at) : undefined,
    }));
  }
  public getMcp(id: string): SecurityMcpServer | null {
    return this.listMcpServers().find(s => s.id === id) ?? null;
  }

  // --- Tasks / executions ---
  public upsertTask(row: SecurityTask): void {
    this.db.prepare(`INSERT INTO security_tasks
      (id, campaign_id, agent_id, capability_id, asset_id, target, status, priority, approval_id, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, approval_id=excluded.approval_id, updated_at=excluded.updated_at`)
      .run(row.id, row.campaign_id, row.agent_id, row.capability_id, row.asset_id ?? null, row.target, row.status, row.priority,
        row.approval_id ?? null, row.reason, row.created_at, row.updated_at);
  }
  private mapTask(r: Record<string, unknown>): SecurityTask {
    return {
      id: String(r.id), campaign_id: String(r.campaign_id), agent_id: String(r.agent_id), capability_id: String(r.capability_id),
      asset_id: r.asset_id ? String(r.asset_id) : undefined, target: String(r.target), status: r.status as SecurityTask["status"],
      priority: Number(r.priority), approval_id: r.approval_id ? String(r.approval_id) : undefined, reason: String(r.reason),
      created_at: String(r.created_at), updated_at: String(r.updated_at),
    };
  }
  public getTask(id: string): SecurityTask | null {
    const r = this.db.prepare("SELECT * FROM security_tasks WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapTask(r) : null;
  }
  public listTasks(campaignId: string): SecurityTask[] {
    return (this.db.prepare("SELECT * FROM security_tasks WHERE campaign_id = ? ORDER BY priority DESC").all(campaignId) as Record<string, unknown>[]).map(r => this.mapTask(r));
  }
  public insertExecution(row: SecurityExecution): void {
    this.db.prepare(`INSERT INTO security_executions
      (id, campaign_id, task_id, agent_id, actor_id, capability_id, scope_token_id, target, risk_tier, approval_id, policy_decision_id, status, reason_code, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, reason_code=excluded.reason_code, finished_at=excluded.finished_at, policy_decision_id=excluded.policy_decision_id`)
      .run(row.id, row.campaign_id, row.task_id ?? null, row.agent_id, row.actor_id, row.capability_id, row.scope_token_id ?? null,
        row.target, row.risk_tier, row.approval_id ?? null, row.policy_decision_id ?? null, row.status, row.reason_code ?? null, row.started_at, row.finished_at ?? null);
  }
  private mapExec(r: Record<string, unknown>): SecurityExecution {
    return {
      id: String(r.id), campaign_id: String(r.campaign_id), task_id: r.task_id ? String(r.task_id) : undefined,
      agent_id: String(r.agent_id), actor_id: String(r.actor_id), capability_id: String(r.capability_id),
      scope_token_id: r.scope_token_id ? String(r.scope_token_id) : undefined, target: String(r.target),
      risk_tier: r.risk_tier as SecurityExecution["risk_tier"], approval_id: r.approval_id ? String(r.approval_id) : undefined,
      policy_decision_id: r.policy_decision_id ? String(r.policy_decision_id) : undefined,
      status: r.status as SecurityExecution["status"], reason_code: r.reason_code ? String(r.reason_code) : undefined,
      started_at: String(r.started_at), finished_at: r.finished_at ? String(r.finished_at) : undefined,
    };
  }
  public getExecution(id: string): SecurityExecution | null {
    const r = this.db.prepare("SELECT * FROM security_executions WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapExec(r) : null;
  }
  public listExecutions(campaignId?: string): SecurityExecution[] {
    const rows = campaignId
      ? this.db.prepare("SELECT * FROM security_executions WHERE campaign_id = ? ORDER BY started_at DESC").all(campaignId)
      : this.db.prepare("SELECT * FROM security_executions ORDER BY started_at DESC LIMIT 200").all();
    return (rows as Record<string, unknown>[]).map(r => this.mapExec(r));
  }

  // --- Approvals ---
  public upsertApproval(row: SecurityApproval): void {
    this.db.prepare(`INSERT INTO security_approvals
      (id, campaign_id, task_id, execution_id, capability_id, target, risk_tier, requested_by, requested_agent_id, request_volume,
       max_duration_seconds, expected_effect, policy_rule, parameters_json, status, decision, decided_by, decision_reason, expires_at, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, decision=excluded.decision, decided_by=excluded.decided_by,
        decision_reason=excluded.decision_reason, decided_at=excluded.decided_at`)
      .run(row.id, row.campaign_id, row.task_id ?? null, row.execution_id ?? null, row.capability_id, row.target, row.risk_tier,
        row.requested_by, row.requested_agent_id ?? null, row.request_volume, row.max_duration_seconds, row.expected_effect,
        row.policy_rule, row.parameters_json, row.status, row.decision ?? null, row.decided_by ?? null, row.decision_reason ?? null,
        row.expires_at, row.created_at, row.decided_at ?? null);
  }
  private mapApproval(r: Record<string, unknown>): SecurityApproval {
    return {
      id: String(r.id), campaign_id: String(r.campaign_id), task_id: r.task_id ? String(r.task_id) : undefined,
      execution_id: r.execution_id ? String(r.execution_id) : undefined, capability_id: String(r.capability_id),
      target: String(r.target), risk_tier: r.risk_tier as SecurityApproval["risk_tier"], requested_by: String(r.requested_by),
      requested_agent_id: r.requested_agent_id ? String(r.requested_agent_id) : undefined, request_volume: Number(r.request_volume),
      max_duration_seconds: Number(r.max_duration_seconds), expected_effect: String(r.expected_effect), policy_rule: String(r.policy_rule),
      parameters_json: String(r.parameters_json), status: r.status as SecurityApproval["status"],
      decision: r.decision ? (r.decision as SecurityApproval["decision"]) : undefined,
      decided_by: r.decided_by ? String(r.decided_by) : undefined, decision_reason: r.decision_reason ? String(r.decision_reason) : undefined,
      expires_at: String(r.expires_at), created_at: String(r.created_at), decided_at: r.decided_at ? String(r.decided_at) : undefined,
    };
  }
  public getApproval(id: string): SecurityApproval | null {
    const r = this.db.prepare("SELECT * FROM security_approvals WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapApproval(r) : null;
  }
  public listApprovals(status?: string): SecurityApproval[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM security_approvals WHERE status = ? ORDER BY created_at DESC").all(status)
      : this.db.prepare("SELECT * FROM security_approvals ORDER BY created_at DESC").all();
    return (rows as Record<string, unknown>[]).map(r => this.mapApproval(r));
  }

  // --- Leads / findings / validation / evidence ---
  public upsertLead(row: SecurityLead): void {
    this.db.prepare(`INSERT INTO security_leads
      (id, campaign_id, asset_id, "source", category, title, summary, priority, confidence, status, assigned_agent_id, evidence_count, memory_refs, score_components, created_at, updated_at, last_touched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, priority=excluded.priority, confidence=excluded.confidence,
        evidence_count=excluded.evidence_count, updated_at=excluded.updated_at, last_touched_at=excluded.last_touched_at`)
      .run(row.id, row.campaign_id, row.asset_id ?? null, row.source, row.category, row.title, row.summary, row.priority, row.confidence,
        row.status, row.assigned_agent_id ?? null, row.evidence_count, jsonText(row.memory_refs), jsonText(row.score_components),
        row.created_at, row.updated_at, row.last_touched_at);
  }
  private mapLead(r: Record<string, unknown>): SecurityLead {
    return {
      id: String(r.id), campaign_id: String(r.campaign_id), asset_id: r.asset_id ? String(r.asset_id) : undefined,
      source: String(r.source), category: String(r.category), title: String(r.title), summary: String(r.summary),
      priority: Number(r.priority), confidence: Number(r.confidence), status: r.status as SecurityLead["status"],
      assigned_agent_id: r.assigned_agent_id ? String(r.assigned_agent_id) : undefined, evidence_count: Number(r.evidence_count),
      memory_refs: parseJson(r.memory_refs, []), score_components: parseJson(r.score_components, {
        asset_criticality: 0, evidence_strength: 0, confidence: 0, novelty: 0, memory_signal: 0, policy_risk_penalty: 0, duplication_penalty: 0,
      }),
      created_at: String(r.created_at), updated_at: String(r.updated_at), last_touched_at: String(r.last_touched_at),
    };
  }
  public getLead(id: string): SecurityLead | null {
    const r = this.db.prepare("SELECT * FROM security_leads WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapLead(r) : null;
  }
  public listLeads(campaignId: string): SecurityLead[] {
    return (this.db.prepare("SELECT * FROM security_leads WHERE campaign_id = ? ORDER BY priority DESC").all(campaignId) as Record<string, unknown>[]).map(r => this.mapLead(r));
  }
  public upsertFinding(row: SecurityFinding): void {
    this.db.prepare(`INSERT INTO security_findings
      (id, campaign_id, asset_id, lead_id, title, category, severity, confidence, impact_summary, technical_summary, scope_snapshot_id, validation_result_id, status, created_by_agent_id, human_owner_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, validation_result_id=excluded.validation_result_id, updated_at=excluded.updated_at`)
      .run(row.id, row.campaign_id, row.asset_id ?? null, row.lead_id ?? null, row.title, row.category, row.severity, row.confidence,
        row.impact_summary, row.technical_summary, row.scope_snapshot_id ?? null, row.validation_result_id ?? null, row.status,
        row.created_by_agent_id, row.human_owner_id ?? null, row.created_at, row.updated_at);
  }
  private mapFinding(r: Record<string, unknown>): SecurityFinding {
    return {
      id: String(r.id), campaign_id: String(r.campaign_id), asset_id: r.asset_id ? String(r.asset_id) : undefined,
      lead_id: r.lead_id ? String(r.lead_id) : undefined, title: String(r.title), category: String(r.category),
      severity: r.severity as SecurityFinding["severity"], confidence: Number(r.confidence),
      impact_summary: String(r.impact_summary), technical_summary: String(r.technical_summary),
      scope_snapshot_id: r.scope_snapshot_id ? String(r.scope_snapshot_id) : undefined,
      validation_result_id: r.validation_result_id ? String(r.validation_result_id) : undefined,
      status: r.status as SecurityFinding["status"], created_by_agent_id: String(r.created_by_agent_id),
      human_owner_id: r.human_owner_id ? String(r.human_owner_id) : undefined,
      created_at: String(r.created_at), updated_at: String(r.updated_at),
    };
  }
  public getFinding(id: string): SecurityFinding | null {
    const r = this.db.prepare("SELECT * FROM security_findings WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapFinding(r) : null;
  }
  public listFindings(campaignId?: string): SecurityFinding[] {
    const rows = campaignId
      ? this.db.prepare("SELECT * FROM security_findings WHERE campaign_id = ? ORDER BY updated_at DESC").all(campaignId)
      : this.db.prepare("SELECT * FROM security_findings ORDER BY updated_at DESC").all();
    return (rows as Record<string, unknown>[]).map(r => this.mapFinding(r));
  }
  public insertValidation(row: SecurityValidationResult): void {
    this.db.prepare(`INSERT INTO security_validation_results (id, finding_id, campaign_id, disposition, answers, notes, validated_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.finding_id, row.campaign_id, row.disposition, jsonText(row.answers), row.notes, row.validated_by, row.created_at);
  }
  public getValidation(id: string): SecurityValidationResult | null {
    const r = this.db.prepare("SELECT * FROM security_validation_results WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id), finding_id: String(r.finding_id), campaign_id: String(r.campaign_id),
      disposition: r.disposition as SecurityValidationResult["disposition"], answers: parseJson(r.answers, {
        scope: false, reality: false, reproducibility: false, impact: false, evidence: false, novelty: false, policy: false,
      }), notes: String(r.notes), validated_by: String(r.validated_by), created_at: String(r.created_at),
    };
  }
  public insertEvidence(row: SecurityEvidence): void {
    this.db.prepare(`INSERT INTO security_evidence
      (id, campaign_id, asset_id, execution_id, "type", storage_uri, sha256, mime_type, captured_at, captured_by, redaction_state, sensitivity, retention_class, metadata_json, raw_preview, redacted_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.campaign_id, row.asset_id ?? null, row.execution_id ?? null, row.type, row.storage_uri, row.sha256, row.mime_type,
        row.captured_at, row.captured_by, row.redaction_state, row.sensitivity, row.retention_class, row.metadata_json,
        row.raw_preview ?? null, row.redacted_preview ?? null);
  }
  private mapEvidence(r: Record<string, unknown>): SecurityEvidence {
    return {
      id: String(r.id), campaign_id: String(r.campaign_id), asset_id: r.asset_id ? String(r.asset_id) : undefined,
      execution_id: r.execution_id ? String(r.execution_id) : undefined, type: r.type as SecurityEvidence["type"],
      storage_uri: String(r.storage_uri), sha256: String(r.sha256), mime_type: String(r.mime_type),
      captured_at: String(r.captured_at), captured_by: String(r.captured_by),
      redaction_state: r.redaction_state as SecurityEvidence["redaction_state"],
      sensitivity: r.sensitivity as SecurityEvidence["sensitivity"],
      retention_class: r.retention_class as SecurityEvidence["retention_class"],
      metadata_json: String(r.metadata_json), raw_preview: r.raw_preview ? String(r.raw_preview) : undefined,
      redacted_preview: r.redacted_preview ? String(r.redacted_preview) : undefined,
    };
  }
  public listEvidence(campaignId: string): SecurityEvidence[] {
    return (this.db.prepare("SELECT * FROM security_evidence WHERE campaign_id = ? ORDER BY captured_at DESC").all(campaignId) as Record<string, unknown>[]).map(r => this.mapEvidence(r));
  }
  public getEvidence(id: string): SecurityEvidence | null {
    const r = this.db.prepare("SELECT * FROM security_evidence WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapEvidence(r) : null;
  }

  // --- Memory ---
  public insertMemory(row: SecurityMemoryRef): void {
    this.db.prepare(`INSERT INTO security_memory_refs
      (id, campaign_id, tier, "kind", body, sanitized, sha256, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.campaign_id ?? null, row.tier, row.kind, row.body, row.sanitized ? 1 : 0, row.sha256, row.created_by, row.created_at, row.expires_at ?? null);
  }
  private mapMemory(r: Record<string, unknown>): SecurityMemoryRef {
    return {
      id: String(r.id), campaign_id: r.campaign_id ? String(r.campaign_id) : undefined, tier: r.tier as SecurityMemoryRef["tier"],
      kind: String(r.kind), body: String(r.body), sanitized: Boolean(r.sanitized), sha256: String(r.sha256),
      created_by: String(r.created_by), created_at: String(r.created_at), expires_at: r.expires_at ? String(r.expires_at) : undefined,
    };
  }
  public listMemory(opts: { campaignId?: string; tier?: string } = {}): SecurityMemoryRef[] {
    let sql = "SELECT * FROM security_memory_refs WHERE 1=1";
    const params: string[] = [];
    if (opts.campaignId) { sql += " AND campaign_id = ?"; params.push(opts.campaignId); }
    if (opts.tier) { sql += " AND tier = ?"; params.push(opts.tier); }
    sql += " ORDER BY created_at DESC";
    const rows = (params.length ? this.db.prepare(sql).all(...params) : this.db.prepare(sql).all()) as Record<string, unknown>[];
    return rows.map(r => this.mapMemory(r));
  }
  public deleteMemoryByPolicy(opts: { expireBefore?: string; tier?: string }): void {
    if (opts.expireBefore && opts.tier) {
      this.db.prepare("DELETE FROM security_memory_refs WHERE expires_at IS NOT NULL AND expires_at < ? AND tier = ?").run(opts.expireBefore, opts.tier);
    } else if (opts.expireBefore) {
      this.db.prepare("DELETE FROM security_memory_refs WHERE expires_at IS NOT NULL AND expires_at < ?").run(opts.expireBefore);
    } else if (opts.tier) {
      this.db.prepare("DELETE FROM security_memory_refs WHERE tier = ?").run(opts.tier);
    }
  }

  // --- Policy decisions / audit / rate / breakers / tokens / packages ---
  public insertPolicyDecision(row: SecurityPolicyDecision): void {
    this.db.prepare(`INSERT INTO security_policy_decisions
      (id, execution_id, campaign_id, capability_id, target, decision, reason_code, policy_version, risk_tier, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.execution_id ?? null, row.campaign_id ?? null, row.capability_id, row.target, row.decision, row.reason_code, row.policy_version, row.risk_tier, row.created_at);
  }
  public insertAudit(row: SecurityAuditEvent): void {
    this.db.prepare(`INSERT INTO security_audit_events
      (id, event_type, actor_id, actor_role, campaign_id, execution_id, task_id, approval_id, policy_decision_id, agent_id, target, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.event_type, row.actor_id, row.actor_role, row.campaign_id ?? null, row.execution_id ?? null, row.task_id ?? null,
        row.approval_id ?? null, row.policy_decision_id ?? null, row.agent_id ?? null, row.target ?? null, row.metadata ? jsonText(row.metadata) : null, row.created_at);
  }
  public listAudit(campaignId?: string, limit = 200): SecurityAuditEvent[] {
    const rows = campaignId
      ? this.db.prepare("SELECT * FROM security_audit_events WHERE campaign_id = ? ORDER BY created_at DESC LIMIT ?").all(campaignId, limit)
      : this.db.prepare("SELECT * FROM security_audit_events ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as Record<string, unknown>[]).map(r => ({
      id: String(r.id), event_type: String(r.event_type), actor_id: String(r.actor_id),
      actor_role: r.actor_role as SecurityAuditEvent["actor_role"], campaign_id: r.campaign_id ? String(r.campaign_id) : undefined,
      execution_id: r.execution_id ? String(r.execution_id) : undefined, task_id: r.task_id ? String(r.task_id) : undefined,
      approval_id: r.approval_id ? String(r.approval_id) : undefined, policy_decision_id: r.policy_decision_id ? String(r.policy_decision_id) : undefined,
      agent_id: r.agent_id ? String(r.agent_id) : undefined, target: r.target ? String(r.target) : undefined,
      metadata: r.metadata ? parseJson(r.metadata, undefined) : undefined, created_at: String(r.created_at),
    }));
  }
  public upsertRateLimit(row: SecurityRateLimit): void {
    this.db.prepare(`INSERT INTO security_rate_limits (id, campaign_id, capability_id, window_started_at, "count", max_count)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "count"=excluded."count", window_started_at=excluded.window_started_at`)
      .run(row.id, row.campaign_id, row.capability_id, row.window_started_at, row.count, row.limit);
  }
  public getRateLimit(id: string): SecurityRateLimit | null {
    const r = this.db.prepare("SELECT * FROM security_rate_limits WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return { id: String(r.id), campaign_id: String(r.campaign_id), capability_id: String(r.capability_id), window_started_at: String(r.window_started_at), count: Number(r.count), limit: Number(r.max_count) };
  }
  public upsertBreaker(row: SecurityCircuitBreaker): void {
    this.db.prepare(`INSERT INTO security_circuit_breakers (id, campaign_id, "kind", state, trip_count, last_tripped_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, trip_count=excluded.trip_count, last_tripped_at=excluded.last_tripped_at, updated_at=excluded.updated_at`)
      .run(row.id, row.campaign_id, row.kind, row.state, row.trip_count, row.last_tripped_at ?? null, row.updated_at);
  }
  public getBreaker(campaignId: string, kind: string): SecurityCircuitBreaker | null {
    const r = this.db.prepare("SELECT * FROM security_circuit_breakers WHERE campaign_id = ? AND kind = ?").get(campaignId, kind) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id), campaign_id: String(r.campaign_id), kind: r.kind as SecurityCircuitBreaker["kind"],
      state: r.state as SecurityCircuitBreaker["state"], trip_count: Number(r.trip_count),
      last_tripped_at: r.last_tripped_at ? String(r.last_tripped_at) : undefined, updated_at: String(r.updated_at),
    };
  }
  public listBreakers(campaignId?: string): SecurityCircuitBreaker[] {
    const rows = campaignId
      ? this.db.prepare("SELECT * FROM security_circuit_breakers WHERE campaign_id = ?").all(campaignId)
      : this.db.prepare("SELECT * FROM security_circuit_breakers").all();
    return (rows as Record<string, unknown>[]).map(r => ({
      id: String(r.id), campaign_id: String(r.campaign_id), kind: r.kind as SecurityCircuitBreaker["kind"],
      state: r.state as SecurityCircuitBreaker["state"], trip_count: Number(r.trip_count),
      last_tripped_at: r.last_tripped_at ? String(r.last_tripped_at) : undefined, updated_at: String(r.updated_at),
    }));
  }
  public insertScopeToken(row: Omit<ScopeToken, "token">): void {
    this.db.prepare(`INSERT INTO security_scope_tokens (id, token_hash, campaign_id, asset_id, capability_id, actor_id, expires_at, revoked, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.token_hash, row.campaign_id, row.asset_id ?? null, row.capability_id, row.actor_id, row.expires_at, row.revoked ? 1 : 0, row.created_at);
  }
  public getScopeTokenByHash(hash: string): Omit<ScopeToken, "token"> | null {
    const r = this.db.prepare("SELECT * FROM security_scope_tokens WHERE token_hash = ?").get(hash) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id), token_hash: String(r.token_hash), campaign_id: String(r.campaign_id),
      asset_id: r.asset_id ? String(r.asset_id) : undefined, capability_id: String(r.capability_id), actor_id: String(r.actor_id),
      expires_at: String(r.expires_at), revoked: Boolean(r.revoked), created_at: String(r.created_at),
    };
  }
  public revokeScopeTokensForCampaign(campaignId: string): void {
    this.db.prepare("UPDATE security_scope_tokens SET revoked = 1 WHERE campaign_id = ?").run(campaignId);
  }
  public insertPackage(row: SecurityImportedPackage): void {
    this.db.prepare(`INSERT INTO security_imported_packages
      (id, name, "source", source_commit, compatibility, restricted_items, warnings, inventory_json, created_at, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET compatibility=excluded.compatibility, activated_at=excluded.activated_at`)
      .run(row.id, row.name, row.source, row.commit ?? null, row.compatibility, jsonText(row.restricted_items), jsonText(row.warnings), row.inventory_json, row.created_at, row.activated_at ?? null);
  }
  public getPackage(id: string): SecurityImportedPackage | null {
    const r = this.db.prepare("SELECT * FROM security_imported_packages WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id), name: String(r.name), source: String(r.source), commit: r.source_commit ? String(r.source_commit) : undefined,
      compatibility: r.compatibility as SecurityImportedPackage["compatibility"],
      restricted_items: parseJson(r.restricted_items, []), warnings: parseJson(r.warnings, []),
      inventory_json: String(r.inventory_json), created_at: String(r.created_at), activated_at: r.activated_at ? String(r.activated_at) : undefined,
    };
  }
  public listPackages(): SecurityImportedPackage[] {
    return (this.db.prepare("SELECT * FROM security_imported_packages ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(r => ({
      id: String(r.id), name: String(r.name), source: String(r.source), commit: r.source_commit ? String(r.source_commit) : undefined,
      compatibility: r.compatibility as SecurityImportedPackage["compatibility"],
      restricted_items: parseJson(r.restricted_items, []), warnings: parseJson(r.warnings, []),
      inventory_json: String(r.inventory_json), created_at: String(r.created_at), activated_at: r.activated_at ? String(r.activated_at) : undefined,
    }));
  }

  public countWhere(table: string, column: string, value: string): number {
    const allowed = new Set([
      "security_campaigns", "security_approvals", "security_leads", "security_findings",
      "security_authorizations", "security_circuit_breakers", "security_executions", "security_audit_events",
    ]);
    if (!allowed.has(table)) return 0;
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as { n: number };
    return Number(row?.n ?? 0);
  }

  public close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
