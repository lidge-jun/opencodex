/**
 * Phase 20.59 — Pao-hubPro × Grok-Register
 * Multi-Provider Credential Lifecycle, OAuth Session Gateway,
 * Health-Checked Token Pool & Policy-Governed Provider Access Runtime.
 *
 * Credentials are security-sensitive runtime entities, not .env strings.
 * This module never implements account registration, CAPTCHA/Turnstile
 * bypass, anti-bot evasion, credential stuffing, or unauthorized acquisition.
 */

export type CredentialType =
  | "api_key"
  | "oauth_access_token"
  | "oauth_refresh_token"
  | "oauth_bundle"
  | "service_account"
  | "session_token"
  | "gateway_token"
  | "local_secret"
  | "none";

export type CredentialStatus =
  | "new"
  | "validating"
  | "valid"
  | "active"
  | "degraded"
  | "quarantined"
  | "expired"
  | "revoked"
  | "rotating"
  | "disabled";

export type HealthStatus =
  | "unknown"
  | "healthy"
  | "warning"
  | "degraded"
  | "unhealthy"
  | "rate_limited"
  | "quota_exhausted"
  | "auth_failed"
  | "provider_down";

export type CircuitState = "closed" | "open" | "half_open";

export type CredentialRole =
  | "owner"
  | "admin"
  | "operator"
  | "developer"
  | "viewer"
  | "agent";

export type PolicyDecisionKind = "allow" | "deny" | "approval_required";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "executed"
  | "cancelled";

export type LeaseStatus = "active" | "released" | "expired" | "denied";

export type OauthSessionStatus = "pending" | "completed" | "failed" | "expired";

export type SensitiveAction =
  | "credential.export"
  | "credential.revoke"
  | "credential.delete"
  | "credential.rotate"
  | "vault.reveal"
  | "policy.override"
  | "provider.disable"
  | "bulk.import";

export type AdapterType =
  | "openai"
  | "xai"
  | "anthropic"
  | "openrouter"
  | "deepseek"
  | "google"
  | "openai-compatible"
  | "local";

export interface EncryptedEnvelopeV1 {
  version: 1;
  algorithm: "aes-256-gcm";
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_id: string;
}

