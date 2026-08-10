import type { OcxConfig, OcxProviderConfig } from "../../types";
import { candidateCapabilityEvidence } from "../capability";
import { costEvidenceForCandidate } from "../cost";
import type { PolicyCandidateEvidence } from "../evaluator";
import { policyCandidateHealthEvidence } from "../health";
import type { NormalizedRoutingProfile } from "../profile";
import { quotaEvidenceForCandidate } from "../quota";
import {
  compatibilitySuiteKey,
  loadCompatibilityCatalogSnapshot,
  type CompatibilityCatalogSnapshot,
} from "./catalog";
import { findVerdictForSuite, loadCompatibilityEvidenceSnapshot } from "./reader";
import {
  resolvePolicyCompatibilitySubjects,
  type ResolvedPolicyCompatibilitySubjects,
} from "./subject";
import type { CandidateCompatibilityEvidence } from "./types";

export type RoutedProviderResolver = (
  providerName: string,
  provider: OcxProviderConfig,
) => OcxProviderConfig;

export interface AssemblePolicyEvidenceOptions {
  configDir?: string;
  routedProviderConfig: RoutedProviderResolver;
  resolveSubjects?: typeof resolvePolicyCompatibilitySubjects;
  loadEvidenceSnapshot?: typeof loadCompatibilityEvidenceSnapshot;
  loadCatalogSnapshot?: typeof loadCompatibilityCatalogSnapshot;
}

function attachCompatibilityEvidence(
  resolved: ResolvedPolicyCompatibilitySubjects | undefined,
  snapshot: ReturnType<typeof loadCompatibilityEvidenceSnapshot>,
  catalog: CompatibilityCatalogSnapshot,
  profile: NonNullable<NormalizedRoutingProfile["compatibility"]>,
): CandidateCompatibilityEvidence {
  const subjectIds = resolved?.subjectIds ?? {};
  const suites: CandidateCompatibilityEvidence["suites"] = [];

  for (const requirement of profile.requiredSuites) {
    const subjectId = subjectIds[requirement.evidenceLayer];
    if (!subjectId) continue;
    const metadata = catalog.get(compatibilitySuiteKey(requirement.evidenceLayer, requirement.suiteId));
    if (!metadata) continue;
    const row = findVerdictForSuite(
      snapshot,
      subjectId,
      requirement.evidenceLayer,
      requirement.suiteId,
      metadata.suiteVersion,
      metadata.suiteManifestDigest,
    );
    if (!row) continue;
    suites.push({
      subjectId,
      suiteId: row.suiteId,
      evidenceLayer: requirement.evidenceLayer,
      suiteVersion: row.suiteVersion,
      suiteManifestDigest: row.suiteManifestDigest,
      verdict: row.verdict,
      asOf: row.asOf,
      maxAgeMs: metadata.maxAgeMs,
      notes: row.notes,
    });
  }

  return {
    subjectIds: { ...subjectIds },
    projectionAvailable: snapshot.projectionAvailable,
    suites,
  };
}

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
  const resolvedByCandidate = new Map<string, ResolvedPolicyCompatibilitySubjects>();
  let catalog: CompatibilityCatalogSnapshot = new Map();
  let snapshot: ReturnType<typeof loadCompatibilityEvidenceSnapshot> = {
    projectionAvailable: true,
    projectionIncompatible: false,
    bySubject: new Map(),
  };

  if (hasCompatibilityRequirements && compatibilityPolicy) {
    const resolveSubjects = options.resolveSubjects ?? resolvePolicyCompatibilitySubjects;
    const loadCatalog = options.loadCatalogSnapshot ?? loadCompatibilityCatalogSnapshot;
    const loadEvidence = options.loadEvidenceSnapshot ?? loadCompatibilityEvidenceSnapshot;
    catalog = loadCatalog(compatibilityPolicy.requiredSuites);
    const subjectIds = new Set<string>();

    for (const candidate of profile.candidates) {
      const provider = config.providers[candidate.provider];
      if (!provider) continue;
      try {
        const routed = options.routedProviderConfig(candidate.provider, provider);
        const resolved = resolveSubjects(
          config,
          candidate.provider,
          candidate.model,
          routed,
          options.configDir,
        );
        resolvedByCandidate.set(`${candidate.provider}/${candidate.model}`, resolved);
        for (const subjectId of Object.values(resolved.subjectIds)) {
          if (subjectId) subjectIds.add(subjectId);
        }
      } catch {
        // Subject construction failure is handled per required layer as unknown.
      }
    }

    snapshot = loadEvidence([...subjectIds], options.configDir);
  }

  return profile.candidates.map(candidate => {
    const key = `${candidate.provider}/${candidate.model}`;
    const compatibility = hasCompatibilityRequirements && compatibilityPolicy
      ? attachCompatibilityEvidence(
        resolvedByCandidate.get(key),
        snapshot,
        catalog,
        compatibilityPolicy,
      )
      : undefined;

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
