/**
 * Slot for the optional compatibility-evidence provider.
 *
 * Routing is synchronous and must stay synchronous: `routeModelInternal` is sync, and so
 * are the subagent-fallback helpers that call `routeModel` (`isNativeModelQuotaExhausted`,
 * `isModelHealthBlocked`, `selectAvailableSubagentModel`, ...). Making the chain async to
 * permit a dynamic import would touch hundreds of call sites and break those APIs, so this
 * is a plain nullable reference rather than an `await import()`.
 *
 * The Lab implementation is installed during activation. Installs without
 * compatibility-gated routing profiles never register one, so the core evidence assembler
 * never reaches the Lab module graph.
 *
 * See devlog/_fin/260814_lab_core_decoupling/030_router_and_startup_activation.md
 */
import type { OcxConfig } from "../../types";
import type { NormalizedRoutingProfile } from "../profile";
import type { CandidateCompatibilityEvidence } from "./types";

/** Options the core assembler can supply without knowing anything Lab-specific. */
export interface CoreEvidenceOptions {
  configDir?: string;
  routedProviderConfig: (providerName: string, provider: import("../../types").OcxProviderConfig)
    => import("../../types").OcxProviderConfig;
}

/**
 * Produce compatibility evidence per candidate, keyed `provider/model`.
 * A candidate absent from the map has no compatibility evidence.
 */
export type CompatibilityEvidenceProvider = (
  config: OcxConfig,
  profile: NormalizedRoutingProfile,
  policy: NonNullable<NormalizedRoutingProfile["compatibility"]>,
  options: CoreEvidenceOptions,
) => Map<string, CandidateCompatibilityEvidence>;

let provider: CompatibilityEvidenceProvider | null = null;

/** Install the provider. Returns a detach function. */
export function setCompatibilityEvidenceProvider(next: CompatibilityEvidenceProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/** The installed provider, or null when no optional subsystem is active. */
export function resolveCompatibilityEvidenceProvider(): CompatibilityEvidenceProvider | null {
  return provider;
}

/** Test-only reset. */
export function resetCompatibilityEvidenceProviderForTests(): void {
  provider = null;
}
