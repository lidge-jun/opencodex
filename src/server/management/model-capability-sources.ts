import type { CatalogModel } from "../../codex/catalog";
import { createModelCapabilityInference, type InferredModelCapabilities } from "../../providers/model-capability-inference";
import type { OcxConfig } from "../../types";

/**
 * Who stands behind a capability value on a `/api/models` row. Precedence follows the runtime:
 * `manual` (operator declaration) > `probed` (a declaration written by the capability probe) >
 * `reported` (discovery, registry or provider metadata) > `inferred` (a same-name estimate the
 * catalog applies under `inferContextWindow`) > `unknown`.
 */
export type CapabilitySource = "manual" | "probed" | "reported" | "inferred" | "unknown";

export interface ModelCapabilitySources {
  contextWindow: CapabilitySource;
  inputModalities: CapabilitySource;
  reasoningEfforts: CapabilitySource;
}

export interface ModelCapabilitySourceFields {
  capabilitySources: ModelCapabilitySources;
  /** Same-name estimates for this model; present only when one exists. Display data, never routed. */
  inferredCapabilities?: InferredModelCapabilities;
}

interface RowFacts {
  contextWindowDeclared?: number;
  inputModalitiesDeclared?: string[];
  reasoningOverridden?: boolean;
  reasoningEfforts?: string[];
}

/** One lookup per `/api/models` listing; bundled tiers are shared across calls. */
export function modelCapabilitySourceResolver(config: OcxConfig) {
  const infer = createModelCapabilityInference(config);
  return (row: Pick<CatalogModel, "provider" | "id" | "contextWindow" | "contextWindowInference" | "inputModalities">, facts: RowFacts): ModelCapabilitySourceFields => {
    const probes = config.providers[row.provider]?.modelCapabilityProbes?.[row.id];
    const declared = (manual: boolean, probed: boolean | undefined): CapabilitySource | undefined =>
      manual ? (probed === true ? "probed" : "manual") : undefined;
    const contextWindow = declared(facts.contextWindowDeclared !== undefined, false)
      ?? (row.contextWindowInference ? "inferred" : typeof row.contextWindow === "number" && row.contextWindow > 0 ? "reported" : "unknown");
    const inputModalities = declared(facts.inputModalitiesDeclared !== undefined, probes?.inputModalities)
      ?? (Array.isArray(row.inputModalities) && row.inputModalities.length > 0 ? "reported" : "unknown");
    const reasoningEfforts = declared(facts.reasoningOverridden === true, probes?.reasoningEfforts)
      ?? (facts.reasoningEfforts !== undefined ? "reported" : "unknown");
    const inferred = infer(row.id, row.provider);
    return {
      capabilitySources: { contextWindow, inputModalities, reasoningEfforts },
      ...(Object.keys(inferred).length > 0 ? { inferredCapabilities: inferred } : {}),
    };
  };
}