export interface ProviderRecord {
  id: string;
  slug: string;
  name: string;
  adapter_type: AdapterType;
  oauth_supported: boolean;
  quota_inspection_supported: boolean;
  revocation_supported: boolean;
  enabled: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CredentialRecord {
  id: string;
  provider_id: string;
  name: string;
  credential_type: CredentialType;
  owner_type: string;
  owner_id: string | null;
  environment: string;
  status: CredentialStatus;
  health_status: HealthStatus;
  health_score: number;
  secret_ref: string;
  scopes: string[];
  tags: string[];
  provider_account_id: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  last_validated_at: string | null;
  last_checked_at: string | null;
  next_check_at: string | null;
  failure_count: number;
  success_count: number;
  last_latency_ms: number | null;
  last_http_status: number | null;
  last_error_code: string | null;
  last_error_class: string | null;
  routing_eligible: boolean;
  remaining_budget: number | null;
  budget_limit: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CredentialPublicView {
  id: string;
  provider_id: string;
  provider_slug: string;
  name: string;
  credential_type: CredentialType;
  owner_type: string;
  owner_id: string | null;
  environment: string;
  status: CredentialStatus;
  health_status: HealthStatus;
  health_score: number;
  secret: string;
  secret_ref: string;
  scopes: string[];
  tags: string[];
  provider_account_id: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  last_validated_at: string | null;
  routing_eligible: boolean;
  remaining_budget: number | null;
  budget_limit: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CredentialHealthRow {
  id: string;
  credential_id: string;
  health_status: HealthStatus;
  health_score: number;
  success: boolean;
  latency_ms: number | null;
  http_status: number | null;
  error_code: string | null;
  error_class: string | null;
  provider_message: string | null;
  metadata: Record<string, unknown>;
  checked_at: string;
}

export interface OauthSession {
  id: string;
  provider_id: string;
  state_token_hash: string;
  redirect_uri: string;
  requested_scopes: string[];
  status: OauthSessionStatus;
  code_verifier_ref: string | null;
  credential_id: string | null;
  expires_at: string;
  completed_at: string | null;
  created_at: string;
}

export interface CredentialLease {
  id: string;
  credential_id: string;
  requester_type: string;
  requester_id: string;
  agent_id: string | null;
  provider_slug: string;
  model: string | null;
  purpose: string | null;
  status: LeaseStatus;
  created_at: string;
  expires_at: string;
  released_at: string | null;
  metadata: Record<string, unknown>;
}

export interface CredentialPolicy {
  id: string;
  name: string;
  policy_type: string;
  enabled: boolean;
  priority: number;
  policy: PolicyDocument;
  created_at: string;
  updated_at: string;
}

export interface PolicyDocument {
  match?: {
    provider?: string;
    environment?: string;
    credential_type?: CredentialType;
  };
  requirements?: {
    status?: CredentialStatus[];
    minimum_health_score?: number;
    allowed_agents?: string[];
    denied_agents?: string[];
    denied_models?: string[];
    allowed_models?: string[];
    required_scopes?: string[];
    human_approval?: { required_for?: SensitiveAction[] };
    minimum_budget?: number;
  };
}

export interface PolicyEvaluation {
  decision: PolicyDecisionKind;
  policy_id: string | null;
  reasons: string[];
}

export interface ApprovalRequest {
  id: string;
  action: SensitiveAction | string;
  target_type: string;
  target_id: string;
  requester_id: string;
  status: ApprovalStatus;
  request_payload: Record<string, unknown>;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface CredentialAuditEvent {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  decision: string | null;
  correlation_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CircuitBreakerRow {
  id: string;
  provider_id: string;
  credential_id: string | null;
  state: CircuitState;
  failure_count: number;
  opened_at: string | null;
  cooldown_until: string | null;
  updated_at: string;
}

export interface SecretRow {
  id: string;
  envelope_json: string;
  key_id: string;
  created_at: string;
  updated_at: string;
}

export interface IdempotencyRow {
  key: string;
  action: string;
  result_json: string;
  created_at: string;
}

export interface OperationRun {
  id: string;
  type: string;
  credential_id: string | null;
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

export interface ProviderCapabilities {
  provider: string;
  capabilities: {
    chat: boolean;
    vision: boolean;
    audio: boolean;
    embeddings: boolean;
    tool_calling: boolean;
    oauth: boolean;
    quota_inspection: boolean;
  };
}

export interface ResolvedCredential {
  record: CredentialRecord;
  provider: ProviderRecord;
  secret: string;
}

export interface ValidationResult {
  ok: boolean;
  status: CredentialStatus;
  health_status: HealthStatus;
  health_score: number;
  http_status: number | null;
  error_code: string | null;
  error_class: string | null;
  latency_ms: number | null;
  message: string;
}

export interface HealthResult extends ValidationResult {
  next_check_at: string;
}

export interface RefreshResult {
  ok: boolean;
  expires_at: string | null;
  message: string;
}

export interface RevokeResult {
  ok: boolean;
  message: string;
}

export interface QuotaResult {
  known: boolean;
  remaining: number | null;
  limit: number | null;
  exhausted: boolean;
  message: string;
}

export interface ProviderCredentialAdapter {
  provider: string;
  validate(credential: ResolvedCredential): Promise<ValidationResult>;
  healthCheck(credential: ResolvedCredential): Promise<HealthResult>;
  refresh?(credential: ResolvedCredential): Promise<RefreshResult>;
  revoke?(credential: ResolvedCredential): Promise<RevokeResult>;
  inspectQuota?(credential: ResolvedCredential): Promise<QuotaResult>;
  listCapabilities?(credential: ResolvedCredential): Promise<ProviderCapabilities>;
  exchangeOauth?(input: {
    code: string;
    redirect_uri: string;
    code_verifier?: string;
  }): Promise<{ access_token: string; refresh_token?: string; expires_at?: string }>;
}

export interface LeaseRequest {
  requester_type: string;
  requester_id: string;
  agent_id?: string;
  provider: string;
  model?: string;
  capability?: string;
  purpose?: string;
  required_scope?: string;
  estimated_cost?: number;
  estimated_tokens?: number;
  ttl_seconds?: number;
  actor_role?: CredentialRole;
  correlation_id?: string;
}

export interface LeaseGrant {
  lease_id: string;
  credential_id: string;
  provider: string;
  expires_at: string;
  health_score: number;
  routing_weight: number;
}

export interface CredentialCandidate {
  credential_id: string;
  provider: string;
  health_score: number;
  quota_factor: number;
  budget_factor: number;
  reliability_factor: number;
  policy_factor: number;
  routing_score: number;
  status: CredentialStatus;
  health_status: HealthStatus;
  lease_count: number;
}

export interface CredentialOverview {
  enabled: boolean;
  total: number;
  healthy: number;
  degraded: number;
  rate_limited: number;
  quota_exhausted: number;
  expiring_soon: number;
  quarantined: number;
  revoked: number;
  active_leases: number;
  circuit_open: number;
  vault_available: boolean;
}

export type CredentialEventName =
  | "credential.created"
  | "credential.validated"
  | "credential.activated"
  | "credential.degraded"
  | "credential.quarantined"
  | "credential.expiring"
  | "credential.expired"
  | "credential.rotated"
  | "credential.revoked"
  | "credential.health.changed"
  | "oauth.started"
  | "oauth.completed"
  | "oauth.refresh_failed"
  | "lease.created"
  | "lease.released"
  | "lease.expired"
  | "policy.allowed"
  | "policy.denied"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected";

