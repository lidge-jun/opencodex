/**
 * Phase 20.57: Pao-hubPro × SkillsGate - Universal Agent Skill Control Plane
 * Domain types and contracts.
 */

export type SkillSourceType =
  | "LOCAL_FOLDER"
  | "GIT"
  | "GITHUB"
  | "SKILLS_SH"
  | "PRIVATE_GIT"
  | "GENERATED"
  | "BUNDLED"
  | "ORGANIZATION"
  | "UNKNOWN";

export type SkillStatus =
  | "DISCOVERED"
  | "IMPORTED"
  | "SCANNED"
  | "REVIEW_REQUIRED"
  | "APPROVED"
  | "PUBLISHED"
  | "DEPLOYABLE"
  | "DEPLOYED"
  | "QUARANTINED"
  | "REVOKED"
  | "DEPRECATED"
  | "REJECTED";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ApprovalStatus =
  | "NOT_REQUIRED"
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "REVOKED";

export type ScopeType = "user" | "project" | "workspace" | "node" | "organization";

export type DeploymentStatus =
  | "PLANNED"
  | "STAGED"
  | "DEPLOYED"
  | "FAILED"
  | "ROLLED_BACK"
  | "REMOVED";

export type DriftType =
  | "IN_SYNC"
  | "MODIFIED"
  | "MISSING"
  | "EXTRA_FILES"
  | "CONFLICT"
  | "UNKNOWN";

export type NodeStatus = "UNKNOWN" | "ONLINE" | "OFFLINE" | "DEGRADED" | "BLOCKED";

export type EnvironmentType = "dev" | "test" | "staging" | "prod" | "personal" | "worker";

/** Canonical AgentSkill Manifest (pao.dev/v1) */
export interface AgentSkillManifest {
  apiVersion: "pao.dev/v1";
  kind: "AgentSkill";
  metadata: {
    id: string;
    namespace: string;
    slug: string;
    name: string;
    version: string;
    description: string;
    tags: string[];
    author?: string;
  };
  source: {
    type: SkillSourceType;
    repository?: string;
    ref?: string;
    commit?: string;
    path?: string;
    imported_at: string;
    license?: {
      spdx?: string;
      evidence_path?: string;
    };
    provenance?: Record<string, unknown>;
  };
  content: {
    entry_file: string; // usually "SKILL.md"
    files: string[];
  };
  compatibility: {
    agents: string[];
    scopes: ScopeType[];
    os?: ("linux" | "macos" | "windows")[];
  };
  risk?: {
    level: RiskLevel;
    score: number;
    findings: SkillScanFinding[];
    inferred_capabilities: string[];
  };
  policy?: {
    approval_required: boolean;
    allowed_environments: EnvironmentType[];
    denied_environments?: EnvironmentType[];
    constraints?: Record<string, unknown>;
  };
  deployment: {
    strategy: "managed-copy" | "symlink" | "template";
    default_scope: ScopeType;
    overwrite_unmanaged: boolean;
    verify_after_write: boolean;
    backup_before_replace: boolean;
  };
  integrity: {
    content_sha256: string;
    files_sha256: Record<string, string>;
    source_snapshot_sha256?: string;
  };
  ownership?: {
    owner_type: "user" | "organization" | "system";
    owner_id: string;
  };
}

export interface SkillSourceRecord {
  id: string;
  source_type: SkillSourceType;
  display_name: string;
  base_url?: string;
  repository_url?: string;
  default_ref?: string;
  auth_ref?: string;
  trust_level: "trusted" | "verified" | "community" | "unknown" | "untrusted";
  enabled: boolean;
  refresh_policy?: Record<string, unknown>;
  last_checked_at?: string;
  created_at: string;
  updated_at: string;
}

export interface SkillRecord {
  id: string; // e.g. "database.postgres-migration"
  namespace: string;
  slug: string;
  display_name: string;
  description: string;
  source_id?: string;
  status: SkillStatus;
  current_version: string;
  publisher?: string;
  license_spdx?: string;
  trust_level: "trusted" | "verified" | "community" | "unknown" | "untrusted";
  risk_level?: RiskLevel;
  tags: string[];
  favorite: boolean;
  created_at: string;
  updated_at: string;
}

