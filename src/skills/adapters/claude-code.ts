import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseSkillAgentAdapter } from "./base";
import type { AgentDetectContext, AgentDetectionResult, ScopeType } from "../types";

export class ClaudeCodeSkillAdapter extends BaseSkillAgentAdapter {
  public readonly id = "claude-code";
  public readonly displayName = "Claude Code";
  public readonly version = "1.0.0";
  public readonly defaultScopes: ScopeType[] = ["user", "project"];

  public async detect(ctx: AgentDetectContext): Promise<AgentDetectionResult> {
    const home = ctx.homeDir ?? homedir();
    const claudeHome = join(home, ".claude");
    const claudeProject = join(ctx.cwd, ".claude");

    const detected = existsSync(claudeHome) || existsSync(claudeProject);

    return {
      detected,
      agentType: this.id,
      version: "1.0.0",
      configRoot: claudeHome,
      supportedScopes: this.defaultScopes,
    };
  }
}

