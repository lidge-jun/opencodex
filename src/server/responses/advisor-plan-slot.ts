/** Core-owned, config-scoped registration. An inactive install has no Advisor factory. */
import type { OcxConfig, OcxParsedRequest, OcxTool } from "../../types";
import type { AdmissionModelScope } from "../admission-model-scope";
import type { AdvisorPlan } from "./advisor-slot";

export interface AdvisorPlanInput {
  config: OcxConfig;
  workerIdentity: string;
  workerModelId: string;
  /** Immutable scope captured from the request that is paying for this sidecar. */
  admissionScope?: AdmissionModelScope;
  admissionPolicy?: import("../../types/admission-policy").CapturedAdmissionPolicy;
  abortSignal?: AbortSignal;
}

export interface RegisteredAdvisorPlan {
  tool: OcxTool;
  consult?: AdvisorPlan["consult"];
  formatUnavailable?: AdvisorPlan["formatUnavailable"];
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
