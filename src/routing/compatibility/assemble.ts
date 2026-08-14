import type { OcxConfig, OcxProviderConfig } from "../../types";
import { candidateCapabilityEvidence } from "../capability";
import { costEvidenceForCandidate } from "../cost";
import type { PolicyCandidateEvidence } from "../evaluator";
import { policyCandidateHealthEvidence } from "../health";
import type { NormalizedRoutingProfile } from "../profile";
import { quotaEvidenceForCandidate } from "../quota";
import { resolveCompatibilityEvidenceProvider, type CoreEvidenceOptions } from "./provider-slot";

export type RoutedProviderResolver = (
  providerName: string,
  provider: OcxProviderConfig,
) => OcxProviderConfig;

/**
 * Options the core assembler needs. Provider-specific test seams (subject resolution,
 * catalog and projection loading) belong to the compatibility provider, not here -- keeping
 * them out is what stops the core assembler from naming Lab-backed contracts.
 *
 * The provider reads its own seams off the same object, so callers may still pass a
 * `LabCompatibilityProviderOptions`; that type extends this one.
 */
export type AssemblePolicyEvidenceOptions = CoreEvidenceOptions;

/**
 * Assemble production policy candidate evidence including compatibility snapshots.
 * Compatibility work is completely skipped for legacy/no-requirement profiles.
 * Active compatibility profiles use one catalog snapshot and one bounded SQLite
 * read for all candidate subject IDs.
 */
export function assemblePolicyCandidateEvidence(
  config: OcxConfig,
  profile: NormalizedRoutingProfile,
  now: number,
  options: AssemblePolicyEvidenceOptions,
): PolicyCandidateEvidence[] {
  const compatibilityPolicy = profile.compatibility;
  const hasCompatibilityRequirements = Boolean(
    compatibilityPolicy && compatibilityPolicy.requiredSuites.length > 0,
  );
  // Compatibility evidence is supplied by an opt-in subsystem. With no provider registered
  // -- every install without compatibility-gated profiles -- the evaluator sees no
  // compatibility evidence and scores on capability, health, quota, and cost exactly as it
  // did before compatibility policy existed.
  const compatibilityProvider = hasCompatibilityRequirements && compatibilityPolicy
    ? resolveCompatibilityEvidenceProvider()
    : null;
  const compatibilityByCandidate = compatibilityProvider && compatibilityPolicy
    ? compatibilityProvider(config, profile, compatibilityPolicy, options)
    : null;

  return profile.candidates.map(candidate => {
    const key = `${candidate.provider}/${candidate.model}`;
    const compatibility = compatibilityByCandidate?.get(key);

    return {
      provider: candidate.provider,
      model: candidate.model,
      capability: candidateCapabilityEvidence(config, candidate.provider, candidate.model),
      health: policyCandidateHealthEvidence(config, candidate, now),
      quota: quotaEvidenceForCandidate({
        provider: candidate.provider,
        model: candidate.model,
      }),
      cost: costEvidenceForCandidate({
        provider: candidate.provider,
        model: candidate.model,
        limitUsd: profile.limits.maxEstimatedCostUsd,
      }),
      ...(compatibility ? { compatibility } : {}),
    };
  });
}
