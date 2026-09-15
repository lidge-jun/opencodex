import { randomBytes } from "node:crypto";
import { sha256 } from "../skills/hasher";
import { decideApproval, createApprovalRequest, isApprovalValid } from "./approval";
import { isAuthorizationExecutable } from "./authorization";
import { canTransitionCampaign, transitionCampaign } from "./campaign";
import { isBreakerOpen, tripBreaker } from "./circuit";
import { DEFAULT_RATE_LIMIT_PER_MINUTE } from "./constants";
import { SecurityDatabase, getDefaultSecurityDbPath } from "./db";
import { ingestEvidence } from "./evidence";
import { isSecurityControlPlaneEnabled } from "./enabled";
import { applyValidation, canExportFinding, createFinding, isDuplicateFinding } from "./findings";
import { seedDemoEnvironment, DEMO } from "./fixtures";
import { invokeSecurityTool } from "./gateway";
import { SecurityHookBus } from "./hooks";
import { importSecurityPackage } from "./importer";
import { createLead, isDuplicateLead } from "./leads";
import { LocalSecurityMemoryAdapter } from "./memory";
import { evaluateSecurityPolicy } from "./policy";
import { normalizeAsset, resolveScope } from "./scope";
import { issueScopeToken } from "./token";
import type {
  ApprovalDecisionKind,
  AssetClass,
  AuthorizationType,
  CampaignStatus,
  ReportExport,
  SecurityApproval,
  SecurityAuditEvent,
  SecurityAuthorization,
  SecurityCampaign,
  SecurityFinding,
  SecurityImportedPackage,
  SecurityLead,
  SecurityMcpServer,
  SecurityMemoryBackend,
  SecurityOverview,
  SecurityPolicyDecision,
  SecurityRole,
  SecurityScope,
  SevenQuestionAnswers,
  ToolGatewayResult,
  ToolInvocationRequest,
} from "./types";

function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

export interface SecurityControlServiceOptions {
  dbPath?: string;
  memory?: SecurityMemoryBackend;
  seedDemo?: boolean;
}

export class SecurityControlService {
  public readonly db: SecurityDatabase;
  public readonly hooks = new SecurityHookBus();
  public readonly memory: SecurityMemoryBackend;

  constructor(options: SecurityControlServiceOptions = {}) {
    this.db = new SecurityDatabase(options.dbPath ?? getDefaultSecurityDbPath());
    this.memory = options.memory ?? new LocalSecurityMemoryAdapter(this.db);
    this.bootstrap(options.seedDemo !== false);
  }

  private bootstrap(seedDemo: boolean): void {
    if (this.db.listPolicyProfiles().length === 0 || this.db.listAgents().length === 0) {
      seedDemoEnvironment(this.db);
      return;
    }
    if (seedDemo && !this.db.getCampaign(DEMO.campaignId)) {
      seedDemoEnvironment(this.db);
    }
  }

