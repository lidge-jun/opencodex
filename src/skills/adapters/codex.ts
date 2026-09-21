import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BaseSkillAgentAdapter } from "./base";
import type { AgentDetectContext, AgentDetectionResult, ScopeType } from "../types";

export class CodexSkillAdapter extends BaseSkillAgentAdapter {
  public readonly id = "codex";
  public readonly displayName = "OpenAI Codex";
  public readonly version = "1.0.0";
  public readonly defaultScopes: ScopeType[] = ["user", "project"];

  public async detect(ctx: AgentDetectContext): Promise<AgentDetectionResult> {
    const home = ctx.homeDir ?? homedir();
    const codexHome = ctx.env?.["CODEX_HOME"] ?? join(home, ".codex");
    const codexProject = join(ctx.cwd, ".codex");

    const detected = existsSync(codexHome) || existsSync(codexProject) || existsSync(join(ctx.cwd, "skills", "ocx"));

    return {
      detected,
      agentType: this.id,
      version: "1.0.0",
      configRoot: codexHome,
      supportedScopes: this.defaultScopes,
    };
  }
}

