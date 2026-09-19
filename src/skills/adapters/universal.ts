import { BaseSkillAgentAdapter } from "./base";
import type { AgentDetectContext, AgentDetectionResult, ScopeType } from "../types";

export class UniversalSkillAdapter extends BaseSkillAgentAdapter {
  public readonly id = "universal";
  public readonly displayName = "Universal Agent";
  public readonly version = "1.0.0";
  public readonly defaultScopes: ScopeType[] = ["user", "project", "workspace"];

  public async detect(_ctx: AgentDetectContext): Promise<AgentDetectionResult> {
    return {
      detected: true, // Always available as fallback
      agentType: this.id,
      version: "1.0.0",
      supportedScopes: this.defaultScopes,
    };
  }
}

