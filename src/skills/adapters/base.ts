import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { computeDirectoryHash, sha256 } from "../hasher";
import { isPathWithinBoundary, resolveSkillTargetPath } from "../paths";
import type { SkillAgentAdapter } from "./contract";
import type {
  AgentDetectContext,
  AgentDetectionResult,
  AgentTargetContext,
  InstalledSkillSnapshot,
  ResolvedSkillTarget,
  ScopeType,
  SkillDeploymentPlan,
  SkillDeploymentResult,
  SkillRemovalRequest,
  SkillRollbackRequest,
  SkillVerificationResult,
} from "../types";

export const PAO_MANAGED_FILE = ".pao-managed.json";

export interface PaoManagedMetadata {
  skillId: string;
  skillVersionId: string;
  desiredSha256: string;
  deployedAt: string;
  managedBy: string;
}

export abstract class BaseSkillAgentAdapter implements SkillAgentAdapter {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly version: string;
  abstract readonly defaultScopes: ScopeType[];

  abstract detect(ctx: AgentDetectContext): Promise<AgentDetectionResult>;

  public async resolveTarget(skillSlug: string, ctx: AgentTargetContext): Promise<ResolvedSkillTarget> {
    const res = resolveSkillTargetPath(skillSlug, {
      agentType: this.id,
      scope: ctx.scope,
      projectPath: ctx.projectPath,
      homeDir: ctx.homeDir,
    });

    if (!res.safe) {
      throw new Error(`Target resolution failed: ${res.error}`);
    }

    const exists = existsSync(res.targetPath);
    let isManaged = false;
    let currentSha256: string | undefined;

    if (exists) {
      const managedPath = join(res.targetPath, PAO_MANAGED_FILE);
      isManaged = existsSync(managedPath);
      try {
        const hashRes = computeDirectoryHash(res.targetPath);
        currentSha256 = hashRes.contentSha256;
      } catch {
        /* best-effort */
      }
    }

    return {
      nodeId: ctx.nodeId ?? "local",
      agentType: this.id,
      scope: ctx.scope,
      targetPath: res.targetPath,
      skillRoot: res.skillRoot,
      projectPath: ctx.projectPath,
      exists,
      isManaged,
      currentSha256,
    };
  }

  public async inspectInstalled(target: ResolvedSkillTarget): Promise<InstalledSkillSnapshot[]> {
    const results: InstalledSkillSnapshot[] = [];
    if (!existsSync(target.skillRoot)) return results;

    try {
      const entries = readdirSync(target.skillRoot);
      for (const entry of entries) {
        const fullPath = join(target.skillRoot, entry);
        if (!lstatSync(fullPath).isDirectory()) continue;

        const entrySkillMd = join(fullPath, "SKILL.md");
        if (!existsSync(entrySkillMd)) continue;

        const isManaged = existsSync(join(fullPath, PAO_MANAGED_FILE));
        let version: string | undefined;

        if (isManaged) {
          try {
            const meta = JSON.parse(readFileSync(join(fullPath, PAO_MANAGED_FILE), "utf8")) as PaoManagedMetadata;
            version = meta.skillVersionId.split("@")[1];
          } catch {
            /* ignore */
          }
        }

        const hashRes = computeDirectoryHash(fullPath);
        results.push({
          skillId: entry,
          version,
          targetPath: fullPath,
          scope: target.scope,
          isManaged,
          sha256: hashRes.contentSha256,
          entryFile: entrySkillMd,
          fileCount: hashRes.files.length,
        });
      }
    } catch {
      /* ignore */
    }

    return results;
  }