  public enabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return isSecurityControlPlaneEnabled(env);
  }

  public overview(): SecurityOverview {
    const campaigns = this.db.listCampaigns();
    const approvals = this.db.listApprovals("PENDING");
    const auths = this.db.listAuthorizations();
    const soon = Date.now() + 7 * 24 * 3600_000;
    return {
      enabled: this.enabled(),
      campaigns_active: campaigns.filter(c => !["CLOSED", "CANCELLED", "FAILED"].includes(c.status)).length,
      approvals_pending: approvals.length,
      leads_open: campaigns.reduce((n, c) => n + this.db.listLeads(c.id).filter(l => !["DISMISSED", "DUPLICATE", "PROMOTED_TO_FINDING"].includes(l.status)).length, 0),
      findings_validated: this.db.listFindings().filter(f => f.status === "VALIDATED" || f.status === "REPORT_READY").length,
      blocked_actions: this.db.listAudit().filter(a => a.event_type === "SECURITY_POLICY_DENY").length,
      authorizations_expiring: auths.filter(a => Date.parse(a.valid_until) < soon && Date.parse(a.valid_until) > Date.now()).length,
      circuit_breakers_open: this.db.listBreakers().filter(b => b.state === "OPEN").length,
    };
  }

  public audit(event: Omit<SecurityAuditEvent, "id" | "created_at"> & { created_at?: string }): SecurityAuditEvent {
    const row: SecurityAuditEvent = {
      id: id("aud"),
      created_at: event.created_at ?? nowIso(),
      ...event,
    };
    this.db.insertAudit(row);
    this.hooks.emit({ name: "onAudit", campaign_id: row.campaign_id, audit: row });
    return row;
  }

  // --- Authorizations ---
  public createAuthorization(input: {
    organization_id?: string;
    type: AuthorizationType;
    source_reference: string;
    valid_from: string;
    valid_until: string;
    allowed_action_classes: string[];
    prohibited_action_classes?: string[];
    notes?: string;
    created_by: string;
    actor_role?: SecurityRole;
  }): SecurityAuthorization {
    const ts = nowIso();
    const orgId = input.organization_id ?? DEMO.orgId;
    if (!this.db.getOrganization(orgId)) {
      this.db.upsertOrganization({ id: orgId, name: orgId, created_at: ts, updated_at: ts });
    }
    const row: SecurityAuthorization = {
      id: id("auth"),
      organization_id: orgId,
      type: input.type,
      source_reference: input.source_reference,
      valid_from: input.valid_from,
      valid_until: input.valid_until,
      status: "PENDING_VERIFICATION",
      allowed_action_classes: input.allowed_action_classes,
      prohibited_action_classes: input.prohibited_action_classes ?? [],
      notes: input.notes,
      created_by: input.created_by,
      created_at: ts,
      updated_at: ts,
    };
    this.db.upsertAuthorization(row);
    this.audit({
      event_type: "SECURITY_AUTHORIZATION_CREATED",
      actor_id: input.created_by,
      actor_role: input.actor_role ?? "security_operator",
      metadata: { authorization_id: row.id },
    });
    return row;
  }

  public verifyAuthorization(id: string, verifier: string, actorRole: SecurityRole = "security_reviewer"): SecurityAuthorization {
    const current = this.db.getAuthorization(id);
    if (!current) throw new Error(`Authorization not found: ${id}`);
    const ts = nowIso();
    const clock = isAuthorizationExecutable({ ...current, status: "ACTIVE" }, new Date()) ? "ACTIVE" : current.status;
    const next: SecurityAuthorization = {
      ...current,
      status: clock === "ACTIVE" ? "ACTIVE" : current.status,
      verified_by: verifier,
      verified_at: ts,
      updated_at: ts,
    };
    if (!isAuthorizationExecutable({ ...next, status: "ACTIVE" })) {
      next.status = Date.parse(next.valid_until) <= Date.now() ? "EXPIRED" : "PENDING_VERIFICATION";
    } else {
      next.status = "ACTIVE";
    }
    this.db.upsertAuthorization(next);
    this.audit({
      event_type: "SECURITY_AUTHORIZATION_VERIFIED",
      actor_id: verifier,
      actor_role: actorRole,
      metadata: { authorization_id: next.id, status: next.status },
    });
    return next;
  }

  public patchAuthorization(id: string, patch: Partial<Pick<SecurityAuthorization, "status" | "notes" | "valid_from" | "valid_until" | "allowed_action_classes" | "prohibited_action_classes" | "approval_owner">>, actor = "operator"): SecurityAuthorization {
    const current = this.db.getAuthorization(id);
    if (!current) throw new Error(`Authorization not found: ${id}`);
    const next = { ...current, ...patch, updated_at: nowIso() };
    this.db.upsertAuthorization(next);
    this.audit({ event_type: "SECURITY_AUTHORIZATION_CREATED", actor_id: actor, actor_role: "security_operator", metadata: { authorization_id: id, patch: Object.keys(patch) } });
    return next;
  }

  // --- Scopes ---
  public createScope(input: {
    authorization_id: string;
    name: string;
    created_by: string;
    rate_limit_per_minute?: number;
    notes?: string;
    assets?: Array<{ asset_class: AssetClass; value: string; criticality?: number }>;
    exclusions?: Array<{ asset_class: AssetClass; value: string; reason?: string }>;
  }): SecurityScope {
    const ts = nowIso();
    const row: SecurityScope = {
      id: id("scp"),
      authorization_id: input.authorization_id,
      name: input.name,
      status: "PENDING_VERIFICATION",
      rate_limit_per_minute: input.rate_limit_per_minute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
      notes: input.notes,
      created_by: input.created_by,
      created_at: ts,
      updated_at: ts,
    };
    this.db.upsertScope(row);
    for (const asset of input.assets ?? []) {
      this.db.insertAsset({
        id: id("ast"),
        scope_id: row.id,
        asset_class: asset.asset_class,
        value: asset.value,
        normalized_asset: normalizeAsset(asset.asset_class, asset.value),
        criticality: asset.criticality ?? 1,
        created_at: ts,
      });
    }
    for (const ex of input.exclusions ?? []) {
      this.db.insertExclusion({
        id: id("exc"),
        scope_id: row.id,
        asset_class: ex.asset_class,
        value: ex.value,
        normalized_asset: normalizeAsset(ex.asset_class, ex.value),
        reason: ex.reason,
        created_at: ts,
      });
    }
    this.audit({
      event_type: "SECURITY_SCOPE_CHANGED",
      actor_id: input.created_by,
      actor_role: "security_operator",
      metadata: { scope_id: row.id },
    });
    return row;
  }

  public verifyScope(scopeId: string, actor: string): SecurityScope {
    const scope = this.db.getScope(scopeId);
    if (!scope) throw new Error(`Scope not found: ${scopeId}`);
    const auth = this.db.getAuthorization(scope.authorization_id);
    if (!auth || !isAuthorizationExecutable(auth)) {
      throw new Error("Cannot verify scope without an active authorization.");
    }
    const next = { ...scope, status: "ACTIVE" as const, updated_at: nowIso() };
    this.db.upsertScope(next);
    this.audit({ event_type: "SECURITY_SCOPE_CHANGED", actor_id: actor, actor_role: "security_reviewer", metadata: { scope_id: scopeId, status: "ACTIVE" } });
    return next;
  }

  public matchScope(scopeId: string, target: string) {
    const scope = this.db.getScope(scopeId);
    if (!scope) throw new Error(`Scope not found: ${scopeId}`);
    const auth = this.db.getAuthorization(scope.authorization_id);
    return resolveScope(target, this.db.listAssets(scopeId), this.db.listExclusions(scopeId), {
      expired: !auth || !isAuthorizationExecutable(auth) || scope.status === "EXPIRED",
    });
  }

  // --- Campaigns ---
  public createCampaign(input: {
    name: string;
    authorization_id: string;
    scope_id: string;
    owner_id: string;
    organization_id?: string;
    policy_profile_id?: string;
  }): SecurityCampaign {
    const ts = nowIso();
    const row: SecurityCampaign = {
      id: id("cmp"),
      organization_id: input.organization_id ?? DEMO.orgId,
      authorization_id: input.authorization_id,
      scope_id: input.scope_id,
      name: input.name,
      status: "DRAFT",
      policy_profile_id: input.policy_profile_id ?? DEMO.profileId,
      owner_id: input.owner_id,
      created_at: ts,
      updated_at: ts,
    };
    this.db.upsertCampaign(row);
    this.audit({
      event_type: "SECURITY_CAMPAIGN_CREATED",
      actor_id: input.owner_id,
      actor_role: "security_operator",
      campaign_id: row.id,
    });
    return row;
  }

  private freezeSnapshot(campaign: SecurityCampaign, actor: string): string {
    const ts = nowIso();
    const auth = this.db.getAuthorization(campaign.authorization_id);
    if (!auth) throw new Error("Authorization missing; cannot freeze snapshot.");
    const snapshotId = id("snp");
    this.db.insertSnapshot({
      id: snapshotId,
      campaign_id: campaign.id,
      authorization_id: campaign.authorization_id,
      scope_id: campaign.scope_id,
      assets_json: JSON.stringify(this.db.listAssets(campaign.scope_id)),
      exclusions_json: JSON.stringify(this.db.listExclusions(campaign.scope_id)),
      allowed_action_classes_json: JSON.stringify(auth.allowed_action_classes),
      prohibited_action_classes_json: JSON.stringify(auth.prohibited_action_classes),
      frozen_at: ts,
      frozen_by: actor,
    });
    return snapshotId;
  }

  public setCampaignStatus(campaignId: string, to: CampaignStatus, actor: string, reason?: string): SecurityCampaign {
    const campaign = this.requireCampaign(campaignId);
    if (!canTransitionCampaign(campaign.status, to)) {
      throw new Error(`Illegal campaign transition ${campaign.status} → ${to}`);
    }
    const ts = nowIso();
    const next: SecurityCampaign = {
      ...campaign,
      status: transitionCampaign(campaign.status, to),
      blocked_reason: reason,
      updated_at: ts,
      started_at: to === "RECON_RUNNING" ? (campaign.started_at ?? ts) : campaign.started_at,
      closed_at: to === "CLOSED" || to === "CANCELLED" ? ts : campaign.closed_at,
    };
    this.db.upsertCampaign(next);
    this.hooks.emit({ name: "onCampaignStatusChange", campaign_id: campaignId, from: campaign.status, to });
    return next;
  }

  public startCampaign(campaignId: string, actor: string): SecurityCampaign {
    const campaign = this.requireCampaign(campaignId);
    const auth = this.db.getAuthorization(campaign.authorization_id);
    const scope = this.db.getScope(campaign.scope_id);
    if (!auth || !isAuthorizationExecutable(auth)) {
      const blocked = this.setCampaignStatus(campaignId, campaign.status === "DRAFT" ? "SCOPE_CHECK" : "BLOCKED_POLICY", actor, "AUTHORIZATION_NOT_ACTIVE");
      if (blocked.status === "SCOPE_CHECK") {
        return this.setCampaignStatus(campaignId, "BLOCKED_SCOPE", actor, "AUTHORIZATION_NOT_ACTIVE");
      }
      this.audit({ event_type: "SECURITY_CAMPAIGN_BLOCKED", actor_id: actor, actor_role: "security_operator", campaign_id: campaignId, metadata: { reason: "AUTHORIZATION_NOT_ACTIVE" } });
      return blocked;
    }
    if (!scope || scope.status !== "ACTIVE") {
      const checking = campaign.status === "DRAFT" ? this.setCampaignStatus(campaignId, "SCOPE_CHECK", actor) : campaign;
      const blocked = this.setCampaignStatus(checking.id, "BLOCKED_SCOPE", actor, "SCOPE_NOT_ACTIVE");
      this.audit({ event_type: "SECURITY_CAMPAIGN_BLOCKED", actor_id: actor, actor_role: "security_operator", campaign_id: campaignId, metadata: { reason: "SCOPE_NOT_ACTIVE" } });
      return blocked;
    }
    let next = campaign;
    if (next.status === "DRAFT") next = this.setCampaignStatus(campaignId, "SCOPE_CHECK", actor);
    if (next.status === "SCOPE_CHECK") next = this.setCampaignStatus(campaignId, "READY", actor);
    const snapshotId = next.snapshot_id ?? this.freezeSnapshot(next, actor);
    next = { ...next, snapshot_id: snapshotId, updated_at: nowIso() };
    this.db.upsertCampaign(next);
    next = this.setCampaignStatus(next.id, "RECON_RUNNING", actor);
    this.audit({ event_type: "SECURITY_CAMPAIGN_STARTED", actor_id: actor, actor_role: "security_operator", campaign_id: campaignId });
    return next;
  }

  public pauseCampaign(campaignId: string, actor: string): SecurityCampaign {
    const next = this.setCampaignStatus(campaignId, "PAUSED", actor);
    this.db.revokeScopeTokensForCampaign(campaignId);
    this.audit({ event_type: "SECURITY_CAMPAIGN_PAUSED", actor_id: actor, actor_role: "security_operator", campaign_id: campaignId });
    return next;
  }

  public resumeCampaign(campaignId: string, actor: string): SecurityCampaign {
    const campaign = this.requireCampaign(campaignId);
    const resumeTo: CampaignStatus = campaign.started_at ? "RECON_RUNNING" : "READY";
    return this.setCampaignStatus(campaignId, resumeTo, actor);
  }

  public cancelCampaign(campaignId: string, actor: string): SecurityCampaign {
    const campaign = this.requireCampaign(campaignId);
    const next = this.setCampaignStatus(campaignId, campaign.status === "CLOSED" ? "CLOSED" : "CANCELLED", actor);
    this.db.revokeScopeTokensForCampaign(campaignId);
    return next;
  }

  private requireCampaign(id: string): SecurityCampaign {
    const campaign = this.db.getCampaign(id);
    if (!campaign) throw new Error(`Campaign not found: ${id}`);
    return campaign;
  }

  public issueToken(campaignId: string, capabilityId: string, actorId: string, assetId?: string) {
    const token = issueScopeToken(this.db, {
      campaign_id: campaignId,
      capability_id: capabilityId,
      actor_id: actorId,
      asset_id: assetId,
    });
    this.audit({
      event_type: "SECURITY_SCOPE_TOKEN_ISSUED",
      actor_id: actorId,
      actor_role: "security_operator",
      campaign_id: campaignId,
      metadata: { capability_id: capabilityId, token_id: token.id },
    });
    return token;
  }

  public invoke(request: ToolInvocationRequest): ToolGatewayResult {
    const result = invokeSecurityTool(this.db, request);
    this.hooks.emit({
      name: "onPolicyDecision",
      campaign_id: request.campaign_id,
      decision: result.decision,
      reason_code: result.reason_code,
    });
    if (result.decision === "APPROVAL_REQUIRED") {
      const approval = this.requestApproval({
        campaign_id: request.campaign_id,
        capability_id: request.capability_id,
        target: request.target,
        requested_by: request.actor_id,
        requested_agent_id: request.agent_id,
        expected_effect: request.reason,
        policy_rule: result.reason_code,
      });
      return { ...result, output: { ...(result.output ?? {}), approval_id: approval.id } };
    }
    return result;
  }

  public runPassiveRecon(campaignId: string, target: string, actorId: string): ToolGatewayResult {
    const token = this.issueToken(campaignId, "cap.recon-passive", actorId);
    const result = this.invoke({
      campaign_id: campaignId,
      actor_id: actorId,
      actor_role: "security_operator",
      agent_id: "agent.recon-agent",
      capability_id: "cap.recon-passive",
      scope_token: token.token,
      target,
      reason: "Passive recon against frozen campaign snapshot (fixture).",
    });
    if (result.decision === "ALLOW" && result.output) {
      this.recordLeadFromRecon(campaignId, target, result);
      this.advanceCampaign(campaignId, "TRIAGE", actorId);
    }
    return result;
  }

  private advanceCampaign(campaignId: string, to: CampaignStatus, actor: string): void {
    const campaign = this.requireCampaign(campaignId);
    if (campaign.status === to) return;
    if (canTransitionCampaign(campaign.status, to)) {
      this.setCampaignStatus(campaignId, to, actor);
    }
  }

  private recordLeadFromRecon(campaignId: string, target: string, result: ToolGatewayResult): SecurityLead {
    const existing = this.db.listLeads(campaignId);
    const title = `Fixture fingerprint: ${target}`;
    const dup = isDuplicateLead(existing, { title, category: "fingerprint", asset_id: target });
    if (dup) return dup;
    const lead = createLead({
      campaign_id: campaignId,
      asset_id: target,
      source: "recon-fixture",
      category: "fingerprint",
      title,
      summary: `Local fixture recon produced metadata for ${target}.`,
      confidence: 70,
      assigned_agent_id: "agent.recon-ranker",
      score_components: {
        asset_criticality: 3,
        evidence_strength: result.evidence_refs.length * 2,
        confidence: 7,
        novelty: 5,
        memory_signal: 0,
        policy_risk_penalty: 0,
        duplication_penalty: 0,
      },
    });
    this.db.upsertLead(lead);
    this.audit({
      event_type: "SECURITY_LEAD_CREATED",
      actor_id: "agent.recon-agent",
      actor_role: "security_operator",
      campaign_id: campaignId,
      metadata: { lead_id: lead.id, target },
    });
    return lead;
  }

  // --- Approvals ---
  public requestApproval(input: {
    campaign_id: string;
    capability_id: string;
    target: string;
    requested_by: string;
    requested_agent_id?: string;
    expected_effect: string;
    policy_rule: string;
    task_id?: string;
  }): SecurityApproval {
    const capability = this.db.getCapability(input.capability_id);
    const profile = this.db.getPolicyProfile(this.requireCampaign(input.campaign_id).policy_profile_id);
    const approval = createApprovalRequest({
      ...input,
      risk_tier: capability?.risk_tier ?? "R2",
      ttlMinutes: profile?.approval_ttl_minutes,
    });
    this.db.upsertApproval(approval);
    const campaign = this.requireCampaign(input.campaign_id);
    if (campaign.status !== "WAITING_APPROVAL" && canTransitionCampaign(campaign.status, "WAITING_APPROVAL")) {
      this.setCampaignStatus(input.campaign_id, "WAITING_APPROVAL", input.requested_by);
    }
    this.audit({
      event_type: "SECURITY_APPROVAL_REQUESTED",
      actor_id: input.requested_by,
      actor_role: "security_operator",
      campaign_id: input.campaign_id,
      approval_id: approval.id,
      target: input.target,
    });
    this.hooks.emit({ name: "onApprovalRequested", campaign_id: input.campaign_id, reason_code: input.policy_rule });
    return approval;
  }

  public decideApprovalRequest(approvalId: string, decision: ApprovalDecisionKind, reviewer: string, reason: string): SecurityApproval {
    const current = this.db.getApproval(approvalId);
    if (!current) throw new Error(`Approval not found: ${approvalId}`);
    const campaign = this.requireCampaign(current.campaign_id);
    const profile = this.db.getPolicyProfile(campaign.policy_profile_id);
    if (!profile) throw new Error("Policy profile missing.");
    const decided = decideApproval(current, decision, reviewer, reason, profile);
    this.db.upsertApproval(decided.record);
    if (decided.error) throw new Error(decided.error);
    this.audit({
      event_type: decided.record.status === "GRANTED" ? "SECURITY_APPROVAL_GRANTED" : "SECURITY_APPROVAL_DENIED",
      actor_id: reviewer,
      actor_role: "security_reviewer",
      campaign_id: current.campaign_id,
      approval_id: approvalId,
      target: current.target,
      metadata: { decision, reason },
    });
    if (decision === "CANCEL_CAMPAIGN") {
      this.cancelCampaign(current.campaign_id, reviewer);
    } else if (decided.record.status === "GRANTED" && campaign.status === "WAITING_APPROVAL") {
      this.setCampaignStatus(current.campaign_id, "VALIDATION", reviewer);
    }
    return decided.record;
  }

  // --- Findings ---
  public promoteLeadToFinding(leadId: string, actor: string): SecurityFinding {
    const lead = this.db.getLead(leadId);
    if (!lead) throw new Error(`Lead not found: ${leadId}`);
    const existing = this.db.listFindings(lead.campaign_id);
    const dup = isDuplicateFinding(existing, { title: lead.title, category: lead.category, asset_id: lead.asset_id });
    if (dup) {
      if (lead.status !== "PROMOTED_TO_FINDING") {
        this.db.upsertLead({ ...lead, status: "DUPLICATE", updated_at: nowIso(), last_touched_at: nowIso() });
      }
      return dup;
    }
    const campaign = this.requireCampaign(lead.campaign_id);
    this.advanceCampaign(lead.campaign_id, "TRIAGE", actor);
    this.advanceCampaign(lead.campaign_id, "VALIDATION", actor);
    const finding = createFinding({
      campaign_id: lead.campaign_id,
      asset_id: lead.asset_id,
      lead_id: lead.id,
      title: lead.title,
      category: lead.category,
      severity: "low",
      confidence: lead.confidence,
      impact_summary: "Pending seven-question validation.",
      technical_summary: lead.summary,
      scope_snapshot_id: campaign.snapshot_id,
      created_by_agent_id: actor,
    });
    this.db.upsertFinding(finding);
    this.db.upsertLead({ ...lead, status: "PROMOTED_TO_FINDING", updated_at: nowIso(), last_touched_at: nowIso() });
    this.audit({
      event_type: "SECURITY_FINDING_CREATED",
      actor_id: actor,
      actor_role: "security_operator",
      campaign_id: lead.campaign_id,
      metadata: { finding_id: finding.id, lead_id: lead.id },
    });
    return finding;
  }

  public validateFinding(findingId: string, answers: SevenQuestionAnswers, validator: string, notes: string): SecurityFinding {
    const finding = this.db.getFinding(findingId);
    if (!finding) throw new Error(`Finding not found: ${findingId}`);
    const duplicate = Boolean(isDuplicateFinding(this.db.listFindings(finding.campaign_id).filter(f => f.id !== finding.id), finding));
    const applied = applyValidation(finding, answers, validator, notes, duplicate);
    this.db.insertValidation(applied.validation);
    this.db.upsertFinding(applied.finding);
    this.audit({
      event_type: applied.finding.status === "VALIDATED" ? "SECURITY_FINDING_VALIDATED" : "SECURITY_FINDING_REJECTED",
      actor_id: validator,
      actor_role: "security_reviewer",
      campaign_id: finding.campaign_id,
      metadata: { finding_id: finding.id, disposition: applied.validation.disposition },
    });
    if (applied.finding.status === "VALIDATED") {
      this.advanceCampaign(finding.campaign_id, "HUMAN_REVIEW", validator);
    }
    return applied.finding;
  }

  public exportReport(campaignId: string, actor: string, findingIds?: string[]): ReportExport {
    const findings = (findingIds
      ? findingIds.map(id => this.db.getFinding(id)).filter((f): f is SecurityFinding => Boolean(f))
      : this.db.listFindings(campaignId)
    ).filter(canExportFinding);
    if (findings.length === 0) {
      throw new Error("No validated findings available for export. Failed validation blocks report export.");
    }
    const campaign = this.requireCampaign(campaignId);
    const lines = [
      `# Security campaign report`,
      ``,
      `- Campaign: ${campaign.name} (\`${campaign.id}\`)`,
      `- Authorization: \`${campaign.authorization_id}\``,
      `- Scope snapshot: \`${campaign.snapshot_id ?? "none"}\``,
      `- Exported: ${nowIso()}`,
      `- Exported by: ${actor}`,
      ``,
      `## Validated findings`,
      ``,
    ];
    for (const finding of findings) {
      lines.push(`### ${finding.title}`);
      lines.push(`- Severity: ${finding.severity}`);
      lines.push(`- Category: ${finding.category}`);
      lines.push(`- Confidence: ${finding.confidence}`);
      lines.push(`- Impact: ${finding.impact_summary}`);
      lines.push(`- Technical: ${finding.technical_summary}`);
      lines.push("");
    }
    const markdown = lines.join("\n");
    const report: ReportExport = {
      campaign_id: campaignId,
      finding_ids: findings.map(f => f.id),
      markdown,
      sha256: sha256(markdown),
      exported_at: nowIso(),
      exported_by: actor,
    };
    this.advanceCampaign(campaignId, "REPORT_READY", actor);
    this.audit({
      event_type: "SECURITY_REPORT_EXPORTED",
      actor_id: actor,
      actor_role: "security_reviewer",
      campaign_id: campaignId,
      metadata: { sha256: report.sha256, finding_ids: report.finding_ids },
    });
    const evidence = ingestEvidence({
      campaign_id: campaignId,
      type: "human_note",
      body: markdown,
      mime_type: "text/markdown",
      captured_by: actor,
    });
    this.db.insertEvidence(evidence);
    return report;
  }

  public closeCampaign(campaignId: string, actor: string): SecurityCampaign {
    return this.setCampaignStatus(campaignId, "CLOSED", actor);
  }

  // --- Packages / MCP ---
  public importPackage(sourcePath: string, actor: string): SecurityImportedPackage {
    const imported = importSecurityPackage(sourcePath, actor);
    this.db.insertPackage(imported);
    this.audit({
      event_type: imported.compatibility === "QUARANTINED" ? "SECURITY_PACKAGE_QUARANTINED" : "SECURITY_PACKAGE_IMPORTED",
      actor_id: actor,
      actor_role: "security_admin",
      metadata: { package_id: imported.id, compatibility: imported.compatibility },
    });
    return imported;
  }

  public activatePackage(packageId: string, actor: string): SecurityImportedPackage {
    const pkg = this.db.getPackage(packageId);
    if (!pkg) throw new Error(`Package not found: ${packageId}`);
    if (pkg.compatibility === "QUARANTINED" || pkg.compatibility === "REJECTED") {
      throw new Error("Quarantined or rejected packages cannot be activated.");
    }
    if (pkg.restricted_items.length > 0) {
      throw new Error("Package still contains restricted items.");
    }
    const next = { ...pkg, compatibility: "ACTIVE" as const, activated_at: nowIso() };
    this.db.insertPackage(next);
    this.audit({ event_type: "SECURITY_PACKAGE_IMPORTED", actor_id: actor, actor_role: "security_admin", metadata: { package_id: packageId, compatibility: "ACTIVE" } });
    return next;
  }

  public quarantinePackage(packageId: string, actor: string): SecurityImportedPackage {
    const pkg = this.db.getPackage(packageId);
    if (!pkg) throw new Error(`Package not found: ${packageId}`);
    const next = { ...pkg, compatibility: "QUARANTINED" as const };
    this.db.insertPackage(next);
    this.audit({ event_type: "SECURITY_PACKAGE_QUARANTINED", actor_id: actor, actor_role: "security_admin", metadata: { package_id: packageId } });
    return next;
  }

  public testMcp(id: string): SecurityMcpServer {
    const server = this.db.getMcp(id);
    if (!server) throw new Error(`MCP server not found: ${id}`);
    if (server.kill_switch) {
      const disabled = { ...server, health_state: "DISABLED" as const };
      this.db.upsertMcp(disabled);
      return disabled;
    }
    if (server.credential_ref && !server.credential_ref.startsWith("secret://")) {
      throw new Error("MCP credential_ref must point at Secret Broker (secret://...).");
    }
    const next = { ...server, health_state: "HEALTHY" as const, last_verified_at: nowIso() };
    this.db.upsertMcp(next);
    return next;
  }

  public evaluate(input: {
    campaign_id?: string;
    capability_id: string;
    target: string;
    actor_id?: string;
    agent_id?: string;
    scope_token?: string;
    approval_id?: string;
  }): SecurityPolicyDecision {
    if (input.campaign_id) {
      const result = this.invoke({
        campaign_id: input.campaign_id,
        actor_id: input.actor_id ?? "operator",
        actor_role: "security_operator",
        agent_id: input.agent_id ?? "agent.policy-sentinel",
        capability_id: input.capability_id,
        scope_token: input.scope_token,
        target: input.target,
        approval_id: input.approval_id,
        reason: "Policy evaluation (no extra side effects beyond audit/execution record).",
      });
      return {
        id: result.execution_id ?? id("pdc"),
        campaign_id: input.campaign_id,
        capability_id: input.capability_id,
        target: input.target,
        decision: result.decision,
        reason_code: result.reason_code,
        policy_version: result.policy_version,
        risk_tier: "R1",
        created_at: nowIso(),
      };
    }
    const capability = this.db.getCapability(input.capability_id) ?? undefined;
    const profile = this.db.listPolicyProfiles()[0];
    if (!profile) throw new Error("No policy profile.");
    const evaluation = evaluateSecurityPolicy({
      capability,
      authorization: null,
      scopeMatch: "UNKNOWN",
      hasScopeToken: Boolean(input.scope_token),
      hasValidApproval: Boolean(input.approval_id),
      profile,
    });
    return {
      id: id("pdc"),
      capability_id: input.capability_id,
      target: input.target,
      decision: evaluation.decision,
      reason_code: evaluation.reason_code,
      policy_version: evaluation.policy_version,
      risk_tier: evaluation.risk_tier,
      created_at: nowIso(),
    };
  }

  public storeReusableMemory(kind: string, body: string, createdBy: string) {
    return this.memory.storeReusablePattern({ kind, body, createdBy });
  }

  public isApprovalCurrentlyValid(approvalId: string, campaignId: string, capabilityId: string, target?: string): boolean {
    return isApprovalValid(this.db.getApproval(approvalId), { campaign_id: campaignId, capability_id: capabilityId, target });
  }

  public trip(campaignId: string, kind: "scope" | "rate" | "error" | "policy" | "authorization") {
    const breaker = tripBreaker(this.db, campaignId, kind);
    this.hooks.emit({ name: "onBreakerTripped", campaign_id: campaignId, reason_code: kind });
    this.audit({
      event_type: "SECURITY_CIRCUIT_BREAKER_TRIPPED",
      actor_id: "policy-sentinel",
      actor_role: "security_admin",
      campaign_id: campaignId,
      metadata: { kind },
    });
    return breaker;
  }

  public breakerOpen(campaignId: string): boolean {
    return isBreakerOpen(this.db, campaignId);
  }
}

let defaultInstance: SecurityControlService | null = null;

export function getSecurityControlService(): SecurityControlService {
  if (!defaultInstance) {
    const dbPath = process.env.PAO_SECURITY_DB_PATH;
    defaultInstance = new SecurityControlService({ dbPath });
  }
  return defaultInstance;
}

export function resetSecurityControlServiceForTests(): void {
  if (defaultInstance) {
    try { defaultInstance.db.close(); } catch { /* ignore */ }
  }
  defaultInstance = null;
}
