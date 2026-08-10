import { queryLabCatalog } from "../../lab/query/catalog";
import type { CatalogScenarioDto } from "../../lab/query/types";
import type {
  CompatibilitySuiteRequirement,
  RoutingCompatibilityEvidenceLayer,
} from "./types";

export interface CompatibilityCatalogSuite {
  suiteId: string;
  evidenceLayer: RoutingCompatibilityEvidenceLayer;
  suiteVersion: string;
  suiteManifestDigest: string;
  maxAgeMs: number | null;
}

export type CompatibilityCatalogSnapshot = Map<string, CompatibilityCatalogSuite>;

export function compatibilitySuiteKey(
  evidenceLayer: RoutingCompatibilityEvidenceLayer,
  suiteId: string,
): string {
  return `${evidenceLayer}:${suiteId}`;
}

function scenarioMaxAge(row: CatalogScenarioDto): number | null | undefined {
  if (!row.freshness || typeof row.freshness !== "object") return undefined;
  if (!Object.hasOwn(row.freshness, "maxAgeMs")) return undefined;
  const value = row.freshness.maxAgeMs;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Resolve current suite identities/freshness once per evidence layer before a
 * routing evaluation. The pure evaluator never performs manifest I/O.
 */
export function loadCompatibilityCatalogSnapshot(
  requirements: readonly CompatibilitySuiteRequirement[],
): CompatibilityCatalogSnapshot {
  const wanted = new Map<RoutingCompatibilityEvidenceLayer, Set<string>>();
  for (const requirement of requirements) {
    const suites = wanted.get(requirement.evidenceLayer) ?? new Set<string>();
    suites.add(requirement.suiteId);
    wanted.set(requirement.evidenceLayer, suites);
  }

  const out: CompatibilityCatalogSnapshot = new Map();
  const invalid = new Set<string>();

  for (const [layer, suiteIds] of wanted) {
    let rows: CatalogScenarioDto[];
    try {
      rows = queryLabCatalog({ layer });
    } catch {
      // Catalog/manifest failure is fail-safe: affected requirements become
      // missing evidence and follow the profile's unknown-evidence policy.
      continue;
    }

    for (const row of rows) {
      if (!suiteIds.has(row.suiteId)) continue;
      const key = compatibilitySuiteKey(layer, row.suiteId);
      if (invalid.has(key)) continue;
      const maxAgeMs = scenarioMaxAge(row);
      if (maxAgeMs === undefined) {
        out.delete(key);
        invalid.add(key);
        continue;
      }

      const prior = out.get(key);
      if (prior && (
        prior.suiteVersion !== row.suiteVersion
        || prior.suiteManifestDigest !== row.suiteManifestDigest
      )) {
        // One current suite id must have one exact version/digest identity.
        out.delete(key);
        invalid.add(key);
        continue;
      }

      const effectiveMaxAge = prior?.maxAgeMs == null
        ? maxAgeMs
        : maxAgeMs == null
          ? prior.maxAgeMs
          : Math.min(prior.maxAgeMs, maxAgeMs);
      out.set(key, {
        suiteId: row.suiteId,
        evidenceLayer: layer,
        suiteVersion: row.suiteVersion,
        suiteManifestDigest: row.suiteManifestDigest,
        maxAgeMs: effectiveMaxAge,
      });
    }
  }

  return out;
}
