import type {
  AgentDetectContext,
  AgentDetectionResult,
  AgentTargetContext,
  InstalledSkillSnapshot,
  ResolvedSkillTarget,
  SkillDeploymentPlan,
  SkillDeploymentResult,
  SkillRemovalRequest,
  SkillRollbackRequest,
  SkillVerificationResult,
} from "../types";

export interface SkillAgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;

  /** Detect if the agent is present or configured on the host. */
  detect(ctx: AgentDetectContext): Promise<AgentDetectionResult>;

  /** Resolve target destination and root for a skill given the scope context. */
  resolveTarget(skillSlug: string, ctx: AgentTargetContext): Promise<ResolvedSkillTarget>;

  /** Inspect and snapshot skills installed in the agent's target root. */
  inspectInstalled(target: ResolvedSkillTarget): Promise<InstalledSkillSnapshot[]>;

  /** Apply deployment to the resolved target on disk. */
  applyDeployment(plan: SkillDeploymentPlan): Promise<SkillDeploymentResult>;

  /** Verify that the deployed files match expected hashes. */
  verifyDeployment(deployment: SkillDeploymentResult): Promise<SkillVerificationResult>;

  /** Plan and apply removal of a managed skill deployment. */
  removeDeployment(request: SkillRemovalRequest, target: ResolvedSkillTarget): Promise<SkillDeploymentResult>;

  /** Rollback deployment to a prior snapshot. */
  rollback(request: SkillRollbackRequest, target: ResolvedSkillTarget): Promise<SkillDeploymentResult>;
}

