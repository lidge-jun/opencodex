import type { AgentKind, RiskTier } from "./types";

export const SECURITY_POLICY_VERSION = "pao.security.v1";

export const FEATURE_FLAG_ENV = "PAO_SECURITY_CONTROL_PLANE";

export const DEFAULT_APPROVAL_TTL_MINUTES = 30;
export const DEFAULT_SCOPE_TOKEN_TTL_SECONDS = 15 * 60;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;

export const BLOCKED_ACTION_CLASSES = [
  "credential_attack",
  "privilege_escalation",
  "persistence",
  "malware_execution",
  "remote_code_execution_validation_on_real_target",
  "data_exfiltration",
  "service_disruption",
  "destructive_action",
  "security_control_bypass",
  "stealth_or_evasion",
] as const;

export const RESTRICTED_CAPABILITY_PATTERNS = [
  /credential[\s_-]*(spray|stuff|guess|harvest)/i,
  /password[\s_-]*(guess|spray|brute)/i,
  /phishing/i,
  /mfa[\s_-]*bypass/i,
  /secret[\s_-]*replay/i,
  /account[\s_-]*takeover/i,
  /lateral[\s_-]*movement/i,
  /data[\s_-]*exfil/i,
  /privilege[\s_-]*escalat/i,
  /persistence/i,
  /rce|remote[\s_-]*code[\s_-]*exec/i,
  /destructive/i,
  /evasion|stealth/i,
  /install\.sh|install_tools\.sh/i,
] as const;

export const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /(?:api[_-]?key|secret|token|password|passwd|authorization)\s*[:=]\s*['"]?[A-Za-z0-9_\-+/=]{12,}/i,
  /\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
] as const;

export const RISK_ORDER: Record<RiskTier, number> = { R0: 0, R1: 1, R2: 2, R3: 3 };

export const DEFAULT_AGENTS: ReadonlyArray<{
  id: string;
  kind: AgentKind;
  display_name: string;
  max_risk_tier: RiskTier;
}> = [
  { id: "agent.security-coordinator", kind: "security-coordinator", display_name: "Security Coordinator", max_risk_tier: "R1" },
  { id: "agent.scope-guardian", kind: "scope-guardian", display_name: "Scope Guardian", max_risk_tier: "R0" },
  { id: "agent.recon-agent", kind: "recon-agent", display_name: "Recon Agent", max_risk_tier: "R1" },
  { id: "agent.recon-ranker", kind: "recon-ranker", display_name: "Recon Ranker", max_risk_tier: "R0" },
  { id: "agent.finding-validator", kind: "finding-validator", display_name: "Finding Validator", max_risk_tier: "R0" },
  { id: "agent.report-writer", kind: "report-writer", display_name: "Report Writer", max_risk_tier: "R0" },
  { id: "agent.memory-curator", kind: "memory-curator", display_name: "Memory Curator", max_risk_tier: "R0" },
  { id: "agent.policy-sentinel", kind: "policy-sentinel", display_name: "Policy Sentinel", max_risk_tier: "R0" },
];