export interface SkillVersionRecord {
  id: string; // e.g. "database.postgres-migration@1.2.0"
  skill_id: string;
  version: string;
  source_ref?: string;
  source_commit?: string;
  source_path?: string;
  manifest: AgentSkillManifest;
  content_sha256: string;
  source_snapshot_sha256?: string;
  scanner_version?: string;
  scan_status: "pending" | "scanned" | "failed";
  risk_score?: number;
  risk_level?: RiskLevel;
  approval_status?: ApprovalStatus;
  immutable: boolean;
  created_by?: string;
  created_at: string;
  published_at?: string;
  published_by?: string;
}

export interface SkillFileRecord {
  id: string;
  skill_version_id: string;
  relative_path: string;
  mime_type?: string;
  size_bytes: number;
  sha256: string;
  storage_ref: string; // key/path in local snapshot storage
  created_at: string;
}

export interface SkillScanFinding {
  id?: string;
  rule_id: string;
  severity: RiskLevel;
  file_path: string;
  line_start?: number;
  line_end?: number;
  evidence_hash: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface SkillRiskAssessment {
  score: number; // 0 - 100
  level: RiskLevel;
  inferred_capabilities: string[];
  findings: SkillScanFinding[];
  hard_escalations: string[];
}

export interface SkillPolicyDecision {
  effect: "allow" | "deny" | "require_approval" | "constrain";
  reason: string;
  matched_rules: string[];
  constraints?: {
    allowed_environments?: EnvironmentType[];
    allowed_agents?: string[];
    allowed_nodes?: string[];
    scopes?: ScopeType[];
    expires_at?: string;
  };
}

export interface SkillApprovalRecord {
  id: string;
  skill_version_id: string;
  requested_action: "deploy" | "publish" | "sync";
  requested_targets?: ResolvedSkillTarget[];
  policy_snapshot?: SkillPolicyDecision;
  risk_snapshot?: SkillRiskAssessment;
  status: ApprovalStatus;
  requested_by: string;
  reviewed_by?: string;
  decision_reason?: string;
  constraints?: Record<string, unknown>;
  content_sha256: string; // bound to exact content hash
  created_at: string;
  decided_at?: string;
  expires_at?: string;
}

export interface SkillAgentRecord {
  id: string; // e.g. "codex", "claude-code"
  agent_type: string;
  display_name: string;
  adapter_version: string;
  enabled: boolean;
  capabilities?: string[];
  created_at: string;
  updated_at: string;
}

export interface SkillNodeRecord {
  id: string; // e.g. "local", "vps-main"
  name: string;
  kind: "local" | "ssh" | "docker" | "kubernetes";
  hostname?: string;
  port?: number;
  username?: string;
  auth_ref?: string; // secret reference e.g. secret://ssh/vps-main
  host_key_fingerprint?: string;
  os?: "linux" | "macos" | "windows";
  architecture?: string;
  environment: EnvironmentType;
  status: NodeStatus;
  allowed_roots: string[];
  tags: string[];
  last_seen_at?: string;
  created_at: string;
  updated_at: string;
}

export interface SkillDeploymentRecord {
  id: string;
  skill_version_id: string;
  node_id: string;
  agent_id: string;
  scope: ScopeType;
  project_ref?: string;
  target_path: string;
  deployment_mode: "managed-copy" | "symlink";
  desired_sha256: string;
  actual_sha256?: string;
  status: DeploymentStatus;
  managed: boolean;
  deployed_by?: string;
  deployed_at?: string;
  verified_at?: string;
  updated_at: string;
}

export interface SkillDeploymentSnapshot {
  id: string;
  deployment_id: string;
  reason: "pre-deployment-backup" | "pre-rollback" | "conflict-backup" | "manual";
  manifest?: AgentSkillManifest;
  file_index: Record<string, { sha256: string; size: number }>;
  storage_ref: string;
  created_by?: string;
  created_at: string;
}

export interface SkillDriftEvent {
  id: string;
  deployment_id: string;
  drift_type: DriftType;
  expected_sha256?: string;
  actual_sha256?: string;
  details?: Record<string, unknown>;
  status: "active" | "resolved" | "dismissed";
  detected_at: string;
  resolved_at?: string;
}

export interface SkillAuditEvent {
  id: string;
  event_type: string;
  actor_type: "user" | "agent" | "system";
  actor_id?: string;
  skill_id?: string;
  skill_version_id?: string;
  deployment_id?: string;
  node_id?: string;
  trace_id?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

// Agent Adapter Contexts & Contracts
export interface AgentDetectContext {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface AgentDetectionResult {
  detected: boolean;
  agentType: string;
  version?: string;
  executablePath?: string;
  configRoot?: string;
  supportedScopes: ScopeType[];
}

export interface AgentTargetContext {
  scope: ScopeType;
  projectPath?: string;
  homeDir?: string;
  nodeId?: string;
}

export interface ResolvedSkillTarget {
  nodeId: string;
  agentType: string;
  scope: ScopeType;
  targetPath: string; // Absolute path on target system
  skillRoot: string;  // Parent directory for skills
  projectPath?: string;
  exists: boolean;
  isManaged: boolean;
  currentSha256?: string;
}

export interface InstalledSkillSnapshot {
  skillId: string;
  version?: string;
  targetPath: string;
  scope: ScopeType;
  isManaged: boolean;
  sha256: string;
  entryFile: string;
  fileCount: number;
}

export interface SkillDeploymentRequest {
  skillVersionId: string;
  targets: {
    nodeId: string;
    agentType: string;
    scope: ScopeType;
    projectPath?: string;
  }[];
  dryRun?: boolean;
  forceOverwriteUnmanaged?: boolean;
  actor?: string;
}

export interface PlannedFileAction {
  action: "create" | "replace" | "delete" | "skip";
  relativePath: string;
  targetPath: string;
  expectedSha256?: string;
  currentSha256?: string;
}

export interface SkillDeploymentPlan {
  planId: string;
  skillVersionId: string;
  manifest: AgentSkillManifest;
  target: ResolvedSkillTarget;
  actions: PlannedFileAction[];
  conflicts: string[];
  requiresApproval: boolean;
  policyDecision: SkillPolicyDecision;
  backupRequired: boolean;
  canApply: boolean;
}

export interface SkillDeploymentResult {
  deploymentId: string;
  target: ResolvedSkillTarget;
  status: DeploymentStatus;
  filesWritten: string[];
  actualSha256?: string;
  error?: string;
  snapshotId?: string;
}

export interface SkillVerificationResult {
  verified: boolean;
  expectedSha256: string;
  actualSha256: string;
  mismatches: string[];
}

export interface SkillRemovalRequest {
  deploymentId: string;
  dryRun?: boolean;
  actor?: string;
}

export interface SkillRollbackRequest {
  deploymentId: string;
  targetVersion?: string;
  snapshotId?: string;
  actor?: string;
}

// Marketplace Contracts
export interface MarketplaceSkillRef {
  id: string; // e.g. "postgres-migration"
  version?: string;
  sourceUrl?: string;
}

export interface MarketplaceSkillResult {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  stars?: number;
  downloads?: number;
  tags: string[];
  sourceUrl: string;
  verified: boolean;
}

export interface MarketplaceSkillMetadata {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  tags: string[];
  sourceUrl: string;
  rawSkillMarkdown: string;
  files?: { path: string; content?: string }[];
}

export interface SkillSourceSnapshot {
  manifest: AgentSkillManifest;
  entryContent: string;
  bundledFiles: Record<string, string | Buffer>;
  contentSha256: string;
}

export interface SkillUpdateResult {
  skillId: string;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  changelog?: string;
}

// Phase 20.56 Capability Bridge
export interface CapabilityProvenance {
  capabilityId: string;
  capabilityVersion: string;
  recipe?: string;
  author?: string;
  generatedAt: string;
  sourceHash?: string;
}

export interface CapabilitySkillPublisherInput {
  capabilityId: string;
  capabilityVersion: string;
  displayName: string;
  description: string;
  skillMarkdown: string;
  bundledFiles?: Record<string, string | Buffer>;
  provenance: CapabilityProvenance;
  tags?: string[];
  author?: string;
}

