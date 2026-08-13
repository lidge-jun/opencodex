import {
  discoverLiveScenarios,
  expandLiveScenario,
  loadLiveCaseAuthority,
} from "../live/manifest";
import {
  liveSuiteManifestDigestForCase,
} from "../live/suite-manifest";
import {
  discoverScenarios,
  expandScenario,
  loadCaseAuthority,
} from "../conformance/manifest";
import {
  suiteManifestDigestForCase,
} from "../conformance/suite-manifest";
import {
  discoverFabricScenarios,
  expandFabricScenario,
  fabricSuiteManifestDigest,
  loadFabricCaseAuthority,
} from "../fabric/manifest";
import { scenarioManifestDigest } from "../digest";
import type { CaseRecord, EvidenceLayer, VerificationRole } from "../conformance/types";
import type { CatalogFilters, CatalogScenarioDto } from "./types";

type CatalogAuthority = {
  manifestDefaults: {
    version: string;
    suiteVersion: string;
    evidenceLayer: EvidenceLayer;
    verificationRole: VerificationRole;
    freshness: { maxAgeMs: number | null };
  };
};

function mapCaseToCatalogScenario<TAuthority extends CatalogAuthority>(
  caseRecord: CaseRecord,
  authority: TAuthority,
  suiteDigestFn: (caseRecord: CaseRecord, authority: TAuthority) => string,
  expandFn: (caseRecord: CaseRecord, authority: TAuthority) => Record<string, unknown>,
): CatalogScenarioDto {
  const expanded = expandFn(caseRecord, authority);
  return {
    scenarioId: caseRecord.id,
    scenarioVersion: authority.manifestDefaults.version,
    evidenceLayer: authority.manifestDefaults.evidenceLayer,
    suiteId: caseRecord.suite,
    suiteVersion: authority.manifestDefaults.suiteVersion,
    capability: caseRecord.capability,
    verificationRole: caseRecord.verificationRole ?? authority.manifestDefaults.verificationRole,
    requirements: {
      inboundProtocols: [...caseRecord.requirements.inboundProtocols],
      upstreamProtocols: [...caseRecord.requirements.upstreamProtocols],
      surfaces: [...caseRecord.requirements.surfaces],
    },
    freshness: { ...authority.manifestDefaults.freshness },
    scenarioManifestDigest: scenarioManifestDigest(expanded),
    suiteManifestDigest: suiteDigestFn(caseRecord, authority),
  };
}

export function queryLabCatalog(filters: CatalogFilters = {}): CatalogScenarioDto[] {
  const items: CatalogScenarioDto[] = [];
  if (!filters.layer || filters.layer === "protocol_conformance") {
    const authority = loadCaseAuthority();
    const suites = filters.suiteId ? [filters.suiteId] : undefined;
    const scenarios = discoverScenarios(authority, suites ?? undefined);
    for (const caseRecord of scenarios) {
      items.push(mapCaseToCatalogScenario(caseRecord, authority, suiteManifestDigestForCase, expandScenario));
    }
  }
  if (!filters.layer || filters.layer === "live_route_compatibility") {
    const authority = loadLiveCaseAuthority();
    const suites = filters.suiteId ? [filters.suiteId] : undefined;
    const scenarios = discoverLiveScenarios(authority, suites ?? undefined);
    for (const caseRecord of scenarios) {
      items.push(mapCaseToCatalogScenario(caseRecord, authority, liveSuiteManifestDigestForCase, expandLiveScenario));
    }
  }
  if (!filters.layer || filters.layer === "task_effectiveness") {
    const authority = loadFabricCaseAuthority();
    const suites = filters.suiteId ? [filters.suiteId] : undefined;
    const scenarios = discoverFabricScenarios(authority, suites ?? undefined);
    for (const caseRecord of scenarios) {
      items.push(mapCaseToCatalogScenario(
        caseRecord,
        authority,
        (row, auth) => fabricSuiteManifestDigest(row.suite, auth),
        expandFabricScenario,
      ));
    }
  }
  return items.sort((a, b) => {
    const layerCmp = a.evidenceLayer.localeCompare(b.evidenceLayer);
    if (layerCmp !== 0) return layerCmp;
    const suiteCmp = a.suiteId.localeCompare(b.suiteId);
    if (suiteCmp !== 0) return suiteCmp;
    return a.scenarioId.localeCompare(b.scenarioId);
  });
}
