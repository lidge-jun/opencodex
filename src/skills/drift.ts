import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PAO_MANAGED_FILE } from "./adapters/base";
import type { SkillsDatabase } from "./db";
import { computeDirectoryHash, sha256 } from "./hasher";
import type {
  DriftType,
  SkillDeploymentRecord,
  SkillDriftEvent,
  SkillRecord,
  SkillVersionRecord,
} from "./types";

export interface DriftCheckResult {
  deploymentId: string;
  skillId: string;
  driftType: DriftType;
  inSync: boolean;
  expectedSha256: string;
  actualSha256?: string;
  missingFiles: string[];
  modifiedFiles: string[];
  extraFiles: string[];
  targetPath: string;
}

export type ConflictResolutionStrategy =
  | "KEEP_LOCAL"
  | "USE_REGISTRY"
  | "USE_UPSTREAM"
  | "CREATE_MERGED_DRAFT"
  | "KEEP_BOTH"
  | "CANCEL";

export class DriftEngine {
  constructor(private readonly db: SkillsDatabase) {}

  /**
   * Check drift for a single deployment.
   */
  public async checkDeploymentDrift(deploymentId: string): Promise<DriftCheckResult> {
    const deployment = this.db.getDeployment(deploymentId);
    if (!deployment) {
      throw new Error(`Deployment not found: ${deploymentId}`);
    }

    const version = this.db.getSkillVersion(deployment.skill_version_id);
    const expectedSha = deployment.desired_sha256;
    const targetPath = deployment.target_path;

    if (!existsSync(targetPath)) {
      const result: DriftCheckResult = {
        deploymentId,
        skillId: version?.skill_id ?? "unknown",
        driftType: "MISSING",
        inSync: false,
        expectedSha256: expectedSha,
        actualSha256: undefined,
        missingFiles: ["SKILL.md"],
        modifiedFiles: [],
        extraFiles: [],
        targetPath,
      };
      this.recordDrift(deploymentId, "MISSING", expectedSha, undefined, { reason: "directory missing" });
      return result;
    }

    const hashRes = computeDirectoryHash(targetPath);
    const actualSha = hashRes.contentSha256;

    const missingFiles: string[] = [];
    const modifiedFiles: string[] = [];
    const extraFiles: string[] = [];

    // Compare individual files if version manifest is available
    if (version?.manifest.integrity.files_sha256) {
      const expectedFiles = version.manifest.integrity.files_sha256;
      for (const [relPath, expSha] of Object.entries(expectedFiles)) {
        if (!hashRes.filesSha256[relPath]) {
          missingFiles.push(relPath);
        } else if (hashRes.filesSha256[relPath] !== expSha) {
          modifiedFiles.push(relPath);
        }
      }

      for (const actualFile of hashRes.files) {
        if (actualFile === PAO_MANAGED_FILE) continue;
        if (!expectedFiles[actualFile]) {
          extraFiles.push(actualFile);
        }
      }
    }

    let driftType: DriftType = "IN_SYNC";
    if (missingFiles.length > 0) {
      driftType = "MISSING";
    } else if (modifiedFiles.length > 0) {
      driftType = "MODIFIED";
    } else if (extraFiles.length > 0) {
      driftType = "EXTRA_FILES";
    } else if (actualSha !== expectedSha) {
      driftType = "MODIFIED";
    }

    const inSync = driftType === "IN_SYNC";
    if (!inSync) {
      this.recordDrift(deploymentId, driftType, expectedSha, actualSha, {
        missingFiles,
        modifiedFiles,
        extraFiles,
      });
    }

    return {
      deploymentId,
      skillId: version?.skill_id ?? "unknown",
      driftType,
      inSync,
      expectedSha256: expectedSha,
      actualSha256: actualSha,
      missingFiles,
      modifiedFiles,
      extraFiles,
      targetPath,
    };
  }

  /**
   * Check all active deployments for drift.
   */
  public async checkAll(): Promise<DriftCheckResult[]> {
    const deployments = this.db.listDeployments();
    const results: DriftCheckResult[] = [];
    for (const dep of deployments) {
      try {
        const res = await this.checkDeploymentDrift(dep.id);
        results.push(res);
      } catch {
        /* best-effort */
      }
    }
    return results;
  }

  private recordDrift(
    deploymentId: string,
    driftType: DriftType,
    expectedSha?: string,
    actualSha?: string,
    details?: Record<string, unknown>,
  ): void {
    const event: SkillDriftEvent = {
      id: `drift_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      deployment_id: deploymentId,
      drift_type: driftType,
      expected_sha256: expectedSha,
      actual_sha256: actualSha,
      details,
      status: "active",
      detected_at: new Date().toISOString(),
    };
    this.db.insertDriftEvent(event);
    this.db.logAudit({
      event_type: "skill.drift.detected",
      actor_type: "system",
      deployment_id: deploymentId,
      metadata: { driftType, expectedSha, actualSha, details },
    });
  }

  /**
   * Adopt drifted local target as a new draft SkillVersion.
   */
  public async adoptAsNewDraft(
    deploymentId: string,
    newVersion: string,
    actor = "system",
  ): Promise<SkillVersionRecord> {
    const deployment = this.db.getDeployment(deploymentId);
    if (!deployment) throw new Error(`Deployment not found: ${deploymentId}`);

    const baseVersion = this.db.getSkillVersion(deployment.skill_version_id);
    if (!baseVersion) throw new Error(`Base version not found for deployment: ${deploymentId}`);

    const targetPath = deployment.target_path;
    const entryPath = join(targetPath, "SKILL.md");
    if (!existsSync(entryPath)) throw new Error(`SKILL.md not found in drifted target: ${targetPath}`);

    const entryContent = readFileSync(entryPath, "utf8");
    const hashRes = computeDirectoryHash(targetPath);

    // Build new manifest
    const newManifest = JSON.parse(JSON.stringify(baseVersion.manifest));
    newManifest.metadata.version = newVersion;
    newManifest.integrity.content_sha256 = hashRes.contentSha256;
    newManifest.integrity.files_sha256 = hashRes.filesSha256;

    const versionId = `${baseVersion.skill_id}@${newVersion}`;
    const now = new Date().toISOString();

    const newVersionRecord: SkillVersionRecord = {
      id: versionId,
      skill_id: baseVersion.skill_id,
      version: newVersion,
      manifest: newManifest,
      content_sha256: hashRes.contentSha256,
      scan_status: "pending",
      immutable: false, // Draft
      created_by: actor,
      created_at: now,
    };

    this.db.upsertSkillVersion(newVersionRecord);
    this.db.logAudit({
      event_type: "skill.drift.adopted",
      actor_type: "user",
      actor_id: actor,
      skill_id: baseVersion.skill_id,
      skill_version_id: versionId,
      deployment_id: deploymentId,
      metadata: { newVersion, contentSha256: hashRes.contentSha256 },
    });

    return newVersionRecord;
  }
}