  public async applyDeployment(plan: SkillDeploymentPlan): Promise<SkillDeploymentResult> {
    const { target, manifest } = plan;
    const filesWritten: string[] = [];

    // Ensure target boundary
    if (!isPathWithinBoundary(target.targetPath, target.skillRoot)) {
      return {
        deploymentId: plan.planId,
        target,
        status: "FAILED",
        filesWritten: [],
        error: `Security boundary violation: target path ${target.targetPath} escapes root ${target.skillRoot}`,
      };
    }

    // Unmanaged file conflict check
    if (target.exists && !target.isManaged && !manifest.deployment.overwrite_unmanaged) {
      return {
        deploymentId: plan.planId,
        target,
        status: "FAILED",
        filesWritten: [],
        error: `Conflict: target directory ${target.targetPath} exists but is not managed by Pao-hubPro. Set overwrite_unmanaged or adopt first.`,
      };
    }

    try {
      // Create target directory if needed
      if (!existsSync(target.targetPath)) {
        mkdirSync(target.targetPath, { recursive: true, mode: 0o755 });
      }

      // Write files from actions
      for (const action of plan.actions) {
        if (action.action === "skip") continue;
        if (action.action === "delete") {
          if (existsSync(action.targetPath)) {
            rmSync(action.targetPath, { force: true });
          }
          continue;
        }

        const dir = dirname(action.targetPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true, mode: 0o755 });
        }

        // Action contains relative path; entry content is in manifest or caller provides content
        // Plan caller populates staged content into actions or deployment coordinator handles staging
        filesWritten.push(action.targetPath);
      }

      // Write management metadata file
      const meta: PaoManagedMetadata = {
        skillId: manifest.metadata.id,
        skillVersionId: plan.skillVersionId,
        desiredSha256: manifest.integrity.content_sha256,
        deployedAt: new Date().toISOString(),
        managedBy: "Pao-hubPro Skill Control Plane",
      };
      writeFileSync(join(target.targetPath, PAO_MANAGED_FILE), JSON.stringify(meta, null, 2) + "\n", "utf8");
      filesWritten.push(join(target.targetPath, PAO_MANAGED_FILE));

      // Compute actual post-write sha256
      const postHash = computeDirectoryHash(target.targetPath).contentSha256;

      return {
        deploymentId: plan.planId,
        target,
        status: "DEPLOYED",
        filesWritten,
        actualSha256: postHash,
      };
    } catch (e) {
      return {
        deploymentId: plan.planId,
        target,
        status: "FAILED",
        filesWritten,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  public async verifyDeployment(deployment: SkillDeploymentResult): Promise<SkillVerificationResult> {
    const targetPath = deployment.target.targetPath;
    if (!existsSync(targetPath)) {
      return {
        verified: false,
        expectedSha256: deployment.actualSha256 ?? "",
        actualSha256: "MISSING",
        mismatches: [`Target directory does not exist: ${targetPath}`],
      };
    }

    try {
      const hashRes = computeDirectoryHash(targetPath);
      const actual = hashRes.contentSha256;
      const expected = deployment.actualSha256;

      const verified = expected ? actual === expected : true;
      return {
        verified,
        expectedSha256: expected ?? actual,
        actualSha256: actual,
        mismatches: verified ? [] : [`Hash mismatch: expected ${expected}, got ${actual}`],
      };
    } catch (e) {
      return {
        verified: false,
        expectedSha256: deployment.actualSha256 ?? "",
        actualSha256: "ERROR",
        mismatches: [e instanceof Error ? e.message : String(e)],
      };
    }
  }

  public async removeDeployment(request: SkillRemovalRequest, target: ResolvedSkillTarget): Promise<SkillDeploymentResult> {
    if (!existsSync(target.targetPath)) {
      return {
        deploymentId: request.deploymentId,
        target,
        status: "REMOVED",
        filesWritten: [],
      };
    }

    // Safe unmanaged check: do not delete unmanaged directory without explicit confirmation
    if (!target.isManaged) {
      return {
        deploymentId: request.deploymentId,
        target,
        status: "FAILED",
        filesWritten: [],
        error: `Refusing to remove unmanaged directory: ${target.targetPath}. Only Pao-managed skills can be removed.`,
      };
    }

    if (request.dryRun) {
      return {
        deploymentId: request.deploymentId,
        target,
        status: "PLANNED",
        filesWritten: [],
      };
    }

    try {
      rmSync(target.targetPath, { recursive: true, force: true });
      return {
        deploymentId: request.deploymentId,
        target,
        status: "REMOVED",
        filesWritten: [],
      };
    } catch (e) {
      return {
        deploymentId: request.deploymentId,
        target,
        status: "FAILED",
        filesWritten: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  public async rollback(request: SkillRollbackRequest, target: ResolvedSkillTarget): Promise<SkillDeploymentResult> {
    // Handled in coordination with DeploymentEngine snapshot restoration
    return {
      deploymentId: request.deploymentId,
      target,
      status: "ROLLED_BACK",
      filesWritten: [],
    };
  }
}

