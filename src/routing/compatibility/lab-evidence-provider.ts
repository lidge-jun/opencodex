/**
 * Compatibility-evidence provider (Lab-backed).
 *
 * Holds every Lab-reaching part of policy candidate evidence: route/protocol subject
 * construction, the suite catalog snapshot, and the projection read. The core assembler
 * (`assemble.ts`) keeps capability, health, quota, and cost and consults this only through
 * the provider slot, so an install that never activates Lab never loads this module.
 *
 * This is a relocation of previously inline logic, not a rewrite: `attachCompatibilityEvidence`
 * below is the original function, and its state arrives entirely through arguments.
 *
 * @internal registered by the Lab activation path
 */
import type { OcxConfig } from "../../types";
import type { NormalizedRoutingProfile } from "../profile";
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
import type { CoreEvidenceOptions, CompatibilityEvidenceProvider } from "./provider-slot";

/** Lab-side seams, kept off the core options contract. */
export interface LabCompatibilityProviderOptions extends CoreEvidenceOptions {
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
 * Build compatibility evidence for every candidate of one profile.
 * Keyed `provider/model`; a candidate absent from the map has no compatibility evidence.
 */
export const labCompatibilityEvidenceProvider: CompatibilityEvidenceProvider = (
  config: OcxConfig,
  profile: NormalizedRoutingProfile,
  policy: NonNullable<NormalizedRoutingProfile["compatibility"]>,
  options: CoreEvidenceOptions,
): Map<string, CandidateCompatibilityEvidence> => {
  const labOptions = options as LabCompatibilityProviderOptions;
  const resolveSubjects = labOptions.resolveSubjects ?? resolvePolicyCompatibilitySubjects;
  const loadCatalog = labOptions.loadCatalogSnapshot ?? loadCompatibilityCatalogSnapshot;
  const loadEvidence = labOptions.loadEvidenceSnapshot ?? loadCompatibilityEvidenceSnapshot;

  const resolvedByCandidate = new Map<string, ResolvedPolicyCompatibilitySubjects>();
  const catalog: CompatibilityCatalogSnapshot = loadCatalog(policy.requiredSuites);
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

  const snapshot = loadEvidence([...subjectIds], options.configDir);

  const byCandidate = new Map<string, CandidateCompatibilityEvidence>();
  for (const candidate of profile.candidates) {
    const key = `${candidate.provider}/${candidate.model}`;
    byCandidate.set(
      key,
      attachCompatibilityEvidence(resolvedByCandidate.get(key), snapshot, catalog, policy),
    );
  }
  return byCandidate;
};
