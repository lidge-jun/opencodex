import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultAgentRegistry } from "./adapters/registry";
import { createApprovalRequest, decideApproval } from "./approval";
import { CapabilityBridge } from "./bridge";
import { SkillsDatabase } from "./db";
import { DeploymentEngine } from "./deployment";
import { DriftEngine, type DriftCheckResult } from "./drift";
import { computeSkillContentHash, sha256 } from "./hasher";
import { ImportResult, SkillImporter } from "./importer";
import { SkillsShConnector } from "./marketplace";
import { ConstrainedSshTransport } from "./remote";
import { assessSkillRisk } from "./risk";
import { scanSkillPackage } from "./scanner";
import type {
  AgentDetectionResult,
  AgentSkillManifest,
  CapabilityProvenance,
  InstalledSkillSnapshot,
  MarketplaceSkillResult,
  ScopeType,
  SkillApprovalRecord,
  SkillAuditEvent,
  SkillDeploymentPlan,
  SkillDeploymentRecord,
  SkillDeploymentResult,
  SkillDeploymentSnapshot,
  SkillNodeRecord,
  SkillRecord,
  SkillScanFinding,
  SkillSourceRecord,
  SkillUpdateResult,
  SkillVersionRecord,
} from "./types";
import { validateSkillPackage } from "./validator";

export class SkillControlService {
  public readonly db: SkillsDatabase;
  public readonly importer: SkillImporter;
  public readonly deploymentEngine: DeploymentEngine;
  public readonly driftEngine: DriftEngine;
  public readonly marketplaceConnector: SkillsShConnector;
  public readonly capabilityBridge: CapabilityBridge;
  public readonly sshTransport: ConstrainedSshTransport;

  private readonly inMemoryPlans = new Map<
    string,
    { plan: SkillDeploymentPlan; entryContent: string; bundledFiles: Record<string, string | Buffer> }
  >();

  // In-memory file store for draft versions: versionId -> { entryContent, bundledFiles }
  private readonly versionFiles = new Map<
    string,
    { entryContent: string; bundledFiles: Record<string, string | Buffer> }
  >();

  constructor(dbPath?: string, fixtureRoot?: string) {
    this.db = new SkillsDatabase(dbPath);
    this.importer = new SkillImporter();
    this.deploymentEngine = new DeploymentEngine(this.db);
    this.driftEngine = new DriftEngine(this.db);
    this.marketplaceConnector = new SkillsShConnector();
    this.capabilityBridge = new CapabilityBridge(this.importer);
    this.sshTransport = new ConstrainedSshTransport(fixtureRoot);

    this.bootstrapDefaults();
  }