export const DEFAULT_CAPABILITIES: ReadonlyArray<{
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
}> = [
  {
    id: "cap.parse-local",
    name: "Parse local artifacts",
    risk_tier: "R0",
    network_access: false,
    requires_scope: false,
    requires_approval: false,
    restricted: false,
    allowed_environments: ["internal", "lab", "ctf", "bug_bounty", "training_environment"],
    capabilities: ["parse_files", "classify_artifacts"],
    prohibited_capabilities: [...BLOCKED_ACTION_CLASSES],
  },
  {
    id: "cap.normalize-scope",
    name: "Normalize scope",
    risk_tier: "R0",
    network_access: false,
    requires_scope: false,
    requires_approval: false,
    restricted: false,
    allowed_environments: ["internal", "lab", "ctf", "bug_bounty", "training_environment"],
    capabilities: ["normalize_scope"],
    prohibited_capabilities: [...BLOCKED_ACTION_CLASSES],
  },
  {
    id: "cap.rank-leads",
    name: "Rank recon leads",
    risk_tier: "R0",
    network_access: false,
    requires_scope: false,
    requires_approval: false,
    restricted: false,
    allowed_environments: ["internal", "lab", "ctf", "bug_bounty", "training_environment"],
    capabilities: ["rank_leads"],
    prohibited_capabilities: [...BLOCKED_ACTION_CLASSES],
  },
  {
    id: "cap.validate-finding",
    name: "Validate finding evidence",
    risk_tier: "R0",
    network_access: false,
    requires_scope: false,
    requires_approval: false,
    restricted: false,
    allowed_environments: ["internal", "lab", "ctf", "bug_bounty", "training_environment"],
    capabilities: ["validate_finding"],
    prohibited_capabilities: [...BLOCKED_ACTION_CLASSES],
  },
  {
    id: "cap.write-report",
    name: "Write validated report",
    risk_tier: "R0",
    network_access: false,
    requires_scope: false,
    requires_approval: false,
    restricted: false,
    allowed_environments: ["internal", "lab", "ctf", "bug_bounty", "training_environment"],
    capabilities: ["write_report"],
    prohibited_capabilities: [...BLOCKED_ACTION_CLASSES],
  },
  {
    id: "cap.memory-curate",
    name: "Curate sanitized memory",
    risk_tier: "R0",
    network_access: false,
    requires_scope: false,
    requires_approval: false,
    restricted: false,
    allowed_environments: ["internal", "lab", "ctf", "bug_bounty", "training_environment"],
    capabilities: ["memory_curate"],
    prohibited_capabilities: [...BLOCKED_ACTION_CLASSES],
  },
  {
    id: "cap.recon-passive",
    name: "Passive recon (fixture)",
    risk_tier: "R1",
    network_access: true,
    requires_scope: true,
    requires_approval: false,
    restricted: false,
    allowed_environments: ["internal", "lab", "ctf", "bug_bounty", "training_environment"],
    capabilities: ["asset_discovery", "fingerprinting"],
    prohibited_capabilities: [...BLOCKED_ACTION_CLASSES],
  },
  {
    id: "cap.validate-active",
    name: "Active low-impact validation",
    risk_tier: "R2",
    network_access: true,
    requires_scope: true,
    requires_approval: true,
    restricted: false,
    allowed_environments: ["internal", "lab", "ctf", "bug_bounty"],
    capabilities: ["controlled_validation"],
    prohibited_capabilities: [...BLOCKED_ACTION_CLASSES],
  },
  {
    id: "cap.credential-attack",
    name: "Credential attack (blocked)",
    risk_tier: "R3",
    network_access: true,
    requires_scope: true,
    requires_approval: true,
    restricted: true,
    allowed_environments: [],
    capabilities: ["credential_attack"],
    prohibited_capabilities: [...BLOCKED_ACTION_CLASSES],
  },
];

export const AUDIT_EVENTS = [
  "SECURITY_AUTHORIZATION_CREATED",
  "SECURITY_AUTHORIZATION_VERIFIED",
  "SECURITY_SCOPE_CHANGED",
  "SECURITY_SCOPE_TOKEN_ISSUED",
  "SECURITY_CAMPAIGN_CREATED",
  "SECURITY_CAMPAIGN_STARTED",
  "SECURITY_CAMPAIGN_PAUSED",
  "SECURITY_CAMPAIGN_BLOCKED",
  "SECURITY_TASK_SCHEDULED",
  "SECURITY_POLICY_ALLOW",
  "SECURITY_POLICY_DENY",
  "SECURITY_APPROVAL_REQUESTED",
  "SECURITY_APPROVAL_GRANTED",
  "SECURITY_APPROVAL_DENIED",
  "SECURITY_TOOL_STARTED",
  "SECURITY_TOOL_FINISHED",
  "SECURITY_TOOL_TERMINATED",
  "SECURITY_EVIDENCE_STORED",
  "SECURITY_LEAD_CREATED",
  "SECURITY_FINDING_CREATED",
  "SECURITY_FINDING_VALIDATED",
  "SECURITY_FINDING_REJECTED",
  "SECURITY_REPORT_EXPORTED",
  "SECURITY_MEMORY_WRITTEN",
  "SECURITY_CIRCUIT_BREAKER_TRIPPED",
  "SECURITY_SCOPE_EXPIRED",
  "SECURITY_PACKAGE_IMPORTED",
  "SECURITY_PACKAGE_QUARANTINED",
] as const;

export const STRICT_DEFAULTS = {
  require_authorization: true,
  require_scope: true,
  require_scope_token: true,
  unknown_asset: "deny",
  expired_authorization: "deny",
  excluded_asset: "deny",
  unclassified_capability: "deny",
  r2_without_approval: "deny",
  r3: "deny",
  imported_tool_auto_execute: false,
  imported_skill_auto_activate: false,
  shell_passthrough: false,
  secret_logging: false,
  cross_campaign_sensitive_memory: false,
} as const;
