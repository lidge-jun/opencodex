/**
 * Phase 20.58 — Pao-hubPro × Agentic Bug Hunter
 * Authorized Security Agent Control Plane — domain types.
 *
 * Target-facing work is deny-by-default. These types exist so every decision
 * can name a campaign, an authorization, a scope token, a risk tier, and an
 * audit event. They are not a permission to run unrestricted offensive tools.
 */

export type AuthorizationType =
  | "internal_owner"
  | "client_contract"
  | "bug_bounty_program"
  | "lab"
  | "ctf"
  | "training_environment";

export type AuthorizationStatus =
  | "DRAFT"
  | "PENDING_VERIFICATION"
  | "ACTIVE"
  | "SUSPENDED"
  | "EXPIRED"
  | "REVOKED";

export type ScopeStatus =
  | "DRAFT"
  | "PENDING_VERIFICATION"
  | "ACTIVE"
  | "SUSPENDED"
  | "EXPIRED"
  | "REVOKED";

export type AssetClass =
  | "domain"
  | "subdomain_pattern"
  | "url_prefix"
  | "ip"
  | "cidr"
  | "repository"
  | "mobile_app"
  | "api"
  | "smart_contract"
  | "local_lab"
  | "ctf_target";

export type ScopeMatch = "IN_SCOPE" | "EXCLUDED" | "UNKNOWN" | "EXPIRED";

export type RiskTier = "R0" | "R1" | "R2" | "R3";

export type PolicyDecisionKind = "ALLOW" | "DENY" | "APPROVAL_REQUIRED" | "CONSTRAIN";

export type CampaignStatus =
  | "DRAFT"
  | "SCOPE_CHECK"
  | "READY"
  | "RECON_RUNNING"
  | "TRIAGE"
  | "VALIDATION"
  | "HUMAN_REVIEW"
  | "REPORT_READY"
  | "CLOSED"
  | "PAUSED"
  | "BLOCKED_POLICY"
  | "BLOCKED_SCOPE"
  | "WAITING_APPROVAL"
  | "CANCELLED"
  | "FAILED";

export type TaskStatus =
  | "PENDING"
  | "SCHEDULED"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "SUCCEEDED"
  | "DENIED"
  | "FAILED"
  | "CANCELLED";

export type LeadStatus =
  | "NEW"
  | "QUEUED"
  | "INVESTIGATING"
  | "NEEDS_APPROVAL"
  | "VALIDATING"
  | "DISMISSED"
  | "PROMOTED_TO_FINDING"
  | "DUPLICATE"
  | "STALE";

export type FindingStatus =
  | "DRAFT"
  | "EVIDENCE_PENDING"
  | "VALIDATION_PENDING"
  | "VALIDATED"
  | "REJECTED"
  | "DUPLICATE"
  | "HUMAN_REVIEW"
  | "REPORT_READY"
  | "SUBMITTED_EXTERNALLY"
  | "CLOSED";

export type ValidationDisposition =
  | "PASS"
  | "FAIL_WEAK_EVIDENCE"
  | "FAIL_OUT_OF_SCOPE"
  | "FAIL_NOT_REPRODUCIBLE"
  | "FAIL_NO_IMPACT"
  | "FAIL_DUPLICATE"
  | "FAIL_POLICY"
  | "NEEDS_HUMAN_REVIEW";

export type EvidenceType =
  | "http_metadata"
  | "screenshot"
  | "response_excerpt"
  | "log"
  | "tool_output"
  | "source_code_reference"
  | "configuration_snapshot"
  | "program_policy_snapshot"
  | "human_note"
  | "external_reference"
  | "recon_fixture";

export type ApprovalDecisionKind =
  | "APPROVE_ONCE"
  | "APPROVE_FOR_TASK"
  | "DENY"
  | "CANCEL_CAMPAIGN";

export type ApprovalRecordStatus = "PENDING" | "GRANTED" | "DENIED" | "EXPIRED" | "CANCELLED";

export type CircuitBreakerKind = "scope" | "rate" | "error" | "policy" | "authorization";

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export type MemoryTier = "session" | "campaign" | "reusable" | "audit";

export type SecurityRole =
  | "security_viewer"
  | "security_operator"
  | "security_reviewer"
  | "security_admin";

export type PackageCompatibility =
  | "DISCOVERED"
  | "PARSED"
  | "REVIEW_REQUIRED"
  | "APPROVED"
  | "ACTIVE"
  | "QUARANTINED"
  | "REJECTED";

export type AgentKind =
  | "security-coordinator"
  | "scope-guardian"
  | "recon-agent"
  | "recon-ranker"
  | "finding-validator"
  | "report-writer"
  | "memory-curator"
  | "policy-sentinel";