  private bootstrapDefaults(): void {
    // 1. Seed local node
    const localNode = this.db.getNode("local");
    if (!localNode) {
      const now = new Date().toISOString();
      this.db.upsertNode({
        id: "local",
        name: "Local Machine",
        kind: "local",
        environment: "dev",
        status: "ONLINE",
        allowed_roots: [],
        tags: ["local", "workstation"],
        created_at: now,
        updated_at: now,
      });
    }

    // 2. Seed default sources
    const sources = this.db.listSources();
    if (sources.length === 0) {
      const now = new Date().toISOString();
      this.db.upsertSource({
        id: "skills-sh",
        source_type: "SKILLS_SH",
        display_name: "skills.sh Public Registry",
        base_url: "https://skills.sh",
        trust_level: "community",
        enabled: true,
        created_at: now,
        updated_at: now,
      });
      this.db.upsertSource({
        id: "local-workspace",
        source_type: "LOCAL_FOLDER",
        display_name: "Local Project Skills",
        trust_level: "verified",
        enabled: true,
        created_at: now,
        updated_at: now,
      });
    }

    // 3. Seed agent definitions
    for (const adapter of defaultAgentRegistry.list()) {
      this.db.upsertAgent({
        id: adapter.id,
        agent_type: adapter.id,
        display_name: adapter.displayName,
        adapter_version: adapter.version,
        enabled: true,
        capabilities: ["inspect", "deploy", "verify", "remove"],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  }

  // --- Skill Queries ---
  public listSkills(options?: { status?: string; namespace?: string }): SkillRecord[] {
    return this.db.listSkills(options);
  }

  public getSkill(id: string): SkillRecord | null {
    return this.db.getSkill(id);
  }

  public searchSkills(query: string): SkillRecord[] {
    const q = query.toLowerCase().trim();
    return this.db.listSkills().filter(s => {
      return (
        s.display_name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        s.tags.some(t => t.toLowerCase().includes(q))
      );
    });
  }

  public listSkillVersions(skillId: string): SkillVersionRecord[] {
    return this.db.listVersionsForSkill(skillId);
  }

  public getSkillVersion(versionId: string): SkillVersionRecord | null {
    return this.db.getSkillVersion(versionId);
  }

  // --- Version File Store ---
  public registerVersionFiles(
    versionId: string,
    entryContent: string,
    bundledFiles: Record<string, string | Buffer> = {},
  ): void {
    this.versionFiles.set(versionId, { entryContent, bundledFiles });
  }

  public getVersionFiles(versionId: string): {
    entryContent: string;
    bundledFiles: Record<string, string | Buffer>;
  } {
    const stored = this.versionFiles.get(versionId);
    if (stored) return stored;

    // Fallback: If version is in DB, check if local source_path exists
    const v = this.db.getSkillVersion(versionId);
    if (v?.source_path && existsSync(v.source_path)) {
      const entryFile = join(v.source_path, "SKILL.md");
      if (existsSync(entryFile)) {
        return {
          entryContent: readFileSync(entryFile, "utf8"),
          bundledFiles: {},
        };
      }
    }

    return {
      entryContent: `# ${versionId}\n\nNo source content registered.\n`,
      bundledFiles: {},
    };
  }

  // --- Import Pipeline ---
  public async importLocal(
    folderPath: string,
    options: { slug?: string; namespace?: string; actor?: string; publishImmediately?: boolean } = {},
  ): Promise<ImportResult> {
    const res = await this.importer.importLocal(folderPath, options);
    this.db.upsertSkill(res.skill);
    this.db.upsertSkillVersion(res.version);
    this.registerVersionFiles(res.version.id, res.entryContent, res.bundledFiles);

    // Save scan findings
    if (res.version.manifest.risk?.findings) {
      this.db.saveFindings(res.version.id, res.version.manifest.risk.findings);
    }

    this.db.logAudit({
      event_type: "skill.imported",
      actor_type: "user",
      actor_id: options.actor ?? "system",
      skill_id: res.skill.id,
      skill_version_id: res.version.id,
      metadata: { source: "local", folderPath, hash: res.version.content_sha256 },
    });

    return res;
  }

  public async importFromMarketplace(
    refId: string,
    options: { actor?: string; publishImmediately?: boolean } = {},
  ): Promise<ImportResult> {
    const snapshot = await this.marketplaceConnector.fetch({ id: refId });
    const res = await this.importer.importRaw(
      snapshot.manifest.metadata.name,
      snapshot.entryContent,
      snapshot.bundledFiles,
      "SKILLS_SH",
      options,
    );

    this.db.upsertSkill(res.skill);
    this.db.upsertSkillVersion(res.version);
    this.registerVersionFiles(res.version.id, res.entryContent, res.bundledFiles);

    if (res.version.manifest.risk?.findings) {
      this.db.saveFindings(res.version.id, res.version.manifest.risk.findings);
    }

    this.db.logAudit({
      event_type: "skill.imported",
      actor_type: "user",
      actor_id: options.actor ?? "system",
      skill_id: res.skill.id,
      skill_version_id: res.version.id,
      metadata: { source: "marketplace", refId, hash: res.version.content_sha256 },
    });

    return res;
  }

  public async importGenerated(
    capabilityId: string,
    capabilityVersion: string,
    artifactPath: string,
    provenance: CapabilityProvenance,
    options: { actor?: string; publishImmediately?: boolean } = {},
  ): Promise<ImportResult> {
    const res = await this.capabilityBridge.publishGeneratedSkill({
      capabilityId,
      capabilityVersion,
      artifactPath,
      provenance,
    });

    this.db.upsertSkill(res.skill);
    this.db.upsertSkillVersion(res.version);
    this.registerVersionFiles(res.version.id, res.entryContent, res.bundledFiles);

    if (res.version.manifest.risk?.findings) {
      this.db.saveFindings(res.version.id, res.version.manifest.risk.findings);
    }

    this.db.logAudit({
      event_type: "skill.imported",
      actor_type: "system",
      actor_id: options.actor ?? "capability-factory",
      skill_id: res.skill.id,
      skill_version_id: res.version.id,
      metadata: { source: "generated", capabilityId, capabilityVersion, hash: res.version.content_sha256 },
    });

    return res;
  }

  // --- Scan & Risk ---
  public scanSkill(versionId: string): { findings: SkillScanFinding[]; score: number; level: string } {
    const version = this.db.getSkillVersion(versionId);
    if (!version) throw new Error(`Version not found: ${versionId}`);

    const files = this.getVersionFiles(versionId);
    const scan = scanSkillPackage(files.entryContent, files.bundledFiles);
    const risk = assessSkillRisk(scan.findings);

    this.db.saveFindings(versionId, scan.findings);
    version.risk_score = risk.score;
    version.risk_level = risk.level;
    version.scan_status = "scanned";
    version.scanner_version = scan.scannerVersion;
    this.db.upsertSkillVersion(version);

    // Also update parent skill risk
    const skill = this.db.getSkill(version.skill_id);
    if (skill) {
      skill.risk_level = risk.level;
      this.db.upsertSkill(skill);
    }

    this.db.logAudit({
      event_type: "skill.scanned",
      actor_type: "system",
      skill_id: version.skill_id,
      skill_version_id: versionId,
      metadata: { findingCount: scan.findings.length, riskScore: risk.score, riskLevel: risk.level },
    });

    return {
      findings: scan.findings,
      score: risk.score,
      level: risk.level,
    };
  }

  public getFindings(versionId: string): SkillScanFinding[] {
    return this.db.getFindings(versionId);
  }

  // --- Review & Approval ---
  public requestReview(
    versionId: string,
    requestedBy: string,
    action: "deploy" | "publish" | "sync" = "deploy",
  ): SkillApprovalRecord {
    const version = this.db.getSkillVersion(versionId);
    if (!version) throw new Error(`Version not found: ${versionId}`);

    const appRecord = createApprovalRequest({
      skillVersionId: versionId,
      contentSha256: version.content_sha256,
      requestedAction: action,
      requestedBy,
    });

    this.db.insertReview(appRecord);
    this.db.logAudit({
      event_type: "skill.review.requested",
      actor_type: "user",
      actor_id: requestedBy,
      skill_id: version.skill_id,
      skill_version_id: versionId,
      metadata: { approvalId: appRecord.id, requestedAction: action },
    });

    return appRecord;
  }

  public submitReviewDecision(
    approvalId: string,
    decision: "APPROVED" | "REJECTED",
    reviewer: string,
    reason: string,
    constraints?: Record<string, unknown>,
  ): SkillApprovalRecord {
    const review = this.db.getReview(approvalId);
    if (!review) throw new Error(`Review record not found: ${approvalId}`);

    const res = decideApproval(review, decision, reviewer, reason, constraints);
    if (res.error) {
      throw new Error(res.error);
    }

    this.db.insertReview(res.record);

    // Update version approval_status
    const version = this.db.getSkillVersion(review.skill_version_id);
    if (version) {
      version.approval_status = decision;
      this.db.upsertSkillVersion(version);
    }

    this.db.logAudit({
      event_type: decision === "APPROVED" ? "skill.review.approved" : "skill.review.rejected",
      actor_type: "user",
      actor_id: reviewer,
      skill_version_id: review.skill_version_id,
      metadata: { approvalId, decision, reason, constraints },
    });

    return res.record;
  }

  // --- Lifecycle Transitions (Publish, Quarantine, Revoke) ---
  public publishVersion(versionId: string, actor = "system"): SkillVersionRecord {
    const version = this.db.getSkillVersion(versionId);
    if (!version) throw new Error(`Version not found: ${versionId}`);

    const skill = this.db.getSkill(version.skill_id);
    if (!skill) throw new Error(`Skill not found: ${version.skill_id}`);
    if (version.immutable) {
      throw new Error(`Version already published and immutable: ${versionId}`);
    }

    const now = new Date().toISOString();
    version.immutable = true;
    version.published_at = now;
    version.published_by = actor;
    this.db.upsertSkillVersion(version);

    skill.status = "PUBLISHED";
    skill.current_version = version.version;
    skill.updated_at = now;
    this.db.upsertSkill(skill);

    this.db.logAudit({
      event_type: "skill.published",
      actor_type: "user",
      actor_id: actor,
      skill_id: skill.id,
      skill_version_id: versionId,
    });

    return version;
  }

  public quarantineSkill(skillId: string, reason: string, actor = "system"): SkillRecord {
    const skill = this.db.getSkill(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);

    skill.status = "QUARANTINED";
    skill.updated_at = new Date().toISOString();
    this.db.upsertSkill(skill);

    this.db.logAudit({
      event_type: "skill.quarantined",
      actor_type: "user",
      actor_id: actor,
      skill_id: skillId,
      metadata: { reason },
    });

    return skill;
  }

  public revokeSkill(skillId: string, reason: string, actor = "system"): SkillRecord {
    const skill = this.db.getSkill(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);

    skill.status = "REVOKED";
    skill.updated_at = new Date().toISOString();
    this.db.upsertSkill(skill);

    this.db.logAudit({
      event_type: "skill.revoked",
      actor_type: "user",
      actor_id: actor,
      skill_id: skillId,
      metadata: { reason },
    });

    return skill;
  }

  // --- Deployment & Planning ---
  public async planDeployment(
    versionId: string,
    target: { agentType: string; scope: ScopeType; projectPath?: string; nodeId?: string },
    options: { forceOverwriteUnmanaged?: boolean } = {},
  ): Promise<SkillDeploymentPlan> {
    const version = this.db.getSkillVersion(versionId);
    if (!version) throw new Error(`Version not found: ${versionId}`);

    const skill = this.db.getSkill(version.skill_id);
    if (skill?.status === "REVOKED") {
      throw new Error(`Security policy error: Cannot deploy revoked skill ${skill.id}`);
    }

    const files = this.getVersionFiles(versionId);
    const plan = await this.deploymentEngine.planDeployment(
      version,
      {
        nodeId: target.nodeId ?? "local",
        agentType: target.agentType,
        scope: target.scope,
        projectPath: target.projectPath,
      },
      files.entryContent,
      files.bundledFiles,
      options,
    );

    this.inMemoryPlans.set(plan.planId, {
      plan,
      entryContent: files.entryContent,
      bundledFiles: files.bundledFiles,
    });

    this.db.logAudit({
      event_type: "skill.deployment.planned",
      actor_type: "user",
      skill_id: version.skill_id,
      skill_version_id: versionId,
      node_id: target.nodeId ?? "local",
      metadata: { planId: plan.planId, agentType: target.agentType, scope: target.scope },
    });

    return plan;
  }

  public async applyDeploymentPlan(planId: string, actor = "system"): Promise<SkillDeploymentResult> {
    const cached = this.inMemoryPlans.get(planId);
    if (!cached) {
      throw new Error(`Deployment plan expired or not found: ${planId}`);
    }

    const result = await this.deploymentEngine.executeDeployment(
      cached.plan,
      cached.entryContent,
      cached.bundledFiles,
      actor,
    );

    return result;
  }

  public async deployDirect(
    versionId: string,
    target: { agentType: string; scope: ScopeType; projectPath?: string; nodeId?: string },
    options: { forceOverwriteUnmanaged?: boolean; actor?: string } = {},
  ): Promise<SkillDeploymentResult> {
    const plan = await this.planDeployment(versionId, target, options);
    return await this.applyDeploymentPlan(plan.planId, options.actor ?? "system");
  }

  public async removeDeployment(deploymentId: string, actor = "system"): Promise<SkillDeploymentResult> {
    return await this.deploymentEngine.removeDeployment({ deploymentId, actor });
  }

  public async rollbackDeployment(deploymentId: string, actor = "system"): Promise<SkillDeploymentResult> {
    return await this.deploymentEngine.rollback({ deploymentId, actor });
  }

  public listDeployments(filter?: { skillVersionId?: string; agentId?: string; nodeId?: string }): SkillDeploymentRecord[] {
    return this.db.listDeployments(filter);
  }

  // --- Drift ---
  public async checkDeploymentDrift(deploymentId: string): Promise<DriftCheckResult> {
    return await this.driftEngine.checkDeploymentDrift(deploymentId);
  }

  public async checkAllDrift(): Promise<DriftCheckResult[]> {
    return await this.driftEngine.checkAll();
  }

  public async restoreDriftedDeployment(deploymentId: string, actor = "system"): Promise<SkillDeploymentResult> {
    const dep = this.db.getDeployment(deploymentId);
    if (!dep) throw new Error(`Deployment not found: ${deploymentId}`);

    const version = this.db.getSkillVersion(dep.skill_version_id);
    if (!version) throw new Error(`Skill version not found: ${dep.skill_version_id}`);

    const files = this.getVersionFiles(version.id);
    const plan = await this.deploymentEngine.planDeployment(
      version,
      {
        nodeId: dep.node_id,
        agentType: dep.agent_id,
        scope: dep.scope,
        projectPath: dep.project_ref,
      },
      files.entryContent,
      files.bundledFiles,
      { forceOverwriteUnmanaged: true },
    );

    const result = await this.deploymentEngine.executeDeployment(plan, files.entryContent, files.bundledFiles, actor);
    return result;
  }

  public async adoptDriftedDraft(deploymentId: string, newVersion: string, actor = "system"): Promise<SkillVersionRecord> {
    return await this.driftEngine.adoptAsNewDraft(deploymentId, newVersion, actor);
  }

  // --- Cross-Agent Sync ---
  public async syncSkill(
    skillId: string,
    fromAgent: string,
    toAgents: string[],
    scope: ScopeType = "user",
    actor = "system",
  ): Promise<SkillDeploymentResult[]> {
    const skill = this.db.getSkill(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);

    const version = this.db.getSkillVersion(`${skillId}@${skill.current_version}`);
    if (!version) throw new Error(`Skill version not found: ${skill.current_version}`);

    const results: SkillDeploymentResult[] = [];
    for (const agentType of toAgents) {
      if (agentType === fromAgent) continue;
      const res = await this.deployDirect(version.id, { agentType, scope }, { actor });
      results.push(res);
    }

    this.db.logAudit({
      event_type: "skill.synced",
      actor_type: "user",
      actor_id: actor,
      skill_id: skillId,
      metadata: { fromAgent, toAgents, scope },
    });

    return results;
  }

  // --- Agents & Installed ---
  public async listInstalledSkills(agentType = "codex", scope: ScopeType = "user"): Promise<InstalledSkillSnapshot[]> {
    const adapter = defaultAgentRegistry.get(agentType);
    if (!adapter) return [];

    const resolved = await adapter.resolveTarget("dummy", { scope });
    return await adapter.inspectInstalled(resolved);
  }

  public async detectAgents(): Promise<AgentDetectionResult[]> {
    return await defaultAgentRegistry.detectAll({ cwd: process.cwd() });
  }

  // --- Remote Nodes ---
  public listNodes(): SkillNodeRecord[] {
    return this.db.listNodes();
  }

  public getNode(id: string): SkillNodeRecord | null {
    return this.db.getNode(id);
  }

  public upsertNode(node: SkillNodeRecord): void {
    this.db.upsertNode(node);
  }

  public deleteNode(id: string): boolean {
    return this.db.deleteNode(id);
  }

  public async testNodeConnection(nodeId: string): Promise<{ connected: boolean; error?: string }> {
    const node = this.db.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    return await this.sshTransport.testConnection(node);
  }

  // --- Marketplace & Updates ---
  public async searchMarketplace(query: string): Promise<MarketplaceSkillResult[]> {
    return await this.marketplaceConnector.search({ query });
  }

  public async checkSkillUpdates(skillId: string): Promise<SkillUpdateResult[]> {
    const skill = this.db.getSkill(skillId);
    if (!skill) return [];
    return await this.marketplaceConnector.checkUpdates([{ id: skill.slug, version: skill.current_version }]);
  }

  // --- Audit ---
  public listAuditEvents(limit = 100): SkillAuditEvent[] {
    return this.db.listAuditEvents(limit);
  }
}

let defaultServiceInstance: SkillControlService | null = null;
export function getSkillControlService(): SkillControlService {
  if (!defaultServiceInstance) {
    defaultServiceInstance = new SkillControlService();
  }
  return defaultServiceInstance;
}

