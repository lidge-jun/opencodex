import type { SkillControlService } from "./service";
import type {
  DriftType,
  InstalledSkillSnapshot,
  MarketplaceSkillResult,
  ScopeType,
  SkillDeploymentPlan,
  SkillDeploymentResult,
  SkillRecord,
  SkillUpdateResult,
} from "./types";

export interface AgentSkillToolContext {
  callerAgentId: string;
  cwd: string;
}

export class AgentSkillTools {
  constructor(private readonly service: SkillControlService) {}

  public async search(query: string, ctx?: AgentSkillToolContext): Promise<SkillRecord[]> {
    return this.service.searchSkills(query);
  }

  public async get(skillId: string, ctx?: AgentSkillToolContext): Promise<SkillRecord | null> {
    return this.service.getSkill(skillId);
  }

  public async listInstalled(agentType?: string, ctx?: AgentSkillToolContext): Promise<InstalledSkillSnapshot[]> {
    const targetAgent = agentType ?? ctx?.callerAgentId ?? "codex";
    return this.service.listInstalledSkills(targetAgent);
  }

  public async planDeploy(
    skillVersionId: string,
    options: { scope?: ScopeType; projectPath?: string; agentType?: string },
    ctx?: AgentSkillToolContext,
  ): Promise<SkillDeploymentPlan> {
    const agent = options.agentType ?? ctx?.callerAgentId ?? "codex";
    return this.service.planDeployment(skillVersionId, {
      agentType: agent,
      scope: options.scope ?? "user",
      projectPath: options.projectPath ?? ctx?.cwd,
      nodeId: "local",
    });
  }

  public async requestDeploy(
    planId: string,
    ctx?: AgentSkillToolContext,
  ): Promise<SkillDeploymentResult> {
    const actor = ctx?.callerAgentId ? `agent:${ctx.callerAgentId}` : "agent";
    return this.service.applyDeploymentPlan(planId, actor);
  }

  public async checkUpdate(skillId: string): Promise<SkillUpdateResult[]> {
    return this.service.checkSkillUpdates(skillId);
  }

  public async reportDrift(deploymentId: string): Promise<{ inSync: boolean; driftType: DriftType }> {
    const res = await this.service.checkDeploymentDrift(deploymentId);
    return { inSync: res.inSync, driftType: res.driftType };
  }
}