export interface SecurityOrganization {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface SecurityAuthorization {
  id: string;
  organization_id: string;
  type: AuthorizationType;
  source_reference: string;
  evidence_uri?: string;
  valid_from: string;
  valid_until: string;
  status: AuthorizationStatus;
  allowed_action_classes: string[];
  prohibited_action_classes: string[];
  notes?: string;
  created_by: string;
  verified_by?: string;
  verified_at?: string;
  approval_owner?: string;
  created_at: string;
  updated_at: string;
}

export interface SecurityScope {
  id: string;
  authorization_id: string;
  name: string;
  status: ScopeStatus;
  rate_limit_per_minute: number;
  notes?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SecurityScopeAsset {
  id: string;
  scope_id: string;
  asset_class: AssetClass;
  value: string;
  normalized_asset: string;
  criticality: number;
  created_at: string;
}

export interface SecurityScopeExclusion {
  id: string;
  scope_id: string;
  asset_class: AssetClass;
  value: string;
  normalized_asset: string;
  reason?: string;
  created_at: string;
}

export interface SecurityCampaign {
  id: string;
  organization_id: string;
  authorization_id: string;
  scope_id: string;
  snapshot_id?: string;
  name: string;
  status: CampaignStatus;
  policy_profile_id: string;
  owner_id: string;
  blocked_reason?: string;
  started_at?: string;
  closed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface SecurityCampaignScopeSnapshot {
  id: string;
  campaign_id: string;
  authorization_id: string;
  scope_id: string;
  assets_json: string;
  exclusions_json: string;
  allowed_action_classes_json: string;
  prohibited_action_classes_json: string;
  frozen_at: string;
  frozen_by: string;
}

export interface SecurityAgentRecord {
  id: string;
  kind: AgentKind;
  display_name: string;
  max_risk_tier: RiskTier;
  enabled: boolean;
  created_at: string;
}

export interface SecurityCapability {
  id: string;
  name: string;
  risk_tier: RiskTier;
  network_access: boolean;
  requires_scope: boolean;
  requires_approval: boolean;
  restricted: boolean;
  allowed_environments: string[];
  capabilities: string[];
  prohibited_capabilities: string[];
  enabled: boolean;
}

export interface SecurityToolRegistration {
  id: string;
  capability_id: string;
  name: string;
  kind: "local_fixture" | "mcp" | "external_api";
  allowlisted: boolean;
  timeout_ms: number;
  max_response_bytes: number;
  kill_switch: boolean;
}

export interface SecurityMcpServer {
  id: string;
  name: string;
  transport: string;
  endpoint: string;
  capabilities: string[];
  risk_tier: RiskTier;
  network_policy: string;
  requires_scope: boolean;
  requires_approval: boolean;
  credential_ref?: string;
  health_state: "UNKNOWN" | "HEALTHY" | "UNHEALTHY" | "DISABLED";
  kill_switch: boolean;
  last_verified_at?: string;
}

export interface SecurityTask {
  id: string;
  campaign_id: string;
  agent_id: string;
  capability_id: string;
  asset_id?: string;
  target: string;
  status: TaskStatus;
  priority: number;
  approval_id?: string;
  reason: string;
  created_at: string;
  updated_at: string;
}

export interface SecurityExecution {
  id: string;
  campaign_id: string;
  task_id?: string;
  agent_id: string;
  actor_id: string;
  capability_id: string;
  scope_token_id?: string;
  target: string;
  risk_tier: RiskTier;
  approval_id?: string;
  policy_decision_id?: string;
  status: "STARTED" | "FINISHED" | "DENIED" | "TERMINATED" | "FAILED";
  reason_code?: string;
  started_at: string;
  finished_at?: string;
}

export interface SecurityApproval {
  id: string;
  campaign_id: string;
  task_id?: string;
  execution_id?: string;
  capability_id: string;
  target: string;
  risk_tier: RiskTier;
  requested_by: string;
  requested_agent_id?: string;
  request_volume: number;
  max_duration_seconds: number;
  expected_effect: string;
  policy_rule: string;
  parameters_json: string;
  status: ApprovalRecordStatus;
  decision?: ApprovalDecisionKind;
  decided_by?: string;
  decision_reason?: string;
  expires_at: string;
  created_at: string;
  decided_at?: string;
}

export interface LeadScoreComponents {
  asset_criticality: number;
  evidence_strength: number;
  confidence: number;
  novelty: number;
  memory_signal: number;
  policy_risk_penalty: number;
  duplication_penalty: number;
}

export interface SecurityLead {
  id: string;
  campaign_id: string;
  asset_id?: string;
  source: string;
  category: string;
  title: string;
  summary: string;
  priority: number;
  confidence: number;
  status: LeadStatus;
  assigned_agent_id?: string;
  evidence_count: number;
  memory_refs: string[];
  score_components: LeadScoreComponents;
  created_at: string;
  updated_at: string;
  last_touched_at: string;
}

export interface SecurityFinding {
  id: string;
  campaign_id: string;
  asset_id?: string;
  lead_id?: string;
  title: string;
  category: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  confidence: number;
  impact_summary: string;
  technical_summary: string;
  scope_snapshot_id?: string;
  validation_result_id?: string;
  status: FindingStatus;
  created_by_agent_id: string;
  human_owner_id?: string;
  created_at: string;
  updated_at: string;
}

export interface SevenQuestionAnswers {
  scope: boolean;
  reality: boolean;
  reproducibility: boolean;
  impact: boolean;
  evidence: boolean;
  novelty: boolean;
  policy: boolean;
}

export interface SecurityValidationResult {
  id: string;
  finding_id: string;
  campaign_id: string;
  disposition: ValidationDisposition;
  answers: SevenQuestionAnswers;
  notes: string;
  validated_by: string;
  created_at: string;
}

export interface SecurityEvidence {
  id: string;
  campaign_id: string;
  asset_id?: string;
  execution_id?: string;
  type: EvidenceType;
  storage_uri: string;
  sha256: string;
  mime_type: string;
  captured_at: string;
  captured_by: string;
  redaction_state: "none" | "partial" | "redacted";
  sensitivity: "public" | "internal" | "sensitive" | "secret";
  retention_class: "session" | "campaign" | "audit";
  metadata_json: string;
  raw_preview?: string;
  redacted_preview?: string;
}

export interface SecurityMemoryRef {
  id: string;
  campaign_id?: string;
  tier: MemoryTier;
  kind: string;
  body: string;
  sanitized: boolean;
  sha256: string;
  created_by: string;
  created_at: string;
  expires_at?: string;
}

export interface SecurityPolicyProfile {
  id: string;
  name: string;
  default_risk_ceiling: RiskTier;
  block_r3: boolean;
  r2_requires_approval: boolean;
  approval_ttl_minutes: number;
  self_approval: boolean;
  require_authorization: boolean;
  require_scope_token: boolean;
  created_at: string;
}

export interface SecurityPolicyDecision {
  id: string;
  execution_id?: string;
  campaign_id?: string;
  capability_id: string;
  target: string;
  decision: PolicyDecisionKind;
  reason_code: string;
  policy_version: string;
  risk_tier: RiskTier;
  created_at: string;
}

export interface SecurityAuditEvent {
  id: string;
  event_type: string;
  actor_id: string;
  actor_role: SecurityRole;
  campaign_id?: string;
  execution_id?: string;
  task_id?: string;
  approval_id?: string;
  policy_decision_id?: string;
  agent_id?: string;
  target?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface SecurityRateLimit {
  id: string;
  campaign_id: string;
  capability_id: string;
  window_started_at: string;
  count: number;
  limit: number;
}

export interface SecurityCircuitBreaker {
  id: string;
  campaign_id: string;
  kind: CircuitBreakerKind;
  state: CircuitBreakerState;
  trip_count: number;
  last_tripped_at?: string;
  updated_at: string;
}

export interface SecurityImportedPackage {
  id: string;
  name: string;
  source: string;
  commit?: string;
  compatibility: PackageCompatibility;
  restricted_items: string[];
  warnings: string[];
  inventory_json: string;
  created_at: string;
  activated_at?: string;
}

export interface ScopeToken {
  id: string;
  token: string;
  token_hash: string;
  campaign_id: string;
  asset_id?: string;
  capability_id: string;
  actor_id: string;
  expires_at: string;
  revoked: boolean;
  created_at: string;
}

export interface ToolInvocationRequest {
  campaign_id: string;
  actor_id: string;
  actor_role: SecurityRole;
  agent_id: string;
  capability_id: string;
  scope_token?: string;
  target: string;
  risk_tier?: RiskTier;
  approval_id?: string;
  parameters?: Record<string, unknown>;
  reason: string;
}

export interface ToolGatewayResult {
  decision: PolicyDecisionKind;
  execution_id?: string;
  reason_code: string;
  policy_version: string;
  evidence_refs: string[];
  output?: Record<string, unknown>;
}

export interface ScopeResolution {
  match: ScopeMatch;
  asset?: SecurityScopeAsset;
  exclusion?: SecurityScopeExclusion;
  reason_code: string;
}

export interface ReportExport {
  campaign_id: string;
  finding_ids: string[];
  markdown: string;
  sha256: string;
  exported_at: string;
  exported_by: string;
}

export interface CampaignMemoryInput {
  campaignId: string;
  kind: string;
  body: string;
  createdBy: string;
}

export interface CampaignMemoryQuery {
  campaignId: string;
  query: string;
}

export interface SanitizedPattern {
  kind: string;
  body: string;
  createdBy: string;
}

export interface PatternQuery {
  query: string;
}

export interface MemoryHit {
  id: string;
  tier: MemoryTier;
  body: string;
  score: number;
}

export interface RetentionPolicy {
  expireBefore?: string;
  tier?: MemoryTier;
}

export interface SecurityMemoryBackend {
  storeCampaignMemory(input: CampaignMemoryInput): Promise<{ id: string }>;
  searchCampaignMemory(query: CampaignMemoryQuery): Promise<MemoryHit[]>;
  storeReusablePattern(input: SanitizedPattern): Promise<{ id: string }>;
  searchReusablePatterns(query: PatternQuery): Promise<MemoryHit[]>;
  deleteOrExpireByPolicy(policy: RetentionPolicy): Promise<void>;
}

export interface SecurityOverview {
  enabled: boolean;
  campaigns_active: number;
  approvals_pending: number;
  leads_open: number;
  findings_validated: number;
  blocked_actions: number;
  authorizations_expiring: number;
  circuit_breakers_open: number;
}
