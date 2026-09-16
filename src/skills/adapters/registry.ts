import { ClaudeCodeSkillAdapter } from "./claude-code";
import { CodexSkillAdapter } from "./codex";
import type { SkillAgentAdapter } from "./contract";
import { OpenCodeSkillAdapter } from "./opencode";
import { UniversalSkillAdapter } from "./universal";
import type { AgentDetectContext, AgentDetectionResult } from "../types";

export class AgentAdapterRegistry {
  private readonly adapters = new Map<string, SkillAgentAdapter>();

  constructor() {
    this.register(new CodexSkillAdapter());
    this.register(new ClaudeCodeSkillAdapter());
    this.register(new OpenCodeSkillAdapter());
    this.register(new UniversalSkillAdapter());
  }

  public register(adapter: SkillAgentAdapter): void {
    this.adapters.set(adapter.id.toLowerCase(), adapter);
  }

  public get(agentType: string): SkillAgentAdapter | undefined {
    const key = agentType.toLowerCase();
    if (key === "claude") return this.adapters.get("claude-code");
    return this.adapters.get(key) ?? this.adapters.get("universal");
  }

  public list(): SkillAgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  public async detectAll(ctx: AgentDetectContext): Promise<AgentDetectionResult[]> {
    const results: AgentDetectionResult[] = [];
    for (const adapter of this.adapters.values()) {
      try {
        const det = await adapter.detect(ctx);
        if (det.detected) {
          results.push(det);
        }
      } catch {
        /* best-effort */
      }
    }
    return results;
  }
}

export const defaultAgentRegistry = new AgentAdapterRegistry();

