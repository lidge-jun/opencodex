import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { getConfigDir } from "../config/paths";
import { SEEDED_PROVIDERS } from "./constants";
import type {
  ApprovalRequest,
  CircuitBreakerRow,
  CredentialAuditEvent,
  CredentialHealthRow,
  CredentialLease,
  CredentialPolicy,
  CredentialRecord,
  EncryptedEnvelopeV1,
  IdempotencyRow,
  OauthSession,
  OperationRun,
  PolicyDocument,
  ProviderRecord,
  SecretRow,
} from "./types";

export function getDefaultCredentialDbPath(customDir?: string): string {
  const dir = customDir ?? getConfigDir();
  return join(dir, "credentials.sqlite");
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

function asBool(raw: unknown): boolean {
  return raw === 1 || raw === true || raw === "1";
}

export class CredentialDatabase {
  public readonly db: Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? getDefaultCredentialDbPath();
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(resolvedPath);
    try {
      (this.db as Database & { timeout?: number }).timeout = 2000;
    } catch { /* best effort */ }
    this.db.exec("PRAGMA busy_timeout = 2000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
    this.seedProviders();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credential_providers (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        adapter_type TEXT NOT NULL,
        oauth_supported INTEGER NOT NULL DEFAULT 0,
        quota_inspection_supported INTEGER NOT NULL DEFAULT 0,
        revocation_supported INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_secrets (
        id TEXT PRIMARY KEY,
        envelope_json TEXT NOT NULL,
        key_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_records (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        name TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        owner_id TEXT,
        environment TEXT NOT NULL,
        status TEXT NOT NULL,
        health_status TEXT NOT NULL,
        health_score INTEGER NOT NULL DEFAULT 0,
        secret_ref TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        provider_account_id TEXT,
        expires_at TEXT,
        last_used_at TEXT,
        last_validated_at TEXT,
        last_checked_at TEXT,
        next_check_at TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        last_latency_ms INTEGER,
        last_http_status INTEGER,
        last_error_code TEXT,
        last_error_class TEXT,
        routing_eligible INTEGER NOT NULL DEFAULT 0,
        remaining_budget REAL,
        budget_limit REAL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_health (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL,
        health_status TEXT NOT NULL,
        health_score INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        http_status INTEGER,
        error_code TEXT,
        error_class TEXT,
        provider_message TEXT,
        metadata_json TEXT NOT NULL,
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_oauth_sessions (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        state_token_hash TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        requested_scopes_json TEXT NOT NULL,
        status TEXT NOT NULL,
        code_verifier_ref TEXT,
        credential_id TEXT,
        expires_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_leases (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL,
        requester_type TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        agent_id TEXT,
        provider_slug TEXT NOT NULL,
        model TEXT,
        purpose TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT,
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_policies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        policy_type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 100,
        policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_approvals (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        status TEXT NOT NULL,
        request_payload_json TEXT NOT NULL,
        approved_by TEXT,
        approved_at TEXT,
        rejected_by TEXT,
        rejected_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_audit_events (
        id TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        decision TEXT,
        correlation_id TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_circuit_breakers (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        credential_id TEXT,
        state TEXT NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 0,
        opened_at TEXT,
        cooldown_until TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_runs (
        id TEXT PRIMARY KEY,
        run_type TEXT NOT NULL,
        credential_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        metadata_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cred_status ON credential_records(status, health_status);
      CREATE INDEX IF NOT EXISTS idx_cred_provider ON credential_records(provider_id, routing_eligible);
      CREATE INDEX IF NOT EXISTS idx_cred_health_cred ON credential_health(credential_id, checked_at);
      CREATE INDEX IF NOT EXISTS idx_cred_leases_status ON credential_leases(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_cred_oauth_state ON credential_oauth_sessions(state_token_hash);
      CREATE INDEX IF NOT EXISTS idx_cred_audit_created ON credential_audit_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_cred_approvals_status ON credential_approvals(status, expires_at);
    `);
  }

  private seedProviders(): void {
    const existing = this.listProviders();
    if (existing.length > 0) return;
    const ts = new Date().toISOString();
    for (const seed of SEEDED_PROVIDERS) {
      this.upsertProvider({
        id: `prv_${seed.slug}`,
        slug: seed.slug,
        name: seed.name,
        adapter_type: seed.adapter_type,
        oauth_supported: seed.oauth_supported,
        quota_inspection_supported: seed.quota_inspection_supported,
        revocation_supported: seed.revocation_supported,
        enabled: true,
        metadata: {},
        created_at: ts,
        updated_at: ts,
      });
    }
  }

  // --- Providers ---
  public upsertProvider(row: ProviderRecord): void {
    this.db.prepare(`INSERT INTO credential_providers
      (id, slug, name, adapter_type, oauth_supported, quota_inspection_supported, revocation_supported, enabled, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, adapter_type=excluded.adapter_type, oauth_supported=excluded.oauth_supported,
        quota_inspection_supported=excluded.quota_inspection_supported, revocation_supported=excluded.revocation_supported,
        enabled=excluded.enabled, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`)
      .run(row.id, row.slug, row.name, row.adapter_type, row.oauth_supported ? 1 : 0,
        row.quota_inspection_supported ? 1 : 0, row.revocation_supported ? 1 : 0,
        row.enabled ? 1 : 0, jsonText(row.metadata), row.created_at, row.updated_at);
  }
  private mapProvider(r: Record<string, unknown>): ProviderRecord {
    return {
      id: String(r.id), slug: String(r.slug), name: String(r.name),
      adapter_type: r.adapter_type as ProviderRecord["adapter_type"],
      oauth_supported: asBool(r.oauth_supported),
      quota_inspection_supported: asBool(r.quota_inspection_supported),
      revocation_supported: asBool(r.revocation_supported),
      enabled: asBool(r.enabled),
      metadata: parseJson(r.metadata_json, {}),
      created_at: String(r.created_at), updated_at: String(r.updated_at),
    };
  }
  public getProvider(id: string): ProviderRecord | null {
    const r = this.db.prepare("SELECT * FROM credential_providers WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapProvider(r) : null;
  }
  public getProviderBySlug(slug: string): ProviderRecord | null {
    const r = this.db.prepare("SELECT * FROM credential_providers WHERE slug = ?").get(slug) as Record<string, unknown> | null;
    return r ? this.mapProvider(r) : null;
  }
  public listProviders(): ProviderRecord[] {
    return (this.db.prepare("SELECT * FROM credential_providers ORDER BY name").all() as Record<string, unknown>[]).map(r => this.mapProvider(r));
  }

  // --- Secrets ---
  public upsertSecret(row: SecretRow): void {
    this.db.prepare(`INSERT INTO credential_secrets (id, envelope_json, key_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET envelope_json=excluded.envelope_json, key_id=excluded.key_id, updated_at=excluded.updated_at`)
      .run(row.id, row.envelope_json, row.key_id, row.created_at, row.updated_at);
  }
  public getSecret(id: string): SecretRow | null {
    const r = this.db.prepare("SELECT * FROM credential_secrets WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return { id: String(r.id), envelope_json: String(r.envelope_json), key_id: String(r.key_id), created_at: String(r.created_at), updated_at: String(r.updated_at) };
  }
  public deleteSecret(id: string): void {
    this.db.prepare("DELETE FROM credential_secrets WHERE id = ?").run(id);
  }
  public parseEnvelope(row: SecretRow): EncryptedEnvelopeV1 {
    return parseJson<EncryptedEnvelopeV1>(row.envelope_json, {
      version: 1, algorithm: "aes-256-gcm", ciphertext: "", iv: "", auth_tag: "", key_id: row.key_id,
    });
  }

  // --- Credentials ---
  public upsertCredential(row: CredentialRecord): void {
    this.db.prepare(`INSERT INTO credential_records
      (id, provider_id, name, credential_type, owner_type, owner_id, environment, status, health_status, health_score,
       secret_ref, scopes_json, tags_json, provider_account_id, expires_at, last_used_at, last_validated_at, last_checked_at,
       next_check_at, failure_count, success_count, last_latency_ms, last_http_status, last_error_code, last_error_class,
       routing_eligible, remaining_budget, budget_limit, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, status=excluded.status, health_status=excluded.health_status, health_score=excluded.health_score,
        secret_ref=excluded.secret_ref, scopes_json=excluded.scopes_json, tags_json=excluded.tags_json,
        provider_account_id=excluded.provider_account_id, expires_at=excluded.expires_at, last_used_at=excluded.last_used_at,
        last_validated_at=excluded.last_validated_at, last_checked_at=excluded.last_checked_at, next_check_at=excluded.next_check_at,
        failure_count=excluded.failure_count, success_count=excluded.success_count, last_latency_ms=excluded.last_latency_ms,
        last_http_status=excluded.last_http_status, last_error_code=excluded.last_error_code, last_error_class=excluded.last_error_class,
        routing_eligible=excluded.routing_eligible, remaining_budget=excluded.remaining_budget, budget_limit=excluded.budget_limit,
        metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`)
      .run(row.id, row.provider_id, row.name, row.credential_type, row.owner_type, row.owner_id, row.environment,
        row.status, row.health_status, row.health_score, row.secret_ref, jsonText(row.scopes), jsonText(row.tags),
        row.provider_account_id, row.expires_at, row.last_used_at, row.last_validated_at, row.last_checked_at,
        row.next_check_at, row.failure_count, row.success_count, row.last_latency_ms, row.last_http_status,
        row.last_error_code, row.last_error_class, row.routing_eligible ? 1 : 0, row.remaining_budget, row.budget_limit,
        jsonText(row.metadata), row.created_at, row.updated_at);
  }
  private mapCredential(r: Record<string, unknown>): CredentialRecord {
    return {
      id: String(r.id),
      provider_id: String(r.provider_id),
      name: String(r.name),
      credential_type: r.credential_type as CredentialRecord["credential_type"],
      owner_type: String(r.owner_type),
      owner_id: r.owner_id == null ? null : String(r.owner_id),
      environment: String(r.environment),
      status: r.status as CredentialRecord["status"],
      health_status: r.health_status as CredentialRecord["health_status"],
      health_score: Number(r.health_score ?? 0),
      secret_ref: String(r.secret_ref),
      scopes: parseJson(r.scopes_json, []),
      tags: parseJson(r.tags_json, []),
      provider_account_id: r.provider_account_id == null ? null : String(r.provider_account_id),
      expires_at: r.expires_at == null ? null : String(r.expires_at),
      last_used_at: r.last_used_at == null ? null : String(r.last_used_at),
      last_validated_at: r.last_validated_at == null ? null : String(r.last_validated_at),
      last_checked_at: r.last_checked_at == null ? null : String(r.last_checked_at),
      next_check_at: r.next_check_at == null ? null : String(r.next_check_at),
      failure_count: Number(r.failure_count ?? 0),
      success_count: Number(r.success_count ?? 0),
      last_latency_ms: r.last_latency_ms == null ? null : Number(r.last_latency_ms),
      last_http_status: r.last_http_status == null ? null : Number(r.last_http_status),
      last_error_code: r.last_error_code == null ? null : String(r.last_error_code),
      last_error_class: r.last_error_class == null ? null : String(r.last_error_class),
      routing_eligible: asBool(r.routing_eligible),
      remaining_budget: r.remaining_budget == null ? null : Number(r.remaining_budget),
      budget_limit: r.budget_limit == null ? null : Number(r.budget_limit),
      metadata: parseJson(r.metadata_json, {}),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }
  public getCredential(id: string): CredentialRecord | null {
    const r = this.db.prepare("SELECT * FROM credential_records WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapCredential(r) : null;
  }
  public listCredentials(filter?: { provider_id?: string; status?: string; environment?: string }): CredentialRecord[] {
    let sql = "SELECT * FROM credential_records WHERE 1=1";
    const args: string[] = [];
    if (filter?.provider_id) { sql += " AND provider_id = ?"; args.push(filter.provider_id); }
    if (filter?.status) { sql += " AND status = ?"; args.push(filter.status); }
    if (filter?.environment) { sql += " AND environment = ?"; args.push(filter.environment); }
    sql += " ORDER BY updated_at DESC";
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map(r => this.mapCredential(r));
  }
  public deleteCredential(id: string): void {
    this.db.prepare("DELETE FROM credential_records WHERE id = ?").run(id);
  }

  // --- Health ---
  public insertHealth(row: CredentialHealthRow): void {
    this.db.prepare(`INSERT INTO credential_health
      (id, credential_id, health_status, health_score, success, latency_ms, http_status, error_code, error_class, provider_message, metadata_json, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.credential_id, row.health_status, row.health_score, row.success ? 1 : 0,
        row.latency_ms, row.http_status, row.error_code, row.error_class, row.provider_message,
        jsonText(row.metadata), row.checked_at);
  }
  public listHealth(credentialId: string, maxRows = 50): CredentialHealthRow[] {
    return (this.db.prepare("SELECT * FROM credential_health WHERE credential_id = ? ORDER BY checked_at DESC LIMIT ?")
      .all(credentialId, maxRows) as Record<string, unknown>[]).map(r => ({
      id: String(r.id), credential_id: String(r.credential_id),
      health_status: r.health_status as CredentialHealthRow["health_status"],
      health_score: Number(r.health_score ?? 0), success: asBool(r.success),
      latency_ms: r.latency_ms == null ? null : Number(r.latency_ms),
      http_status: r.http_status == null ? null : Number(r.http_status),
      error_code: r.error_code == null ? null : String(r.error_code),
      error_class: r.error_class == null ? null : String(r.error_class),
      provider_message: r.provider_message == null ? null : String(r.provider_message),
      metadata: parseJson(r.metadata_json, {}), checked_at: String(r.checked_at),
    }));
  }

  // --- OAuth ---
  public upsertOauth(row: OauthSession): void {
    this.db.prepare(`INSERT INTO credential_oauth_sessions
      (id, provider_id, state_token_hash, redirect_uri, requested_scopes_json, status, code_verifier_ref, credential_id, expires_at, completed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, credential_id=excluded.credential_id, completed_at=excluded.completed_at`)
      .run(row.id, row.provider_id, row.state_token_hash, row.redirect_uri, jsonText(row.requested_scopes),
        row.status, row.code_verifier_ref, row.credential_id, row.expires_at, row.completed_at, row.created_at);
  }
  private mapOauth(r: Record<string, unknown>): OauthSession {
    return {
      id: String(r.id), provider_id: String(r.provider_id), state_token_hash: String(r.state_token_hash),
      redirect_uri: String(r.redirect_uri), requested_scopes: parseJson(r.requested_scopes_json, []),
      status: r.status as OauthSession["status"],
      code_verifier_ref: r.code_verifier_ref == null ? null : String(r.code_verifier_ref),
      credential_id: r.credential_id == null ? null : String(r.credential_id),
      expires_at: String(r.expires_at), completed_at: r.completed_at == null ? null : String(r.completed_at),
      created_at: String(r.created_at),
    };
  }
  public getOauth(id: string): OauthSession | null {
    const r = this.db.prepare("SELECT * FROM credential_oauth_sessions WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapOauth(r) : null;
  }
  public getOauthByStateHash(hash: string): OauthSession | null {
    const r = this.db.prepare("SELECT * FROM credential_oauth_sessions WHERE state_token_hash = ?").get(hash) as Record<string, unknown> | null;
    return r ? this.mapOauth(r) : null;
  }
  public listOauth(): OauthSession[] {
    return (this.db.prepare("SELECT * FROM credential_oauth_sessions ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(r => this.mapOauth(r));
  }

  // --- Leases ---
  public upsertLease(row: CredentialLease): void {
    this.db.prepare(`INSERT INTO credential_leases
      (id, credential_id, requester_type, requester_id, agent_id, provider_slug, model, purpose, status, created_at, expires_at, released_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, released_at=excluded.released_at, metadata_json=excluded.metadata_json`)
      .run(row.id, row.credential_id, row.requester_type, row.requester_id, row.agent_id, row.provider_slug,
        row.model, row.purpose, row.status, row.created_at, row.expires_at, row.released_at, jsonText(row.metadata));
  }
  private mapLease(r: Record<string, unknown>): CredentialLease {
    return {
      id: String(r.id), credential_id: String(r.credential_id), requester_type: String(r.requester_type),
      requester_id: String(r.requester_id), agent_id: r.agent_id == null ? null : String(r.agent_id),
      provider_slug: String(r.provider_slug), model: r.model == null ? null : String(r.model),
      purpose: r.purpose == null ? null : String(r.purpose), status: r.status as CredentialLease["status"],
      created_at: String(r.created_at), expires_at: String(r.expires_at),
      released_at: r.released_at == null ? null : String(r.released_at),
      metadata: parseJson(r.metadata_json, {}),
    };
  }
  public getLease(id: string): CredentialLease | null {
    const r = this.db.prepare("SELECT * FROM credential_leases WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapLease(r) : null;
  }
  public listLeases(status?: string): CredentialLease[] {
    if (status) {
      return (this.db.prepare("SELECT * FROM credential_leases WHERE status = ? ORDER BY created_at DESC").all(status) as Record<string, unknown>[]).map(r => this.mapLease(r));
    }
    return (this.db.prepare("SELECT * FROM credential_leases ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(r => this.mapLease(r));
  }
  public countActiveLeases(credentialId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM credential_leases WHERE credential_id = ? AND status = 'active'").get(credentialId) as { n: number };
    return Number(row?.n ?? 0);
  }

  // --- Policies ---
  public upsertPolicy(row: CredentialPolicy): void {
    this.db.prepare(`INSERT INTO credential_policies
      (id, name, policy_type, enabled, priority, policy_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, priority=excluded.priority,
        policy_json=excluded.policy_json, updated_at=excluded.updated_at`)
      .run(row.id, row.name, row.policy_type, row.enabled ? 1 : 0, row.priority, jsonText(row.policy), row.created_at, row.updated_at);
  }
  private mapPolicy(r: Record<string, unknown>): CredentialPolicy {
    return {
      id: String(r.id), name: String(r.name), policy_type: String(r.policy_type),
      enabled: asBool(r.enabled), priority: Number(r.priority ?? 100),
      policy: parseJson<PolicyDocument>(r.policy_json, {}),
      created_at: String(r.created_at), updated_at: String(r.updated_at),
    };
  }
  public getPolicy(id: string): CredentialPolicy | null {
    const r = this.db.prepare("SELECT * FROM credential_policies WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapPolicy(r) : null;
  }
  public listPolicies(): CredentialPolicy[] {
    return (this.db.prepare("SELECT * FROM credential_policies ORDER BY priority ASC, name").all() as Record<string, unknown>[]).map(r => this.mapPolicy(r));
  }

  // --- Approvals ---
  public upsertApproval(row: ApprovalRequest): void {
    this.db.prepare(`INSERT INTO credential_approvals
      (id, action, target_type, target_id, requester_id, status, request_payload_json, approved_by, approved_at, rejected_by, rejected_at, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, approved_by=excluded.approved_by, approved_at=excluded.approved_at,
        rejected_by=excluded.rejected_by, rejected_at=excluded.rejected_at`)
      .run(row.id, row.action, row.target_type, row.target_id, row.requester_id, row.status,
        jsonText(row.request_payload), row.approved_by, row.approved_at, row.rejected_by, row.rejected_at,
        row.expires_at, row.created_at);
  }
  private mapApproval(r: Record<string, unknown>): ApprovalRequest {
    return {
      id: String(r.id), action: String(r.action), target_type: String(r.target_type), target_id: String(r.target_id),
      requester_id: String(r.requester_id), status: r.status as ApprovalRequest["status"],
      request_payload: parseJson(r.request_payload_json, {}),
      approved_by: r.approved_by == null ? null : String(r.approved_by),
      approved_at: r.approved_at == null ? null : String(r.approved_at),
      rejected_by: r.rejected_by == null ? null : String(r.rejected_by),
      rejected_at: r.rejected_at == null ? null : String(r.rejected_at),
      expires_at: r.expires_at == null ? null : String(r.expires_at),
      created_at: String(r.created_at),
    };
  }
  public getApproval(id: string): ApprovalRequest | null {
    const r = this.db.prepare("SELECT * FROM credential_approvals WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapApproval(r) : null;
  }
  public listApprovals(status?: string): ApprovalRequest[] {
    if (status) {
      return (this.db.prepare("SELECT * FROM credential_approvals WHERE status = ? ORDER BY created_at DESC").all(status) as Record<string, unknown>[]).map(r => this.mapApproval(r));
    }
    return (this.db.prepare("SELECT * FROM credential_approvals ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(r => this.mapApproval(r));
  }

  // --- Audit ---
  public insertAudit(row: CredentialAuditEvent): void {
    this.db.prepare(`INSERT INTO credential_audit_events
      (id, actor_type, actor_id, action, target_type, target_id, decision, correlation_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.actor_type, row.actor_id, row.action, row.target_type, row.target_id,
        row.decision, row.correlation_id, jsonText(row.metadata), row.created_at);
  }
  public listAudit(maxRows = 200): CredentialAuditEvent[] {
    return (this.db.prepare("SELECT * FROM credential_audit_events ORDER BY created_at DESC LIMIT ?").all(maxRows) as Record<string, unknown>[]).map(r => ({
      id: String(r.id), actor_type: String(r.actor_type),
      actor_id: r.actor_id == null ? null : String(r.actor_id),
      action: String(r.action),
      target_type: r.target_type == null ? null : String(r.target_type),
      target_id: r.target_id == null ? null : String(r.target_id),
      decision: r.decision == null ? null : String(r.decision),
      correlation_id: r.correlation_id == null ? null : String(r.correlation_id),
      metadata: parseJson(r.metadata_json, {}),
      created_at: String(r.created_at),
    }));
  }

  // --- Circuit ---
  public upsertBreaker(row: CircuitBreakerRow): void {
    this.db.prepare(`INSERT INTO credential_circuit_breakers
      (id, provider_id, credential_id, state, failure_count, opened_at, cooldown_until, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, failure_count=excluded.failure_count,
        opened_at=excluded.opened_at, cooldown_until=excluded.cooldown_until, updated_at=excluded.updated_at`)
      .run(row.id, row.provider_id, row.credential_id, row.state, row.failure_count, row.opened_at, row.cooldown_until, row.updated_at);
  }
  private mapBreaker(r: Record<string, unknown>): CircuitBreakerRow {
    return {
      id: String(r.id), provider_id: String(r.provider_id),
      credential_id: r.credential_id == null ? null : String(r.credential_id),
      state: r.state as CircuitBreakerRow["state"],
      failure_count: Number(r.failure_count ?? 0),
      opened_at: r.opened_at == null ? null : String(r.opened_at),
      cooldown_until: r.cooldown_until == null ? null : String(r.cooldown_until),
      updated_at: String(r.updated_at),
    };
  }
  public getBreaker(id: string): CircuitBreakerRow | null {
    const r = this.db.prepare("SELECT * FROM credential_circuit_breakers WHERE id = ?").get(id) as Record<string, unknown> | null;
    return r ? this.mapBreaker(r) : null;
  }
  public listBreakers(): CircuitBreakerRow[] {
    return (this.db.prepare("SELECT * FROM credential_circuit_breakers ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map(r => this.mapBreaker(r));
  }

  // --- Idempotency ---
  public getIdempotency(key: string): IdempotencyRow | null {
    const r = this.db.prepare("SELECT * FROM credential_idempotency WHERE idempotency_key = ?").get(key) as Record<string, unknown> | null;
    if (!r) return null;
    return { key: String(r.idempotency_key), action: String(r.action), result_json: String(r.result_json), created_at: String(r.created_at) };
  }
  public putIdempotency(row: IdempotencyRow): void {
    this.db.prepare(`INSERT INTO credential_idempotency (idempotency_key, action, result_json, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(row.key, row.action, row.result_json, row.created_at);
  }

  // --- Runs ---
  public upsertRun(row: OperationRun): void {
    this.db.prepare(`INSERT INTO credential_runs
      (id, run_type, credential_id, status, started_at, completed_at, error, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, completed_at=excluded.completed_at, error=excluded.error, metadata_json=excluded.metadata_json`)
      .run(row.id, row.type, row.credential_id, row.status, row.started_at, row.completed_at, row.error, jsonText(row.metadata));
  }
  public listRuns(maxRows = 50): OperationRun[] {
    return (this.db.prepare("SELECT * FROM credential_runs ORDER BY started_at DESC LIMIT ?").all(maxRows) as Record<string, unknown>[]).map(r => ({
      id: String(r.id), type: String(r.run_type),
      credential_id: r.credential_id == null ? null : String(r.credential_id),
      status: r.status as OperationRun["status"],
      started_at: String(r.started_at),
      completed_at: r.completed_at == null ? null : String(r.completed_at),
      error: r.error == null ? null : String(r.error),
      metadata: parseJson(r.metadata_json, {}),
    }));
  }

  public close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

