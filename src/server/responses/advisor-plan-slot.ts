/** Core-owned, config-scoped registration. An inactive install has no Advisor factory. */
import type { OcxConfig, OcxParsedRequest, OcxTool } from "../../types";

export interface AdvisorPlanInput {
  config: OcxConfig;
  workerIdentity: string;
  workerModelId: string;
  abortSignal?: AbortSignal;
}

export interface RegisteredAdvisorPlan {
  tool: OcxTool;
  preflightInject(parsed: OcxParsedRequest): Promise<boolean>;
  attachGuard(parsed: OcxParsedRequest): void;
}

type AdvisorPlanFactory = (input: AdvisorPlanInput) => Promise<RegisteredAdvisorPlan | null>;
const factories = new WeakMap<OcxConfig, AdvisorPlanFactory>();

export function setAdvisorPlanFactory(config: OcxConfig, factory: AdvisorPlanFactory | null): void {
  if (factory) factories.set(config, factory);
  else factories.delete(config);
}

export function createRegisteredAdvisorPlan(input: AdvisorPlanInput): Promise<RegisteredAdvisorPlan | null> | null {
  return factories.get(input.config)?.(input) ?? null;
}
