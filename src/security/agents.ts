import { DEFAULT_AGENTS, RISK_ORDER } from "./constants";
import type { AgentKind, RiskTier, SecurityAgentRecord } from "./types";

export function defaultAgentRecords(now = new Date()): SecurityAgentRecord[] {
  const created = now.toISOString();
  return DEFAULT_AGENTS.map(agent => ({
    ...agent,
    enabled: true,
    created_at: created,
  }));
}

export function agentMayRun(agent: SecurityAgentRecord | null | undefined, risk: RiskTier): boolean {
  if (!agent || !agent.enabled) return false;
  return RISK_ORDER[risk] <= RISK_ORDER[agent.max_risk_tier];
}

export function agentByKind(kind: AgentKind): (typeof DEFAULT_AGENTS)[number] | undefined {
  return DEFAULT_AGENTS.find(a => a.kind === kind);
}
