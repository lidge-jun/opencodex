import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultAgentRegistry } from "./adapters/registry";
import { PAO_MANAGED_FILE } from "./adapters/base";
import type { SkillsDatabase } from "./db";
import { computeDirectoryHash, sha256 } from "./hasher";
import { evaluateSkillPolicy } from "./policy";
import { isApprovalValidForVersion } from "./approval";
import type {
  PlannedFileAction,
  ResolvedSkillTarget,
  SkillDeploymentPlan,
  SkillDeploymentRecord,
  SkillDeploymentRequest,
  SkillDeploymentResult,
  SkillDeploymentSnapshot,
  SkillRemovalRequest,
  SkillRollbackRequest,
  SkillVerificationResult,
  SkillVersionRecord,
} from "./types";

export class DeploymentEngine {
  constructor(private readonly db: SkillsDatabase) {}

  /**
   * Plan a deployment (dry-run). Never mutates filesystem.
   */
  public async planDeployment(
    version: SkillVersionRecord,
    targetReq: SkillDeploymentRequest["targets"][0],
    entryContent: string,
    bundledFiles: Record<string, string | Buffer> = {},
    options: { forceOverwriteUnmanaged?: boolean } = {},
  ): Promise<SkillDeploymentPlan> {
    const adapter = defaultAgentRegistry.get(targetReq.agentType);
    if (!adapter) {
      throw new Error(`Unsupported agent type: ${targetReq.agentType}`);
    }

    const resolvedTarget = await adapter.resolveTarget(version.manifest.metadata.slug, {
      scope: targetReq.scope,
      projectPath: targetReq.projectPath,
      nodeId: targetReq.nodeId,
    });

    const conflicts: string[] = [];
    if (resolvedTarget.exists && !resolvedTarget.isManaged && !options.forceOverwriteUnmanaged) {
      conflicts.push(
        `Target directory ${resolvedTarget.targetPath} exists but is not managed by Pao-hubPro. Set overwrite_unmanaged to adopt or replace.`,
      );
    }

    // Planned file actions
    const actions: PlannedFileAction[] = [];
    const desiredFiles: Record<string, string | Buffer> = {
      "SKILL.md": entryContent,
      ...bundledFiles,
    };

    for (const [relPath, content] of Object.entries(desiredFiles)) {
      const fileTargetPath = join(resolvedTarget.targetPath, relPath);
      const fileExpectedSha = sha256(content);
      let actionType: PlannedFileAction["action"] = "create";
      let currentSha: string | undefined;

      if (existsSync(fileTargetPath)) {
        currentSha = sha256(readFileSync(fileTargetPath));
        actionType = currentSha === fileExpectedSha ? "skip" : "replace";
      }

      actions.push({
        action: actionType,
        relativePath: relPath,
        targetPath: fileTargetPath,
        expectedSha256: fileExpectedSha,
        currentSha256: currentSha,
      });
    }

    // Policy check
    const riskAssessment = {
      score: version.risk_score ?? 0,
      level: version.risk_level ?? "low",
      inferred_capabilities: version.manifest.risk?.inferred_capabilities ?? [],
      findings: version.manifest.risk?.findings ?? [],
      hard_escalations: [],
    };

    const latestApproval = this.db.getLatestApprovalForVersion(version.id);
    const hasApproval = isApprovalValidForVersion(latestApproval, version);

    const policyDecision = evaluateSkillPolicy(riskAssessment, {
      environment: "dev",
      targetAgents: [targetReq.agentType],
      targetNodes: [targetReq.nodeId],
      hasApproval,
    });

    const requiresApproval = policyDecision.effect === "require_approval" && !hasApproval;
    const canApply = policyDecision.effect !== "deny" && !requiresApproval && conflicts.length === 0;

    return {
      planId: `plan_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      skillVersionId: version.id,
      manifest: version.manifest,
      target: resolvedTarget,
      actions,
      conflicts,
      requiresApproval,
      policyDecision,
      backupRequired: resolvedTarget.exists,
      canApply,
    };
  }

  /**
   * Execute deployment transactionally with staging, atomic replacement, and verification.
   */
  public async executeDeployment(
    plan: SkillDeploymentPlan,
    entryContent: string,
    bundledFiles: Record<string, string | Buffer> = {},
    actor = "system",
  ): Promise<SkillDeploymentResult> {
    if (!plan.canApply && plan.conflicts.length > 0) {
      throw new Error(`Cannot execute deployment plan due to conflicts: ${plan.conflicts.join("; ")}`);
    }

    if (plan.requiresApproval) {
      throw new Error(`Deployment blocked: Explicit operator approval required by safety policy.`);
    }

    const { target, manifest } = plan;
    const adapter = defaultAgentRegistry.get(target.agentType);
    if (!adapter) {
      throw new Error(`Adapter not found: ${target.agentType}`);
    }

    const deploymentId = `dep_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    let snapshotId: string | undefined;

    // Step 1: Backup current state if target already exists
    if (target.exists) {
      snapshotId = `snap_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const fileIndex: Record<string, { sha256: string; size: number }> = {};
      const backupDir = join(target.skillRoot, ".pao-backups", snapshotId);
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });

      // Copy existing files to backup
      try {
        const hashRes = computeDirectoryHash(target.targetPath);
        for (const f of hashRes.files) {
          const src = join(target.targetPath, f);
          const dest = join(backupDir, f);
          mkdirSync(dirname(dest), { recursive: true });
          const content = readFileSync(src);
          writeFileSync(dest, content);
          fileIndex[f] = { sha256: hashRes.filesSha256[f] ?? sha256(content), size: content.length };
        }

        const snapshot: SkillDeploymentSnapshot = {
          id: snapshotId,
          deployment_id: deploymentId,
          reason: "pre-deployment-backup",
          file_index: fileIndex,
          storage_ref: backupDir,
          created_by: actor,
          created_at: new Date().toISOString(),
        };
        this.db.insertSnapshot(snapshot);
      } catch (e) {
        throw new Error(`Failed to create pre-deployment recovery snapshot: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Step 2: Staging directory
    const stageDir = join(target.skillRoot, ".pao-staging", randomUUID());
    mkdirSync(stageDir, { recursive: true, mode: 0o755 });

    try {
      // Write entry SKILL.md
      writeFileSync(join(stageDir, "SKILL.md"), entryContent, "utf8");

      // Write bundled files
      for (const [relPath, content] of Object.entries(bundledFiles)) {
        if (relPath === "SKILL.md") continue;
        const filePath = join(stageDir, relPath);
        mkdirSync(dirname(filePath), { recursive: true });
        if (typeof content === "string") {
          writeFileSync(filePath, content, "utf8");
        } else {
          writeFileSync(filePath, content);
        }
      }

      // Write .pao-managed.json metadata
      const meta = {
        skillId: manifest.metadata.id,
        skillVersionId: plan.skillVersionId,
        desiredSha256: manifest.integrity.content_sha256,
        deployedAt: new Date().toISOString(),
        managedBy: "Pao-hubPro Skill Control Plane",
      };
      writeFileSync(join(stageDir, PAO_MANAGED_FILE), JSON.stringify(meta, null, 2) + "\n", "utf8");

      // Step 3: Validate staged content
      const stagedHash = computeDirectoryHash(stageDir);
      // Expected post-write files: target directory will have the staged files
      if (!existsSync(target.targetPath)) {
        mkdirSync(target.targetPath, { recursive: true, mode: 0o755 });
      }

      // Clean up files in targetPath omitted from the new staged set
      if (existsSync(target.targetPath)) {
        const existingTarget = computeDirectoryHash(target.targetPath);
        for (const ef of existingTarget.files) {
          if (!stagedHash.files.includes(ef) && !ef.startsWith(".pao-")) {
            const obsolete = join(target.targetPath, ef);
            if (existsSync(obsolete)) rmSync(obsolete, { force: true });
          }
        }
      }

      // Step 4: Atomic copy / replace files into targetPath
      for (const f of stagedHash.files) {
        const src = join(stageDir, f);
        const dest = join(target.targetPath, f);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(src));
      }

      // Also copy .pao-managed.json receipt
      const receiptSrc = join(stageDir, PAO_MANAGED_FILE);
      if (existsSync(receiptSrc)) {
        writeFileSync(join(target.targetPath, PAO_MANAGED_FILE), readFileSync(receiptSrc));
      }

      // Clean up staging
      rmSync(stageDir, { recursive: true, force: true });

      // Step 5: Post-write verification
      const verifyRes = await adapter.verifyDeployment({
        deploymentId,
        target,
        status: "DEPLOYED",
        filesWritten: stagedHash.files,
        actualSha256: manifest.integrity.content_sha256,
      });

      if (!verifyRes.verified) {
        // Verification failed! Fail closed & Rollback
        if (snapshotId) {
          await this.rollback({ deploymentId, snapshotId });
        } else {
          rmSync(target.targetPath, { recursive: true, force: true });
        }

        const failureRecord: SkillDeploymentRecord = {
          id: deploymentId,
          skill_version_id: plan.skillVersionId,
          node_id: target.nodeId,
          agent_id: target.agentType,
          scope: target.scope,
          project_ref: target.projectPath,
          target_path: target.targetPath,
          deployment_mode: "managed-copy",
          desired_sha256: manifest.integrity.content_sha256,
          actual_sha256: verifyRes.actualSha256,
          status: "FAILED",
          managed: true,
          deployed_by: actor,
          deployed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        this.db.upsertDeployment(failureRecord);
        this.db.logAudit({
          event_type: "skill.deployment.failed",
          actor_type: "user",
          actor_id: actor,
          skill_id: manifest.metadata.id,
          skill_version_id: plan.skillVersionId,
          deployment_id: deploymentId,
          node_id: target.nodeId,
          metadata: { reason: "post-write verification failed", mismatches: verifyRes.mismatches },
        });

        return {
          deploymentId,
          target,
          status: "FAILED",
          filesWritten: [],
          error: `Integrity verification failed: ${verifyRes.mismatches.join("; ")}`,
        };
      }

      // Step 6: Commit deployment record to database
      const now = new Date().toISOString();
      const deploymentRecord: SkillDeploymentRecord = {
        id: deploymentId,
        skill_version_id: plan.skillVersionId,
        node_id: target.nodeId,
        agent_id: target.agentType,
        scope: target.scope,
        project_ref: target.projectPath,
        target_path: target.targetPath,
        deployment_mode: "managed-copy",
        desired_sha256: manifest.integrity.content_sha256,
        actual_sha256: verifyRes.actualSha256,
        status: "DEPLOYED",
        managed: true,
        deployed_by: actor,
        deployed_at: now,
        verified_at: now,
        updated_at: now,
      };
      this.db.upsertDeployment(deploymentRecord);

      // Audit log
      this.db.logAudit({
        event_type: "skill.deployment.succeeded",
        actor_type: "user",
        actor_id: actor,
        skill_id: manifest.metadata.id,
        skill_version_id: plan.skillVersionId,
        deployment_id: deploymentId,
        node_id: target.nodeId,
        metadata: {
          targetPath: target.targetPath,
          verifiedSha256: verifyRes.actualSha256,
          snapshotId,
        },
      });

      return {
        deploymentId,
        target,
        status: "DEPLOYED",
        filesWritten: stagedHash.files.map(f => join(target.targetPath, f)),
        actualSha256: verifyRes.actualSha256,
        snapshotId,
      };
    } catch (e) {
      // Clean up staging on exception
      try {
        rmSync(stageDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      throw e;
    }
  }

  /**
   * Remove a managed skill deployment.
   */
  public async removeDeployment(request: SkillRemovalRequest): Promise<SkillDeploymentResult> {
    const deployment = this.db.getDeployment(request.deploymentId);
    if (!deployment) {
      throw new Error(`Deployment not found: ${request.deploymentId}`);
    }

    const adapter = defaultAgentRegistry.get(deployment.agent_id);
    if (!adapter) {
      throw new Error(`Adapter not found: ${deployment.agent_id}`);
    }

    const target: ResolvedSkillTarget = {
      nodeId: deployment.node_id,
      agentType: deployment.agent_id,
      scope: deployment.scope,
      targetPath: deployment.target_path,
      skillRoot: dirname(deployment.target_path),
      projectPath: deployment.project_ref,
      exists: existsSync(deployment.target_path),
      isManaged: deployment.managed,
    };

    const res = await adapter.removeDeployment(request, target);
    if (res.status === "REMOVED") {
      this.db.deleteDeployment(request.deploymentId);
      this.db.logAudit({
        event_type: "skill.deployment.removed",
        actor_type: "user",
        actor_id: request.actor ?? "system",
        deployment_id: request.deploymentId,
        node_id: deployment.node_id,
        metadata: { targetPath: deployment.target_path },
      });
    }

    return res;
  }

  /**
   * Rollback a deployment using a stored recovery snapshot.
   */
  public async rollback(request: SkillRollbackRequest): Promise<SkillDeploymentResult> {
    const deployment = this.db.getDeployment(request.deploymentId);
    if (!deployment) {
      throw new Error(`Deployment not found: ${request.deploymentId}`);
    }

    const snapshot = request.snapshotId
      ? this.db.getSnapshot(request.snapshotId)
      : this.db.getLatestSnapshotForDeployment(request.deploymentId);

    if (request.snapshotId && snapshot && snapshot.deployment_id !== request.deploymentId) {
      throw new Error(`Snapshot ${request.snapshotId} does not belong to deployment ${request.deploymentId}`);
    }

    if (!snapshot || !existsSync(snapshot.storage_ref)) {
      throw new Error(`No valid rollback snapshot found for deployment ${request.deploymentId}`);
    }

    const targetPath = deployment.target_path;
    // Restore files from snapshot storage_ref
    if (existsSync(targetPath)) {
      rmSync(targetPath, { recursive: true, force: true });
    }
    mkdirSync(targetPath, { recursive: true, mode: 0o755 });

    for (const [relPath] of Object.entries(snapshot.file_index)) {
      const src = join(snapshot.storage_ref, relPath);
      const dest = join(targetPath, relPath);
      if (existsSync(src)) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(src));
      }
    }

    const hashRes = computeDirectoryHash(targetPath);
    deployment.status = "ROLLED_BACK";
    deployment.actual_sha256 = hashRes.contentSha256;
    deployment.updated_at = new Date().toISOString();
    this.db.upsertDeployment(deployment);

    this.db.logAudit({
      event_type: "skill.deployment.rolled_back",
      actor_type: "user",
      actor_id: request.actor ?? "system",
      deployment_id: request.deploymentId,
      node_id: deployment.node_id,
      metadata: { targetPath, snapshotId: snapshot.id, restoredSha256: hashRes.contentSha256 },
    });

    const target: ResolvedSkillTarget = {
      nodeId: deployment.node_id,
      agentType: deployment.agent_id,
      scope: deployment.scope,
      targetPath: deployment.target_path,
      skillRoot: dirname(deployment.target_path),
      projectPath: deployment.project_ref,
      exists: true,
      isManaged: true,
      currentSha256: hashRes.contentSha256,
    };

    return {
      deploymentId: request.deploymentId,
      target,
      status: "ROLLED_BACK",
      filesWritten: Object.keys(snapshot.file_index).map(f => join(targetPath, f)),
      actualSha256: hashRes.contentSha256,
      snapshotId: snapshot.id,
    };
  }
}

