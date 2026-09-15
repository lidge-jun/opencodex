import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseSkillAgentAdapter } from "./base";
import type { AgentDetectContext, AgentDetectionResult, ScopeType } from "../types";

export class OpenCodeSkillAdapter extends BaseSkillAgentAdapter {
  public readonly id = "opencode";
  public readonly displayName = "OpenCode";
  public readonly version = "1.0.0";
  public readonly defaultScopes: ScopeType[] = ["user", "project"];

  public async detect(ctx: AgentDetectContext): Promise<AgentDetectionResult> {
    const home = ctx.homeDir ?? homedir();
    const configHome = ctx.env?.["XDG_CONFIG_HOME"] ?? join(home, ".config");
    const opencodeHome = join(configHome, "opencode");
    const opencodeProject = join(ctx.cwd, ".opencode");

    const detected = existsSync(opencodeHome) || existsSync(opencodeProject);

    return {
      detected,
      agentType: this.id,
      version: "1.0.0",
      configRoot: opencodeHome,
      supportedScopes: this.defaultScopes,
    };
  }
}

