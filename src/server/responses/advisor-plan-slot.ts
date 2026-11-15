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

/** Request-scoped config views (e.g. the Claude replay config) -> the live config they were built from. */
type AdvisorLinkedConfig = Pick<OcxConfig, "advisor">;
const views = new WeakMap<AdvisorLinkedConfig, OcxConfig>();

/**
 * Record that `view` is a request-scoped copy of `live`. A view resolves the live config's
 * factory at lookup time, so a later disable or re-activation of the live config still applies.
 * The view's `advisor` reads through to the live config: management writes replace that object
 * (`config.advisor = ...`), so a copied reference would keep a revoked consent alive for the
 * plan. Every other request-scoped override on the view is kept. Nothing is stored on the live
 * config, and an accessor is still cloneable (#7974).
 */
export function linkAdvisorPlanConfig<T extends OcxConfig>(live: OcxConfig, view: T): T {
  const root = views.get(live) ?? live;
  views.set(view, root);
  if (view !== root) {
    Object.defineProperty(view, "advisor", { get: () => root.advisor, enumerable: true, configurable: true });
  }
  return view;
}

/**
 * The live config a request-scoped view was linked to, or the config itself when it was not
 * linked. Identity-scoped state that must outlive one request (the activity feed the management
 * route reads from its own config object) resolves through the same link as the factory.
 */
export function advisorPlanRootConfig<T extends AdvisorLinkedConfig>(config: T): T | OcxConfig {
  return views.get(config) ?? config;
}

/** Create the plan from the factory registered for this config, or for the live config it was linked to. */
export function createRegisteredAdvisorPlan(input: AdvisorPlanInput): Promise<RegisteredAdvisorPlan | null> | null {
  const live = views.get(input.config);
  return (factories.get(input.config) ?? (live && factories.get(live)))?.(input) ?? null;
}
